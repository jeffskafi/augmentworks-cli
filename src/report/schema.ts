import { z } from "zod";

export const RUN_REPORT_SCHEMA_VERSION = "aw-run-report/1" as const;
export const RUN_REPORT_EXPORT_SCHEMA_VERSION = "aw-run-report-export/1" as const;
export const CRITERION_DETAIL_SCHEMA_VERSION = "aw-criterion-detail-read/1" as const;

export const REPORT_PATH_TEMPLATE = "/v1/relay/runs/{runId}/report";
export const CRITERION_PATH_TEMPLATE =
  "/v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria";
export const CRITERION_API_ALIAS_TEMPLATE =
  "/api/v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria";

export const REPORT_PAGE_DEFAULT = 20;
export const REPORT_PAGE_MAX = 60;
export const REPORT_PAGE_BYTES_MAX = 512 * 1024;
export const CRITERION_PAGE_DEFAULT = 8;
export const CRITERION_PAGE_MAX = 16;
export const REPORT_RETRY_BUDGET_MS = 20_000;
export const REPORT_RETRY_MAX_ATTEMPTS = 4;
export const REPORT_RETRY_AFTER_CAP_MS = 5_000;
export const REPORT_MAX_PAGES = 64;
export const CRITERION_MAX_PAGES = 256;

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const boundedUrl = z.string().url().max(2_048);

export const ReportExecutionStatusSchema = z.enum([
  "queued",
  "connected",
  "running",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed"
]);

export const ReportOutcomeSchema = z.enum(["passed", "failed", "inconclusive", "error"]).nullable();

export const ReportEvaluationStatusSchema = z.enum([
  "absent",
  "pending",
  "complete",
  "partial",
  "error"
]);

export const AttemptExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "not_started"
]);

export const AttemptCleanupStateSchema = z.enum([
  "not_required",
  "pending",
  "completed",
  "failed",
  "not_attempted"
]);

export const AttemptOutcomeSchema = z
  .enum(["pass", "fail", "error", "not_run", "uncertain"])
  .nullable();

export const MappedAvailabilitySchema = z.enum(["available", "redacted", "missing", "purged"]);

export const EvaluationBindingSchema = z
  .object({
    evaluationId: identifier,
    evaluationRevision: z.number().int().min(0).max(1_000_000),
    snapshotHash: sha256,
    executionResultHash: sha256.nullable(),
    assessmentPlanHash: sha256.nullable(),
    referenceBundleHash: sha256.nullable(),
    graderConfigHash: sha256.nullable()
  })
  .strict();

export const CoverageSchema = z
  .object({
    plannedAttempts: z.number().int().min(0).max(10_000).nullable(),
    completedAttempts: z.number().int().min(0).max(10_000).nullable(),
    requiredJudgmentsPlanned: z.number().int().min(0).max(10_000).nullable(),
    requiredJudgmentsComplete: z.number().int().min(0).max(10_000).nullable()
  })
  .strict();

export const MappedResponseSchema = z
  .object({
    availability: MappedAvailabilitySchema,
    text: z.string().max(64 * 1024).nullable(),
    sha256: sha256.nullable(),
    truncated: z.boolean(),
    turnId: identifier.nullable(),
    evidenceId: identifier.nullable()
  })
  .strict();

export const RetentionSchema = z
  .object({
    retainUntil: timestamp.nullable(),
    policyVersion: z.string().min(1).max(200).nullable(),
    purgedAt: timestamp.nullable(),
    contentAvailable: z.boolean()
  })
  .strict();

export const ReportPageSchema = z
  .object({
    nextCursor: z.string().min(1).max(4_096).nullable(),
    hasMore: z.boolean(),
    totalAttempts: z.number().int().min(0).max(10_000).nullable()
  })
  .strict();

export const ReportAttemptSchema = z
  .object({
    attemptId: identifier,
    scenarioId: identifier,
    repetitionIndex: z.number().int().min(0).max(999),
    attemptNumber: z.number().int().min(1).max(1_000),
    executionStatus: AttemptExecutionStatusSchema,
    cleanupState: AttemptCleanupStateSchema,
    criterionIndexUrl: boundedUrl.nullable(),
    mappedResponse: MappedResponseSchema,
    outcome: AttemptOutcomeSchema
  })
  .strict();

export const RunReportSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_SCHEMA_VERSION),
    runId: identifier,
    workspaceId: identifier,
    dashboardUrl: boundedUrl,
    asOf: timestamp,
    executionStatus: ReportExecutionStatusSchema,
    outcome: ReportOutcomeSchema,
    creditState: z.enum(["reserved", "consumed", "released"]),
    evaluationStatus: ReportEvaluationStatusSchema,
    evaluationBinding: EvaluationBindingSchema.nullable(),
    aggregate: z.unknown().nullable(),
    coverage: CoverageSchema,
    attempts: z.array(ReportAttemptSchema).max(REPORT_PAGE_MAX),
    retention: RetentionSchema,
    reportReady: z.boolean(),
    page: ReportPageSchema,
    createsBillableRun: z.literal(false)
  })
  .strict();

export const ReportErrorSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_SCHEMA_VERSION),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(500),
        retryable: z.boolean()
      })
      .strict()
  })
  .strict();

export const CriterionVerdictSchema = z.enum([
  "pass",
  "fail",
  "error",
  "not_judged",
  "uncertain"
]);

export const CriterionEvidenceSchema = z
  .object({
    availability: MappedAvailabilitySchema,
    text: z.string().max(64 * 1024).nullable(),
    sha256: sha256.nullable(),
    truncated: z.boolean()
  })
  .strict();

export const CriterionIndexItemSchema = z
  .object({
    criterionId: identifier,
    criterionKey: identifier.optional(),
    required: z.boolean(),
    verdict: CriterionVerdictSchema,
    detailUrl: boundedUrl.nullable(),
    evidence: CriterionEvidenceSchema.optional()
  })
  .passthrough();

export const CriterionIndexSchema = z
  .object({
    schemaVersion: z.literal(CRITERION_DETAIL_SCHEMA_VERSION),
    runId: identifier,
    workspaceId: identifier.optional(),
    evaluationId: identifier,
    evaluationRevision: z.number().int().min(0).max(1_000_000),
    snapshotHash: sha256,
    attemptId: identifier,
    criteria: z.array(CriterionIndexItemSchema).max(CRITERION_PAGE_MAX),
    page: z
      .object({
        nextCursor: z.string().min(1).max(4_096).nullable(),
        hasMore: z.boolean(),
        totalCriteria: z.number().int().min(0).max(10_000).nullable()
      })
      .strict()
  })
  .passthrough();

export const CriterionDetailSchema = z
  .object({
    schemaVersion: z.literal(CRITERION_DETAIL_SCHEMA_VERSION),
    runId: identifier,
    workspaceId: identifier.optional(),
    evaluationId: identifier,
    evaluationRevision: z.number().int().min(0).max(1_000_000),
    snapshotHash: sha256,
    attemptId: identifier,
    criterionId: identifier,
    criterionKey: identifier.optional(),
    required: z.boolean(),
    verdict: CriterionVerdictSchema,
    evidence: CriterionEvidenceSchema
  })
  .passthrough();

export const ExportDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    retryable: z.boolean().optional()
  })
  .strict();

export const RunReportExportSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_EXPORT_SCHEMA_VERSION),
    retrieved: z.boolean(),
    complete: z.boolean(),
    report: RunReportSchema.optional(),
    criteria: z.array(z.record(z.string(), z.unknown())).optional(),
    diagnostics: z.array(ExportDiagnosticSchema),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(500),
        retryable: z.boolean(),
        httpStatus: z.number().int().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type RunReport = z.infer<typeof RunReportSchema>;
export type RunReportAttempt = z.infer<typeof ReportAttemptSchema>;
export type EvaluationBinding = z.infer<typeof EvaluationBindingSchema>;
export type MappedResponse = z.infer<typeof MappedResponseSchema>;
export type CriterionIndex = z.infer<typeof CriterionIndexSchema>;
export type CriterionDetail = z.infer<typeof CriterionDetailSchema>;
export type ExportDiagnostic = z.infer<typeof ExportDiagnosticSchema>;
export type RunReportExport = z.infer<typeof RunReportExportSchema>;
export type ReportErrorEnvelope = z.infer<typeof ReportErrorSchema>;

export function reportPath(runId: string): string {
  return `/v1/relay/runs/${encodeURIComponent(runId)}/report`;
}
