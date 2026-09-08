import { sanitizeTerminal } from "../errors.js";
import type { InvestigationExport } from "./schema.js";
import type { PrerequisiteReport } from "./prerequisites.js";
import { redactInvestigationText } from "./load.js";

export type InvestigationInspectJson = {
  readonly ok: true;
  readonly action: "inspect" | "fetch";
  readonly observation: true;
  readonly createsBillableRun: false;
  readonly executesTarget: false;
  readonly executesShell: false;
  readonly callsEvaluator: false;
  readonly admissionCalls: 0;
  readonly copiedCommandsAreData: true;
  readonly schemaVersion: string;
  readonly packageVersion: string | null;
  readonly workspaceId: string;
  readonly runId: string;
  readonly evaluationId: string;
  readonly evaluationRevision: number;
  readonly attemptId: string;
  readonly criterionId: string;
  readonly verdict: string;
  readonly reproductionKind: string;
  readonly fullyReproducible: boolean;
  readonly identities: InvestigationExport["identities"];
  readonly expected: InvestigationExport["evidence"]["expected"];
  readonly actualIsNotGroundTruth: true;
  readonly prerequisites: PrerequisiteReport;
  readonly limitations: readonly string[];
  readonly commandFragment: {
    readonly kind: "data_not_executed";
    readonly argv: readonly string[];
    readonly text: string | null;
  };
  readonly localVsHosted: {
    readonly hostedSemantic: true;
    readonly localDeterministicPacket: false;
    readonly message: string;
  };
  readonly issueProposalAutomaticWrite: false;
};

const LOCAL_VS_HOSTED =
  "Hosted semantic reproduction uses the pinned suite revision and a new quote. Local `test --local` deterministic packets cannot admit this artifact.";

export function commandFragmentAsData(document: InvestigationExport): {
  readonly kind: "data_not_executed";
  readonly argv: readonly string[];
  readonly text: string | null;
} {
  const fragment = document.prerequisites.commandFragment;
  return {
    kind: "data_not_executed",
    argv: fragment?.argv ?? [],
    text: fragment?.text ?? null
  };
}

export function investigationInspectJson(
  document: InvestigationExport,
  prerequisites: PrerequisiteReport,
  action: "inspect" | "fetch" = "inspect"
): InvestigationInspectJson {
  return {
    ok: true,
    action,
    observation: true,
    createsBillableRun: false,
    executesTarget: false,
    executesShell: false,
    callsEvaluator: false,
    admissionCalls: 0,
    copiedCommandsAreData: true,
    schemaVersion: document.schemaVersion,
    packageVersion: document.packageVersion ?? null,
    workspaceId: document.workspaceId,
    runId: document.runId,
    evaluationId: document.evaluationId,
    evaluationRevision: document.evaluationRevision,
    attemptId: document.attemptId,
    criterionId: document.criterionId,
    verdict: document.verdict,
    reproductionKind: document.reproductionKind,
    fullyReproducible: document.fullyReproducible,
    identities: document.identities,
    expected: document.evidence.expected,
    actualIsNotGroundTruth: true,
    prerequisites,
    limitations: document.limitations ?? [],
    commandFragment: commandFragmentAsData(document),
    localVsHosted: {
      hostedSemantic: true,
      localDeterministicPacket: false,
      message: LOCAL_VS_HOSTED
    },
    issueProposalAutomaticWrite: false
  };
}

export function formatInvestigationHuman(
  document: InvestigationExport,
  prerequisites: PrerequisiteReport,
  secrets: readonly string[] = []
): string {
  const redact = (value: string): string => sanitizeTerminal(redactInvestigationText(value, secrets));
  const fragment = commandFragmentAsData(document);
  const expectedFacts = document.evidence.expected.facts.map((fact) => redact(fact));
  const actual = document.evidence.actual?.text;
  const lines = [
    "Investigation (read-only — does not execute a target, shell command, or evaluator)",
    `  schema: ${document.schemaVersion}`,
    `  workspace: ${redact(document.workspaceId)}`,
    `  run: ${redact(document.runId)}`,
    `  evaluation: ${redact(document.evaluationId)} revision ${String(document.evaluationRevision)}`,
    `  attempt: ${redact(document.attemptId)}`,
    `  criterion: ${redact(document.criterionId)}`,
    `  verdict: ${redact(document.verdict)} (immutable original machine result)`,
    `  reproduction_kind: ${document.reproductionKind}`,
    `  fully_reproducible: ${document.fullyReproducible ? "yes" : "no"}`,
    `  suite: ${redact(document.identities.suiteId)}`,
    `  suite_revision: ${redact(document.identities.suiteRevisionId)}`,
    `  suite_content_hash: ${document.identities.suiteContentHash}`,
    `  case: ${redact(document.identities.caseId)}`,
    `  references: ${(document.identities.referenceIds ?? []).join(", ") || "(none)"}`,
    document.identities.rubricId === undefined ? "  rubric: (none)" : `  rubric: ${redact(document.identities.rubricId)}`,
    "  expected (original condition, not the failing chatbot output):",
    ...expectedFacts.map((fact) => `    - ${fact}`),
    document.evidence.expected.permittedRefusal === undefined
      ? "  permitted_refusal: (unspecified)"
      : `  permitted_refusal: ${document.evidence.expected.permittedRefusal ? "yes" : "no"}`,
    actual === undefined || actual === null
      ? "  actual: (missing or redacted; not ground truth)"
      : `  actual (not ground truth): ${redact(actual).slice(0, 400)}`,
    `  copied_commands_are_data: yes (this CLI will not execute them)`,
    fragment.argv.length === 0
      ? fragment.text === null || fragment.text === ""
        ? "  command_fragment: (none)"
        : `  command_fragment: ${redact(fragment.text ?? "")}`
      : `  command_fragment: ${fragment.argv.map((part) => redact(part)).join(" ")}`,
    `  local_mapping: send=${prerequisites.local.send ? "yes" : "no"} prepare=${prerequisites.local.prepare ? "yes" : "no"} observe=${prerequisites.local.observe ? "yes" : "no"} cleanup=${prerequisites.local.cleanup ? "yes" : "no"} session=${prerequisites.local.session ? "yes" : "no"}`,
    `  ready_for_paid_execution: ${prerequisites.readyForPaidExecution ? "yes" : "no"}`,
    `  ${LOCAL_VS_HOSTED}`,
    "  executes_target: no",
    "  executes_shell: no",
    "  calls_evaluator: no",
    "  admission_calls: 0"
  ];
  if (prerequisites.findings.length > 0) {
    lines.push("  prerequisites:");
    for (const finding of prerequisites.findings) {
      lines.push(`    - ${finding.blocking ? "block" : "qualify"} ${finding.code}: ${redact(finding.message)}`);
    }
  }
  for (const limitation of document.limitations ?? []) {
    lines.push(`  limitation: ${redact(limitation)}`);
  }
  return lines.join("\n");
}

export function investigationFailureJson(error: {
  readonly code: string;
  readonly message: string;
  readonly category?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly exitCode: number;
}): string {
  return `${JSON.stringify({
    ok: false,
    observation: true,
    createsBillableRun: false,
    executesTarget: false,
    executesShell: false,
    callsEvaluator: false,
    admissionCalls: 0,
    copiedCommandsAreData: true,
    code: error.code,
    category: error.category,
    safe_message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    exit_code: error.exitCode
  })}\n`;
}
