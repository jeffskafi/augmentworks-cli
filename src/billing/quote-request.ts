import type { LoadedAssessment } from "../assessment/load.js";
import { buildAssessmentReferencePayload, primaryPacket } from "../assessment/index.js";
import {
  RELAY_PROTOCOL_VERSION_V3,
  type CreateRunAssessment,
  type TargetBinding
} from "../cloud/protocol.js";
import { BILLING_SCHEMA_VERSION } from "./protocol.js";

export type QuoteAssessmentInput = {
  readonly packet: { readonly key: string; readonly version: string };
  readonly configSha256: string;
  readonly target: TargetBinding;
  readonly assessment: CreateRunAssessment;
};

export function assessmentCreateFields(assessment: LoadedAssessment): CreateRunAssessment {
  return {
    plan_hash: assessment.freezeSha256,
    profile: assessment.profile,
    evaluation_mode: assessment.evaluationMode,
    disclosure_version: assessment.disclosureVersion,
    selected_scenario_ids: assessment.document.packets.flatMap((packet) => packet.scenarios ?? []),
    packet_bindings: assessment.document.packets.map((packet) => ({
      key: packet.key,
      version: packet.version
    })),
    reference_bundle: buildAssessmentReferencePayload(assessment)
  };
}

export function primaryAssessmentPacket(assessment: LoadedAssessment): {
  key: string;
  version: string;
} {
  return {
    key: primaryPacket(assessment).key,
    version: primaryPacket(assessment).version
  };
}

export function buildBillingQuoteRequest(input: QuoteAssessmentInput): Record<string, unknown> {
  return {
    schemaVersion: BILLING_SCHEMA_VERSION,
    packet: input.packet,
    config_sha256: input.configSha256,
    target: input.target,
    assessment: input.assessment
  };
}

export function quotedCreateIntent(input: {
  readonly packet: { readonly key: string; readonly version: string };
  readonly configSha256: string;
  readonly target: TargetBinding;
  readonly assessment: CreateRunAssessment;
  readonly quoteId: string;
  readonly maxCredits?: number;
}): {
  protocol_version: typeof RELAY_PROTOCOL_VERSION_V3;
  packet: { key: string; version: string };
  config_sha256: string;
  target: TargetBinding;
  assessment: CreateRunAssessment;
  quote_id: string;
  max_credits?: number;
} {
  return {
    protocol_version: RELAY_PROTOCOL_VERSION_V3,
    packet: input.packet,
    config_sha256: input.configSha256,
    target: input.target,
    assessment: input.assessment,
    quote_id: input.quoteId,
    ...(input.maxCredits === undefined ? {} : { max_credits: input.maxCredits })
  };
}
