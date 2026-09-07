import type { SuitePreview } from "./preview.js";

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatSuitePreview(preview: SuitePreview): string {
  const lines = [
    "Customer suite (local preview — not a price, does not execute a target or an LLM)",
    `  schema: ${preview.schemaVersion}`,
    `  suite_id: ${preview.suiteId}`,
    `  title: ${preview.title}`,
    `  file: ${preview.sourcePath}`,
    `  content_hash: ${preview.contentHash}`,
    `  cases: ${String(preview.caseCount)}`,
    `  projected_attempts: ${String(preview.projectedAttemptCount)} (bounded; local preview is not an authoritative price)`,
    `  projected_turns: ${String(preview.projectedTurnCount)}`,
    `  requires_multi_turn: ${yn(preview.requiresMultiTurn)} (target conversation.strategy must be explicit_session_v1 at run time; this preview does not advertise multi_turn)`,
    `  evaluation_mode: ${preview.evaluationMode}`,
    `  tags: ${preview.tags.length > 0 ? preview.tags.join(", ") : "(none)"}`,
    `  references: ${String(preview.references.length)}`,
    `  supported_deterministic_observations: ${preview.supportedDeterministicObservations.join(", ")}`,
    "  authoritative_price: no",
    "  executes_target: no",
    "  calls_llm: no",
    ""
  ];

  for (const suiteCase of preview.cases) {
    lines.push(`Case ${suiteCase.caseId}${suiteCase.name === null ? "" : ` — ${suiteCase.name}`}`);
    if (suiteCase.tags.length > 0) {
      lines.push(`  tags: ${suiteCase.tags.join(", ")}`);
    }
    for (const [index, turn] of suiteCase.turns.entries()) {
      lines.push(`  turn ${String(index + 1)} (${turn.role}): ${turn.content}`);
    }
    if (suiteCase.expectedFacts.length > 0) {
      lines.push("  expected:");
      for (const fact of suiteCase.expectedFacts) {
        lines.push(`    - ${fact}`);
      }
    }
    if (suiteCase.permittedRefusal !== null) {
      lines.push(`  permitted_refusal: ${yn(suiteCase.permittedRefusal)}`);
    }
    if (suiteCase.criteria.length > 0) {
      lines.push("  criteria:");
      for (const criterion of suiteCase.criteria) {
        lines.push(
          `    - ${criterion.criterionId} (${criterion.kind}, ${criterion.requirement}): ${criterion.statement}`
        );
      }
    }
    if (suiteCase.observations.length > 0) {
      lines.push(
        `  observations: ${suiteCase.observations
          .map((observation) =>
            observation.expected === undefined ? observation.key : `${observation.key}=${String(observation.expected)}`
          )
          .join(", ")}`
      );
    }
    if (suiteCase.referenceIds.length > 0) {
      lines.push(`  references: ${suiteCase.referenceIds.join(", ")}`);
    }
    lines.push("");
  }

  if (preview.references.length > 0) {
    lines.push("References");
    for (const reference of preview.references) {
      const location = reference.path ?? "inline";
      lines.push(`  - ${reference.id}: ${location} (${reference.kind}, ${reference.contentHash})`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatSuiteValidate(preview: SuitePreview): string {
  return [
    `Valid ${preview.schemaVersion} customer suite.`,
    `  suite_id: ${preview.suiteId}`,
    `  cases: ${String(preview.caseCount)}`,
    `  content_hash: ${preview.contentHash}`,
    `  projected_attempts: ${String(preview.projectedAttemptCount)}`,
    `  projected_turns: ${String(preview.projectedTurnCount)}`,
    "  Local preview is not an authoritative price and does not execute a target or an LLM."
  ].join("\n");
}
