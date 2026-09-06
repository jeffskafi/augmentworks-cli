import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  localExitCode,
  runLocalTest,
  type LocalSignalHost,
  type LocalTestDependencies,
  type LocalTestResult
} from "../commands/local-test.js";
import { AwError, EXIT } from "../errors.js";
import { openLocalReport } from "../local/open-report.js";
import { isolatedDemoEnv } from "./env.js";
import { loadDemoAssets, readDemoConfigTemplate, type DemoAssets } from "./resources.js";
import { buildDemoSummary, inspectFailedAssertion } from "./summary.js";
import { startDemoTarget, type DemoTarget } from "./target.js";
import {
  DEMO_DISCLAIMER,
  type DemoCommandOptions,
  type DemoCommandResult,
  type DemoMode,
  type DemoPolicy,
  type DemoRunRecord
} from "./types.js";

const DEFAULT_DEMO_TIMEOUT_MS = 120_000;
const DEFAULT_RUN_DEADLINE_MS = 60_000;

export interface DemoOrchestratorDependencies {
  readonly loadAssets?: (packageRoot?: string) => Promise<DemoAssets>;
  readonly startTarget?: typeof startDemoTarget;
  readonly runLocalTest?: typeof runLocalTest;
  readonly openReport?: typeof openLocalReport;
  readonly local?: LocalTestDependencies;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly signals?: LocalSignalHost;
  readonly randomId?: () => string;
  readonly randomToken?: () => string;
}

export interface DemoOrchestratorOptions extends DemoCommandOptions {
  readonly policies?: { readonly faulty: DemoPolicy; readonly corrected: DemoPolicy };
  readonly cleanupMode?: "ok" | "fail";
  readonly packageRoot?: string;
}

export async function runDemo(
  options: DemoOrchestratorOptions = {},
  dependencies: DemoOrchestratorDependencies = {}
): Promise<DemoCommandResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const mode: DemoMode = options.mode ?? "full";
  const stderr = dependencies.stderr ?? process.stderr;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEMO_TIMEOUT_MS;
  const runDeadlineMs = options.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  const controller = new AbortController();
  if (options.signal?.aborted === true) controller.abort(options.signal.reason);
  else {
    options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), {
      once: true
    });
  }

  const timeout = setTimeout(() => {
    controller.abort(
      new AwError({
        code: "DEMO_TIMEOUT",
        category: "target",
        message: `The packaged demo exceeded its ${String(timeoutMs)} ms bound.`
      })
    );
  }, timeoutMs);
  timeout.unref?.();

  const removeSignals =
    options.handleSignals === false
      ? () => undefined
      : installDemoInterruptHandler(controller, {
          host: dependencies.signals ?? (process as LocalSignalHost),
          stderr
        });

  const demoId = (dependencies.randomId ?? defaultDemoId)();
  const outputRoot = resolve(cwd, options.outputDirectory ?? join(".augmentworks", "demo", demoId));
  let workspace: string | undefined;
  let target: DemoTarget | undefined;
  const records: DemoRunRecord[] = [];
  let runError: unknown;
  let listenerCleanupError: AwError | undefined;
  let interrupted = false;

  try {
    writeLine(stderr, "Starting packaged synthetic refund demo.");
    writeLine(stderr, DEMO_DISCLAIMER);
    await createFreshDirectory(outputRoot);
    const assets = await (dependencies.loadAssets ?? loadDemoAssets)(options.packageRoot);
    workspace = await mkdtemp(join(tmpdir(), "augmentworks-demo-"));
    await writeFile(
      join(workspace, "augmentworks.yaml"),
      await readDemoConfigTemplate(assets.configPath),
      "utf8"
    );

    const token = (dependencies.randomToken ?? defaultToken)();
    const startPromise = (dependencies.startTarget ?? startDemoTarget)({
      token,
      policy: options.policies?.faulty ?? "ignore-limit",
      signal: controller.signal,
      ...(options.cleanupMode === undefined ? {} : { cleanupMode: options.cleanupMode })
    });
    try {
      target = await awaitWithAbort(controller.signal, startPromise);
    } catch (error) {
      void startPromise.then((started) => started.close(), () => undefined);
      throw error;
    }
    writeLine(stderr, `Loopback target listening on ${target.baseUrl}`);

    const env = isolatedDemoEnv({
      baseUrl: target.baseUrl,
      token,
      ...(options.env === undefined ? {} : { parent: options.env })
    });

    if (mode === "full" || mode === "faulty") {
      writeLine(stderr, "Running faulty implementation (policy maximum not enforced).");
      const faulty = await runRole({
        role: "faulty",
        policy: target.policy,
        expectedOutcome: "failed",
        outputDirectory: join(outputRoot, "failing"),
        workspace,
        packetPath: assets.packetPath,
        env,
        signal: controller.signal,
        runDeadlineMs,
        dependencies
      });
      records.push(faulty);
      writeLine(
        stderr,
        `Faulty run ${faulty.outcome} (exit ${String(faulty.exitCode)}). Reports: ${faulty.artifacts.directory}`
      );
      if (faulty.result.attempts.some((attempt) => attempt.cleanup_status === "failed")) {
        throw new AwError({
          code: "DEMO_CLEANUP_FAILED",
          category: "cleanup",
          message:
            "Synthetic cleanup failed during the faulty demo run. No subsequent synthetic attempts were started."
        });
      }
      if (faulty.exitCode === EXIT.INTERRUPTED || controller.signal.aborted) interrupted = true;
    }

    if (!interrupted && !controller.signal.aborted && (mode === "full" || mode === "corrected")) {
      target.setPolicy(options.policies?.corrected ?? "enforce-limit");
      writeLine(stderr, "Running corrected implementation (policy maximum enforced).");
      const corrected = await runRole({
        role: "corrected",
        policy: target.policy,
        expectedOutcome: "passed",
        outputDirectory: join(outputRoot, "passing"),
        workspace,
        packetPath: assets.packetPath,
        env,
        signal: controller.signal,
        runDeadlineMs,
        dependencies
      });
      records.push(corrected);
      writeLine(
        stderr,
        `Corrected run ${corrected.outcome} (exit ${String(corrected.exitCode)}). Reports: ${corrected.artifacts.directory}`
      );
      if (corrected.result.attempts.some((attempt) => attempt.cleanup_status === "failed")) {
        throw new AwError({
          code: "DEMO_CLEANUP_FAILED",
          category: "cleanup",
          message: "Synthetic cleanup failed during the corrected demo run."
        });
      }
      if (corrected.exitCode === EXIT.INTERRUPTED) interrupted = true;
    }

    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof AwError && reason.code === "DEMO_TIMEOUT") throw reason;
      interrupted = true;
    }

    if (options.open === true) {
      const toOpen = [...records].reverse()[0];
      if (toOpen !== undefined) {
        try {
          await (dependencies.openReport ?? openLocalReport)(toOpen.artifacts.html);
        } catch (error) {
          if (!(error instanceof AwError) || error.code !== "LOCAL_REPORT_OPEN_FAILED") throw error;
          writeLine(stderr, "The demo HTML report could not be opened automatically; use the path below.");
        }
      }
    }
  } catch (error) {
    runError = error;
  } finally {
    clearTimeout(timeout);
    removeSignals();
    if (target !== undefined) {
      try {
        await target.close();
      } catch (error) {
        listenerCleanupError =
          error instanceof AwError
            ? error
            : new AwError({
                code: "DEMO_CLEANUP_FAILED",
                category: "cleanup",
                message: "The demo target listener could not be closed.",
                cause: error
              });
      }
    }
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const cleanupError =
    runError instanceof AwError && runError.category === "cleanup"
      ? runError
      : listenerCleanupError;
  const timeoutError =
    runError instanceof AwError && runError.code === "DEMO_TIMEOUT" ? runError : undefined;
  const interruptedError =
    interrupted || (runError instanceof AwError && runError.code === "INTERRUPTED");

  if (timeoutError !== undefined && records.length === 0) throw timeoutError;
  if (
    runError instanceof AwError &&
    records.length === 0 &&
    cleanupError === undefined &&
    runError.code !== "INTERRUPTED"
  ) {
    throw runError;
  }
  if (runError !== undefined && !(runError instanceof AwError) && records.length === 0) {
    throw runError;
  }

  const { summary, exitCode } = finalizeDemo({
    mode,
    records,
    cleanupOk: cleanupError === undefined,
    cleanupError: cleanupError?.message ?? null,
    interrupted: interruptedError
  });

  if (timeoutError !== undefined && !summary.ok) {
    return { summary, exitCode: Math.max(exitCode, EXIT.TARGET), records };
  }
  if (cleanupError !== undefined) {
    return { summary, exitCode: EXIT.CLEANUP, records };
  }
  if (runError instanceof AwError && !summary.ok && records.length > 0) {
    return { summary, exitCode, records };
  }
  if (runError instanceof AwError) throw runError;
  if (runError !== undefined) throw runError;
  return { summary, exitCode, records };
}

async function runRole(options: {
  readonly role: "faulty" | "corrected";
  readonly policy: DemoPolicy;
  readonly expectedOutcome: "failed" | "passed";
  readonly outputDirectory: string;
  readonly workspace: string;
  readonly packetPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly runDeadlineMs: number;
  readonly dependencies: DemoOrchestratorDependencies;
}): Promise<DemoRunRecord> {
  const completed: LocalTestResult = await (options.dependencies.runLocalTest ?? runLocalTest)(
    {
      config: "augmentworks.yaml",
      packet: options.packetPath,
      outputDirectory: options.outputDirectory,
      cwd: options.workspace,
      env: options.env,
      json: true,
      handleSignals: false,
      signal: options.signal,
      runDeadlineMs: options.runDeadlineMs
    },
    options.dependencies.local ?? {}
  );
  return {
    role: options.role,
    policy: options.policy,
    expectedOutcome: options.expectedOutcome,
    outcome: completed.result.outcome,
    exitCode: localExitCode(completed),
    artifacts: completed.artifacts,
    result: completed.result
  };
}

function finalizeDemo(options: {
  readonly mode: DemoMode;
  readonly records: readonly DemoRunRecord[];
  readonly cleanupOk: boolean;
  readonly cleanupError: string | null;
  readonly interrupted: boolean;
}): { summary: ReturnType<typeof buildDemoSummary>; exitCode: number } {
  const faulty = options.records.find((record) => record.role === "faulty");
  const corrected = options.records.find((record) => record.role === "corrected");
  const reportsPresent =
    options.records.length > 0 &&
    options.records.every(
      (record) =>
        record.artifacts.json !== "" && record.artifacts.junit !== "" && record.artifacts.html !== ""
    );
  let contractOk = false;
  if (options.cleanupOk && reportsPresent && !options.interrupted) {
    if (options.mode === "full") {
      contractOk = faulty !== undefined && isExpectedFaulty(faulty) && corrected !== undefined && isExpectedCorrected(corrected);
    } else if (options.mode === "faulty") {
      contractOk = faulty !== undefined && isExpectedFaulty(faulty);
    } else {
      contractOk = corrected !== undefined && isExpectedCorrected(corrected);
    }
  }
  const summary = buildDemoSummary({
    ok: contractOk,
    mode: options.mode,
    records: options.records,
    cleanupOk: options.cleanupOk,
    cleanupError: options.cleanupError
  });
  return { summary, exitCode: demoExitCode({ ...options, contractOk, faulty, corrected }) };
}

function demoExitCode(options: {
  readonly mode: DemoMode;
  readonly contractOk: boolean;
  readonly cleanupOk: boolean;
  readonly interrupted: boolean;
  readonly faulty: DemoRunRecord | undefined;
  readonly corrected: DemoRunRecord | undefined;
}): number {
  if (options.interrupted) return EXIT.INTERRUPTED;
  if (!options.cleanupOk) return EXIT.CLEANUP;
  const underlying = [options.faulty, options.corrected]
    .filter((record): record is DemoRunRecord => record !== undefined)
    .map((record) => record.exitCode);
  if (underlying.includes(EXIT.CLEANUP)) return EXIT.CLEANUP;
  if (underlying.includes(EXIT.TARGET)) return EXIT.TARGET;
  if (underlying.includes(EXIT.CONFIG)) return EXIT.CONFIG;
  if (options.mode === "full") {
    if (options.contractOk) return EXIT.OK;
    if (options.faulty !== undefined && !isExpectedFaulty(options.faulty)) {
      return options.faulty.exitCode === EXIT.OK ? EXIT.INTERNAL : options.faulty.exitCode;
    }
    if (options.corrected !== undefined && !isExpectedCorrected(options.corrected)) {
      return options.corrected.exitCode === EXIT.OK ? EXIT.INTERNAL : options.corrected.exitCode;
    }
    return EXIT.INTERNAL;
  }
  if (options.mode === "faulty") return options.faulty?.exitCode ?? EXIT.INTERNAL;
  return options.corrected?.exitCode ?? EXIT.INTERNAL;
}

export function isExpectedFaulty(record: DemoRunRecord): boolean {
  const assertion = inspectFailedAssertion(record.result);
  return (
    record.expectedOutcome === "failed" &&
    record.outcome === "failed" &&
    record.exitCode === EXIT.ASSESSMENT_FAILED &&
    record.result.attempts.every((attempt) => attempt.cleanup_status !== "failed") &&
    assertion !== undefined &&
    assertion.passed === false
  );
}

export function isExpectedCorrected(record: DemoRunRecord): boolean {
  return (
    record.expectedOutcome === "passed" &&
    record.outcome === "passed" &&
    record.exitCode === EXIT.OK &&
    record.result.attempts.every((attempt) => attempt.cleanup_status !== "failed")
  );
}

function installDemoInterruptHandler(
  controller: AbortController,
  options: { host: LocalSignalHost; stderr: Pick<NodeJS.WriteStream, "write"> }
): () => void {
  let count = 0;
  const listener = (): void => {
    count += 1;
    if (count >= 2) options.host.exit(EXIT.INTERRUPTED);
    writeLine(
      options.stderr,
      "Cancellation requested; draining synthetic cleanup and closing the demo listener. Press Ctrl+C again to exit now."
    );
    controller.abort(
      new AwError({
        code: "INTERRUPTED",
        category: "local",
        message: "The packaged demo was interrupted."
      })
    );
  };
  options.host.on("SIGINT", listener);
  return () => options.host.off("SIGINT", listener);
}

async function createFreshDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path, { recursive: false, mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AwError({
        code: "LOCAL_OUTPUT_EXISTS",
        category: "config",
        message: "The demo output directory already exists; refusing to overwrite it."
      });
    }
    throw new AwError({
      code: "DEMO_OUTPUT_CREATE_FAILED",
      category: "local",
      message: "Could not create the demo output directory.",
      cause
    });
  }
}

function defaultDemoId(): string {
  return `demo_${randomUUID().replaceAll("-", "")}`;
}

function defaultToken(): string {
  return `aw_demo_${randomBytes(16).toString("hex")}`;
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(`${message}\n`);
}

async function awaitWithAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) throw abortReason(signal.reason);
  return await new Promise<T>((fulfill, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        fulfill(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function abortReason(reason: unknown): AwError {
  if (reason instanceof AwError) return reason;
  return new AwError({
    code: "INTERRUPTED",
    category: "local",
    message: "The packaged demo was interrupted."
  });
}

export function demoModeFrom(value: string | undefined): DemoMode {
  if (value === undefined || value === "full" || value === "faulty" || value === "corrected") {
    return value ?? "full";
  }
  throw new AwError({
    code: "DEMO_MODE_INVALID",
    category: "config",
    message: "Demo mode must be full, faulty, or corrected."
  });
}
