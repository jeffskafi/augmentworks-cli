import { describe, expect, it } from "vitest";

import { classifyBillingRunStatus, isWaitTerminal } from "../../src/billing/status-classification.js";
import { parseBillingRunStatusResponse } from "../../src/billing/validate.js";
import { EXIT } from "../../src/errors.js";
import {
  billingRunStatusDocument,
  parsedBillingRunStatus,
  unfinishedRunningAbsentDocument
} from "./run-status-fixtures.js";

type Case = {
  readonly name: string;
  readonly overrides: Parameters<typeof parsedBillingRunStatus>[0];
  readonly waitTerminal: boolean;
  readonly releaseSuccess: boolean;
  readonly exitCode: number;
  readonly assessment: string;
  readonly work: string;
};

const cases: readonly Case[] = [
  {
    name: "AUG-11 running/absent/0-of-10/null-outcome",
    overrides: {
      executionStatus: "running",
      evaluationStatus: "absent",
      outcome: null,
      completedAttempts: 0,
      plannedAttempts: 10,
      plannedJudgeJobs: 0
    },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "nonterminal"
  },
  {
    name: "queued absent is still incomplete",
    overrides: { executionStatus: "queued", evaluationStatus: "absent", plannedJudgeJobs: 0 },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "nonterminal"
  },
  {
    name: "connected pending is incomplete",
    overrides: { executionStatus: "connected", evaluationStatus: "pending", plannedJudgeJobs: 4 },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "nonterminal"
  },
  {
    name: "cancel_requested remains nonterminal",
    overrides: { executionStatus: "cancel_requested", evaluationStatus: "pending" },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "nonterminal"
  },
  {
    name: "completed pending grading",
    overrides: { executionStatus: "completed", evaluationStatus: "pending", plannedJudgeJobs: 4 },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "terminal"
  },
  {
    name: "completed partial grading",
    overrides: {
      executionStatus: "completed",
      evaluationStatus: "partial",
      plannedJudgeJobs: 4,
      retryEligible: true
    },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "terminal"
  },
  {
    name: "completed hybrid absent with planned judge jobs",
    overrides: {
      executionStatus: "completed",
      evaluationStatus: "absent",
      plannedJudgeJobs: 4,
      outcome: null
    },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "terminal"
  },
  {
    name: "deterministic-only completed success with passed outcome",
    overrides: {
      executionStatus: "completed",
      evaluationStatus: "absent",
      outcome: "passed",
      plannedJudgeJobs: 0
    },
    waitTerminal: true,
    releaseSuccess: true,
    exitCode: EXIT.OK,
    assessment: "passed",
    work: "terminal"
  },
  {
    name: "deterministic-only completed success with omitted outcome (2A)",
    overrides: {
      executionStatus: "completed",
      evaluationStatus: "absent",
      plannedJudgeJobs: 0
    },
    waitTerminal: true,
    releaseSuccess: true,
    exitCode: EXIT.OK,
    assessment: "passed",
    work: "terminal"
  },
  {
    name: "deterministic-only completed failed outcome",
    overrides: {
      executionStatus: "completed",
      evaluationStatus: "absent",
      outcome: "failed",
      plannedJudgeJobs: 0
    },
    waitTerminal: true,
    releaseSuccess: false,
    exitCode: EXIT.ASSESSMENT_FAILED,
    assessment: "failed",
    work: "terminal"
  },
  {
    name: "graded complete passed",
    overrides: {
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: "passed",
      plannedJudgeJobs: 4,
      completedJudgeJobs: 4
    },
    waitTerminal: true,
    releaseSuccess: true,
    exitCode: EXIT.OK,
    assessment: "passed",
    work: "terminal"
  },
  {
    name: "graded complete failed",
    overrides: {
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: "failed"
    },
    waitTerminal: true,
    releaseSuccess: false,
    exitCode: EXIT.ASSESSMENT_FAILED,
    assessment: "failed",
    work: "terminal"
  },
  {
    name: "graded complete with null outcome is not a pass",
    overrides: {
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: null
    },
    waitTerminal: true,
    releaseSuccess: false,
    exitCode: EXIT.ASSESSMENT_FAILED,
    assessment: "failed",
    work: "terminal"
  },
  {
    name: "evaluator error",
    overrides: { executionStatus: "completed", evaluationStatus: "error" },
    waitTerminal: true,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_ERROR,
    assessment: "error",
    work: "terminal"
  },
  {
    name: "unsupported evaluation",
    overrides: { executionStatus: "completed", evaluationStatus: "unsupported" },
    waitTerminal: true,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_ERROR,
    assessment: "unsupported",
    work: "terminal"
  },
  {
    name: "cancelled interrupts wait",
    overrides: { executionStatus: "cancelled", evaluationStatus: "absent", plannedJudgeJobs: 0 },
    waitTerminal: true,
    releaseSuccess: false,
    exitCode: EXIT.INTERRUPTED,
    assessment: "interrupted",
    work: "terminal"
  },
  {
    name: "cancelled pending still interrupts",
    overrides: { executionStatus: "cancelled", evaluationStatus: "pending" },
    waitTerminal: true,
    releaseSuccess: false,
    exitCode: EXIT.INTERRUPTED,
    assessment: "interrupted",
    work: "terminal"
  },
  {
    name: "failed execution with pending grading continues wait",
    overrides: { executionStatus: "failed", evaluationStatus: "pending", plannedJudgeJobs: 4 },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "terminal"
  },
  {
    name: "failed deterministic-only is not a pass",
    overrides: {
      executionStatus: "failed",
      evaluationStatus: "absent",
      plannedJudgeJobs: 0,
      outcome: null
    },
    waitTerminal: true,
    releaseSuccess: false,
    exitCode: EXIT.ASSESSMENT_FAILED,
    assessment: "failed",
    work: "terminal"
  },
  {
    name: "unknown execution is not success",
    overrides: { executionStatus: "expired", evaluationStatus: "absent", plannedJudgeJobs: 0 },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "unknown",
    work: "unknown"
  },
  {
    name: "running complete-passed cannot pass a release gate",
    overrides: {
      executionStatus: "running",
      evaluationStatus: "complete",
      outcome: "passed"
    },
    waitTerminal: false,
    releaseSuccess: false,
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    assessment: "incomplete",
    work: "nonterminal"
  }
];

describe("billing run status classification", () => {
  it.each(cases)("$name", (row) => {
    const status = parsedBillingRunStatus(row.overrides);
    const classified = classifyBillingRunStatus(status);
    expect(classified.observation).toBe("success");
    expect(classified.waitTerminal).toBe(row.waitTerminal);
    expect(classified.releaseSuccess).toBe(row.releaseSuccess);
    expect(classified.exitCode).toBe(row.exitCode);
    expect(classified.assessment).toBe(row.assessment);
    expect(classified.work).toBe(row.work);
    expect(isWaitTerminal(status)).toBe(row.waitTerminal);
  });

  it("rejects unknown outcomes instead of treating them as a pass", () => {
    expect(() =>
      parseBillingRunStatusResponse(
        billingRunStatusDocument({
          executionStatus: "completed",
          evaluationStatus: "complete",
          outcome: "pass"
        })
      )
    ).toThrow(/cannot be interpreted/i);
  });

  it("rejects unknown evaluation statuses fail-closed", () => {
    expect(() =>
      parseBillingRunStatusResponse(
        billingRunStatusDocument({
          executionStatus: "completed",
          evaluationStatus: "running"
        })
      )
    ).toThrow(/cannot be interpreted/i);
  });

  it("does not classify the constructed AUG-11 reproduction as wait-terminal success", () => {
    const status = parseBillingRunStatusResponse(unfinishedRunningAbsentDocument());
    const classified = classifyBillingRunStatus(status);
    expect(status.executionStatus).toBe("running");
    expect(status.evaluationStatus).toBe("absent");
    expect(status.progress.completedAttempts).toBe(0);
    expect(status.progress.plannedAttempts).toBe(10);
    expect(status.outcome).toBeNull();
    expect(classified.waitTerminal).toBe(false);
    expect(classified.releaseSuccess).toBe(false);
    expect(classified.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });
});
