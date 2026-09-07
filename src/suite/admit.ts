import { DISCLOSURE_VERSION } from "../assessment/schema.js";
import type { AssessmentReferencePayload } from "../assessment/bundle.js";
import type { CreateRunAssessment } from "../cloud/protocol.js";
import type { LoadedCustomerSuite } from "./load.js";
import { CUSTOMER_OWNED_SUITE_PACKET, suiteEvaluationMode } from "./schema.js";

export type SuiteRevisionPin = {
  readonly suiteId: string;
  readonly revisionId: string;
  readonly contentHash: string;
};

export function buildSuiteReferencePayload(loaded: LoadedCustomerSuite): AssessmentReferencePayload {
  const knowledgeBoundary = loaded.document.description ?? null;
  return {
    bundleId: `bundle_${loaded.contentHash.slice(0, 12)}`,
    entries: loaded.references.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      sourceLabel: entry.path ?? `inline:${entry.id}`,
      scope: knowledgeBoundary ?? "customer-supplied suite extract",
      content: entry.content,
      contentHash: entry.contentHash,
      complete: knowledgeBoundary !== null
    })),
    refundPolicy: null,
    knowledgeBoundary,
    targetAlreadyConfigured: true
  };
}

export function suiteCreateFields(
  loaded: LoadedCustomerSuite,
  pin: SuiteRevisionPin
): CreateRunAssessment {
  const evaluationMode = suiteEvaluationMode(loaded.document);
  return {
    plan_hash: loaded.contentHash,
    profile: "custom",
    evaluation_mode: evaluationMode,
    disclosure_version: evaluationMode === "hybrid" ? DISCLOSURE_VERSION : null,
    selected_scenario_ids: loaded.document.cases.map((suiteCase) => suiteCase.caseId),
    packet_bindings: [
      {
        key: CUSTOMER_OWNED_SUITE_PACKET.key,
        version: CUSTOMER_OWNED_SUITE_PACKET.version
      }
    ],
    reference_bundle: buildSuiteReferencePayload(loaded),
    suite_id: pin.suiteId,
    suite_revision_id: pin.revisionId,
    suite_content_hash: pin.contentHash
  };
}

export function suitePacketBinding(): { key: string; version: string } {
  return {
    key: CUSTOMER_OWNED_SUITE_PACKET.key,
    version: CUSTOMER_OWNED_SUITE_PACKET.version
  };
}
