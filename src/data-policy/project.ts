import type { JsonValue } from "../config/types.js";
import type { AssessmentReferencePayload } from "../assessment/bundle.js";
import type { SafeRelayFailure } from "../cloud/client.js";
import type { RelayResult } from "../cloud/protocol.js";
import { parseRelayResult } from "../cloud/protocol.js";
import type { OperationKind } from "../errors.js";
import { representationHash } from "./hash.js";
import { inspectOutbound } from "./transform.js";
import { evaluateRetainedEvidence } from "./evidence.js";
import { dataPolicyError } from "./errors.js";
import type {
  DataHandlingReceipt,
  DataPolicyContext,
  InspectOutboundResult,
  RetainedEvidenceEvaluation
} from "./types.js";

export const DATA_POLICY_BLOCKED_FAILURE: SafeRelayFailure = {
  code: "DATA_POLICY_BLOCKED",
  safe_message: "The target response was blocked by the data policy. Evidence is unavailable.",
  retryable: false
};

export const INSUFFICIENT_EVIDENCE_FAILURE: SafeRelayFailure = {
  code: "INSUFFICIENT_EVIDENCE",
  safe_message: "Masking removed the decisive fact from the retained representation.",
  retryable: false
};

export function projectOutboundDocument(
  document: unknown,
  context: DataPolicyContext
): InspectOutboundResult {
  return inspectOutbound(document, context.policy, context.profile, context.localSecrets);
}

export function projectRelayResult(
  kind: OperationKind,
  result: RelayResult,
  context: DataPolicyContext,
  expectedFacts: readonly string[] = []
): {
  readonly disposition: "completed" | "blocked" | "insufficient_evidence";
  readonly result?: RelayResult;
  readonly failure?: SafeRelayFailure;
  readonly receipt: DataHandlingReceipt;
  readonly evidence: RetainedEvidenceEvaluation;
} {
  const inspected = inspectOutbound(result, context.policy, context.profile, context.localSecrets);
  const evidence = evaluateRetainedEvidence(inspected.representation, expectedFacts);
  if (inspected.receipt.outcome === "blocked" || inspected.blockedPaths.length > 0) {
    return {
      disposition: "blocked",
      failure: DATA_POLICY_BLOCKED_FAILURE,
      receipt: { ...inspected.receipt, outcome: "blocked" },
      evidence
    };
  }
  if (!evidence.ok) {
    return {
      disposition: "insufficient_evidence",
      failure: INSUFFICIENT_EVIDENCE_FAILURE,
      receipt: { ...inspected.receipt, outcome: "insufficient_evidence" },
      evidence
    };
  }
  try {
    const typed = parseRelayResult(kind, inspected.representation);
    return {
      disposition: "completed",
      result: typed,
      receipt: inspected.receipt,
      evidence
    };
  } catch {
    return {
      disposition: "blocked",
      failure: DATA_POLICY_BLOCKED_FAILURE,
      receipt: { ...inspected.receipt, outcome: "blocked" },
      evidence
    };
  }
}

export function projectJsonDocument(
  document: JsonValue,
  context: DataPolicyContext
): InspectOutboundResult {
  return inspectOutbound(document, context.policy, context.profile, context.localSecrets);
}

export function projectAssessmentReferencePayload(
  payload: AssessmentReferencePayload,
  context: DataPolicyContext
): AssessmentReferencePayload {
  const inspected = inspectOutbound(
    {
      bundleId: payload.bundleId,
      entries: payload.entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        sourceLabel: entry.sourceLabel,
        scope: entry.scope,
        content: entry.content,
        complete: entry.complete
      })),
      refundPolicy: payload.refundPolicy,
      knowledgeBoundary: payload.knowledgeBoundary,
      targetAlreadyConfigured: payload.targetAlreadyConfigured
    },
    context.policy,
    context.profile,
    context.localSecrets
  );
  if (inspected.receipt.outcome === "blocked") {
    throw dataPolicyError(
      "DATA_POLICY_BLOCKED",
      "Assessment reference content was blocked by the data policy before upload."
    );
  }
  const representation = inspected.representation;
  if (!isObject(representation) || !Array.isArray(representation["entries"])) {
    throw dataPolicyError(
      "DATA_POLICY_BLOCKED",
      "Assessment reference content could not be projected into a retained representation."
    );
  }
  const entries = representation["entries"].map((raw, index) => {
    const original = payload.entries[index];
    if (original === undefined || !isObject(raw) || typeof raw["content"] !== "string") {
      throw dataPolicyError(
        "DATA_POLICY_BLOCKED",
        "Assessment reference content could not be projected into a retained representation."
      );
    }
    const content = raw["content"];
    return {
      ...original,
      content,
      contentHash: representationHash(content),
      complete: original.complete && content.length > 0 && !content.includes("[REDACTED:")
    };
  });
  return { ...payload, entries };
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
