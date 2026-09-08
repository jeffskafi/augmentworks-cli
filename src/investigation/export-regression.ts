import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { InvestigationExport } from "./schema.js";
import { investigationError } from "./errors.js";

function yamlQuote(value: string): string {
  if (value === "" || /[:#{}[\],&*?|>!%@`]/.test(value) || /^\s|\s$/u.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function yamlList(values: readonly string[], indent: string): string {
  if (values.length === 0) return `${indent}[]`;
  return values.map((value) => `${indent}- ${yamlQuote(value)}`).join("\n");
}

export function regressionDraftYaml(document: InvestigationExport): string {
  const expectedSource = document.regressionDraft?.expectedSource ?? "original_expected_condition";
  if (expectedSource === ("actual_output" as string)) {
    throw investigationError(
      "REGRESSION_ACTUAL_NOT_EXPECTED",
      "The failing chatbot output cannot be saved as the expected answer. Review the original expected condition first."
    );
  }
  const facts = document.regressionDraft?.expectedFacts ?? document.evidence.expected.facts;
  if (facts.length === 0) {
    throw investigationError(
      "REGRESSION_EXPECTED_UNREVIEWED",
      "A regression draft requires the original expected condition. This CLI will not invent an expected answer from the failing output."
    );
  }
  const identities = document.identities;
  const selected = {
    caseId: identities.caseId,
    facts,
    permittedRefusal: document.evidence.expected.permittedRefusal,
    criterionId: document.criterionId,
    statement:
      document.criterionStatement ??
      "The assistant satisfies the original expected condition from the saved investigation. Do not treat the failing chatbot output as ground truth."
  };
  const provenance = [
    `Reviewed regression draft exported from investigation of run ${document.runId}.`,
    `Pinned suite ${identities.suiteId} revision ${identities.suiteRevisionId} case ${identities.caseId} criterion ${document.criterionId}.`,
    `Original machine verdict ${document.verdict} is unchanged. Failing chatbot output is not the expected answer.`,
    "Hosted semantic case — not a local deterministic packet. Use test --investigation or test --suite with a new quote and --max-credits. test --local cannot admit this file."
  ].join(" ");
  const lines = [
    "# Reviewed regression draft. Expected facts come from the original condition, not the failing output.",
    "# Hosted semantic case. Not a local deterministic packet.",
    "schema_version: aw-suite/1",
    `suite_id: ${yamlQuote(`${identities.suiteId}.regression`)}`,
    `title: ${yamlQuote(`Regression: ${identities.caseId}`)}`,
    `description: ${yamlQuote(provenance)}`,
    "synthetic_only: true",
    "tags:",
    "  - regression",
    "  - investigation-export",
    "references:"
  ];
  const referenceIds = identities.referenceIds ?? [];
  if (referenceIds.length === 0) {
    lines.push("  - id: investigation-provenance");
    lines.push("    kind: synthetic_fixture_facts");
    lines.push(`    content: ${yamlQuote(provenance)}`);
  } else {
    for (const id of referenceIds) {
      lines.push(`  - id: ${yamlQuote(id)}`);
      lines.push("    kind: synthetic_fixture_facts");
      lines.push(`    content: ${yamlQuote(`Pinned reference ${id} from investigation ${document.runId}.`)}`);
    }
  }
  const refs = referenceIds.length === 0 ? ["investigation-provenance"] : referenceIds;
  lines.push("cases:");
  lines.push(`  - case_id: ${yamlQuote(selected.caseId)}`);
  lines.push("    turns:");
  const input = document.evidence.sanitizedInput?.text;
  lines.push(
    `      - content: ${yamlQuote(input && input.trim() !== "" ? input : "Repeat the original pinned case input.")}`
  );
  lines.push("    expected:");
  lines.push("      facts:");
  lines.push(yamlList(selected.facts, "        "));
  if (selected.permittedRefusal !== undefined) {
    lines.push(`      permitted_refusal: ${selected.permittedRefusal ? "true" : "false"}`);
  }
  lines.push("    criteria:");
  lines.push(`      - criterion_id: ${yamlQuote(selected.criterionId)}`);
  lines.push("        requirement: required");
  lines.push("        kind: llm_rubric");
  lines.push(`        statement: ${yamlQuote(selected.statement)}`);
  lines.push(`        reference_ids: [${refs.map((id) => yamlQuote(id)).join(", ")}]`);
  lines.push(`    reference_ids: [${refs.map((id) => yamlQuote(id)).join(", ")}]`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function writeRegressionDraftFile(
  document: InvestigationExport,
  outputPath: string,
  cwd = process.cwd()
): Promise<{ readonly path: string; readonly yaml: string }> {
  if (outputPath.trim() === "") {
    throw investigationError(
      "REGRESSION_OUTPUT_REQUIRED",
      "Provide --out with a .yaml path for the regression draft."
    );
  }
  const absolute = resolve(cwd, outputPath);
  if (!absolute.toLowerCase().endsWith(".yaml") && !absolute.toLowerCase().endsWith(".yml")) {
    throw investigationError(
      "REGRESSION_OUTPUT_EXTENSION",
      "Regression drafts use the existing case-file format and must end in .yaml or .yml."
    );
  }
  const yaml = regressionDraftYaml(document);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, yaml, "utf8");
  return { path: absolute, yaml };
}
