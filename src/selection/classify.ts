import { EXIT } from "../errors.js";
import { createsBillableCompileError, manifestGateResponseMismatchError } from "./errors.js";
import { mapServerReasonCodes } from "./gate-v2.js";
import type { ManifestReleasePolicyV2 } from "./schema.js";

export type ManifestGateAssessment =
  | "passed"
  | "blocked"
  | "incomplete"
  | "incompatible"
  | "unsupported";

export interface ManifestGateClassification {
  readonly observation: "succeeded";
  readonly assessment: ManifestGateAssessment;
  readonly exitCode: number;
  readonly reasonCodes: readonly string[];
}

export function classifyManifestReleasePolicy(
  result: ManifestReleasePolicyV2
): ManifestGateClassification {
  if (result.createsBillableRun) {
    throw createsBillableCompileError();
  }
  const reasonCodes = mapServerReasonCodes(result.reasonCodes);
  const allTerminalPass =
    result.resolvedShards.length > 0 &&
    result.resolvedShards.every(
      (shard) =>
        shard.executionState === "completed" &&
        shard.evaluationStatus === "completed" &&
        shard.decision === "pass"
    );
  if (result.decision === "pass" && result.coverageComplete && result.evidenceSource === "server") {
    if (!allTerminalPass || reasonCodes.length > 0) {
      throw manifestGateResponseMismatchError();
    }
    return {
      observation: "succeeded",
      assessment: "passed",
      exitCode: EXIT.OK,
      reasonCodes
    };
  }
  if (result.decision === "incompatible") {
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
  if (result.decision === "incomplete") {
    return {
      observation: "succeeded",
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      reasonCodes
    };
  }
  return {
    observation: "succeeded",
    assessment: "unsupported",
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    reasonCodes: [...reasonCodes, "MANIFEST_GATE_CONTRACT_UNSUPPORTED"]
  };
}
