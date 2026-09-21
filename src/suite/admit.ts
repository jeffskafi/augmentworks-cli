import { DISCLOSURE_VERSION } from "../assessment/schema.js";
import type { AssessmentReferencePayload } from "../assessment/bundle.js";
import type { CreateRunAssessment } from "../cloud/protocol.js";
import type { LoadedCustomerSuite } from "./load.js";
import {
  CUSTOMER_OWNED_SUITE_PACKET,
  CUSTOMER_OWNED_SUITE_PACKET_V2,
  CUSTOMER_OWNED_SUITE_PACKET_V3,
  isAuthorizedCustomerSuite,
  isLiveCustomerSuite,
  suiteEvaluationMode
} from "./schema.js";

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

export function suitePacketBinding(loaded?: LoadedCustomerSuite): { key: string; version: string } {
  if (loaded !== undefined && isAuthorizedCustomerSuite(loaded.document)) {
    return {
      key: CUSTOMER_OWNED_SUITE_PACKET_V3.key,
      version: CUSTOMER_OWNED_SUITE_PACKET_V3.version
    };
  }
  if (loaded !== undefined && isLiveCustomerSuite(loaded.document)) {
    return {
      key: CUSTOMER_OWNED_SUITE_PACKET_V2.key,
      version: CUSTOMER_OWNED_SUITE_PACKET_V2.version
    };
  }
  return {
    key: CUSTOMER_OWNED_SUITE_PACKET.key,
    version: CUSTOMER_OWNED_SUITE_PACKET.version
  };
}

export function suiteCreateFields(
  loaded: LoadedCustomerSuite,
  pin: SuiteRevisionPin
): CreateRunAssessment {
  const evaluationMode = suiteEvaluationMode(loaded.document);
  const packet = suitePacketBinding(loaded);
  return {
    plan_hash: pin.contentHash,
    profile: "custom",
    evaluation_mode: evaluationMode,
    disclosure_version: evaluationMode === "hybrid" ? DISCLOSURE_VERSION : null,
    selected_scenario_ids: loaded.document.cases.map(
      (suiteCase) => `${packet.key}/${packet.version}/${suiteCase.caseId}`
    ),
    packet_bindings: [
      {
        key: packet.key,
        version: packet.version
      }
    ],
    reference_bundle: buildSuiteReferencePayload(loaded),
    suite_id: pin.suiteId,
    suite_revision_id: pin.revisionId,
    suite_content_hash: pin.contentHash
  };
}
