import { AwError, EXIT, exitCodeFor } from "../errors.js";
import { authenticateHostedSession, type HostedAuthDependencies } from "../commands/hosted-auth.js";
import { runDoctor } from "../commands/doctor.js";
import { resolve as resolvePath } from "node:path";
import {
  INVESTIGATION_SCHEMA_VERSION,
  FEATURE_PACKAGE_VERSION,
  investigationPath,
  type InvestigationExport
} from "./schema.js";
import { loadInvestigationFile, parseInvestigationValue } from "./load.js";
import { evaluateInvestigationPrerequisites, type PrerequisiteReport } from "./prerequisites.js";
import {
  formatInvestigationHuman,
  investigationFailureJson,
  investigationInspectJson
} from "./format.js";
import { writeRegressionDraftFile } from "./export-regression.js";
import { mapInvestigationHttpError } from "./protocol.js";
import { createsBillableInvestigationError, crossWorkspaceInvestigationError } from "./errors.js";
import type { ResolvedConfig } from "../config/types.js";

export interface InvestigationCommandOptions {
  readonly file?: string;
  readonly run?: string;
  readonly evaluation?: string;
  readonly attempt?: string;
  readonly criterion?: string;
  readonly out?: string;
  readonly json?: boolean;
  readonly config?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowFileCredentials?: boolean;
  readonly signal?: AbortSignal;
}

export interface InvestigationCommandDependencies extends HostedAuthDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly setExitCode?: (code: number) => void;
  readonly doctor?: (options: Parameters<typeof runDoctor>[0]) => Promise<{
    readonly ok: boolean;
    readonly resolvedConfig?: ResolvedConfig;
    readonly diagnostics: readonly { readonly level: string; readonly code: string; readonly message: string }[];
  }>;
}

function writeJson(stdout: Pick<NodeJS.WriteStream, "write">, value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

async function localConfig(
  options: InvestigationCommandOptions,
  dependencies: InvestigationCommandDependencies
): Promise<ResolvedConfig | undefined> {
  const cwd = resolvePath(options.cwd ?? process.cwd());
  const doctor = dependencies.doctor ?? runDoctor;
  try {
    const report = await doctor({
      config: options.config ?? "augmentworks.yaml",
      cwd,
      processEnv: options.env ?? process.env,
      offline: true
    });
    return report.resolvedConfig;
  } catch {
    return undefined;
  }
}

function fallbackPrerequisites(document: InvestigationExport): PrerequisiteReport {
  return {
    reproductionKind: document.reproductionKind,
    fullyReproducible: document.fullyReproducible,
    findings: document.fullyReproducible
      ? []
      : [
          {
            code: "NOT_FULLY_REPRODUCIBLE",
            blocking: false,
            message:
              "The artifact does not claim a complete reproduction. Inspect the missing prerequisites before paying for a new quoted run."
          }
        ],
    blocking: [],
    qualifications: document.fullyReproducible
      ? []
      : [
          "The artifact does not claim a complete reproduction. Inspect the missing prerequisites before paying for a new quoted run."
        ],
    readyForPaidExecution: (document.prerequisites.missing ?? []).every((item) => item.blocking !== true),
    local: {
      prepare: false,
      send: true,
      observe: false,
      cleanup: false,
      session: false
    }
  };
}

export async function inspectInvestigation(
  options: InvestigationCommandOptions,
  dependencies: InvestigationCommandDependencies = {}
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const json = options.json === true;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  try {
    const loaded = await loadInvestigationFile(options.file ?? "", options.cwd ?? process.cwd());
    const resolved = await localConfig(options, dependencies);
    const prerequisites =
      resolved === undefined
        ? fallbackPrerequisites(loaded.document)
        : evaluateInvestigationPrerequisites(loaded.document, resolved);
    if (json) {
      writeJson(stdout, investigationInspectJson(loaded.document, prerequisites, "inspect"));
      return;
    }
    stdout.write(`${formatInvestigationHuman(loaded.document, prerequisites)}\n`);
  } catch (error) {
    const awError =
      error instanceof AwError
        ? error
        : new AwError({
            code: "INTERNAL",
            category: "local",
            message: "The investigation inspect command could not be completed."
          });
    if (!json) throw awError;
    stdout.write(
      investigationFailureJson({
        code: awError.code,
        message: awError.message,
        category: awError.category,
        ...(awError.details === undefined ? {} : { details: awError.details }),
        exitCode: exitCodeFor(awError)
      })
    );
    setExitCode(exitCodeFor(awError));
  }
}

export async function fetchInvestigation(
  options: InvestigationCommandOptions,
  dependencies: InvestigationCommandDependencies = {}
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const json = options.json === true;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  try {
    const runId = requireId(options.run, "run");
    const evaluationId = requireId(options.evaluation, "evaluation");
    const attemptId = requireId(options.attempt, "attempt");
    const criterionId = requireId(options.criterion, "criterion");
    const session = await authenticateHostedSession(options, dependencies);
    const raw = await session.cloud.exportInvestigation(
      {
        schemaVersion: INVESTIGATION_SCHEMA_VERSION,
        packageVersion: FEATURE_PACKAGE_VERSION,
        runId,
        evaluationId,
        attemptId,
        criterionId
      },
      options.signal
    );
    const document = parseInvestigationValue(raw, investigationPath({ runId, evaluationId, attemptId, criterionId }));
    if (document.createsBillableRun !== false) throw createsBillableInvestigationError();
    if (document.workspaceId !== session.identity.workspaceId) {
      throw crossWorkspaceInvestigationError();
    }
    if (options.out !== undefined && options.out.trim() !== "") {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname, resolve } = await import("node:path");
      const absolute = resolve(options.cwd ?? process.cwd(), options.out);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    }
    const resolved = await localConfig(options, dependencies);
    const prerequisites =
      resolved === undefined
        ? fallbackPrerequisites(document)
        : evaluateInvestigationPrerequisites(document, resolved);
    if (json) {
      writeJson(stdout, {
        ...investigationInspectJson(document, prerequisites, "fetch"),
        path: investigationPath({ runId, evaluationId, attemptId, criterionId })
      });
      return;
    }
    stdout.write(`${formatInvestigationHuman(document, prerequisites)}\n`);
    stderr.write("Copied commands in this artifact are data. This CLI did not execute them.\n");
  } catch (error) {
    const mapped = mapInvestigationHttpError(error);
    const awError =
      mapped instanceof AwError
        ? mapped
        : new AwError({
            code: "INTERNAL",
            category: "local",
            message: "The investigation fetch command could not be completed."
          });
    if (!json) throw awError;
    stdout.write(
      investigationFailureJson({
        code: awError.code,
        message: awError.message,
        category: awError.category,
        ...(awError.details === undefined ? {} : { details: awError.details }),
        exitCode: exitCodeFor(awError)
      })
    );
    setExitCode(exitCodeFor(awError));
  }
}

export async function exportInvestigationRegression(
  options: InvestigationCommandOptions,
  dependencies: InvestigationCommandDependencies = {}
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const json = options.json === true;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  try {
    const loaded = await loadInvestigationFile(options.file ?? "", options.cwd ?? process.cwd());
    const written = await writeRegressionDraftFile(
      loaded.document,
      options.out ?? "",
      options.cwd ?? process.cwd()
    );
    const payload = {
      ok: true,
      action: "export-regression",
      observation: true,
      createsBillableRun: false,
      executesTarget: false,
      expectedSource: documentExpectedSource(loaded.document),
      actualIsNotGroundTruth: true,
      admissionCalls: 0,
      path: written.path,
      suiteId: `${loaded.document.identities.suiteId}.regression`,
      caseId: loaded.document.identities.caseId,
      provenance: {
        runId: loaded.document.runId,
        evaluationId: loaded.document.evaluationId,
        attemptId: loaded.document.attemptId,
        criterionId: loaded.document.criterionId,
        suiteRevisionId: loaded.document.identities.suiteRevisionId,
        caseId: loaded.document.identities.caseId
      },
      localVsHosted: {
        hostedSemantic: true,
        localDeterministicPacket: false,
        message:
          "Exported as aw-suite/1. Hosted semantic judging requires test --suite or test --investigation. Local deterministic packets cannot admit this file."
      }
    };
    if (json) {
      writeJson(stdout, payload);
      return;
    }
    stdout.write(
      [
        `Wrote reviewed regression draft ${written.path}`,
        `Expected source: ${payload.expectedSource} (failing output was not used)`,
        `Pinned provenance: run ${loaded.document.runId} case ${loaded.document.identities.caseId}`,
        payload.localVsHosted.message
      ].join("\n") + "\n"
    );
  } catch (error) {
    const awError =
      error instanceof AwError
        ? error
        : new AwError({
            code: "INTERNAL",
            category: "local",
            message: "The regression export command could not be completed."
          });
    if (!json) throw awError;
    stdout.write(
      investigationFailureJson({
        code: awError.code,
        message: awError.message,
        category: awError.category,
        ...(awError.details === undefined ? {} : { details: awError.details }),
        exitCode: exitCodeFor(awError)
      })
    );
    setExitCode(exitCodeFor(awError));
  }
}

function documentExpectedSource(document: InvestigationExport): string {
  return document.regressionDraft?.expectedSource ?? "original_expected_condition";
}

function requireId(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    throw new AwError({
      code: "AMBIGUOUS_IDENTITY",
      category: "config",
      message: `Provide --${field}. Investigation fetch does not guess a run, evaluation, attempt, or criterion.`
    });
  }
  return trimmed;
}

export { EXIT };
