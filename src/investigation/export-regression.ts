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

export function regressionDraftYaml(
  document: InvestigationExport,
  options: { readonly fabricateSyntheticFixture?: boolean } = {}
): string {
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
  const real = investigationRealProvenance(document);
  if (real !== undefined && options.fabricateSyntheticFixture !== true) {
    if (real.executionScope === undefined) {
      throw investigationError(
        "REGRESSION_FABRICATE_REQUIRED",
        "This investigation has real source/effect provenance. Pass --fabricate-synthetic-fixture to emit an explicit approved synthetic aw-suite/1, or include the admitted execution_scope to export aw-suite/3. The CLI will not silently fabricate a synthetic fixture."
      );
    }
    return realAuthorizedRegressionYaml(
      document,
      {
        caseId: selected.caseId,
        facts: selected.facts,
        criterionId: selected.criterionId,
        statement: selected.statement,
        ...(selected.permittedRefusal === undefined ? {} : { permittedRefusal: selected.permittedRefusal })
      },
      real
    );
  }
  const provenance = [
    `Reviewed regression draft exported from investigation of run ${document.runId}.`,
    `Pinned suite ${identities.suiteId} revision ${identities.suiteRevisionId} case ${identities.caseId} criterion ${document.criterionId}.`,
    `Original machine verdict ${document.verdict} is unchanged. Failing chatbot output is not the expected answer.`,
    real !== undefined
      ? `Approved transformation to a fabricated synthetic fixture from real ${real.dataOrigin}/${real.effects} provenance.`
      : "Hosted semantic case — not a local deterministic packet. Use test --investigation or test --suite with a new quote and --max-credits. test --local cannot admit this file."
  ].join(" ");
  const lines = [
    "# Reviewed regression draft. Expected facts come from the original condition, not the failing output.",
    real !== undefined
      ? "# Approved fabricated synthetic fixture. Real source/effect provenance is recorded in the description only."
      : "# Hosted semantic case. Not a local deterministic packet.",
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
  cwd = process.cwd(),
  options: { readonly fabricateSyntheticFixture?: boolean } = {}
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
  const yaml = regressionDraftYaml(document, {
    ...(options.fabricateSyntheticFixture === true ? { fabricateSyntheticFixture: true } : {})
  });
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, yaml, "utf8");
  return { path: absolute, yaml };
}

type SelectedRegression = {
  readonly caseId: string;
  readonly facts: readonly string[];
  readonly permittedRefusal?: boolean;
  readonly criterionId: string;
  readonly statement: string;
};

type RealInvestigationProvenance = {
  readonly dataOrigin: string;
  readonly environment: string;
  readonly effects: string;
  readonly executionScope?: { readonly scopeId: string; readonly schemaVersion?: string };
};

function investigationRealProvenance(document: InvestigationExport): RealInvestigationProvenance | undefined {
  const identities = document.identities as Record<string, unknown>;
  const extra = document as Record<string, unknown>;
  const dataOrigin =
    stringField(identities["dataOrigin"]) ??
    stringField(identities["data_origin"]) ??
    stringField(extra["dataOrigin"]) ??
    stringField(extra["data_origin"]);
  const environment =
    stringField(identities["environment"]) ?? stringField(extra["environment"]) ?? "production";
  const effects = stringField(identities["effects"]) ?? stringField(extra["effects"]) ?? "informational";
  const overlay =
    stringField(identities["packetOverlay"]) ??
    stringField(identities["packet_overlay"]) ??
    stringField(extra["packetOverlay"]);
  const scopeRaw = identities["executionScope"] ?? identities["execution_scope"] ?? extra["executionScope"];
  const scope =
    scopeRaw !== null && typeof scopeRaw === "object" && !Array.isArray(scopeRaw)
      ? (scopeRaw as Record<string, unknown>)
      : undefined;
  const scopeId = scope === undefined ? undefined : stringField(scope["scopeId"] ?? scope["scope_id"]);
  const scopeSchemaVersion =
    scope === undefined ? undefined : stringField(scope["schemaVersion"] ?? scope["schema_version"]);
  const real =
    dataOrigin === "customer_records" ||
    dataOrigin === "mixed" ||
    overlay === "aw-packet/authorized-1" ||
    stringField(identities["schemaVersion"] ?? identities["schema_version"]) === "aw-suite/3" ||
    scopeId !== undefined;
  if (!real) return undefined;
  return {
    dataOrigin: dataOrigin ?? "customer_records",
    environment,
    effects,
    ...(scopeId === undefined
      ? {}
      : {
          executionScope: {
            scopeId,
            ...(scopeSchemaVersion === undefined ? {} : { schemaVersion: scopeSchemaVersion })
          }
        })
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function realAuthorizedRegressionYaml(
  document: InvestigationExport,
  selected: SelectedRegression,
  real: RealInvestigationProvenance
): string {
  const identities = document.identities;
  const provenance = [
    `Reviewed real-data regression draft from investigation of run ${document.runId}.`,
    `Source origin ${real.dataOrigin}; environment ${real.environment}; effects ${real.effects}.`,
    `Pinned suite ${identities.suiteId} revision ${identities.suiteRevisionId} case ${identities.caseId} criterion ${document.criterionId}.`,
    "Not a fabricated synthetic fixture. Pass --fabricate-synthetic-fixture only after an explicit approved transformation."
  ].join(" ");
  const scope = real.executionScope!;
  const lines = [
    "# Reviewed real-data regression draft. Expected facts come from the original condition.",
    "# Preserves real source/effect provenance. Not a fabricated synthetic fixture.",
    "schema_version: aw-suite/3",
    `suite_id: ${yamlQuote(`${identities.suiteId}.regression`)}`,
    `title: ${yamlQuote(`Regression: ${identities.caseId}`)}`,
    `description: ${yamlQuote(provenance)}`,
    "execution_scope:",
    `  schema_version: ${yamlQuote(scope.schemaVersion ?? "aw-execution-scope/1")}`,
    `  scope_id: ${yamlQuote(scope.scopeId)}`,
    "tags:",
    "  - regression",
    "  - investigation-export",
    "  - real-data",
    "references:"
  ];
  const referenceIds = identities.referenceIds ?? [];
  if (referenceIds.length === 0) {
    lines.push("  - id: investigation-provenance");
    lines.push("    kind: reference_facts");
    lines.push(`    content: ${yamlQuote(provenance)}`);
  } else {
    for (const id of referenceIds) {
      lines.push(`  - id: ${yamlQuote(id)}`);
      lines.push("    kind: reference_facts");
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
