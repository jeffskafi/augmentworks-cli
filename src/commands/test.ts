import { resolve } from "node:path";

import { Command } from "commander";

import type { AccessTokenProvider, AuthIdentity } from "../auth/types.js";
import { CloudClient } from "../cloud/client.js";
import {
  RELAY_PROTOCOL_VERSION,
  type CreateRunRequest,
  type CreateRunResponse,
  type RunStatusResponse
} from "../cloud/protocol.js";
import type { ResolvedConfig } from "../config/types.js";
import { targetBoundarySha256 } from "../config/boundary.js";
import { HttpConnector } from "../connector/http.js";
import { AwError, EXIT, sanitizeTerminal } from "../errors.js";
import {
  prepareCreateAttempt,
  releaseTerminalIfSafe,
  settleCreateFailure,
  type RecoveryContext
} from "../relay/recovery.js";
import {
  RunIntentStore,
  type CreateRunIntentRequest,
  type RunIntent
} from "../relay/run-intent.js";
import { RelayRunner, type RelayProgressEvent } from "../relay/runner.js";
import { getStateDirectory } from "../relay/state-dir.js";
import { assertAllowedBrowserUrl, openBrowserUrl, type BrowserOpener } from "../system/browser.js";
import { HOSTED_TEST_KEEP_TERMINAL } from "../release.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies
} from "./hosted-auth.js";
import {
  formatLocalTestHuman,
  formatLocalTestJson,
  localExitCode,
  runLocalTest,
  type LocalTestDependencies
} from "./local-test.js";

export interface TestOptions {
  readonly config?: string;
  readonly packet: string;
  readonly open?: boolean;
  readonly json?: boolean;
  readonly allowFileCredentials?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDirectory?: string;
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
}

export interface TestResult {
  readonly binding: CreateRunResponse;
  readonly run: RunStatusResponse;
}

export interface SignalHost {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
  exit(code: number): never;
}

export interface TestDependencies extends HostedAuthDependencies {
  readonly doctor?: (options: Parameters<typeof runDoctor>[0]) => Promise<DoctorReport>;
  readonly connector?: (config: ResolvedConfig) => HttpConnector;
  readonly runner?: (options: ConstructorParameters<typeof RelayRunner>[0]) => RelayRunner;
  readonly intentStore?: (
    options: ConstructorParameters<typeof RunIntentStore>[0]
  ) => RunIntentStore;
  readonly openBrowser?: BrowserOpener;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly signals?: SignalHost;
  readonly setExitCode?: (code: number) => void;
  readonly onProgress?: (event: RelayProgressEvent) => void;
  readonly local?: LocalTestDependencies;
}

export async function runTest(
  options: TestOptions,
  dependencies: TestDependencies = {}
): Promise<TestResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const config = options.config ?? "augmentworks.yaml";
  const doctor = dependencies.doctor ?? runDoctor;
  const report = await doctor({ config, cwd, processEnv: env, offline: true });
  if (!report.ok || report.resolvedConfig === undefined) {
    const error = report.diagnostics.find((diagnostic) => diagnostic.level === "error");
    throw new AwError({
      code: error?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: error?.message ?? "Doctor found configuration errors."
    });
  }

  const packet = parsePacketReference(options.packet);
  const session = await authenticateHostedSession(options, dependencies);
  const observationKeys = report.resolvedConfig.capabilities.observation
    ? [...new Set(report.resolvedConfig.config.telemetry?.allow_observations ?? [])].sort()
    : [];
  const request: CreateRunIntentRequest = {
    protocol_version: RELAY_PROTOCOL_VERSION,
    packet,
    config_sha256: report.resolvedConfig.configDigest,
    target: {
      name: report.resolvedConfig.config.target.name,
      boundary_sha256: targetBoundarySha256(report.resolvedConfig),
      capabilities: {
        prepare: report.resolvedConfig.capabilities.prepare,
        observation: report.resolvedConfig.capabilities.observation,
        cleanup: report.resolvedConfig.capabilities.cleanup,
        tool_events: report.resolvedConfig.capabilities.tool_events,
        observation_keys: observationKeys
      }
    }
  };
  const stateDirectory = options.stateDirectory ?? getStateDirectory(env);
  const intentStore =
    dependencies.intentStore?.({
      apiOrigin: session.apiOrigin,
      tenant: session.tenant,
      stateDirectory,
      env
    }) ??
    new RunIntentStore({
      apiOrigin: session.apiOrigin,
      tenant: session.tenant,
      stateDirectory,
      env
    });
  await intentStore.open();
  try {
    await intentStore.migrateLegacyTenantBinding(async (legacyBinding) => {
      const status = await session.cloud.getRunStatus(legacyBinding.run_id, options.signal);
      return status.run_id === legacyBinding.run_id;
    });
    const recovery: RecoveryContext = {
      cloud: session.cloud,
      intentStore,
      tenant: session.tenant,
      stateDirectory,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    };
    const prepared = await prepareCreateAttempt(recovery, request);
    let binding: CreateRunResponse;
    if (prepared.kind === "resume_bound") {
      binding = prepared.binding;
    } else {
      const loaded =
        prepared.kind === "replay_pending"
          ? { intent: prepared.intent, resumed: true }
          : await intentStore.loadOrCreate(request);
      binding = await createOrRecover(recovery, loaded.intent, options.signal);
    }
    assertRunBinding(binding, intentStore.intent?.request ?? { ...request, create_request_id: binding.create_request_id });
    if (intentStore.intent?.phase !== "bound") {
      await intentStore.bind(binding);
    }

    const dashboard = dashboardUrl(binding.dashboard_url, session.apiOrigin);
    const stderr = dependencies.stderr ?? process.stderr;
    writeLine(
      stderr,
      `${prepared.kind === "resume_bound" || prepared.kind === "replay_pending" ? "Resuming" : "Run"} ${sanitizeTerminal(binding.run_id)}: ${sanitizeTerminal(dashboard.toString())}`
    );
    writeLine(stderr, HOSTED_TEST_KEEP_TERMINAL);
    if (options.open === true) {
      try {
        await (dependencies.openBrowser ?? ((url) => openBrowserUrl(url, [session.apiOrigin.origin])))(
          dashboard
        );
      } catch (error) {
        if (!(error instanceof AwError) || error.code !== "BROWSER_OPEN_FAILED") throw error;
        writeLine(stderr, "The dashboard could not be opened automatically; use the URL above.");
      }
    }

    if (isTerminal(binding.status)) {
      const run = await session.cloud.getRunStatus(binding.run_id, options.signal);
      await releaseTerminalIfSafe(recovery, binding, run);
      return { binding, run };
    }

    const connector =
      dependencies.connector?.(report.resolvedConfig) ?? new HttpConnector(report.resolvedConfig);
    const progress =
      dependencies.onProgress ??
      (options.json === true
        ? undefined
        : (event: RelayProgressEvent) => writeProgress(stderr, event));
    const runnerOptions: ConstructorParameters<typeof RelayRunner>[0] = {
      cloud: session.cloud,
      connector,
      binding,
      stateDirectory,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(progress === undefined ? {} : { onProgress: progress })
    };
    const runner = dependencies.runner?.(runnerOptions) ?? new RelayRunner(runnerOptions);
    const removeSignals =
      options.handleSignals === false
        ? () => undefined
        : installRelayInterruptHandler(runner, {
            host: dependencies.signals ?? (process as SignalHost),
            stderr
          });
    try {
      const run = await runner.run();
      await releaseTerminalIfSafe(recovery, binding, run);
      return { binding, run };
    } finally {
      removeSignals();
    }
  } finally {
    await intentStore.close();
  }
}

async function createOrRecover(
  recovery: RecoveryContext,
  intent: RunIntent,
  signal?: AbortSignal
): Promise<CreateRunResponse> {
  try {
    return await recovery.cloud.createRun(intent.request, signal);
  } catch (error) {
    return await settleCreateFailure(recovery, intent, error);
  }
}

export function createTestCommand(dependencies: TestDependencies = {}): Command {
  return new Command("test")
    .description("Run a deterministic hosted or customer-executed local assessment")
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .requiredOption(
      "--packet <reference>",
      "hosted key@version, or a bundled/local JSON packet with --local"
    )
    .option("--local", "run entirely in the customer environment without AugmentWorks services")
    .option("--output-dir <path>", "fresh exact report directory for --local")
    .option("--open", "open the hosted dashboard or generated local HTML report")
    .option("--json", "emit the final run status as JSON")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(
      async (values: {
        config: string;
        packet: string;
        local?: boolean;
        outputDir?: string;
        open?: boolean;
        json?: boolean;
        allowFileCredentials?: boolean;
      }) => {
        const stdout = dependencies.stdout ?? process.stdout;
        const stderr = dependencies.stderr ?? process.stderr;
        const setExitCode =
          dependencies.setExitCode ??
          ((code: number) => {
            process.exitCode = code;
          });
        if (values.local === true) {
          if (values.allowFileCredentials === true) {
            throw new AwError({
              code: "LOCAL_FILE_CREDENTIALS_UNSUPPORTED",
              category: "config",
              message:
                "--allow-file-credentials applies only to hosted AugmentWorks authentication and cannot be used with --local."
            });
          }
          const local = await runLocalTest(
            {
              config: values.config,
              packet: values.packet,
              ...(values.outputDir === undefined ? {} : { outputDirectory: values.outputDir }),
              ...(values.open === undefined ? {} : { open: values.open }),
              ...(values.json === undefined ? {} : { json: values.json })
            },
            {
              ...dependencies.local,
              stdout,
              stderr
            }
          );
          stdout.write(values.json === true ? formatLocalTestJson(local) : formatLocalTestHuman(local));
          const exitCode = localExitCode(local);
          if (exitCode !== EXIT.OK) setExitCode(exitCode);
          return;
        }
        if (values.outputDir !== undefined) {
          throw new AwError({
            code: "LOCAL_OUTPUT_REQUIRES_LOCAL_MODE",
            category: "config",
            message: "--output-dir can be used only with --local."
          });
        }
        const result = await runTest(
          {
            config: values.config,
            packet: values.packet,
            ...(values.open === undefined ? {} : { open: values.open }),
            ...(values.json === undefined ? {} : { json: values.json }),
            ...(values.allowFileCredentials === undefined
              ? {}
              : { allowFileCredentials: values.allowFileCredentials })
          },
          dependencies
        );
        if (values.json === true) {
          stdout.write(
            `${JSON.stringify({
              run_id: result.run.run_id,
              status: result.run.status,
              credit_state: result.run.credit_state,
              outcome: result.run.outcome ?? null,
              dashboard_url: result.binding.dashboard_url
            })}\n`
          );
        } else {
          writeLine(
            stdout,
            `Assessment ${sanitizeTerminal(result.run.status)}${
              result.run.outcome == null ? "" : ` (${sanitizeTerminal(result.run.outcome)})`
            }.`
          );
        }
        if (result.run.status === "cancelled") setExitCode(EXIT.INTERRUPTED);
        else if (
          result.run.status === "failed" ||
          (result.run.outcome != null && result.run.outcome !== "passed")
        ) {
          setExitCode(EXIT.ASSESSMENT_FAILED);
        }
      }
    );
}

export function installRelayInterruptHandler(
  runner: Pick<RelayRunner, "requestCancellation">,
  options: { host: SignalHost; stderr: Pick<NodeJS.WriteStream, "write"> }
): () => void {
  let count = 0;
  const listener = () => {
    count += 1;
    if (count >= 2) options.host.exit(EXIT.INTERRUPTED);
    writeLine(
      options.stderr,
      "Cancellation requested; draining cleanup. Press Ctrl+C again to exit now."
    );
    void runner.requestCancellation("sigint").catch((error: unknown) => {
      const message =
        error instanceof AwError ? error.message : "Could not send cancellation to AugmentWorks.";
      writeLine(options.stderr, message);
    });
  };
  options.host.on("SIGINT", listener);
  return () => {
    options.host.off("SIGINT", listener);
  };
}

export function parsePacketReference(value: string): {
  key: string;
  version: string;
} {
  const match =
    /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,159})@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(
      value.trim()
    );
  if (match?.[1] === undefined || match?.[2] === undefined) {
    throw new AwError({
      code: "INVALID_PACKET_REFERENCE",
      category: "config",
      message: "Packet must use the form key@version, for example support-refunds@0.1.0."
    });
  }
  return { key: match[1], version: match[2] };
}

function assertRunBinding(binding: CreateRunResponse, request: CreateRunRequest): void {
  if (
    binding.create_request_id !== request.create_request_id ||
    binding.packet.key !== request.packet.key ||
    binding.packet.version !== request.packet.version ||
    binding.config_sha256 !== request.config_sha256
  ) {
    throw new AwError({
      code: "RUN_BINDING_MISMATCH",
      category: "protocol",
      message: "AugmentWorks created a run with a different packet or configuration binding."
    });
  }
}

function isTerminal(status: CreateRunResponse["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function dashboardUrl(value: string, apiOrigin: URL): URL {
  const url = new URL(value);
  assertAllowedBrowserUrl(url, [apiOrigin.origin]);
  if (url.search !== "" || url.hash !== "") {
    throw new AwError({
      code: "UNSAFE_DASHBOARD_URL",
      category: "protocol",
      message: "The dashboard URL cannot contain a query string or fragment."
    });
  }
  return url;
}

function writeProgress(stream: Pick<NodeJS.WriteStream, "write">, event: RelayProgressEvent): void {
  if (event.type === "operation_started") {
    writeLine(stream, `→ ${event.kind} (${event.sequence})`);
  } else if (event.type === "operation_completed") {
    writeLine(stream, `✓ ${event.kind}${event.replayed ? " (replayed safely)" : ""}`);
  } else if (event.type === "operation_failed") {
    writeLine(stream, `✗ ${event.kind}: ${sanitizeTerminal(event.code)}`);
  }
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, value: string): void {
  stream.write(`${sanitizeTerminal(value)}\n`);
}

export type { AccessTokenProvider, AuthIdentity };
