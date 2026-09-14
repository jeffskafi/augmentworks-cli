import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTestCommand,
  installSelectionExecutionInterruptHandler,
  runTest
} from "../../src/commands/test.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import { AwError, EXIT } from "../../src/errors.js";
import {
  aggregateExecutionExitCode,
  artifactFromExecution,
  derivedRemainingCredits,
  executionDocumentPath,
  executionJsonFields,
  executionPaths,
  formatSelectionResumeCommand,
  initialExecution,
  interruptExecution,
  markShardAdmitted,
  markShardCompleted,
  markShardFailed,
  markShardQuoted,
  nextRunnableShard,
  openSelectionExecution,
  parseExecutionId,
  resumeExecution,
  saveSelectionExecution,
  skipRemainingPendingShards
} from "../../src/selection/execution.js";
import { SELECTION_EXECUTION_DOCUMENT_KIND, type SuiteSelectionManifest } from "../../src/selection/schema.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-suite-selection-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function stateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-execution-"));
  temporaryDirectories.push(directory);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return directory;
}

function baseManifest(): SuiteSelectionManifest {
  return fixtures.fixtures["compile_executable"]?.response as SuiteSelectionManifest;
}

function twoShardManifest(manifestHash = `b${"c".repeat(63)}`): SuiteSelectionManifest {
  const compiled = baseManifest();
  const first = compiled.shards[0];
  if (first === undefined) throw new Error("missing shard");
  return {
    ...compiled,
    manifestHash,
    shards: [
      first,
      {
        ...first,
        shardId: "shard-001",
        shardIndex: 1,
        shardIdentityHash: "c".repeat(64)
      }
    ]
  };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AwError);
  expect((error as AwError).code).toBe(code);
}

async function expectAsyncCode(run: () => Promise<unknown>, code: string): Promise<AwError> {
  try {
    await run();
  } catch (error) {
    expectCode(error, code);
    return error as AwError;
  }
  throw new Error(`expected ${code}`);
}

function doctorFor() {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "refunds",
      connector: "http",
      base_url: "http://127.0.0.1:8000",
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          request: { message: "$input.message" },
          response: { content: "$.answer" }
        }
      }
    }
  };
  const inspection = resolveConfig(config, "/tmp/augmentworks.yaml", "/tmp", {});
  const resolvedConfig = inspection.resolvedConfig;
  if (resolvedConfig === undefined) throw new Error("test config did not resolve");
  return async () => ({
    ok: true as const,
    configPath: resolvedConfig.configPath,
    offline: true as const,
    diagnostics: [],
    resolvedConfig
  });
}

describe("selection execution IDs", () => {
  it("creates a cryptographically random execution id for a fresh attempt", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const opened = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20
    });
    expect(opened.kind).toBe("created");
    expect(opened.execution.executionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(opened.execution.shards.every((shard) => shard.state === "pending")).toBe(true);
    expect(opened.execution.remainingCredits).toBe(20);
    await opened.lock.release();
  });

  it("starts a new empty execution after a terminal attempt on the same manifest", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      createExecutionId: () => "11111111-1111-4111-8111-111111111111"
    });
    let execution = markShardQuoted(first.execution, "shard-000", {
      quoteId: "quote-a",
      quotedUnits: 4
    });
    execution = markShardAdmitted(execution, "shard-000", { runId: "run-a" });
    execution = markShardCompleted(execution, "shard-000", { runId: "run-a", chargedUnits: 4 });
    execution = markShardQuoted(execution, "shard-001", { quoteId: "quote-b", quotedUnits: 4 });
    execution = markShardAdmitted(execution, "shard-001", { runId: "run-b" });
    execution = markShardCompleted(execution, "shard-001", { runId: "run-b", chargedUnits: 4 });
    const saved = await saveSelectionExecution(first.paths, execution);
    expect(saved.state).toBe("completed");
    expect(saved.terminalReason).toBeNull();
    await first.lock.release();

    const second = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      createExecutionId: () => "22222222-2222-4222-8222-222222222222"
    });
    expect(second.kind).toBe("rerun");
    expect(second.execution.executionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(second.execution.shards.map((shard) => shard.state)).toEqual(["pending", "pending"]);
    expect(second.execution.shards.some((shard) => shard.runId === "run-a")).toBe(false);
    expect(second.execution.remainingCredits).toBe(20);
    await second.lock.release();
  });

  it("keeps different manifests from colliding", async () => {
    const stateDirectory = await stateDir();
    const a = await openSelectionExecution({
      stateDirectory,
      manifest: twoShardManifest("a".repeat(64)),
      aggregateMaxCredits: 8,
      createExecutionId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
    const b = await openSelectionExecution({
      stateDirectory,
      manifest: twoShardManifest("d".repeat(64)),
      aggregateMaxCredits: 8,
      createExecutionId: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    });
    expect(a.execution.executionId).not.toBe(b.execution.executionId);
    expect(a.paths.root).not.toBe(b.paths.root);
    await a.lock.release();
    await b.lock.release();
  });

  it("refuses a second invocation without --execution-id while an attempt is unfinished", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      manifestPath: "./suite-selection.manifest.json"
    });
    await first.lock.release();
    const error = await expectAsyncCode(
      () =>
        openSelectionExecution({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 20,
          manifestPath: "./suite-selection.manifest.json"
        }),
      "SELECTION_RESUME_REQUIRED"
    );
    expect(error.details?.["execution_id"]).toBe(first.execution.executionId);
    expect(error.details?.["recovery_action"]).toBe("resume_execution");
    expect(String(error.details?.["recovery_command"])).toContain("--execution-id");
    expect(error.message).toContain("Resume this attempt");
    expect(error.message).toContain("new rerun");
  });

  it("resumes only the exact execution id and clears interrupted terminal reason", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 12
    });
    const interrupted = await saveSelectionExecution(
      first.paths,
      interruptExecution(markShardQuoted(first.execution, "shard-000", { quoteId: "quote-1", quotedUnits: 4 }))
    );
    expect(interrupted.state).toBe("interrupted");
    expect(interrupted.terminalReason).toBeNull();
    await first.lock.release();

    await expectAsyncCode(
      () =>
        openSelectionExecution({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 12,
          executionId: "99999999-9999-4999-8999-999999999999"
        }),
      "SELECTION_EXECUTION_NOT_FOUND"
    );

    const resumed = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 12,
      executionId: interrupted.executionId
    });
    expect(resumed.kind).toBe("resumed");
    expect(resumed.execution.state).toBe("running");
    expect(resumed.execution.terminalReason).toBeNull();
    expect(resumed.execution.shards[0]?.quoteId).toBe("quote-1");
    expect(resumed.execution.shards[0]?.quotedUnits).toBe(4);
    await resumed.lock.release();
  });

  it("does not requote or double-subtract completed shards", async () => {
    const manifest = twoShardManifest();
    let execution = initialExecution(manifest, 10);
    execution = markShardQuoted(execution, "shard-000", { quoteId: "quote-1", quotedUnits: 4 });
    execution = markShardAdmitted(execution, "shard-000", { runId: "run-1" });
    execution = markShardCompleted(execution, "shard-000", { runId: "run-1", chargedUnits: 4 });
    const remaining = execution.remainingCredits;
    const again = markShardCompleted(execution, "shard-000", { runId: "run-1", chargedUnits: 4 });
    expect(again.remainingCredits).toBe(remaining);
    expect(derivedRemainingCredits(again)).toBe(6);
    expect(nextRunnableShard(again)?.shardId).toBe("shard-001");
  });

  it("restores durable units for a recovered terminal shard and advances coverage", () => {
    const manifest = twoShardManifest();
    let execution = initialExecution(manifest, 10);
    execution = markShardQuoted(execution, "shard-000", { quoteId: "quote-1", quotedUnits: 4 });
    execution = markShardAdmitted(execution, "shard-000", { runId: "run-1" });
    execution = markShardCompleted(execution, "shard-000", {
      runId: "run-1",
      chargedUnits: 4,
      quoteId: "quote-1"
    });
    const artifact = artifactFromExecution(manifest, execution);
    expect(artifact.declaredShards).toEqual([
      expect.objectContaining({ shardId: "shard-000", runId: "run-1" })
    ]);
    expect(artifact.missingShardIds).toContain("shard-001");
    expect(execution.remainingCredits).toBe(6);
  });

  it("treats exact budget coverage as complete and budget exhaustion with a pending shard as incomplete", () => {
    const manifest = twoShardManifest();
    let exact = initialExecution(manifest, 8);
    exact = markShardCompleted(markShardAdmitted(markShardQuoted(exact, "shard-000", { quoteId: "q1", quotedUnits: 4 }), "shard-000", { runId: "r1" }), "shard-000", { chargedUnits: 4 });
    exact = markShardCompleted(markShardAdmitted(markShardQuoted(exact, "shard-001", { quoteId: "q2", quotedUnits: 4 }), "shard-001", { runId: "r2" }), "shard-001", { chargedUnits: 4 });
    expect(exact.remainingCredits).toBe(0);
    expect(aggregateExecutionExitCode(exact, EXIT.OK)).toBe(EXIT.OK);

    let exhausted = initialExecution(manifest, 4);
    exhausted = markShardCompleted(markShardAdmitted(markShardQuoted(exhausted, "shard-000", { quoteId: "q1", quotedUnits: 4 }), "shard-000", { runId: "r1" }), "shard-000", { chargedUnits: 4 });
    exhausted = skipRemainingPendingShards(exhausted, "aggregate_budget");
    expect(exhausted.state).toBe("blocked");
    expect(exhausted.shards[1]?.state).toBe("blocked");
    expect(aggregateExecutionExitCode(exhausted, EXIT.OK)).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(executionJsonFields(exhausted)["coverage_complete"]).toBe(false);
  });

  it("does not let a last-shard pass mask missing coverage", () => {
    const manifest = twoShardManifest();
    let execution = initialExecution(manifest, 4);
    execution = markShardCompleted(
      markShardAdmitted(markShardQuoted(execution, "shard-000", { quoteId: "q1", quotedUnits: 4 }), "shard-000", {
        runId: "r1"
      }),
      "shard-000",
      { chargedUnits: 4 }
    );
    execution = skipRemainingPendingShards(execution, "aggregate_budget");
    expect(aggregateExecutionExitCode(execution, EXIT.OK)).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("counts unique quote ids once across duplicate poll/retry completions", () => {
    const manifest = twoShardManifest();
    let execution = initialExecution(manifest, 10);
    execution = markShardQuoted(execution, "shard-000", { quoteId: "same-quote", quotedUnits: 4 });
    execution = markShardCompleted(execution, "shard-000", { runId: "run-1", chargedUnits: 4, quoteId: "same-quote" });
    const duplicate = markShardCompleted(execution, "shard-000", {
      runId: "run-1",
      chargedUnits: 4,
      quoteId: "same-quote"
    });
    expect(duplicate.remainingCredits).toBe(6);
  });

  it("fails closed on negative, overflowing, or missing unit ledgers", () => {
    const manifest = twoShardManifest();
    const execution = initialExecution(manifest, 4);
    expect(() =>
      markShardQuoted(execution, "shard-000", { quoteId: "q", quotedUnits: -1 })
    ).toThrow(/SELECTION_BUDGET_INVARIANT|quotedUnits/);
    expect(() =>
      markShardQuoted(execution, "shard-000", { quoteId: "q", quotedUnits: 8 })
    ).toThrow(/SELECTION_BUDGET_INVARIANT|underflow/i);
  });

  it("maps mixed pass/block/failure to a stable failed aggregate exit", () => {
    const manifest = twoShardManifest();
    let execution = initialExecution(manifest, 20);
    execution = markShardCompleted(
      markShardAdmitted(markShardQuoted(execution, "shard-000", { quoteId: "q1", quotedUnits: 4 }), "shard-000", {
        runId: "r1"
      }),
      "shard-000",
      { chargedUnits: 4 }
    );
    execution = markShardFailed(execution, "shard-001", { runId: "r2" });
    expect(aggregateExecutionExitCode(execution)).toBe(EXIT.ASSESSMENT_FAILED);
  });

  it("migrates an unambiguous v1 progress file once and keeps the original file", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    const first = manifest.shards[0]!;
    const v1 = {
      schemaVersion: "aw-selection-progress/1",
      manifestHash: manifest.manifestHash,
      aggregateMaxCredits: 8,
      remainingCredits: 4,
      stoppedReason: null,
      shards: [
        {
          shardId: first.shardId,
          shardIdentityHash: first.shardIdentityHash,
          status: "completed",
          runId: "run-1",
          quoteUnits: 4
        },
        {
          shardId: "shard-001",
          shardIdentityHash: "c".repeat(64),
          status: "pending"
        }
      ]
    };
    const paths = executionPaths(stateDirectory, manifest.manifestHash);
    await mkdir(join(stateDirectory, "selections"), { recursive: true, mode: 0o700 });
    await writeFile(paths.v1Progress, `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    const error = await expectAsyncCode(
      () => openSelectionExecution({ stateDirectory, manifest, aggregateMaxCredits: 8 }),
      "SELECTION_RESUME_REQUIRED"
    );
    expect(JSON.parse(await readFile(paths.v1Progress, "utf8"))).toMatchObject({
      schemaVersion: "aw-selection-progress/1"
    });
    expect(error.details?.["execution_id"]).toEqual(expect.any(String));
    const resumed = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 8,
      executionId: String(error.details?.["execution_id"])
    });
    expect(resumed.execution.shards[0]?.chargedUnits).toBe(4);
    expect(resumed.execution.remainingCredits).toBe(4);
    await resumed.lock.release();
  });

  it("refuses an ambiguous v1 progress file before any caller can quote", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    const first = manifest.shards[0]!;
    const v1 = {
      schemaVersion: "aw-selection-progress/1",
      manifestHash: manifest.manifestHash,
      aggregateMaxCredits: 4,
      remainingCredits: 0,
      stoppedReason: "stale",
      shards: [
        {
          shardId: first.shardId,
          shardIdentityHash: first.shardIdentityHash,
          status: "completed",
          runId: "run-1"
        },
        {
          shardId: "shard-001",
          shardIdentityHash: "c".repeat(64),
          status: "pending"
        }
      ]
    };
    const paths = executionPaths(stateDirectory, manifest.manifestHash);
    await mkdir(join(stateDirectory, "selections"), { recursive: true, mode: 0o700 });
    await writeFile(paths.v1Progress, `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    await expectAsyncCode(
      () => openSelectionExecution({ stateDirectory, manifest, aggregateMaxCredits: 4 }),
      "SELECTION_PROGRESS_MIGRATION_REQUIRED"
    );
  });

  it("quarantines truncated JSON and does not silently discard it", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openSelectionExecution({ stateDirectory, manifest, aggregateMaxCredits: 4 });
    const file = executionDocumentPath(first.paths, first.execution.executionId);
    await first.lock.release();
    await writeFile(file, '{"documentKind":"aw-selection-execution/2"', { mode: 0o600 });
    await expectAsyncCode(
      () =>
        openSelectionExecution({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 4,
          executionId: first.execution.executionId
        }),
      "SELECTION_EXECUTION_CORRUPT"
    );
    const quarantined = await readdir(join(first.paths.root, "quarantine"));
    expect(quarantined.length).toBeGreaterThan(0);
  });

  it("rejects symlink execution paths", async () => {
    if (process.platform === "win32") return;
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openSelectionExecution({ stateDirectory, manifest, aggregateMaxCredits: 4 });
    await first.lock.release();
    const target = join(stateDirectory, "other.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    const file = executionDocumentPath(first.paths, first.execution.executionId);
    await rm(file);
    try {
      await symlink(target, file);
    } catch {
      return;
    }
    await expectAsyncCode(
      () =>
        openSelectionExecution({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 4,
          executionId: first.execution.executionId
        }),
      "UNSAFE_SELECTION_EXECUTION"
    );
  });

  it("contends safely when another invocation holds the execution lock", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openSelectionExecution({ stateDirectory, manifest, aggregateMaxCredits: 4 });
    await expectAsyncCode(
      () => openSelectionExecution({ stateDirectory, manifest, aggregateMaxCredits: 4 }),
      "SELECTION_EXECUTION_LOCKED"
    );
    await first.lock.release();
  });

  it("writes execution files as mode 0600 regular files on unix", async () => {
    if (process.platform === "win32") return;
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const opened = await openSelectionExecution({ stateDirectory, manifest, aggregateMaxCredits: 4 });
    const file = executionDocumentPath(opened.paths, opened.execution.executionId);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(opened.paths.root)).mode & 0o777).toBe(0o700);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(raw["documentKind"]).toBe(SELECTION_EXECUTION_DOCUMENT_KIND);
    expect(JSON.stringify(raw)).not.toMatch(/token|api[_-]?key|authorization/i);
    await opened.lock.release();
  });

  it("writes a single interrupted checkpoint then aborts without claiming completion", () => {
    const manifest = twoShardManifest();
    let execution = markShardQuoted(initialExecution(manifest, 4), "shard-000", {
      quoteId: "quote-int",
      quotedUnits: 2
    });
    execution = interruptExecution(execution);
    expect(execution.state).toBe("interrupted");
    expect(execution.terminalReason).toBeNull();
    expect(execution.shards[0]?.state).toBe("quoted");
    const resumed = resumeExecution(execution);
    expect(resumed.state).toBe("running");
    expect(resumed.terminalReason).toBeNull();
  });

  it("checkpoints once on SIGINT/SIGTERM and exits on the second signal", () => {
    const listeners = new Map<string, () => void>();
    let exited: number | undefined;
    const host = {
      on(event: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.set(event, listener);
      },
      off(event: "SIGINT" | "SIGTERM") {
        listeners.delete(event);
      },
      exit(code: number): never {
        exited = code;
        throw new Error(`exit ${code}`);
      }
    };
    const abort = new AbortController();
    let checkpoints = 0;
    const remove = installSelectionExecutionInterruptHandler({
      host,
      stderr: { write: () => true },
      abort,
      checkpoint: async () => {
        checkpoints += 1;
      },
      resumeCommand: "augmentworks test --all-shards --execution-id 11111111-1111-4111-8111-111111111111 --max-credits 4"
    });
    listeners.get("SIGINT")?.();
    expect(checkpoints).toBe(1);
    expect(abort.signal.aborted).toBe(true);
    expect(() => listeners.get("SIGINT")?.()).toThrow(/exit 130/);
    expect(exited).toBe(EXIT.INTERRUPTED);
    remove();
  });
});

describe("selection execution CLI", () => {
  it("documents resume versus new rerun on test --help", async () => {
    const { runSourceCli } = await import("../util/cli-process.js");
    const testHelp = await runSourceCli(["test", "--help"], { cwd: projectRoot });
    expect(testHelp.stdout).toContain("--execution-id");
    expect(testHelp.stdout).toContain("resume");
    expect(testHelp.stdout).toMatch(/new\s+execution/);
  });

  it("rejects --execution-id without --all-shards before network work", async () => {
    const test = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();
    await expect(
      test.parseAsync(
        [
          "node",
          "augmentworks",
          "--manifest",
          "suite-selection.manifest.json",
          "--execution-id",
          "11111111-1111-4111-8111-111111111111",
          "--max-credits",
          "4",
          "--yes"
        ],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "EXECUTION_ID_REQUIRES_ALL_SHARDS" });
  });

  it("refuses resume without --execution-id before authenticate or quote", async () => {
    const cwd = await stateDir();
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    const opened = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      manifestPath: "suite-selection.manifest.json"
    });
    await opened.lock.release();
    let authenticated = false;
    await expect(
      runTest(
        {
          manifest: "suite-selection.manifest.json",
          allShards: true,
          maxCredits: "20",
          yes: true,
          cwd,
          stateDirectory,
          handleSignals: false,
          env: { CI: "1" }
        },
        {
          doctor: doctorFor(),
          accessToken: async () => {
            authenticated = true;
            return "token";
          },
          identity: async () => {
            authenticated = true;
            return {
              subject: "user-1",
              workspaceId: "workspace-1",
              connectorId: "connector-1",
              scopes: ["connector:identity", "connector:run"]
            };
          },
          cloud: () => {
            authenticated = true;
            throw new Error("cloud must not initialize");
          },
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      )
    ).rejects.toMatchObject({ code: "SELECTION_RESUME_REQUIRED" });
    expect(authenticated).toBe(false);
  });

  it("does not read an API key for doctor --offline or resume-required local refusal", async () => {
    const cwd = await stateDir();
    const { runSourceCli } = await import("../util/cli-process.js");
    const doctor = await runSourceCli(["doctor", "--offline", "--json"], {
      cwd,
      env: {
        AUGMENTWORKS_API_KEY: "",
        AUGMENTWORKS_TOKEN: "",
        CI: "1"
      }
    });
    expect(doctor.stdout).not.toContain("sk-");
  });
});

describe("execution helpers", () => {
  it("rejects a non-uuid execution id", () => {
    try {
      parseExecutionId("../secret");
      throw new Error("expected EXECUTION_ID_INVALID");
    } catch (error) {
      expectCode(error, "EXECUTION_ID_INVALID");
    }
    expect(formatSelectionResumeCommand({
      executionId: "11111111-1111-4111-8111-111111111111",
      maxCredits: 20,
      manifestPath: "./suite-selection.manifest.json",
      yes: true
    })).toContain("--all-shards --execution-id");
  });

  it("resumes interrupt-before-quote through observation checkpoints", () => {
    const manifest = twoShardManifest();
    let execution = initialExecution(manifest, 20);
    expect(nextRunnableShard(execution)?.state).toBe("pending");
    execution = markShardQuoted(execution, "shard-000", { quoteId: randomUUID(), quotedUnits: 3 });
    expect(nextRunnableShard(execution)?.state).toBe("quoted");
    execution = markShardAdmitted(execution, "shard-000", { runId: "run-obs" });
    expect(nextRunnableShard(execution)?.state).toBe("admitted");
    execution = resumeExecution(interruptExecution(execution));
    expect(execution.state).toBe("running");
    expect(execution.terminalReason).toBeNull();
    expect(nextRunnableShard(execution)?.runId).toBe("run-obs");
  });
});
