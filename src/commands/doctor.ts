import { resolve } from "node:path";

import { Command } from "commander";

import {
  assessmentDiagnostics,
  loadAssessmentFile,
  type LoadedAssessment
} from "../assessment/index.js";
import { EXIT, AwError } from "../errors.js";
import { inspectConfig } from "../config/load.js";
import type { ConfigInspection, Diagnostic } from "../config/types.js";

export interface DoctorOptions {
  readonly config?: string;
  readonly cwd?: string;
  readonly processEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly offline?: boolean;
  readonly assessment?: string;
  readonly profile?: string;
}

export interface DoctorReport extends ConfigInspection {
  readonly ok: boolean;
  readonly configPath: string;
  readonly offline: true;
  readonly assessment?: LoadedAssessment;
}

export interface DoctorCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
  readonly processEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly setExitCode?: (code: number) => void;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.config ?? "augmentworks.yaml");
  const inspection = await inspectConfig({
    configPath,
    cwd,
    processEnv: options.processEnv ?? process.env
  });
  const diagnostics: Diagnostic[] = [...inspection.diagnostics];
  let assessment: LoadedAssessment | undefined;
  if (options.assessment !== undefined) {
    try {
      assessment = await loadAssessmentFile({
        path: options.assessment,
        cwd,
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      diagnostics.push(...assessmentDiagnostics(assessment));
    } catch (error) {
      if (error instanceof AwError) {
        diagnostics.push({
          level: "error",
          code: error.code,
          message: error.message
        });
      } else {
        diagnostics.push({
          level: "error",
          code: "ASSESSMENT_FILE_INVALID",
          message: "The assessment file could not be validated."
        });
      }
    }
  }
  diagnostics.push({
    level: "ok",
    code: "OFFLINE_CHECK_COMPLETE",
    message: "No target hooks or cloud operations were invoked."
  });
  return {
    ok: !diagnostics.some((item) => item.level === "error"),
    configPath,
    offline: true,
    diagnostics,
    ...(inspection.resolvedConfig === undefined ? {} : { resolvedConfig: inspection.resolvedConfig }),
    ...(assessment === undefined ? {} : { assessment })
  };
}

function formatHuman(report: DoctorReport): string {
  const marker = { ok: "OK", warning: "WARN", error: "ERROR" } as const;
  const lines = report.diagnostics.map((item) => {
    const suffix = item.path === undefined ? "" : ` (${item.path})`;
    return `${marker[item.level]} ${item.code}: ${item.message}${suffix}`;
  });
  lines.push(report.ok ? "Doctor passed." : "Doctor found configuration errors.");
  return `${lines.join("\n")}\n`;
}

function formatJson(report: DoctorReport): string {
  return `${JSON.stringify(
    {
      ok: report.ok,
      config_path: report.configPath,
      offline: report.offline,
      capability_level: report.resolvedConfig?.capabilities.level ?? null,
      config_digest: report.resolvedConfig?.configDigest ?? null,
      assessment:
        report.assessment === undefined
          ? null
          : {
              path: report.assessment.path,
              profile: report.assessment.profile,
              evaluation_mode: report.assessment.evaluationMode,
              yaml_sha256: report.assessment.yamlSha256,
              freeze_sha256: report.assessment.freezeSha256,
              disclosure_version: report.assessment.disclosureVersion,
              references: report.assessment.localReferences.map((entry) => ({
                id: entry.id,
                path: entry.relativePath,
                sha256: entry.sha256
              }))
            },
      diagnostics: report.diagnostics
    },
    null,
    2
  )}\n`;
}

export function createDoctorCommand(dependencies: DoctorCommandDependencies = {}): Command {
  return new Command("doctor")
    .description("Validate configuration and local prerequisites without running target hooks")
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option("--assessment <path>", "validate an assessment file without running tests")
    .option("--profile <profile>", "quick, full, combined, or custom")
    .option("--json", "emit stable machine-readable diagnostics")
    .option("--offline", "validate locally without checking cloud authentication", true)
    .action(
      async (commandOptions: {
        config: string;
        assessment?: string;
        profile?: string;
        json?: boolean;
        offline?: boolean;
      }) => {
        const report = await runDoctor({
          config: commandOptions.config,
          cwd: dependencies.cwd?.() ?? process.cwd(),
          processEnv: dependencies.processEnv ?? process.env,
          offline: commandOptions.offline !== false,
          ...(commandOptions.assessment === undefined ? {} : { assessment: commandOptions.assessment }),
          ...(commandOptions.profile === undefined ? {} : { profile: commandOptions.profile })
        });
        (dependencies.stdout ?? process.stdout).write(
          commandOptions.json === true ? formatJson(report) : formatHuman(report)
        );
        if (!report.ok) (dependencies.setExitCode ?? ((code) => { process.exitCode = code; }))(EXIT.CONFIG);
      }
    );
}

export const doctorFormatters = { human: formatHuman, json: formatJson } as const;
