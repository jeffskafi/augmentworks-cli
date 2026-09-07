import type { BillingRunStatus } from "../../src/billing/protocol.js";
import { parseBillingRunStatusResponse } from "../../src/billing/validate.js";

export const RUN_STATUS_WORKSPACE = "11111111-1111-4111-8111-111111111111";
export const RUN_STATUS_RUN_ID = "66666666-6666-4666-8666-666666666666";

export type RunStatusFixtureOverrides = {
  readonly executionStatus?: string;
  readonly evaluationStatus?: string;
  readonly outcome?: string | null;
  readonly completedAttempts?: number;
  readonly plannedAttempts?: number;
  readonly completedJudgeJobs?: number;
  readonly plannedJudgeJobs?: number;
  readonly nextActions?: readonly string[];
  readonly savedEvidence?: boolean;
  readonly retryEligible?: boolean;
  readonly retryReason?: string | null;
};

export function billingRunStatusDocument(
  overrides: RunStatusFixtureOverrides = {}
): Record<string, unknown> {
  return {
    schemaVersion: "aw-billing/1",
    runId: RUN_STATUS_RUN_ID,
    workspaceId: RUN_STATUS_WORKSPACE,
    originalRunId: RUN_STATUS_RUN_ID,
    executionStatus: overrides.executionStatus ?? "completed",
    evaluationStatus: overrides.evaluationStatus ?? "pending",
    credit: {
      reservedUnits: 0,
      consumedUnits: 10,
      releasedUnits: 0,
      compensatedUnits: 0
    },
    progress: {
      completedAttempts: overrides.completedAttempts ?? 10,
      plannedAttempts: overrides.plannedAttempts ?? 10,
      completedJudgeJobs: overrides.completedJudgeJobs ?? 0,
      plannedJudgeJobs: overrides.plannedJudgeJobs ?? 0
    },
    savedEvidence: overrides.savedEvidence ?? true,
    retryEligible: overrides.retryEligible ?? false,
    retryReason: overrides.retryReason ?? null,
    nextActions: [...(overrides.nextActions ?? ["wait", "inspect", "open_dashboard"])],
    dashboardUrl: `https://augmentworks.ai/portal/runs/${RUN_STATUS_RUN_ID}`,
    asOf: "2026-09-06T17:20:00.000Z",
    ...(overrides.outcome === undefined ? {} : { outcome: overrides.outcome })
  };
}

export function parsedBillingRunStatus(overrides: RunStatusFixtureOverrides = {}): BillingRunStatus {
  return parseBillingRunStatusResponse(billingRunStatusDocument(overrides));
}

/** AUG-11 reproduction: running execution, absent evaluation, 0 of 10 attempts, null outcome. */
export function unfinishedRunningAbsentDocument(): Record<string, unknown> {
  return billingRunStatusDocument({
    executionStatus: "running",
    evaluationStatus: "absent",
    outcome: null,
    completedAttempts: 0,
    plannedAttempts: 10,
    completedJudgeJobs: 0,
    plannedJudgeJobs: 0,
    savedEvidence: false,
    nextActions: ["wait", "inspect"]
  });
}

export function deterministicCompletedDocument(
  outcome: string | null | undefined = "passed"
): Record<string, unknown> {
  return billingRunStatusDocument({
    executionStatus: "completed",
    evaluationStatus: "absent",
    ...(outcome === undefined ? {} : { outcome }),
    completedAttempts: 10,
    plannedAttempts: 10,
    completedJudgeJobs: 0,
    plannedJudgeJobs: 0,
    nextActions: ["inspect", "open_dashboard"]
  });
}
