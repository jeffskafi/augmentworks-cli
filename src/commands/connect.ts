import { resolve } from "node:path";

import { Command } from "commander";

import { getApiOrigin } from "../auth/api-origin.js";
import { resolveAccessToken } from "../auth/credential-store.js";
import { CloudClient } from "../cloud/client.js";
import {
  RELAY_PROTOCOL_VERSION,
  type ConnectorSessionResponse,
  type CreateSessionRequest,
  type RunStatusResponse
} from "../cloud/protocol.js";
import type { ResolvedConfig } from "../config/types.js";
import { targetBoundarySha256 } from "../config/boundary.js";
import { HttpConnector } from "../connector/http.js";
import { AwError, EXIT, sanitizeTerminal } from "../errors.js";
import { RelayRunner, type RelayProgressEvent } from "../relay/runner.js";
import { assertAllowedBrowserUrl, openBrowserUrl, type BrowserOpener } from "../system/browser.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import type { SignalHost } from "./test.js";

export interface ConnectOptions {
  readonly config?: string;
  readonly open?: boolean;
  readonly json?: boolean;
  readonly allowFileCredentials?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDirectory?: string;
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
}

export interface ConnectResult {
  readonly session: ConnectorSessionResponse;
  readonly runs: readonly RunStatusResponse[];
  readonly status: "closed";
}

export interface ConnectDependencies {
  readonly doctor?: (options: Parameters<typeof runDoctor>[0]) => Promise<DoctorReport>;
  readonly apiOrigin?: (env: NodeJS.ProcessEnv) => URL;
  readonly accessToken?: (options: Parameters<typeof resolveAccessToken>[0]) => Promise<string>;
  readonly cloud?: (options: { apiOrigin: URL; accessToken: string }) => CloudClient;
  readonly connector?: (config: ResolvedConfig) => HttpConnector;
  readonly runner?: (options: ConstructorParameters<typeof RelayRunner>[0]) => RelayRunner;
  readonly openBrowser?: BrowserOpener;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly signals?: SignalHost;
  readonly onProgress?: (event: RelayProgressEvent) => void;
}

export async function runConnect(
  options: ConnectOptions = {},
  dependencies: ConnectDependencies = {}
): Promise<ConnectResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const report = await (dependencies.doctor ?? runDoctor)({
    config: options.config ?? "augmentworks.yaml",
    cwd,
    processEnv: env,
    offline: true
  });
  if (!report.ok || report.resolvedConfig === undefined) {
    const error = report.diagnostics.find((diagnostic) => diagnostic.level === "error");
    throw new AwError({
      code: error?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: error?.message ?? "Doctor found configuration errors."
    });
  }

  const apiOrigin = (dependencies.apiOrigin ?? getApiOrigin)(env);
  const accessToken = await (dependencies.accessToken ?? resolveAccessToken)({
    apiOrigin,
    env,
    ...(options.allowFileCredentials === undefined
      ? {}
      : { allowFileFallback: options.allowFileCredentials }),
    onWarning: (message) => writeLine(dependencies.stderr ?? process.stderr, message)
  });
  const cloud =
    dependencies.cloud?.({ apiOrigin, accessToken }) ??
    new CloudClient({ apiUrl: apiOrigin, accessToken });
  const request: CreateSessionRequest = {
    protocol_version: RELAY_PROTOCOL_VERSION,
    config_sha256: report.resolvedConfig.configDigest,
    target: {
      name: report.resolvedConfig.config.target.name,
      boundary_sha256: targetBoundarySha256(report.resolvedConfig),
      capabilities: {
        prepare: report.resolvedConfig.capabilities.prepare,
        observation: report.resolvedConfig.capabilities.observation,
        cleanup: report.resolvedConfig.capabilities.cleanup,
        tool_events: report.resolvedConfig.capabilities.tool_events,
        observation_keys: report.resolvedConfig.capabilities.observation
          ? [...(report.resolvedConfig.config.telemetry?.allow_observations ?? [])].sort()
          : []
      }
    }
  };
  const session = await cloud.createConnectorSession(request, options.signal);
  const dashboard = validateDashboard(session.dashboard_url, apiOrigin);
  const stderr = dependencies.stderr ?? process.stderr;
  writeLine(stderr, `Connected. Dashboard: ${dashboard.toString()}`);
  if (options.open === true) {
    try {
      await (dependencies.openBrowser ?? ((url) => openBrowserUrl(url, [apiOrigin.origin])))(dashboard);
    } catch (error) {
      if (!(error instanceof AwError) || error.code !== "BROWSER_OPEN_FAILED") throw error;
      writeLine(stderr, "The dashboard could not be opened automatically; use the URL above.");
    }
  }

  const connector = dependencies.connector?.(report.resolvedConfig) ?? new HttpConnector(report.resolvedConfig);
  const runs: RunStatusResponse[] = [];
  let stopping = false;
  let activeRunner: RelayRunner | undefined;
  let pollAbort: AbortController | undefined;
  let interruptCount = 0;
  const signalHost = dependencies.signals ?? (process as SignalHost);
  const interrupt = () => {
    interruptCount += 1;
    if (interruptCount >= 2) signalHost.exit(EXIT.INTERRUPTED);
    stopping = true;
    pollAbort?.abort("connector close requested");
    writeLine(stderr, "Disconnect requested; draining cleanup. Press Ctrl+C again to exit now.");
    if (activeRunner !== undefined) {
      void activeRunner.requestCancellation("connector_closing").catch((error: unknown) => {
        const message =
          error instanceof AwError
            ? error.message
            : "The active assessment could not be cancelled cleanly.";
        writeLine(stderr, sanitizeTerminal(message));
      });
    }
  };
  if (options.handleSignals !== false) signalHost.on("SIGINT", interrupt);

  try {
    while (!stopping) {
      if (options.signal?.aborted) {
        stopping = true;
        break;
      }
      pollAbort = new AbortController();
      let poll;
      try {
        poll = await cloud.pollConnectorSession({
          sessionId: session.session_id,
          fencingEpoch: session.fencing_epoch,
          waitMs: 25_000,
          signal: combineSignals(options.signal, pollAbort.signal)
        });
      } catch (error) {
        if (stopping && error instanceof AwError && error.code === "RELAY_REQUEST_CANCELLED") break;
        throw error;
      } finally {
        pollAbort = undefined;
      }
      if (poll === null) continue;
      if (
        poll.session_id !== session.session_id ||
        poll.fencing_epoch !== session.fencing_epoch
      ) {
        throw new AwError({
          code: "SESSION_BINDING_MISMATCH",
          category: "protocol",
          message: "The relay changed the connector session binding."
        });
      }
      if (poll.status === "closed") break;
      if (poll.run === null) continue;
      if (
        poll.run.session_id !== session.session_id ||
        poll.run.fencing_epoch !== session.fencing_epoch ||
        poll.run.config_sha256 !== report.resolvedConfig.configDigest
      ) {
        throw new AwError({
          code: "RUN_BINDING_MISMATCH",
          category: "protocol",
          message: "The dashboard-started run changed its connector or configuration binding."
        });
      }
      const runnerProgress =
        dependencies.onProgress ??
        (options.json === true ? undefined : (event: RelayProgressEvent) => writeProgress(stderr, event));
      const runnerOptions: ConstructorParameters<typeof RelayRunner>[0] = {
        cloud,
        connector,
        binding: poll.run,
        ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(runnerProgress === undefined ? {} : { onProgress: runnerProgress })
      };
      activeRunner = dependencies.runner?.(runnerOptions) ?? new RelayRunner(runnerOptions);
      const run = await activeRunner.run();
      runs.push(run);
      activeRunner = undefined;
    }
  } finally {
    if (options.handleSignals !== false) signalHost.off("SIGINT", interrupt);
    if (activeRunner !== undefined) {
      await activeRunner.requestCancellation("connector_closing").catch(() => undefined);
    }
    await cloud
      .closeConnectorSession(session.session_id, session.fencing_epoch, options.signal)
      .catch((error: unknown) => {
        if (!stopping) throw error;
        return undefined;
      });
  }
  return { session, runs, status: "closed" };
}

export function createConnectCommand(dependencies: ConnectDependencies = {}): Command {
  return new Command("connect")
    .description("Keep the local connector online for dashboard-started assessments")
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option("--open", "open the connector dashboard")
    .option("--json", "emit a final JSON session summary")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(async (values: {
      config: string;
      open?: boolean;
      json?: boolean;
      allowFileCredentials?: boolean;
    }) => {
      const result = await runConnect(
        {
          config: values.config,
          ...(values.open === undefined ? {} : { open: values.open }),
          ...(values.json === undefined ? {} : { json: values.json }),
          ...(values.allowFileCredentials === undefined
            ? {}
            : { allowFileCredentials: values.allowFileCredentials })
        },
        dependencies
      );
      const stdout = dependencies.stdout ?? process.stdout;
      if (values.json === true) {
        stdout.write(
          `${JSON.stringify({
            session_id: result.session.session_id,
            status: result.status,
            runs: result.runs.map((run) => ({
              run_id: run.run_id,
              status: run.status,
              outcome: run.outcome ?? null
            }))
          })}\n`
        );
      } else {
        writeLine(stdout, `Disconnected after ${result.runs.length} run${result.runs.length === 1 ? "" : "s"}.`);
      }
    });
}

function validateDashboard(value: string, apiOrigin: URL): URL {
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

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}

function writeProgress(stream: Pick<NodeJS.WriteStream, "write">, event: RelayProgressEvent): void {
  if (event.type === "operation_started") writeLine(stream, `→ ${event.kind} (${event.sequence})`);
  else if (event.type === "operation_completed") writeLine(stream, `✓ ${event.kind}`);
  else if (event.type === "operation_failed") writeLine(stream, `✗ ${event.kind}: ${event.code}`);
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, value: string): void {
  stream.write(`${sanitizeTerminal(value)}\n`);
}
