import { z } from "zod";

export const INVESTIGATION_SCHEMA_VERSION = "aw-investigation-export/1" as const;
export const ISSUE_PROPOSAL_SCHEMA_VERSION = "aw-issue-proposal/1" as const;
export const FEATURE_PACKAGE_VERSION = "aw-feature/1" as const;
export const FEATURE_ERROR_SCHEMA_VERSION = "aw-feature-error/1" as const;
export const INVESTIGATION_DOCUMENT_KIND = "investigation_export" as const;
export const INVESTIGATION_SCHEMA_ID = INVESTIGATION_SCHEMA_VERSION;

export const MAX_INVESTIGATION_FILE_BYTES = 64 * 1024;
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const INVESTIGATION_PATHS = {
  export:
    "/v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria/{criterionId}/investigation"
} as const;

const identifier = z.string().min(1).max(300).regex(IDENTIFIER_PATTERN, "must be a bounded protocol identifier");
const sha256Hex = z.string().regex(SHA256_HEX_PATTERN);

const AUTHORING_KEY_MAP: Readonly<Record<string, string>> = {
  schema_version: "schemaVersion",
  package_version: "packageVersion",
  investigation_id: "investigationId",
  workspace_id: "workspaceId",
  run_id: "runId",
  evaluation_id: "evaluationId",
  evaluation_revision: "evaluationRevision",
  attempt_id: "attemptId",
  criterion_id: "criterionId",
  criterion_statement: "criterionStatement",
  reproduction_kind: "reproductionKind",
  fully_reproducible: "fullyReproducible",
  creates_billable_run: "createsBillableRun",
  suite_id: "suiteId",
  suite_revision_id: "suiteRevisionId",
  suite_content_hash: "suiteContentHash",
  case_id: "caseId",
  case_revision_id: "caseRevisionId",
  reference_ids: "referenceIds",
  rubric_id: "rubricId",
  rubric_revision_id: "rubricRevisionId",
  permitted_refusal: "permittedRefusal",
  sanitized_input: "sanitizedInput",
  failure_mode: "failureMode",
  judge_preview: "judgePreview",
  command_fragment: "commandFragment",
  expected_source: "expectedSource",
  expected_facts: "expectedFacts",
  regression_draft: "regressionDraft",
  content_hash: "contentHash",
  canonical_document: "canonicalDocument"
};

export function rewriteInvestigationKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child) => rewriteInvestigationKeys(child));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[AUTHORING_KEY_MAP[key] ?? key] = rewriteInvestigationKeys(child);
  }
  return output;
}

export function investigationSchemaVersion(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const version = record["schemaVersion"] ?? record["schema_version"];
  return typeof version === "string" ? version : undefined;
}

export function investigationPath(ids: {
  readonly runId: string;
  readonly evaluationId: string;
  readonly attemptId: string;
  readonly criterionId: string;
}): string {
  return `/v1/runs/${encodeURIComponent(ids.runId)}/evaluations/${encodeURIComponent(ids.evaluationId)}/attempts/${encodeURIComponent(ids.attemptId)}/criteria/${encodeURIComponent(ids.criterionId)}/investigation`;
}

export const InvestigationExportRequestSchema = z
  .object({
    schemaVersion: z.literal(INVESTIGATION_SCHEMA_VERSION),
    packageVersion: z.literal(FEATURE_PACKAGE_VERSION),
    runId: identifier,
    evaluationId: identifier,
    attemptId: identifier,
    criterionId: identifier
  })
  .strict();

export type InvestigationExportRequest = z.infer<typeof InvestigationExportRequestSchema>;

export const InvestigationIdentitiesSchema = z
  .object({
    suiteId: identifier,
    suiteRevisionId: identifier,
    suiteContentHash: sha256Hex,
    caseId: identifier,
    caseRevisionId: identifier.optional(),
    referenceIds: z.array(identifier).max(16).optional(),
    rubricId: identifier.optional(),
    rubricRevisionId: identifier.optional()
  })
  .passthrough();

export const InvestigationExpectedSchema = z
  .object({
    facts: z.array(z.string().min(1).max(2_000)).max(16),
    permittedRefusal: z.boolean().optional(),
    source: z.enum(["reviewed_expected_condition", "original_expected_condition"]).optional()
  })
  .passthrough();

export const InvestigationActualSchema = z
  .object({
    text: z.string().max(8_000).optional(),
    preview: z.string().max(4_000).optional(),
    excerpt: z.string().max(4_000).optional(),
    redacted: z.boolean().optional(),
    truncated: z.boolean().optional()
  })
  .passthrough();

export const InvestigationSanitizedInputSchema = z
  .object({
    text: z.string().max(8_000).optional()
  })
  .passthrough();

export const InvestigationEvidenceSchema = z
  .object({
    expected: InvestigationExpectedSchema,
    actual: InvestigationActualSchema.optional(),
    sanitizedInput: InvestigationSanitizedInputSchema.optional(),
    failureMode: z.string().min(1).max(128).optional(),
    judgePreview: z.string().max(4_000).optional()
  })
  .passthrough();

export const InvestigationMissingPrerequisiteSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(2_000),
    blocking: z.boolean().optional()
  })
  .passthrough();

export const InvestigationMappingSchema = z
  .object({
    prepare: z.boolean().optional(),
    observe: z.boolean().optional(),
    cleanup: z.boolean().optional(),
    session: z.boolean().optional()
  })
  .passthrough();

export const InvestigationCommandFragmentSchema = z
  .object({
    argv: z.array(z.string().min(1).max(500)).max(32).optional(),
    text: z.string().max(2_000).optional()
  })
  .passthrough();

export const InvestigationPrerequisitesSchema = z
  .object({
    mapping: InvestigationMappingSchema.optional(),
    missing: z.array(InvestigationMissingPrerequisiteSchema).max(32).optional(),
    commandFragment: InvestigationCommandFragmentSchema.optional()
  })
  .passthrough();

export const InvestigationLinksSchema = z
  .object({
    audience: z.string().min(1).max(64).optional()
  })
  .passthrough();

export const RegressionExpectedSourceSchema = z.enum([
  "reviewed_expected_condition",
  "original_expected_condition"
]);

export const InvestigationRegressionDraftSchema = z
  .object({
    expectedSource: RegressionExpectedSourceSchema,
    expectedFacts: z.array(z.string().min(1).max(2_000)).max(16).optional()
  })
  .passthrough();

export const InvestigationExportSchema = z
  .object({
    schemaVersion: z.literal(INVESTIGATION_SCHEMA_VERSION),
    packageVersion: z.string().min(1).max(80).optional(),
    investigationId: identifier.optional(),
    workspaceId: identifier,
    runId: identifier,
    evaluationId: identifier,
    evaluationRevision: z.number().int().min(0).max(1_000_000),
    attemptId: identifier,
    criterionId: identifier,
    criterionStatement: z.string().min(1).max(4_000).optional(),
    verdict: z.string().min(1).max(64),
    reproductionKind: z.enum(["response_only", "stateful"]),
    fullyReproducible: z.boolean(),
    createsBillableRun: z.boolean(),
    identities: InvestigationIdentitiesSchema,
    evidence: InvestigationEvidenceSchema,
    prerequisites: InvestigationPrerequisitesSchema,
    limitations: z.array(z.string().min(1).max(500)).max(32).optional(),
    links: InvestigationLinksSchema.optional(),
    regressionDraft: InvestigationRegressionDraftSchema.optional(),
    warnings: z.array(z.string().min(1).max(500)).max(32).optional()
  })
  .passthrough();

export type InvestigationExport = z.infer<typeof InvestigationExportSchema>;
export type InvestigationIdentities = z.infer<typeof InvestigationIdentitiesSchema>;
export type InvestigationExpected = z.infer<typeof InvestigationExpectedSchema>;
export type InvestigationActual = z.infer<typeof InvestigationActualSchema>;
export type InvestigationEvidence = z.infer<typeof InvestigationEvidenceSchema>;
export type InvestigationPrerequisites = z.infer<typeof InvestigationPrerequisitesSchema>;
