import { resolve } from "node:path";

import { Command } from "commander";

import { CloudAuthClient } from "../auth/client.js";
import { getApiOrigin } from "../auth/api-origin.js";
import { createAccessTokenManager, resolveAccessToken } from "../auth/credential-store.js";
import type { AccessTokenProvider, AuthIdentity } from "../auth/types.js";
import { CloudClient } from "../cloud/client.js";
import {
  RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION_V2,
  type CreateRunRequest,
  type CreateRunResponse,
  type RunStatusResponse
} from "../cloud/protocol.js";
import type { ResolvedConfig } from "../config/types.js";
import { targetBoundarySha256 } from "../config/boundary.js";
import { HttpConnector } from "../connector/http.js";
import { AwError, EXIT, sanitizeTerminal } from "../errors.js";
import {
  loadAssessmentFile,
  primaryPacket
} from "../assessment/index.js";
import {
  RunIntentStore,
  type CreateRunIntentRequest,
  type RunIntentTenantBinding
} from "../relay/run-intent.js";
import { RelayRunner, type RelayProgressEvent } from "../relay/runner.js";
import { getStateDirectory } from "../relay/state-dir.js";
import { assertAllowedBrowserUrl, openBrowserUrl, type BrowserOpener } from "../system/browser.js";
import { HOSTED_TEST_KEEP_TERMINAL } from "../release.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  formatLocalTestHuman,
  formatLocalTestJson,
  localExitCode,
  runLocalTest,
  type LocalTestDependencies
} from "./local-test.js";

export interface TestOptions {
  readonly config?: string;
  readonly packet?: string;
  readonly assessment?: string;
  readonly profile?: string;
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

export interface TestDependencies {
  readonly doctor?: (options: Parameters<typeof runDoctor>[0]) => Promise<DoctorReport>;
  readonly apiOrigin?: (env: NodeJS.ProcessEnv) => URL;
  readonly accessToken?: (options: Parameters<typeof resolveAccessToken>[0]) => Promise<string>;
  readonly identity?: (options: {
    readonly apiOrigin: URL;
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }) => Promise<AuthIdentity>;
  readonly cloud?: (options: {
    apiOrigin: URL;
    accessToken: string;
    accessTokenProvider: AccessTokenProvider;
  }) => CloudClient;
  readonly connector?: (config: ResolvedConfig) => HttpConnector;
  readonly runner?: (options: ConstructorParameters<typeof RelayRunner>[0]) => RelayRunner;
  readonly intentStore?: (
    options: ConstructorParameters<typeof RunIntentStore>[0]
  ) => RunIntentStore;
  readonly openBrowser?: BrowserOpener;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
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

  const assessment =
    options.assessment === undefined
      ? undefined
      : await loadAssessmentFile({
          path: options.assessment,
          cwd,
          ...(options.profile === undefined ? {} : { profile: options.profile })
        });
  const packet =
    assessment === undefined
      ? parsePacketReference(requirePacket(options.packet))
      : {
          key: primaryPacket(assessment).key,
          version: primaryPacket(assessment).version
        };
  const protocolVersion =
    assessment === undefined ? RELAY_PROTOCOL_VERSION : RELAY_PROTOCOL_VERSION_V2;
  const apiOrigin = (dependencies.apiOrigin ?? getApiOrigin)(env);
  const accessTokenOptions = {
    apiOrigin,
    env,
    ...(options.allowFileCredentials === undefined
      ? {}
      : { allowFileFallback: options.allowFileCredentials }),
    onWarning: (message: string) => writeLine(dependencies.stderr ?? process.stderr, message)
  };
  const rawAccessTokenProvider: AccessTokenProvider =
    dependencies.accessToken === undefined
      ? (await createAccessTokenManager(accessTokenOptions)).getAccessToken
      : async (request = {}) =>
          await dependencies.accessToken!({
            ...accessTokenOptions,
            ...request
          });
  const authClient = new CloudAuthClient({ apiOrigin });
  const lookupIdentity =
    dependencies.identity ??
    (async (identityOptions: { readonly accessToken: string; readonly signal?: AbortSignal }) =>
      await authClient.me(identityOptions.accessToken));
  let accessToken = await rawAccessTokenProvider();
  let identity: AuthIdentity;
  try {
    identity = await lookupIdentity({
      apiOrigin,
      accessToken,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  } catch (cause) {
    if (!(cause instanceof AwError) || cause.code !== "TOKEN_REVOKED") throw cause;
    const replacement = await rawAccessTokenProvider({
      forceRefresh: true,
      rejectedAccessToken: accessToken,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (replacement === accessToken) throw cause;
    accessToken = replacement;
    identity = await lookupIdentity({
      apiOrigin,
      accessToken,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }
  const tenant = tenantBinding(identity);
  let verifiedAccessToken = accessToken;
  const accessTokenProvider: AccessTokenProvider = async (request = {}) => {
    const current = await rawAccessTokenProvider(request);
    if (current === verifiedAccessToken) return current;
    const currentIdentity = await lookupIdentity({
      apiOrigin,
      accessToken: current,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });
    assertSameTenant(tenant, currentIdentity);
    verifiedAccessToken = current;
    return current;
  };
  const cloud =
    dependencies.cloud?.({ apiOrigin, accessToken, accessTokenProvider }) ??
    new CloudClient({ apiUrl: apiOrigin, accessToken, accessTokenProvider });
  const observationKeys = report.resolvedConfig.capabilities.observation
    ? [...new Set(report.resolvedConfig.config.telemetry?.allow_observations ?? [])].sort()
    : [];
  const request: CreateRunIntentRequest = {
    protocol_version: protocolVersion,
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
        observation_keys: observationKeys,
        ...(assessment === undefined ? {} : { multi_turn: true })
      }
    },
    ...(assessment === undefined
      ? {}
      : {
          assessment: {
            plan_hash: assessment.freezeSha256,
            profile: assessment.profile,
            evaluation_mode: assessment.evaluationMode,
            disclosure_version: assessment.disclosureVersion
          }
        })
  } as CreateRunIntentRequest;
  const stateDirectory = options.stateDirectory ?? getStateDirectory(env);
  const intentStore =
    dependencies.intentStore?.({ apiOrigin, tenant, stateDirectory, env }) ??
    new RunIntentStore({ apiOrigin, tenant, stateDirectory, env });
  await intentStore.open();
  try {
    await intentStore.migrateLegacyTenantBinding(async (legacyBinding) => {
      const status = await cloud.getRunStatus(legacyBinding.run_id, options.signal);
      return status.run_id === legacyBinding.run_id;
    });
    const loaded = await intentStore.loadOrCreate(request);
    const binding = await cloud.createRun(loaded.intent.request, options.signal);
    assertRunBinding(binding, loaded.intent.request);
    await intentStore.bind(binding);

    const dashboard = dashboardUrl(binding.dashboard_url, apiOrigin);
    const stderr = dependencies.stderr ?? process.stderr;
    writeLine(
      stderr,
      `${loaded.resumed ? "Resuming" : "Run"} ${sanitizeTerminal(binding.run_id)}: ${sanitizeTerminal(dashboard.toString())}`
    );
    writeLine(stderr, HOSTED_TEST_KEEP_TERMINAL);
    if (options.open === true) {
      try {
        await (dependencies.openBrowser ?? ((url) => openBrowserUrl(url, [apiOrigin.origin])))(
          dashboard
        );
      } catch (error) {
        if (!(error instanceof AwError) || error.code !== "BROWSER_OPEN_FAILED") throw error;
        writeLine(stderr, "The dashboard could not be opened automatically; use the URL above.");
      }
    }

    if (isTerminal(binding.status)) {
      const run = await cloud.getRunStatus(binding.run_id, options.signal);
      await intentStore.removeTerminal(run);
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
      cloud,
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
      await intentStore.removeTerminal(run);
      return { binding, run };
    } finally {
      removeSignals();
    }
  } finally {
    await intentStore.close();
  }
}

export function createTestCommand(dependencies: TestDependencies = {}): Command {
  return new Command("test")
    .description("Run a deterministic hosted or customer-executed local assessment")
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option(
      "--packet <reference>",
      "hosted key@version, or a bundled/local JSON packet with --local"
    )
    .option(
      "--assessment <path>",
      "hosted assessment file (source 0.3.0; not in published 0.2.0)"
    )
    .option("--profile <profile>", "quick, full, combined, or custom")
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
        packet?: string;
        assessment?: string;
        profile?: string;
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
        assertTestSelection(values);
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
              packet: requirePacket(values.packet),
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
            ...(values.packet === undefined ? {} : { packet: values.packet }),
            ...(values.assessment === undefined ? {} : { assessment: values.assessment }),
            ...(values.profile === undefined ? {} : { profile: values.profile }),
            ...(values.open === undefined ? {} : { open: values.open }),
            ...(values.json === undefined ? {} : { json: values.json }),
            ...(values.allowFileCredentials === undefined
              ? {}
              : { allowFileCredentials: values.allowFileCredentials })
          },
          dependencies
        );
        if (values.json === true) {
          stdout.write(`${JSON.stringify(hostedJsonResult(result))}\n`);
        } else {
          writeHostedResult(stdout, result);
        }
        const exitCode = hostedExitCode(result.run);
        if (exitCode !== EXIT.OK) setExitCode(exitCode);
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
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new AwError({
      code: "INVALID_PACKET_REFERENCE",
      category: "config",
      message: "Packet must use the form key@version, for example support-refunds@0.1.0."
    });
  }
  return { key: match[1], version: match[2] };
}

export function hostedExitCode(run: RunStatusResponse): number {
  if (run.status === "cancelled") return EXIT.INTERRUPTED;
  if (run.evaluation_status === "pending" || run.evaluation_status === "partial") {
    return EXIT.EVALUATION_INCOMPLETE;
  }
  if (run.evaluation_status === "error") return EXIT.EVALUATION_ERROR;
  if (run.status === "failed" || (run.outcome != null && run.outcome !== "passed")) {
    return EXIT.ASSESSMENT_FAILED;
  }
  return EXIT.OK;
}

function assertTestSelection(values: {
  packet?: string;
  assessment?: string;
  profile?: string;
  local?: boolean;
}): void {
  if (values.assessment !== undefined && values.local === true) {
    throw new AwError({
      code: "ASSESSMENT_LOCAL_UNSUPPORTED",
      category: "config",
      message:
        "--assessment is a hosted compiler and cannot be used with --local. Hybrid packets are also rejected in local mode."
    });
  }
  if (values.assessment !== undefined && values.packet !== undefined) {
    throw new AwError({
      code: "ASSESSMENT_PACKET_CONFLICT",
      category: "config",
      message: "Use either --assessment or --packet, not both."
    });
  }
  if (values.profile !== undefined && values.assessment === undefined) {
    throw new AwError({
      code: "ASSESSMENT_PROFILE_REQUIRES_FILE",
      category: "config",
      message: "--profile requires --assessment."
    });
  }
  if (values.assessment === undefined && values.packet === undefined) {
    throw new AwError({
      code: "PACKET_OR_ASSESSMENT_REQUIRED",
      category: "config",
      message: "Provide --packet or --assessment."
    });
  }
}

function requirePacket(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new AwError({
      code: "PACKET_OR_ASSESSMENT_REQUIRED",
      category: "config",
      message: "Provide --packet or --assessment."
    });
  }
  return value;
}

function hostedJsonResult(result: TestResult): Record<string, unknown> {
  return {
    run_id: result.run.run_id,
    status: result.run.status,
    credit_state: result.run.credit_state,
    outcome: result.run.outcome ?? null,
    dashboard_url: result.binding.dashboard_url,
    ...(result.run.evaluation_status === undefined
      ? {}
      : { evaluation_status: result.run.evaluation_status })
  };
}

function writeHostedResult(stdout: Pick<NodeJS.WriteStream, "write">, result: TestResult): void {
  writeLine(stdout, `Run ${sanitizeTerminal(result.binding.dashboard_url)}`);
  if (result.run.evaluation_status !== undefined) {
    writeLine(stdout, `Grading: ${sanitizeTerminal(result.run.evaluation_status)}`);
  }
  if (
    result.run.evaluation_status === "pending" ||
    result.run.evaluation_status === "partial"
  ) {
    writeLine(
      stdout,
      "Response evaluation is incomplete. Re-run the same test command to resume. This is not a hybrid pass."
    );
    return;
  }
  if (result.run.evaluation_status === "error") {
    writeLine(
      stdout,
      "Required response evaluation did not complete. Re-run the same test command after the judging error is resolved."
    );
    return;
  }
  writeLine(
    stdout,
    `Assessment ${sanitizeTerminal(result.run.status)}${
      result.run.outcome == null ? "" : ` (${sanitizeTerminal(result.run.outcome)})`
    }.`
  );
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

function tenantBinding(identity: AuthIdentity): RunIntentTenantBinding {
  return {
    workspace_id: identity.workspaceId,
    connector_id: identity.connectorId
  };
}

function assertSameTenant(expected: RunIntentTenantBinding, identity: AuthIdentity): void {
  if (
    identity.workspaceId !== expected.workspace_id ||
    identity.connectorId !== expected.connector_id
  ) {
    throw new AwError({
      code: "AUTH_TENANT_CHANGED",
      category: "auth",
      message:
        "The authenticated AugmentWorks connector or workspace changed while the assessment was starting. No request was sent with the changed credential."
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
