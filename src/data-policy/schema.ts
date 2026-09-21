import { z } from "zod";

import type { JsonValue } from "../config/types.js";
import { LIMITS, assertJsonLimits } from "../util/limits.js";
import { dataPolicyError } from "./errors.js";
import { hashCanonicalObject } from "./hash.js";
import { parseSelector } from "./pointers.js";
import {
  DATA_HANDLING_RECEIPT_SCHEMA_VERSION,
  DATA_POLICY_SCHEMA_VERSION,
  REDACTION_PROFILE_SCHEMA_VERSION,
  type DataHandlingReceipt,
  type DataPolicy,
  type RedactionProfile
} from "./types.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const RULE_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/u;

const uuid = z.string().regex(UUID);
const sha256hex = z.string().regex(SHA256);
const positiveInt = z.number().int().min(1).max(1_000_000);
const nonnegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const DataPolicySchema = z
  .object({
    schemaVersion: z.literal(DATA_POLICY_SCHEMA_VERSION),
    policyId: uuid,
    revision: positiveInt,
    policyHash: sha256hex,
    dataClass: z.enum(["public", "business", "personal"]),
    contentHandling: z.enum(["minimized", "verbatim"]),
    redactionProfileId: uuid,
    redactionProfileHash: sha256hex,
    retentionDays: z.number().int().min(1).max(3_650),
    externalSharing: z.enum(["disabled", "reviewed"]),
    providerProcessing: z.literal("openai_standard")
  })
  .strict();

const RedactionRuleSchema = z
  .object({
    id: z.string().regex(RULE_ID),
    selector: z.string().min(0).max(500),
    action: z.enum(["drop", "mask", "block"]),
    detector: z.enum(["field", "credential", "email", "phone", "exact_local_secret"])
  })
  .strict();

const RedactionProfileSchema = z
  .object({
    schemaVersion: z.literal(REDACTION_PROFILE_SCHEMA_VERSION),
    profileId: uuid,
    revision: positiveInt,
    profileHash: sha256hex,
    allowedContentFields: z.array(z.string().min(0).max(500)).max(256),
    rules: z.array(RedactionRuleSchema).max(512),
    maxDocumentBytes: z.number().int().min(1).max(LIMITS.targetResponseBytes),
    maxTextChars: z.number().int().min(1).max(1_000_000)
  })
  .strict();

const DataHandlingReceiptSchema = z
  .object({
    schemaVersion: z.literal(DATA_HANDLING_RECEIPT_SCHEMA_VERSION),
    policyId: uuid,
    policyHash: sha256hex,
    profileHash: sha256hex,
    representationHash: sha256hex,
    outcome: z.enum(["accepted", "transformed", "blocked", "insufficient_evidence"]),
    counts: z
      .object({
        dropped: nonnegativeInt,
        masked: nonnegativeInt,
        blocked: nonnegativeInt
      })
      .strict(),
    processor: z.enum(["cli", "server"]),
    processorVersion: z.string().min(1).max(80)
  })
  .strict();

export function parseDataPolicy(input: unknown): DataPolicy {
  const parsed = DataPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw dataPolicyError("INVALID_DATA_POLICY", "The data policy document is invalid.");
  }
  const expected = hashCanonicalObject(parsed.data, ["policyHash"]);
  if (expected !== parsed.data.policyHash) {
    throw dataPolicyError("DATA_POLICY_STALE", "The data policy hash does not match the canonical document.");
  }
  return parsed.data;
}

export function parseRedactionProfile(input: unknown): RedactionProfile {
  const parsed = RedactionProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw dataPolicyError("REDACTION_PROFILE_MISMATCH", "The redaction profile document is invalid.");
  }
  for (const selector of parsed.data.allowedContentFields) {
    parseSelector(selector, "allowed content field");
  }
  const seen = new Set<string>();
  for (const rule of parsed.data.rules) {
    if (seen.has(rule.id)) {
      throw dataPolicyError("REDACTION_PROFILE_MISMATCH", "The redaction profile contains a duplicate rule id.");
    }
    seen.add(rule.id);
    parseSelector(rule.selector, "redaction rule selector");
  }
  const expected = hashCanonicalObject(parsed.data, ["profileHash"]);
  if (expected !== parsed.data.profileHash) {
    throw dataPolicyError("REDACTION_PROFILE_MISMATCH", "The redaction profile hash does not match the canonical document.");
  }
  return parsed.data;
}

export function parseDataHandlingReceipt(input: unknown): DataHandlingReceipt {
  const parsed = DataHandlingReceiptSchema.safeParse(input);
  if (!parsed.success) {
    throw dataPolicyError("EVIDENCE_REPRESENTATION_MISMATCH", "The data-handling receipt is invalid.");
  }
  return parsed.data;
}

export function assertFreshPolicy(policy: DataPolicy): void {
  const expected = hashCanonicalObject(policy, ["policyHash"]);
  if (expected !== policy.policyHash) {
    throw dataPolicyError("DATA_POLICY_STALE", "The data policy hash does not match the canonical document.");
  }
}

export function assertFreshProfile(profile: RedactionProfile): void {
  const expected = hashCanonicalObject(profile, ["profileHash"]);
  if (expected !== profile.profileHash) {
    throw dataPolicyError(
      "REDACTION_PROFILE_MISMATCH",
      "The redaction profile hash does not match the canonical document."
    );
  }
}

export function assertPolicyProfileBinding(policy: DataPolicy, profile: RedactionProfile): void {
  if (policy.redactionProfileId !== profile.profileId || policy.redactionProfileHash !== profile.profileHash) {
    throw dataPolicyError(
      "REDACTION_PROFILE_MISMATCH",
      "The data policy is bound to a different redaction profile."
    );
  }
}

export function assertJsonDocument(value: unknown, label: string): asserts value is JsonValue {
  try {
    assertJsonLimits(value, label);
  } catch (error) {
    if (error instanceof Error && error.message.includes("nesting")) {
      throw dataPolicyError("DATA_POLICY_BLOCKED", `${label} exceeds the maximum nesting depth.`);
    }
    throw dataPolicyError("INVALID_DATA_POLICY", `${label} exceeds JSON size or shape limits.`);
  }
}

export function sealPolicyDocument(policy: Omit<DataPolicy, "policyHash">): DataPolicy {
  const candidate = { ...policy, policyHash: "0".repeat(64) };
  return { ...policy, policyHash: hashCanonicalObject(candidate, ["policyHash"]) };
}

export function sealProfileDocument(profile: Omit<RedactionProfile, "profileHash">): RedactionProfile {
  const candidate = { ...profile, profileHash: "0".repeat(64) };
  return { ...profile, profileHash: hashCanonicalObject(candidate, ["profileHash"]) };
}
