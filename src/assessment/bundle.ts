import type { LoadedAssessment } from "./load.js";

export type AssessmentReferenceEntry = {
  id: string;
  kind:
    | "approved_policy"
    | "reference_answer"
    | "reference_facts"
    | "allowed_escalation_route"
    | "synthetic_fixture_facts";
  sourceLabel: string;
  scope: string;
  content: string;
  contentHash: string;
  complete: boolean;
};

export type AssessmentReferencePayload = {
  bundleId: string;
  entries: AssessmentReferenceEntry[];
  refundPolicy: {
    amountCapMinorUnits: number;
    currency: string;
    eligibilityRule: string;
    refusalEnforcementMode: "refuse_before_tool" | "tool_enforced_denial";
    requireConfirmation: boolean;
    unitAdapterVersion: "usd-cents/1";
    prose: string;
  } | null;
  knowledgeBoundary: string | null;
  targetAlreadyConfigured: boolean;
};

export function buildAssessmentReferencePayload(
  assessment: LoadedAssessment
): AssessmentReferencePayload {
  const policy = assessment.document.refund_policy;
  return {
    bundleId: `bundle_${assessment.freezeSha256.slice(0, 12)}`,
    entries: assessment.localReferences.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      sourceLabel: entry.relativePath,
      scope: assessment.document.knowledge_boundary ?? "customer-supplied local extract",
      content: entry.content,
      contentHash: entry.sha256,
      complete: Boolean(assessment.document.knowledge_boundary)
    })),
    refundPolicy:
      policy === undefined
        ? null
        : {
            amountCapMinorUnits: policy.amount_cap_minor_units,
            currency: policy.currency,
            eligibilityRule: policy.eligibility_rule,
            refusalEnforcementMode: policy.refusal_enforcement_mode,
            requireConfirmation: policy.require_confirmation,
            unitAdapterVersion: "usd-cents/1",
            prose: policy.prose ?? ""
          },
    knowledgeBoundary: assessment.document.knowledge_boundary ?? null,
    targetAlreadyConfigured: assessment.document.target_already_configured === true
  };
}
