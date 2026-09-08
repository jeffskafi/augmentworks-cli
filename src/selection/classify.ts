import { EXIT } from "../errors.js";
import type { ManifestReleasePolicyResult } from "./schema.js";
import { createsBillableCompileError } from "./errors.js";

export type ManifestGateAssessment =
  | "passed"
  | "blocked"
  | "incomplete"
  | "incompatible"
  | "evaluator_error"
  | "unsupported";

export interface ManifestGateClassification {
  readonly observation: "succeeded";
  readonly assessment: ManifestGateAssessment;
  readonly exitCode: number;
  readonly reasonCodes: readonly string[];
}

export function classifyManifestReleasePolicy(
  result: ManifestReleasePolicyResult
): ManifestGateClassification {
  if (result.createsBillableRun) {
    throw createsBillableCompileError();
  }
  const reasonCodes = result.reasons.map((reason) => reason.code);
  if (reasonCodes.includes("evaluator_error")) {
    return {
      observation: "succeeded",
      assessment: "evaluator_error",
      exitCode: EXIT.EVALUATION_ERROR,
      reasonCodes
    };
  }
  if (result.decision === "incompatible" || reasonCodes.includes("substituted_shard")) {
    return {
      observation: "succeeded",
      assessment: "incompatible",
      exitCode: EXIT.CONFIG,
      reasonCodes
    };
  }
  if (result.decision === "block") {
    return {
      observation: "succeeded",
      assessment: "blocked",
      exitCode: EXIT.ASSESSMENT_FAILED,
      reasonCodes
    };
  }
  if (
    result.decision === "incomplete" ||
    result.coverageComplete === false ||
    reasonCodes.includes("missing_shard") ||
    reasonCodes.includes("incomplete_shard")
  ) {
    return {
      observation: "succeeded",
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      reasonCodes
    };
  }
  if (result.decision === "pass" && result.coverageComplete) {
    return {
      observation: "succeeded",
      assessment: "passed",
      exitCode: EXIT.OK,
      reasonCodes
    };
  }
  return {
    observation: "succeeded",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    reasonCodes: [...reasonCodes, "unsupported_decision"]
  };
}
