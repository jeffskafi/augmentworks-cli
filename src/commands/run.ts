import { Command } from "commander";

import { AwError, EXIT, exitCodeFor, sanitizeTerminal } from "../errors.js";
import {
  formatRunStatusHuman,
  retryEvaluationSuccessJson,
  runStatusSuccessJson
} from "../billing/format.js";
import { classifyBillingRunStatus } from "../billing/classify.js";
import type { BillingRunStatus } from "../billing/protocol.js";
import { assertStatusCapability, assertStatusWorkspace } from "../billing/validate.js";
import { statusUnsupportedError } from "../billing/errors.js";
import { STATUS_V1 } from "../billing/protocol.js";
import { capabilityIsAvailable } from "../billing/protocol.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies,
  type HostedAuthOptions,
  type HostedAuthSession
} from "./hosted-auth.js";

const RUN_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/;
const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const MAX_POLLS = 120;

export interface RunCommandOptions extends HostedAuthOptions {
  readonly json?: boolean;
  readonly timeoutMs?: string;
}

export interface RunCommandDependencies extends HostedAuthDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly setExitCode?: (code: number) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function createRunCommand(dependencies: RunCommandDependencies = {}): Command {
  const run = new Command("run").description(
    "Inspect or wait on an original hosted run without creating another test"
  );
  run
    .command("status")
    .description("Show target-execution and grading status for an original run")
    .argument("<run-id>", "original run ID")
    .option("--json", "write one machine-readable status object to stdout")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(async (runId: string, values: RunCommandOptions) => {
      await executeRunSubcommand("status", runId, values, dependencies);
    });
  run
    .command("wait")
    .description("Wait for original-run target work and grading without calling the target")
    .argument("<run-id>", "original run ID")
    .option("--json", "write one machine-readable status object to stdout")
    .option("--timeout-ms <ms>", "maximum wait in milliseconds", String(DEFAULT_WAIT_MS))
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(async (runId: string, values: RunCommandOptions) => {
      await executeRunSubcommand("wait", runId, values, dependencies);
    });
  run
    .command("retry-evaluation")
    .description("Retry server-approved incomplete grading for an original run (no new test credit)")
    .argument("<run-id>", "original run ID")
    .option("--json", "write one machine-readable result object to stdout")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(async (runId: string, values: RunCommandOptions) => {
      await executeRunSubcommand("retry-evaluation", runId, values, dependencies);
    });
  return run;
}

async function executeRunSubcommand(
  action: "status" | "wait" | "retry-evaluation",
  runId: string,
  values: RunCommandOptions,
  dependencies: RunCommandDependencies
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const json = values.json === true;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  try {
    const id = parseRunId(runId);
    const session = await authenticateHostedSession(values, dependencies);
    await assertStatusAvailable(session, values.signal);
    if (action === "retry-evaluation") {
      const retried =
        values.signal === undefined
          ? await session.cloud.retryEvaluation(id)
          : await session.cloud.retryEvaluation(id, values.signal);
      if (retried.customer_units_debited !== 0 || retried.reused_target_evidence !== true) {
        throw new AwError({
          code: "INVALID_CLOUD_RESPONSE",
          category: "protocol",
          message: "AugmentWorks returned an invalid evaluation retry result."
        });
      }
      if (json) {
        stdout.write(
          retryEvaluationSuccessJson({
            protocolVersion: retried.protocol_version,
            runId: retried.run_id,
            evaluationId: retried.evaluation_id
          })
        );
      } else {
        stdout.write(
          `Grading retry requested for ${sanitizeTerminal(retried.run_id)}. Saved evidence was reused. Customer credits debited: 0.\n`
        );
      }
      return;
    }
    const status =
      action === "wait"
        ? await waitForRunStatus(session, id, values, dependencies)
        : await readRunStatus(session, id, values.signal);
    if (json) stdout.write(runStatusSuccessJson(status));
    else stdout.write(formatRunStatusHuman(status));
    const exitCode = billingStatusExitCode(status);
    if (exitCode !== EXIT.OK) setExitCode(exitCode);
  } catch (error) {
    if (!json) throw error;
    const awError =
      error instanceof AwError
        ? error
        : new AwError({
            code: "INTERNAL",
            category: "local",
            message: "The run command could not be completed."
          });
    stdout.write(
      `${JSON.stringify({
        ok: false,
        ...awError.toSafeJSON(),
        exit_code: exitCodeFor(awError)
      })}\n`
    );
    setExitCode(exitCodeFor(awError));
  }
}

async function assertStatusAvailable(session: HostedAuthSession, signal?: AbortSignal): Promise<void> {
  let capabilities;
  try {
    capabilities =
      signal === undefined
        ? await session.cloud.getBillingCapabilities()
        : await session.cloud.getBillingCapabilities(signal);
  } catch (error) {
    if (error instanceof AwError && error.code === "USAGE_UNSUPPORTED") {
      throw statusUnsupportedError(error.details);
    }
    throw error;
  }
  if (!capabilityIsAvailable(capabilities.capabilities, STATUS_V1)) {
    throw statusUnsupportedError();
  }
  assertStatusCapability(capabilities.capabilities);
}

async function readRunStatus(
  session: HostedAuthSession,
  runId: string,
  signal?: AbortSignal
): Promise<BillingRunStatus> {
  const status =
    signal === undefined
      ? await session.cloud.getBillingRunStatus(runId)
      : await session.cloud.getBillingRunStatus(runId, signal);
  assertStatusWorkspace(status, session.identity.workspaceId);
  return status;
}

async function waitForRunStatus(
  session: HostedAuthSession,
  runId: string,
  values: RunCommandOptions,
  dependencies: RunCommandDependencies
): Promise<BillingRunStatus> {
  const timeoutMs = parseTimeoutMs(values.timeoutMs);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? sleepWithSignal;
  const deadline = now() + timeoutMs;
  let delay = 1_000;
  let last: BillingRunStatus | undefined;
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    last = await readRunStatus(session, runId, values.signal);
    if (isWaitTerminal(last)) return last;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw waitIncompleteError(runId, last);
    }
    const jitter = Math.floor(delay * 0.2 * Math.random());
    await sleep(Math.min(delay + jitter, remaining), values.signal);
    delay = Math.min(delay * 2, 5_000);
  }
  throw waitIncompleteError(runId, last);
}

function waitIncompleteError(runId: string, status: BillingRunStatus | undefined): AwError {
  const gradingPending =
    status !== undefined &&
    (status.evaluationStatus === "pending" || status.evaluationStatus === "partial");
  const reason = gradingPending
    ? "Grading is still pending"
    : "The original run is still in progress";
  return new AwError({
    code: "EVALUATION_INCOMPLETE",
    category: "relay",
    message: `${reason} on original run ${runId}. Evidence remains saved. Retry: augmentworks run wait ${runId}`
  });
}

export function isWaitTerminal(status: BillingRunStatus): boolean {
  return classifyBillingRunStatus(status).waitTerminal;
}

export function billingStatusExitCode(status: BillingRunStatus): number {
  return classifyBillingRunStatus(status).exitCode;
}

function parseRunId(value: string): string {
  if (!RUN_ID.test(value)) {
    throw new AwError({
      code: "INVALID_RUN_ID",
      category: "config",
      message: "Run ID must be a bounded identifier without spaces."
    });
  }
  return value;
}

function parseTimeoutMs(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_WAIT_MS : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new AwError({
      code: "INVALID_TIMEOUT",
      category: "config",
      message: "--timeout-ms must be an integer between 1 and 3600000."
    });
  }
  return value;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The wait was cancelled.",
          retryable: true
        })
      );
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The wait was cancelled.",
          retryable: true
        })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
