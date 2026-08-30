import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudClient, FailureDisposition, SafeRelayFailure } from "../../src/cloud/client.js";
import type {
  CommandAck,
  CreateRunResponse,
  RelayCommand,
  RelayResult,
  RunStatusResponse
} from "../../src/cloud/protocol.js";
import { AwError } from "../../src/errors.js";
import { RelayJournal } from "../../src/relay/journal.js";
import { RelayRunner } from "../../src/relay/runner.js";
import { LIMITS } from "../../src/util/limits.js";
import { packet, relayCommand, resultFor } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-relay-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

function binding(overrides: Partial<CreateRunResponse> = {}): CreateRunResponse {
  return {
    protocol_version: "aw-relay/0.1",
    create_request_id: `crq_${"a".repeat(24)}`,
    create_request_sha256: "c".repeat(64),
    create_disposition: "created",
    run_id: "run-1",
    session_id: "session-1",
    packet,
    config_sha256: "b".repeat(64),
    fencing_epoch: 2,
    status: "connected",
    dashboard_url: "https://augmentworks.ai/dashboard/runs/run-1",
    run_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    credit_state: "reserved",
    ...overrides
  };
}

class MockCloud {
  readonly commands: RelayCommand[];
  readonly completions: Array<{ command: RelayCommand; result: RelayResult }> = [];
  readonly failures: Array<{
    command: RelayCommand;
    error: SafeRelayFailure;
    disposition: FailureDisposition;
  }> = [];
  cancelled = false;

  constructor(commands: RelayCommand[]) {
    this.commands = commands;
  }

  async pollOperation(options: { afterSequence: number }) {
    const command = this.commands.find((item) => item.sequence === options.afterSequence + 1) ?? null;
    return {
      protocol_version: "aw-relay/0.1" as const,
      run_id: "run-1",
      session_id: "session-1",
      status: command === null ? (this.cancelled ? "cancelled" : "completed") : this.cancelled ? "cancel_requested" : "running",
      command
    };
  }

  async completeOperation(command: RelayCommand, result: RelayResult): Promise<CommandAck> {
    this.completions.push({ command, result });
    return { protocol_version: "aw-relay/0.1", command_id: command.command_id, accepted: true };
  }

  async failOperation(
    command: RelayCommand,
    error: SafeRelayFailure,
    disposition: FailureDisposition
  ): Promise<CommandAck> {
    this.failures.push({ command, error, disposition });
    return { protocol_version: "aw-relay/0.1", command_id: command.command_id, accepted: true };
  }

  async getRunStatus(): Promise<RunStatusResponse> {
    return {
      protocol_version: "aw-relay/0.1",
      run_id: "run-1",
      status: this.cancelled ? "cancelled" : "completed",
      outcome: this.cancelled ? null : "passed",
      credit_state: "consumed"
    };
  }

  async cancelRun(): Promise<RunStatusResponse> {
    this.cancelled = true;
    return {
      protocol_version: "aw-relay/0.1",
      run_id: "run-1",
      status: "cancel_requested",
      credit_state: "consumed"
    };
  }
}

function asCloud(mock: MockCloud): CloudClient {
  return mock as unknown as CloudClient;
}

describe("RelayRunner", () => {
  it("runs one operation at a time and durably acknowledges normalized results", async () => {
    const commands = [
      relayCommand("prepare"),
      relayCommand("send", { command_id: "command-send-2", sequence: 2 }),
      relayCommand("cleanup", { command_id: "command-cleanup-3", sequence: 3 })
    ];
    const cloud = new MockCloud(commands);
    let active = 0;
    let maximumActive = 0;
    const connector = {
      isIdempotent: (kind: RelayCommand["kind"]) => kind !== "send",
      execute: vi.fn(async (kind: RelayCommand["kind"], input: unknown) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const command = commands.find((candidate) => candidate.kind === kind && candidate.input === input);
        if (command === undefined) throw new Error("unexpected command");
        await Promise.resolve();
        active -= 1;
        return resultFor(command);
      })
    };
    const runner = new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    });
    const result = await runner.run();
    expect(result).toMatchObject({ status: "completed", outcome: "passed" });
    expect(maximumActive).toBe(1);
    expect(connector.execute).toHaveBeenCalledTimes(3);
    expect(cloud.completions.map((item) => item.command.command_id)).toEqual([
      "command-prepare-1",
      "command-send-2",
      "command-cleanup-3"
    ]);
  });

  it("marks a crashed non-idempotent send indeterminate instead of replaying it", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.close();
    const cloud = new MockCloud([command]);
    const connector = {
      isIdempotent: () => false,
      execute: vi.fn(async () => resultFor(command))
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.failures).toHaveLength(1);
    expect(cloud.failures[0]).toMatchObject({
      disposition: "outcome_indeterminate",
      error: { code: "OUTCOME_INDETERMINATE" }
    });
  });

  it("safely reexecutes a crashed operation explicitly declared idempotent", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("prepare");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.close();
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const cloud = new MockCloud([command, cleanup]);
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(async (kind: RelayCommand["kind"]) =>
        resultFor(kind === "cleanup" ? cleanup : command)
      )
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).toHaveBeenCalledTimes(2);
    expect(cloud.completions).toHaveLength(2);
    expect(cloud.failures).toHaveLength(0);
  });

  it("re-sends a cached completion after expiry when its cloud acknowledgement was lost", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.recordSuccess(command.command_id, resultFor(command));
    await journal.close();
    const cloud = new MockCloud([command]);
    const connector = { execute: vi.fn(async () => resultFor(command)), isIdempotent: () => false };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      now: () => new Date(Date.parse(command.expires_at) + 1_000),
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.completions).toHaveLength(1);
  });

  it("aborts an active non-idempotent send on cancellation, reports indeterminate, then drains cleanup", async () => {
    const send = relayCommand("send");
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const cloud = new MockCloud([send, cleanup]);
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const connector = {
      isIdempotent: (kind: RelayCommand["kind"]) => kind === "cleanup",
      execute: vi.fn(async (kind: RelayCommand["kind"], _input: unknown, context: { signal?: AbortSignal }) => {
        if (kind === "cleanup") return resultFor(cleanup);
        notifyStarted();
        await new Promise<void>((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new AwError({
                  code: "TARGET_OUTCOME_INDETERMINATE",
                  category: "target",
                  message: "The send may have completed.",
                  operation: "send"
                })
              ),
            { once: true }
          );
        });
        throw new Error("unreachable");
      })
    };
    const runner = new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    });
    const running = runner.run();
    await started;
    await runner.requestCancellation();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(cloud.failures[0]).toMatchObject({ disposition: "outcome_indeterminate" });
    expect(cloud.completions.at(-1)?.command.kind).toBe("cleanup");
    expect(connector.execute.mock.calls.map((call) => call[0])).toEqual(["send", "cleanup"]);
  });

  it("never aborts an active cleanup when graceful cancellation is requested", async () => {
    const prepare = relayCommand("prepare");
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const cloud = new MockCloud([prepare, cleanup]);
    let notifyCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanupStarted = resolve;
    });
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupSignal: AbortSignal | undefined;
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(
        async (
          kind: RelayCommand["kind"],
          _input: unknown,
          context: { signal?: AbortSignal }
        ) => {
          if (kind === "prepare") return resultFor(prepare);
          cleanupSignal = context.signal;
          notifyCleanupStarted();
          await cleanupReleased;
          return resultFor(cleanup);
        }
      )
    };
    const runner = new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    });
    const running = runner.run();
    await cleanupStarted;
    await runner.requestCancellation();
    expect(cleanupSignal?.aborted).toBe(false);
    releaseCleanup();
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(cloud.completions.at(-1)?.command.kind).toBe("cleanup");
  });

  it("reports a returned non-idempotent send with invalid correlation as indeterminate", async () => {
    const send = relayCommand("send");
    const cloud = new MockCloud([send]);
    const connector = {
      isIdempotent: () => false,
      execute: vi.fn(async () => ({ ...resultFor(send), turn_id: "wrong-turn" }))
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    }).run();
    expect(cloud.failures).toHaveLength(1);
    expect(cloud.failures[0]).toMatchObject({
      disposition: "outcome_indeterminate",
      error: { code: "TARGET_CORRELATION_ERROR" }
    });
  });

  it("durably finalizes an expired crashed non-idempotent send as indeterminate", async () => {
    const now = Date.now();
    const send = relayCommand("send", {
      issued_at: new Date(now - 120_000).toISOString(),
      expires_at: new Date(now - 60_000).toISOString()
    });
    const stateDirectory = await temporaryDirectory();
    const journal = await new RelayJournal({ runId: send.run_id, stateDirectory }).open();
    await journal.accept(send);
    await journal.markStarted(send.command_id);
    await journal.close();
    const cloud = new MockCloud([send]);
    const connector = {
      isIdempotent: () => false,
      execute: vi.fn(async () => resultFor(send))
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.failures[0]).toMatchObject({
      disposition: "outcome_indeterminate",
      error: { code: "OUTCOME_INDETERMINATE" }
    });
  });

  it("does not reexecute an expired idempotent prepare and still requires cleanup", async () => {
    const now = Date.now();
    const prepare = relayCommand("prepare", {
      issued_at: new Date(now - 120_000).toISOString(),
      expires_at: new Date(now - 60_000).toISOString()
    });
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const stateDirectory = await temporaryDirectory();
    const journal = await new RelayJournal({ runId: prepare.run_id, stateDirectory }).open();
    await journal.accept(prepare);
    await journal.markStarted(prepare.command_id);
    await journal.close();
    const cloud = new MockCloud([prepare, cleanup]);
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(async (kind: RelayCommand["kind"]) => {
        if (kind !== "cleanup") throw new Error("expired prepare was reexecuted");
        return resultFor(cleanup);
      })
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).toHaveBeenCalledOnce();
    expect(cloud.failures[0]).toMatchObject({
      disposition: "failed",
      error: { code: "COMMAND_EXPIRED_AFTER_START" }
    });
    expect(cloud.completions.at(-1)?.command.kind).toBe("cleanup");
  });

  it("retries an explicitly idempotent cleanup at most three times with identical inputs", async () => {
    const prepare = relayCommand("prepare");
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const cloud = new MockCloud([prepare, cleanup]);
    let cleanupAttempts = 0;
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(
        async (kind: RelayCommand["kind"], _input: unknown, _context: unknown) => {
          if (kind === "prepare") return resultFor(prepare);
          cleanupAttempts += 1;
          if (cleanupAttempts < 3) {
            throw new AwError({
              code: "TARGET_TEMPORARY_FAILURE",
              category: "target",
              message: "Cleanup is temporarily unavailable.",
              retryable: true,
              operation: "cleanup"
            });
          }
          return resultFor(cleanup);
        }
      )
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    }).run();
    const cleanupCalls = connector.execute.mock.calls.filter((call) => call[0] === "cleanup");
    expect(cleanupCalls).toHaveLength(3);
    expect(new Set(cleanupCalls.map((call) => call[1])).size).toBe(1);
    expect(new Set(cleanupCalls.map((call) => call[2])).size).toBe(1);
    expect(cloud.failures).toHaveLength(0);
  });

  it("refuses a terminal run while a prepared fixture remains outstanding", async () => {
    const prepare = relayCommand("prepare");
    const cloud = new MockCloud([prepare]);
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(async () => resultFor(prepare))
    };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory: await temporaryDirectory(),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "CLEANUP_INCOMPLETE", category: "cleanup" });
  });

  it("enforces the immutable server run expiry before polling", async () => {
    const now = Date.now();
    const cloud = new MockCloud([]);
    const connector = { execute: vi.fn() };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding({ run_expires_at: new Date(now - 1).toISOString() }),
        stateDirectory: await temporaryDirectory(),
        now: () => new Date(now),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "RUN_EXPIRED" });
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it("does not reset the durable local runtime deadline after restart", async () => {
    const startedAt = Date.now();
    const stateDirectory = await temporaryDirectory();
    const serverExpiresAt = new Date(startedAt + 2 * LIMITS.maxRunMs).toISOString();
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    await journal.bindRunDeadline(
      serverExpiresAt,
      new Date(startedAt + LIMITS.maxRunMs).toISOString()
    );
    await journal.close();

    const cloud = new MockCloud([]);
    const connector = { execute: vi.fn() };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding({ run_expires_at: serverExpiresAt }),
        stateDirectory,
        now: () => new Date(startedAt + LIMITS.maxRunMs + 1),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "RUN_TIME_LIMIT_EXCEEDED" });
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it("rejects a stale fence before local execution", async () => {
    const bad = relayCommand("send", { fencing_epoch: 1 });
    const cloud = new MockCloud([bad]);
    const connector = { execute: vi.fn(async () => resultFor(bad)) };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory: await temporaryDirectory(),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(connector.execute).not.toHaveBeenCalled();
  });
});
