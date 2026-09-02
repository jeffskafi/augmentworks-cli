import { describe, expect, it, vi } from "vitest";

import type { ConnectorExecutionContext, ConnectorResult } from "../../src/connector/types.js";
import { AwError, type OperationKind } from "../../src/errors.js";
import { LocalRunner, type LocalConnector } from "../../src/local/runner.js";
import type { PacketManifest } from "../../src/local/types.js";

function packet(repetitions = 1): PacketManifest {
  return {
    schema_version: "aw-packet/0.1",
    packet_id: "runner-test",
    version: "0.1.0",
    name: "Runner test packet",
    description: "Synthetic packet for the local runner contract.",
    domain: "test",
    synthetic_only: true,
    required_capabilities: {
      multi_turn: false,
      observation: true,
      tool_events: false,
      cleanup: true
    },
    scenarios: [
      {
        key: "runner-test.lifecycle",
        name: "Lifecycle",
        category: "test",
        severity: "high",
        description: "Exercise the direct lifecycle.",
        expected_behavior: "Return done and persist synthetic state.",
        fixture: { record: { id: "synthetic-1" } },
        turns: [{ content: "Run the synthetic action." }],
        observation_keys: ["record.status"],
        assertions: [
          {
            kind: "assistant_contains",
            key: "response-done",
            description: "The response says done.",
            value: "done"
          },
          {
            kind: "observation_equals",
            key: "state-done",
            description: "The authoritative state is done.",
            observation_key: "record.status",
            expected: "done",
            authoritative_only: true
          }
        ],
        repetitions,
        pass_threshold: 1
      }
    ]
  };
}

function resultFor(
  kind: OperationKind,
  context: ConnectorExecutionContext
): ConnectorResult {
  if (kind === "prepare") {
    return {
      protocol_version: "aw-target/0.1",
      status: "ready",
      attempt_id: context.attemptId!,
      metadata: {}
    };
  }
  if (kind === "send") {
    return {
      protocol_version: "aw-target/0.1",
      turn_id: context.turnId!,
      message: { role: "assistant", content: "Done." },
      events: [],
      finished: true,
      metadata: {}
    };
  }
  if (kind === "observe") {
    return {
      protocol_version: "aw-target/0.1",
      request_id: context.requestId!,
      observations: [
        {
          key: "record.status",
          value: "done",
          source: "synthetic-store",
          authoritative: true
        }
      ],
      metadata: {}
    };
  }
  return {
    protocol_version: "aw-target/0.1",
    status: "cleaned",
    attempt_id: context.attemptId!
  };
}

function connector(
  execute: (
    kind: OperationKind,
    input: unknown,
    context: ConnectorExecutionContext
  ) => Promise<ConnectorResult>,
  cleanupIdempotent = true
): LocalConnector {
  return {
    execute,
    isIdempotent: (kind) => kind === "cleanup" && cleanupIdempotent
  };
}

function runnerOptions(localConnector: LocalConnector, manifest = packet()) {
  return {
    connector: localConnector,
    packet: manifest,
    packetSha256: "a".repeat(64),
    targetName: "synthetic-target",
    configSha256: "b".repeat(64),
    cliVersion: "0.2.0",
    runId: "local_run_runner_test"
  } as const;
}

describe("LocalRunner", () => {
  it("executes prepare, send, observe, and cleanup serially and scores locally", async () => {
    const calls: OperationKind[] = [];
    const localConnector = connector(async (kind, _input, context) => {
      calls.push(kind);
      return resultFor(kind, context);
    });

    const result = await new LocalRunner(runnerOptions(localConnector)).run();

    expect(calls).toEqual(["prepare", "send", "observe", "cleanup"]);
    expect(result.outcome).toBe("passed");
    expect(result.counts).toMatchObject({ attempts: 1, passed: 1, errors: 0 });
    expect(result.provenance).toMatchObject({
      execution_mode: "local",
      platform_received: false,
      cloud_contacted: false,
      signed: false
    });
  });

  it("observes state and cleans up after an indeterminate non-idempotent send", async () => {
    const calls: OperationKind[] = [];
    const localConnector = connector(async (kind, _input, context) => {
      calls.push(kind);
      if (kind === "send") {
        throw new AwError({
          code: "TARGET_OUTCOME_INDETERMINATE",
          category: "target",
          message: "The dispatched send may have completed.",
          operation: "send"
        });
      }
      return resultFor(kind, context);
    });

    const result = await new LocalRunner(runnerOptions(localConnector)).run();

    expect(calls).toEqual(["prepare", "send", "observe", "cleanup"]);
    expect(result.outcome).toBe("inconclusive");
    expect(result.attempts[0]).toMatchObject({
      status: "inconclusive",
      cleanup_status: "completed"
    });
  });

  it("stops new attempts when cleanup cannot be confirmed", async () => {
    const calls: OperationKind[] = [];
    const localConnector = connector(async (kind, _input, context) => {
      calls.push(kind);
      if (kind === "cleanup") {
        throw new AwError({
          code: "TARGET_CLEANUP_FAILED",
          category: "cleanup",
          message: "Synthetic cleanup was not confirmed.",
          operation: "cleanup",
          retryable: false
        });
      }
      return resultFor(kind, context);
    });

    const result = await new LocalRunner(runnerOptions(localConnector, packet(2))).run();

    expect(calls).toEqual(["prepare", "send", "observe", "cleanup"]);
    expect(result.outcome).toBe("error");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.cleanup_status).toBe("failed");
    expect(result.attempts[1]).toMatchObject({
      status: "error",
      cleanup_status: "not_required",
      errors: [expect.objectContaining({ code: "not_run_after_cleanup_failure" })]
    });
  });

  it("aborts active target work on cancellation but drains cleanup", async () => {
    const calls: OperationKind[] = [];
    let runner: LocalRunner;
    const localConnector = connector(async (kind, _input, context) => {
      calls.push(kind);
      if (kind === "send") {
        await new Promise<void>((_resolve, reject) => {
          if (context.signal?.aborted === true) {
            reject(cancelledError(kind));
            return;
          }
          context.signal?.addEventListener("abort", () => reject(cancelledError(kind)), {
            once: true
          });
        });
      }
      if (context.signal?.aborted === true && kind !== "cleanup") throw cancelledError(kind);
      return resultFor(kind, context);
    });
    runner = new LocalRunner({
      ...runnerOptions(localConnector),
      onProgress: (event) => {
        if (event.type === "operation_started" && event.kind === "send") {
          setImmediate(() => runner.requestCancellation());
        }
      }
    });

    const result = await runner.run();

    expect(runner.interrupted).toBe(true);
    expect(calls.at(-1)).toBe("cleanup");
    expect(result.attempts[0]).toMatchObject({ status: "error", cleanup_status: "completed" });
  });

  it("enforces the total run deadline without classifying it as a user interrupt", async () => {
    const localConnector = connector(async (kind, _input, context) => {
      if (kind === "send") {
        await new Promise<void>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(cancelledError(kind)), {
            once: true
          });
        });
      }
      if (context.signal?.aborted === true && kind !== "cleanup") throw cancelledError(kind);
      return resultFor(kind, context);
    });
    const runner = new LocalRunner({ ...runnerOptions(localConnector), runDeadlineMs: 10 });

    const result = await runner.run();

    expect(runner.cancelRequested).toBe(true);
    expect(runner.interrupted).toBe(false);
    expect(result.outcome).toBe("error");
    expect(result.attempts[0]?.cleanup_status).toBe("completed");
  });

  it("rejects re-entrant execution", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const localConnector = connector(async (kind, _input, context) => {
      if (kind === "send") await gate;
      return resultFor(kind, context);
    });
    const runner = new LocalRunner(runnerOptions(localConnector));
    const first = runner.run();
    await vi.waitFor(() => expect(runner.cancelRequested).toBe(false));
    await expect(runner.run()).rejects.toMatchObject({ code: "LOCAL_RUN_ALREADY_ACTIVE" });
    release();
    await first;
  });
});

function cancelledError(operation: OperationKind): AwError {
  return new AwError({
    code: "OPERATION_CANCELLED",
    category: operation === "cleanup" ? "cleanup" : "target",
    message: "The target operation was cancelled.",
    operation
  });
}
