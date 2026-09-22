import type { JsonValue } from "../config/types.js";
import type { DataPolicyContext } from "../data-policy/index.js";
import {
  applyRedactionProfile as applyLandedRedactionProfile,
  parseDataPolicy as parseLandedDataPolicy,
  parseRedactionProfile as parseLandedRedactionProfile,
  sealDataHandlingReceipt as sealLandedDataHandlingReceipt
} from "../data-policy/index.js";
import { CLI_VERSION } from "../version.js";
import type { DispatchPolicy } from "./policy.js";
import type {
  ApplyRedactionProfileInput,
  ApplyRedactionProfileResult,
  PrivacyService
} from "./privacy.js";

function uniqueSecrets(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function privacyContextFromDocuments(
  policy: unknown,
  profile: unknown,
  secrets: readonly string[] = []
): DataPolicyContext {
  return {
    policy: parseLandedDataPolicy(policy),
    profile: parseLandedRedactionProfile(profile),
    localSecrets: uniqueSecrets(secrets)
  };
}

export function dispatchPolicyPrivacyContext(
  policy: DispatchPolicy | undefined,
  secrets: readonly string[] = []
): DataPolicyContext | undefined {
  if (policy === undefined || policy.kind !== "authorized") return undefined;
  if (policy.dataPolicy === undefined || policy.redactionProfile === undefined) return undefined;
  return privacyContextFromDocuments(policy.dataPolicy, policy.redactionProfile, secrets);
}

/**
 * R05 adapter over the landed AUG-189/R06 pure modules.
 * Signatures stay the R05 PrivacyService shape; documents are re-parsed by R06
 * so stale hashes fail closed instead of uploading raw content.
 */
export const r06PrivacyService: PrivacyService = {
  applyRedactionProfile(input, profile, policy, secrets) {
    return applyLandedRedaction(input, profile, policy, secrets);
  },
  sealDataHandlingReceipt(result, policy, profile, processor = "cli") {
    const context = privacyContextFromDocuments(policy, profile);
    return sealLandedDataHandlingReceipt({
      policy: context.policy,
      profile: context.profile,
      representation: (result.representation ?? null) as JsonValue,
      counts: result.counts,
      processor,
      processorVersion: CLI_VERSION,
      outcome: result.outcome
    });
  }
};

function applyLandedRedaction(
  input: ApplyRedactionProfileInput,
  profile: unknown,
  policy: unknown,
  secrets: readonly string[]
): ApplyRedactionProfileResult {
  const context = privacyContextFromDocuments(policy, profile, [
    ...secrets,
    ...(input.secrets ?? [])
  ]);
  const applied = applyLandedRedactionProfile(
    input.document,
    context.profile,
    context.policy,
    context.localSecrets
  );
  const blocked = applied.counts.blocked > 0 || applied.blockedPaths.length > 0;
  return {
    representation: applied.representation,
    outcome: blocked
      ? "blocked"
      : applied.counts.dropped + applied.counts.masked > 0
        ? "transformed"
        : "accepted",
    counts: applied.counts,
    blocked
  };
}
