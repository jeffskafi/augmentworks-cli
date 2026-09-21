import type { JsonValue } from "../config/types.js";

export const DATA_POLICY_SCHEMA_VERSION = "aw-data-policy/1" as const;
export const REDACTION_PROFILE_SCHEMA_VERSION = "aw-redaction-profile/1" as const;
export const DATA_HANDLING_RECEIPT_SCHEMA_VERSION = "aw-data-handling-receipt/1" as const;
export const R06_HANDOFF_SCHEMA_VERSION = "aw-real-data-r06-handoff/1" as const;

export const HOSTED_REAL_DATA_RELEASE = "unavailable" as const;

export const PLACEHOLDERS = {
  credential: "[REDACTED:credential]",
  email: "[REDACTED:email]",
  phone: "[REDACTED:phone]",
  exact_local_secret: "[REDACTED:secret]",
  field: "[REDACTED:field]"
} as const;

export type DataClass = "public" | "business" | "personal";
export type ContentHandling = "minimized" | "verbatim";
export type ExternalSharing = "disabled" | "reviewed";
export type ProviderProcessing = "openai_standard";
export type RedactionAction = "drop" | "mask" | "block";
export type RedactionDetector = "field" | "credential" | "email" | "phone" | "exact_local_secret";
export type DataHandlingOutcome = "accepted" | "transformed" | "blocked" | "insufficient_evidence";
export type DataProcessor = "cli" | "server";

export interface DataPolicy {
  readonly schemaVersion: typeof DATA_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly revision: number;
  readonly policyHash: string;
  readonly dataClass: DataClass;
  readonly contentHandling: ContentHandling;
  readonly redactionProfileId: string;
  readonly redactionProfileHash: string;
  readonly retentionDays: number;
  readonly externalSharing: ExternalSharing;
  readonly providerProcessing: ProviderProcessing;
}

export interface RedactionRule {
  readonly id: string;
  readonly selector: string;
  readonly action: RedactionAction;
  readonly detector: RedactionDetector;
}

export interface RedactionProfile {
  readonly schemaVersion: typeof REDACTION_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly revision: number;
  readonly profileHash: string;
  readonly allowedContentFields: readonly string[];
  readonly rules: readonly RedactionRule[];
  readonly maxDocumentBytes: number;
  readonly maxTextChars: number;
}

export interface DataHandlingCounts {
  readonly dropped: number;
  readonly masked: number;
  readonly blocked: number;
}

export interface DataHandlingReceipt {
  readonly schemaVersion: typeof DATA_HANDLING_RECEIPT_SCHEMA_VERSION;
  readonly policyId: string;
  readonly policyHash: string;
  readonly profileHash: string;
  readonly representationHash: string;
  readonly outcome: DataHandlingOutcome;
  readonly counts: DataHandlingCounts;
  readonly processor: DataProcessor;
  readonly processorVersion: string;
}

export interface BlockedPath {
  readonly path: string;
  readonly action: RedactionAction;
  readonly ruleId: string;
}

export interface InspectOutboundResult {
  readonly representation: JsonValue;
  readonly receipt: DataHandlingReceipt;
  readonly blockedPaths: readonly BlockedPath[];
}

export interface DataPolicyContext {
  readonly policy: DataPolicy;
  readonly profile: RedactionProfile;
  readonly localSecrets: readonly string[];
}

export interface ApplyRedactionProfileResult {
  readonly representation: JsonValue;
  readonly counts: DataHandlingCounts;
  readonly blockedPaths: readonly BlockedPath[];
  readonly maskedPaths: readonly string[];
  readonly droppedPaths: readonly string[];
}

export interface EvidenceSpan {
  readonly start: number;
  readonly end: number;
}

export interface RetainedEvidenceEvaluation {
  readonly ok: boolean;
  readonly outcome: Extract<DataHandlingOutcome, "accepted" | "insufficient_evidence">;
  readonly missingFacts: readonly string[];
}

export interface EffectivePolicySummary {
  readonly dataClass: DataClass;
  readonly contentHandling: ContentHandling;
  readonly retentionDays: number;
  readonly externalSharing: ExternalSharing;
  readonly providerProcessing: ProviderProcessing;
  readonly profileId: string;
  readonly policyId: string;
  readonly revision: number;
}
