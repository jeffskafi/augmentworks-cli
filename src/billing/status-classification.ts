import { EXIT } from "../errors.js";
import {
  isNonterminalBillingExecutionStatus,
  type BillingAssessmentOutcome,
  type BillingRunStatus
} from "./protocol.js";

/**
 * Billing run-status classification (AUG-11).
 *
 * Observation, terminal work, and successful assessment are separate:
 *
 * | Layer | Meaning | Release gate |
 * | --- | --- | --- |
 * | Observation | `GET /v1/billing/status` parsed | Never. HTTP success is not a pass. |
 * | Work | Target execution reached a known terminal relay status | Wait may stop. Assessment may still fail. |
 * | Assessment | A resolved applicable outcome the CLI may treat as a pass | Exit `0` / `release_success` only. |
 *
 * Combinations (main-owned `aw-billing/1`; `executionStatus` is a free string;
 * `evaluationStatus` is enumerated; `outcome` is optional additive and is not
 * currently produced by Stage 2A `cli_billing_status_v1`):
 *
 * | execution | evaluation | notes | wait | assessment exit |
 * | --- | --- | --- | --- | --- |
 * | running/queued/connected/cancel_requested | absent | Deterministic-only still executing. AUG-11 reproduction: 0-of-N attempts, null outcome. | continue | 11 |
 * | running/… | pending/partial | Hybrid still executing or grading. | continue | 11 |
 * | completed | absent, plannedJudgeJobs=0 | Terminal deterministic-only. Outcome `passed` or omitted (2A). | stop | 0, or 10 if outcome failed/inconclusive/error |
 * | completed | absent, plannedJudgeJobs>0 | Grading expected but not present. | continue | 11 |
 * | completed | pending/partial | Saved evidence; grading incomplete. | continue | 11 |
 * | completed | complete + passed | Graded pass. | stop | 0 |
 * | completed | complete + failed/inconclusive/error/null | Graded or complete without an applicable pass. | stop | 10 |
 * | completed | error | Evaluator error. | stop | 12 |
 * | completed | unsupported | Evaluation not applicable as a pass. | stop | 12 |
 * | failed | pending/partial | Target failed; grading may still finish. | continue | 11 |
 * | failed | absent, plannedJudgeJobs=0 / complete / error / unsupported | Terminal failed work. | stop | 10, or 12 if evaluation error/unsupported |
 * | cancelled | any | User/server interruption. | stop | 130 |
 * | unknown | any | Not a documented relay status. Fail closed; do not guess success. | continue | 11 |
 */
export type RunObservationKind = "success";
export type RunWorkKind = "nonterminal" | "terminal" | "unknown";
export type RunAssessmentKind =
  | "passed"
  | "failed"
  | "incomplete"
  | "error"
  | "interrupted"
  | "unsupported"
  | "unknown";

export type ClassifiedRunStatus = {
  readonly observation: RunObservationKind;
  readonly work: RunWorkKind;
  readonly assessment: RunAssessmentKind;
  readonly waitTerminal: boolean;
  readonly releaseSuccess: boolean;
  readonly exitCode: number;
  readonly deterministicOnly: boolean;
};

type KnownExecutionKind = "nonterminal" | "completed" | "failed" | "cancelled" | "unknown";

function executionKind(status: string): KnownExecutionKind {
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (isNonterminalBillingExecutionStatus(status)) return "nonterminal";
  return "unknown";
}

function workKind(kind: KnownExecutionKind): RunWorkKind {
  if (kind === "unknown") return "unknown";
  if (kind === "nonterminal") return "nonterminal";
  return "terminal";
}

function outcomeOf(status: BillingRunStatus): BillingAssessmentOutcome | null {
  if (status.outcome === undefined || status.outcome === null) return null;
  return status.outcome as BillingAssessmentOutcome;
}

function isDeterministicOnlyAbsent(status: BillingRunStatus): boolean {
  return status.evaluationStatus === "absent" && status.progress.plannedJudgeJobs === 0;
}

function failedOutcome(outcome: BillingAssessmentOutcome | null): boolean {
  return outcome === "failed" || outcome === "inconclusive" || outcome === "error";
}

export function classifyBillingRunStatus(status: BillingRunStatus): ClassifiedRunStatus {
  const execution = executionKind(status.executionStatus);
  const work = workKind(execution);
  const deterministicOnly = isDeterministicOnlyAbsent(status);
  const outcome = outcomeOf(status);

  if (execution === "cancelled") {
    return result({
      work,
      assessment: "interrupted",
      waitTerminal: true,
      exitCode: EXIT.INTERRUPTED,
      deterministicOnly
    });
  }

  if (execution === "unknown") {
    return result({
      work,
      assessment: "unknown",
      waitTerminal: false,
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      deterministicOnly
    });
  }

  if (execution === "nonterminal") {
    return result({
      work,
      assessment: "incomplete",
      waitTerminal: false,
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      deterministicOnly
    });
  }

  switch (status.evaluationStatus) {
    case "pending":
    case "partial":
      return result({
        work,
        assessment: "incomplete",
        waitTerminal: false,
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        deterministicOnly
      });
    case "error":
      return result({
        work,
        assessment: "error",
        waitTerminal: true,
        exitCode: EXIT.EVALUATION_ERROR,
        deterministicOnly
      });
    case "unsupported":
      return result({
        work,
        assessment: "unsupported",
        waitTerminal: true,
        exitCode: EXIT.EVALUATION_ERROR,
        deterministicOnly
      });
    case "absent":
      if (!deterministicOnly) {
        return result({
          work,
          assessment: "incomplete",
          waitTerminal: false,
          exitCode: EXIT.EVALUATION_INCOMPLETE,
          deterministicOnly
        });
      }
      if (execution === "failed" || failedOutcome(outcome)) {
        return result({
          work,
          assessment: "failed",
          waitTerminal: true,
          exitCode: EXIT.ASSESSMENT_FAILED,
          deterministicOnly
        });
      }
      return result({
        work,
        assessment: "passed",
        waitTerminal: true,
        exitCode: EXIT.OK,
        deterministicOnly
      });
    case "complete":
      if (execution === "failed" || failedOutcome(outcome) || outcome !== "passed") {
        return result({
          work,
          assessment: "failed",
          waitTerminal: true,
          exitCode: EXIT.ASSESSMENT_FAILED,
          deterministicOnly
        });
      }
      return result({
        work,
        assessment: "passed",
        waitTerminal: true,
        exitCode: EXIT.OK,
        deterministicOnly
      });
  }
}

function result(input: {
  readonly work: RunWorkKind;
  readonly assessment: RunAssessmentKind;
  readonly waitTerminal: boolean;
  readonly exitCode: number;
  readonly deterministicOnly: boolean;
}): ClassifiedRunStatus {
  return {
    observation: "success",
    work: input.work,
    assessment: input.assessment,
    waitTerminal: input.waitTerminal,
    releaseSuccess: input.exitCode === EXIT.OK,
    exitCode: input.exitCode,
    deterministicOnly: input.deterministicOnly
  };
}

export function isWaitTerminal(status: BillingRunStatus): boolean {
  return classifyBillingRunStatus(status).waitTerminal;
}

export function billingStatusExitCode(status: BillingRunStatus): number {
  return classifyBillingRunStatus(status).exitCode;
}
