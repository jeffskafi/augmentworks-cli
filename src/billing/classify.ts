import { EXIT } from "../errors.js";
import { isBillingExecutionStatus, type BillingRunStatus } from "./protocol.js";

/**
 * Outcome values the relay contract treats as resolved assessments.
 * The billing status schema leaves `outcome` unconstrained; unknown strings
 * are observable but never a release pass.
 */
export const BILLING_RESOLVED_OUTCOMES = ["passed", "failed", "inconclusive", "error"] as const;

export type BillingResolvedOutcome = (typeof BILLING_RESOLVED_OUTCOMES)[number];

export type BillingRunWork = "in_progress" | "terminal";

export type BillingRunAssessment =
  | "passed"
  | "failed"
  | "incomplete"
  | "evaluator_error"
  | "interrupted"
  | "unsupported"
  | "unknown";

/**
 * One explicit classification for a successfully parsed billing status.
 *
 * `observation: "succeeded"` means the HTTP query parsed. That is not a
 * release pass. `run status --json` keeps `ok: true` for observation so
 * operators can inspect an unfinished run; `exit_code` and `assessment`
 * are the gate. `run wait` continues while `waitTerminal` is false.
 *
 * Combinations (execution × evaluation × outcome → wait / assessment / exit):
 *
 * | execution | evaluation | outcome | wait | assessment | exit |
 * | --- | --- | --- | --- | --- | --- |
 * | queued/connected/running/cancel_requested | absent | null | continue | incomplete | 11 |
 * | running | absent | 0/N attempts, null | continue | incomplete | 11 |
 * | completed | absent | passed | terminal | passed (deterministic-only) | 0 |
 * | completed | absent | failed/inconclusive/error | terminal | failed | 10 |
 * | completed | absent | null/unknown | terminal | incomplete/unknown | 11 |
 * | completed | pending/partial | any | continue | incomplete | 11 |
 * | completed | complete | passed | terminal | passed | 0 |
 * | completed | complete | failed/inconclusive/error | terminal | failed | 10 |
 * | completed | complete | null/unknown | terminal | incomplete/unknown | 11 |
 * | completed | error | any | terminal | evaluator_error | 12 |
 * | completed | unsupported | any | terminal | unsupported | 11 |
 * | failed | not pending/partial | any | terminal | failed | 10 |
 * | cancelled | not pending/partial | any | terminal | interrupted | 130 |
 * | failed/cancelled | error | any | terminal | evaluator_error | 12 |
 * | unknown | not pending/partial | any | terminal | unknown | 11 |
 *
 * Ambiguous contract combinations never silently pass. Evaluation `error`
 * takes precedence over execution failure so exit 12 stays distinct from 10.
 */
export type BillingRunClassification = {
  readonly observation: "succeeded";
  readonly work: BillingRunWork;
  readonly waitTerminal: boolean;
  readonly assessment: BillingRunAssessment;
  readonly exitCode: number;
  readonly deterministicOnly: boolean;
};

export function isKnownBillingExecutionStatus(value: string): boolean {
  return isBillingExecutionStatus(value);
}

export function isResolvedBillingOutcome(value: string): value is BillingResolvedOutcome {
  return (BILLING_RESOLVED_OUTCOMES as readonly string[]).includes(value);
}

function executionWork(executionStatus: string): BillingRunWork | "unknown" {
  if (!isBillingExecutionStatus(executionStatus)) return "unknown";
  if (
    executionStatus === "completed" ||
    executionStatus === "failed" ||
    executionStatus === "cancelled"
  ) {
    return "terminal";
  }
  return "in_progress";
}

function resolvedOutcome(
  outcome: string | null | undefined
): BillingResolvedOutcome | null | "unknown" {
  if (outcome === undefined || outcome === null || outcome === "") return null;
  if (isResolvedBillingOutcome(outcome)) return outcome;
  return "unknown";
}

export function classifyBillingRunStatus(status: BillingRunStatus): BillingRunClassification {
  const execution = executionWork(status.executionStatus);
  const work: BillingRunWork = execution === "in_progress" ? "in_progress" : "terminal";
  const gradingInProgress =
    status.evaluationStatus === "pending" || status.evaluationStatus === "partial";
  const waitTerminal = work === "terminal" && !gradingInProgress;
  const outcome = resolvedOutcome(status.outcome);
  const deterministicOnly =
    status.executionStatus === "completed" && status.evaluationStatus === "absent";

  let assessment: BillingRunAssessment;
  let exitCode: number;

  if (execution === "in_progress" || gradingInProgress) {
    assessment = "incomplete";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  } else if (status.evaluationStatus === "error") {
    assessment = "evaluator_error";
    exitCode = EXIT.EVALUATION_ERROR;
  } else if (status.executionStatus === "cancelled") {
    assessment = "interrupted";
    exitCode = EXIT.INTERRUPTED;
  } else if (status.evaluationStatus === "unsupported") {
    assessment = "unsupported";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  } else if (execution === "unknown") {
    assessment = "unknown";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  } else if (
    status.executionStatus === "failed" ||
    outcome === "failed" ||
    outcome === "inconclusive" ||
    outcome === "error"
  ) {
    assessment = "failed";
    exitCode = EXIT.ASSESSMENT_FAILED;
  } else if (outcome === "unknown") {
    assessment = "unknown";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  } else if (
    outcome === "passed" &&
    status.executionStatus === "completed" &&
    (status.evaluationStatus === "complete" || status.evaluationStatus === "absent")
  ) {
    assessment = "passed";
    exitCode = EXIT.OK;
  } else {
    assessment = "incomplete";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  }

  return {
    observation: "succeeded",
    work,
    waitTerminal,
    assessment,
    exitCode,
    deterministicOnly
  };
}
