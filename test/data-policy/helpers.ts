import { LIMITS } from "../../src/util/limits.js";
import {
  sealPolicyDocument,
  sealProfileDocument,
  type DataClass,
  type DataPolicy,
  type DataPolicyContext,
  type RedactionProfile,
  type RedactionRule
} from "../../src/data-policy/index.js";

export const POLICY_ID = "11111111-1111-4111-8111-111111111111";
export const PROFILE_ID = "22222222-2222-4222-8222-222222222222";

export const CANARIES = {
  secret: "SYNTHETIC_CANARY_SECRET_do_not_leak",
  token: "SYNTHETIC_CANARY_TOKEN_do_not_leak",
  password: "nested-synthetic-password-value",
  apiKey: "sk-syntheticCanaryKey12",
  email: "canary.user@example.test",
  phone: "+1-555-010-1234",
  query: "https://example.test/callback?token=SYNTHETIC_CANARY_TOKEN_do_not_leak&email=canary.user@example.test"
} as const;

export const CANARY_UNICODE = "café-日本語-do-not-leak";

export function makeProfile(
  overrides: Partial<Omit<RedactionProfile, "profileHash" | "schemaVersion" | "profileId">> & {
    readonly rules?: readonly RedactionRule[];
    readonly allowedContentFields?: readonly string[];
  } = {}
): RedactionProfile {
  return sealProfileDocument({
    schemaVersion: "aw-redaction-profile/1",
    profileId: PROFILE_ID,
    revision: 1,
    allowedContentFields: overrides.allowedContentFields ?? [],
    rules: overrides.rules ?? [],
    maxDocumentBytes: overrides.maxDocumentBytes ?? LIMITS.targetResponseBytes,
    maxTextChars: overrides.maxTextChars ?? 1_000_000
  });
}

export function makePolicy(
  profile: RedactionProfile,
  overrides: Partial<Pick<DataPolicy, "dataClass" | "contentHandling" | "retentionDays" | "externalSharing">> = {}
): DataPolicy {
  return sealPolicyDocument({
    schemaVersion: "aw-data-policy/1",
    policyId: POLICY_ID,
    revision: 1,
    dataClass: overrides.dataClass ?? "business",
    contentHandling: overrides.contentHandling ?? "minimized",
    redactionProfileId: profile.profileId,
    redactionProfileHash: profile.profileHash,
    retentionDays: overrides.retentionDays ?? 30,
    externalSharing: overrides.externalSharing ?? "disabled",
    providerProcessing: "openai_standard"
  });
}

export function makeContext(
  dataClass: DataClass,
  contentHandling: DataPolicy["contentHandling"],
  rules: readonly RedactionRule[] = [],
  allowedContentFields: readonly string[] = [],
  secrets: readonly string[] = [CANARIES.secret, CANARIES.token]
): DataPolicyContext {
  const profile = makeProfile({ rules, allowedContentFields });
  return {
    policy: makePolicy(profile, { dataClass, contentHandling }),
    profile,
    localSecrets: secrets
  };
}

export function leakText(value: unknown): string {
  return JSON.stringify(value);
}

export function expectNoCanaries(value: unknown): void {
  const text = leakText(value);
  for (const canary of Object.values(CANARIES)) {
    if (text.includes(canary)) {
      throw new Error("Invented canary leaked from outbound representation.");
    }
  }
}
