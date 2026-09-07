import { resolve } from "node:path";

import { Command } from "commander";

import { inspectConfig } from "../config/load.js";
import type { Diagnostic } from "../config/types.js";
import {
  CONNECTION_PROBE_DISCLAIMER,
  CONNECTION_PROBE_SCHEMA_VERSION,
  formatConnectionProbeHuman,
  formatConnectionProbeJson,
  probeExitCode,
  runConnectionProbe,
  type ConnectionProbeReport
} from "../connector/connection-probe.js";
import { EXIT, sanitizeTerminal } from "../errors.js";

export interface ProbeOptions {
  readonly config?: string;
  readonly cwd?: string;
  readonly processEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface ProbeCommandResult {
  readonly report: ConnectionProbeReport;
  readonly secrets: readonly string[];
}

export interface ProbeCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
  readonly processEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly setExitCode?: (code: number) => void;
  readonly fetch?: typeof globalThis.fetch;
}

export async function runProbeCommand(options: ProbeOptions = {}): Promise<ProbeCommandResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.config ?? "augmentworks.yaml");
  const inspection = await inspectConfig({
    configPath,
    cwd,
    processEnv: options.processEnv ?? process.env
  });
  const errors = inspection.diagnostics.filter((item) => item.level === "error");
  if (inspection.resolvedConfig === undefined || errors.length > 0) {
    return {
      report: configFailureReport(configPath, inspection.diagnostics),
      secrets: inspection.resolvedConfig?.secrets ?? []
    };
  }

  const report = await runConnectionProbe({
    resolved: inspection.resolvedConfig,
    execute: options.yes === true,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return { report, secrets: inspection.resolvedConfig.secrets };
}

export function createProbeCommand(dependencies: ProbeCommandDependencies = {}): Command {
  return new Command("probe")
    .description(
      "Explicit bounded synthetic connection probe. Prints the planned calls first; pass --yes to execute. Never runs during doctor or init. Does not contact AugmentWorks or consume credits."
    )
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option("--yes", "execute the printed plan against the configured target")
    .option("--json", "emit stable machine-readable probe output")
    .action(async (commandOptions: { config: string; yes?: boolean; json?: boolean }) => {
      const { report, secrets } = await runProbeCommand({
        config: commandOptions.config,
        cwd: dependencies.cwd?.() ?? process.cwd(),
        processEnv: dependencies.processEnv ?? process.env,
        yes: commandOptions.yes === true,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
      });
      (dependencies.stdout ?? process.stdout).write(
        commandOptions.json === true
          ? formatConnectionProbeJson(report, secrets)
          : formatConnectionProbeHuman(report, secrets)
      );
      const code = report.executed ? probeExitCode(report) : report.ok ? EXIT.OK : EXIT.CONFIG;
      if (code !== EXIT.OK) {
        (dependencies.setExitCode ?? ((value) => { process.exitCode = value; }))(code);
      }
    });
}

export const probeFormatters = {
  human: formatConnectionProbeHuman,
  json: formatConnectionProbeJson
} as const;

function configFailureReport(configPath: string, diagnostics: readonly Diagnostic[]): ConnectionProbeReport {
  return {
    schema_version: CONNECTION_PROBE_SCHEMA_VERSION,
    ok: false,
    executed: false,
    credits_consumed: 0,
    hosted_contacted: false,
    pattern: "response-only",
    conversation_strategy: "single_turn",
    config_path: configPath,
    correlation: {
      probe_id: "probe_unstarted",
      run_id: "probe_unstarted",
      attempt_id: "probe_unstarted",
      conversation_id: null,
      turn_ids: []
    },
    preflight: {
      pattern: "response-only",
      conversation_strategy: "single_turn",
      operations: [],
      call_count: 0,
      time_limit_ms: 0,
      request_bytes_limit: 0,
      response_bytes_limit: 0,
      synthetic_side_effects: ["No target calls were made because configuration is invalid."],
      cleanup: "none",
      hosted_work: "none",
      confirmation: "Fix doctor/config errors before probing. Pass --yes only after the plan is valid."
    },
    calls: [],
    diagnostics: diagnostics.map((item) => ({
      ...item,
      message: sanitizeTerminal(item.message)
    })),
    failed_phase: null,
    failure_class: null,
    corrective_action: "Run doctor -c <config> and fix configuration errors. Probe did not call the target.",
    disclaimer: CONNECTION_PROBE_DISCLAIMER
  };
}
