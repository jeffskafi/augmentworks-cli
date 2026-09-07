export const AW_RUN_REPORT_CONTRACT = {
  schemaVersion: "aw-run-report/1",
  exportSchemaVersion: "aw-run-report-export/1",
  criterionSchemaVersion: "aw-criterion-detail-read/1",
  source: {
    repository: "compatibility-local",
    producerIssue: "AUG-55",
    contract: "AW-QA-1",
    note:
      "Producer artifacts from the main report owner are not yet published. These compatibility fixtures follow AW-QA-1 wire names exactly."
  },
  paths: {
    report: "/v1/relay/runs/{runId}/report",
    criteria: "/v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria",
    criteriaAlias: "/api/v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria",
    authMe: "/api/v1/cli/auth/me"
  },
  requiredActions: ["run:read", "evaluation:read", "criterion_detail:read"],
  bounds: {
    reportPageDefault: 20,
    reportPageMax: 60,
    reportPageBytesMax: 524288,
    criterionPageDefault: 8,
    criterionPageMax: 16
  }
} as const;

export type AwRunReportContract = typeof AW_RUN_REPORT_CONTRACT;
