import { Buffer } from "node:buffer";

import { CLI_VERSION } from "../version.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { DATA_HANDLING_RECEIPT_SCHEMA_VERSION } from "./constants.js";
import {
  type DataHandlingReceipt,
  type DataPolicy,
  type RedactionProfile,
  representationHash
} from "./documents.js";
import { realDataError } from "./errors.js";
import type { DispatchPolicy } from "./policy.js";
import { r06PrivacyService } from "./r06-service.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ApplyRedactionProfileInput = {
  readonly document: unknown;
  readonly secrets?: readonly string[];
};

export type ApplyRedactionProfileResult = {
  readonly representation: unknown;
  readonly outcome: DataHandlingReceipt["outcome"];
  readonly counts: DataHandlingReceipt["counts"];
  readonly blocked: boolean;
};

export type PrivacyService = {
  readonly applyRedactionProfile: (
    input: ApplyRedactionProfileInput,
    profile: RedactionProfile,
    policy: DataPolicy,
    secrets: readonly string[]
  ) => ApplyRedactionProfileResult | Promise<ApplyRedactionProfileResult>;
  readonly sealDataHandlingReceipt: (
    result: ApplyRedactionProfileResult,
    policy: DataPolicy,
    profile: RedactionProfile,
    processor?: DataHandlingReceipt["processor"]
  ) => DataHandlingReceipt;
};

let registered: PrivacyService | undefined;

export function registerPrivacyService(service: PrivacyService | undefined): void {
  registered = service;
}

export function installLandedPrivacyService(): void {
  registerPrivacyService(r06PrivacyService);
}

export function getPrivacyService(): PrivacyService {
  return registered ?? r06PrivacyService;
}

export function assertAuthorizedPrivacyDocuments(policy: DispatchPolicy | undefined): void {
  requireAuthorizedPrivacyDocuments(policy);
}

export function requireAuthorizedPrivacyDocuments(
  policy: DispatchPolicy | undefined
): { readonly dataPolicy: DataPolicy; readonly redactionProfile: RedactionProfile } | undefined {
  if (policy === undefined || policy.kind !== "authorized") return undefined;
  if (policy.dataPolicy === undefined) {
    throw realDataError(
      "UNSUPPORTED_DATA_POLICY",
      "Authorized execution requires an admitted data policy. Raw content is not uploaded or written to artifacts."
    );
  }
  if (policy.redactionProfile === undefined) {
    throw realDataError(
      "REDACTION_PROFILE_MISMATCH",
      "Authorized execution requires the bound redaction profile. Raw content is not uploaded or written to artifacts."
    );
  }
  return { dataPolicy: policy.dataPolicy, redactionProfile: policy.redactionProfile };
}

export function applyRedactionProfile(
  input: ApplyRedactionProfileInput,
  profile: RedactionProfile,
  policy: DataPolicy,
  secrets: readonly string[] = []
): ApplyRedactionProfileResult | Promise<ApplyRedactionProfileResult> {
  return getPrivacyService().applyRedactionProfile(input, profile, policy, secrets);
}

export function sealDataHandlingReceipt(
  result: ApplyRedactionProfileResult,
  policy: DataPolicy,
  profile: RedactionProfile,
  processor: DataHandlingReceipt["processor"] = "cli"
): DataHandlingReceipt {
  return getPrivacyService().sealDataHandlingReceipt(result, policy, profile, processor);
}

export async function minimizeForUpload(
  input: ApplyRedactionProfileInput,
  profile: RedactionProfile,
  policy: DataPolicy,
  secrets: readonly string[] = []
): Promise<{
  readonly representation: unknown;
  readonly representationHash: string;
  readonly receipt: DataHandlingReceipt;
}> {
  const result = await Promise.resolve(applyRedactionProfile(input, profile, policy, secrets));
  const receipt = sealDataHandlingReceipt(result, policy, profile, "cli");
  if (result.blocked || result.outcome === "blocked") {
    throw realDataError(
      "DATA_POLICY_BLOCKED",
      "The selected data policy blocked this content before upload. The run is not restarted."
    );
  }
  if (result.outcome === "insufficient_evidence") {
    throw realDataError(
      "INSUFFICIENT_EVIDENCE",
      "The selected data policy could not produce a complete representation."
    );
  }
  return {
    representation: result.representation,
    representationHash: representationHash(result.representation),
    receipt
  };
}

const failClosedPrivacyService: PrivacyService = {
  applyRedactionProfile(input, profile, policy, secrets) {
    return defaultApplyRedactionProfile(input, profile, policy, secrets);
  },
  sealDataHandlingReceipt(result, policy, profile, processor = "cli") {
    return defaultSealDataHandlingReceipt(result, policy, profile, processor);
  }
};

export { failClosedPrivacyService };

export function defaultApplyRedactionProfile(
  input: ApplyRedactionProfileInput,
  profile: RedactionProfile,
  policy: DataPolicy,
  secrets: readonly string[]
): ApplyRedactionProfileResult {
  const unknownRule = profile.rules.find(
    (rule) =>
      !["field", "credential", "email", "phone", "exact_local_secret"].includes(rule.detector) ||
      !["drop", "mask", "block"].includes(rule.action)
  );
  if (unknownRule !== undefined) {
    return blockedResult("Unknown redaction rule failed closed.");
  }
  const requiresPrivacyService =
    policy.dataClass === "personal" ||
    policy.contentHandling === "minimized" ||
    policy.contentHandling === "verbatim" && policy.dataClass !== "public" ||
    profile.rules.some((rule) => rule.action === "block" || rule.detector !== "credential");
  if (requiresPrivacyService) {
    return {
      representation: null,
      outcome: "blocked",
      counts: { dropped: 0, masked: 0, blocked: 1 },
      blocked: true
    };
  }

  const encoded = JSON.stringify(input.document ?? null);
  if (Buffer.byteLength(encoded, "utf8") > profile.maxDocumentBytes) {
    return blockedResult("Document exceeds the redaction profile byte limit.");
  }
  const credentialSecrets = uniqueSecrets([...(secrets ?? []), ...(input.secrets ?? [])]);
  const { value, dropped, masked } = redactCredentials(input.document, credentialSecrets);
  return {
    representation: value,
    outcome: dropped > 0 || masked > 0 ? "transformed" : "accepted",
    counts: { dropped, masked, blocked: 0 },
    blocked: false
  };
}

export function defaultSealDataHandlingReceipt(
  result: ApplyRedactionProfileResult,
  policy: DataPolicy,
  profile: RedactionProfile,
  processor: DataHandlingReceipt["processor"] = "cli"
): DataHandlingReceipt {
  return {
    schemaVersion: DATA_HANDLING_RECEIPT_SCHEMA_VERSION,
    policyId: policy.policyId,
    policyHash: policy.policyHash,
    profileHash: profile.profileHash,
    representationHash: sha256(canonicalize(result.representation ?? null)),
    outcome: result.outcome,
    counts: result.counts,
    processor,
    processorVersion: CLI_VERSION
  };
}

function blockedResult(_reason: string): ApplyRedactionProfileResult {
  return {
    representation: null,
    outcome: "blocked",
    counts: { dropped: 0, masked: 0, blocked: 1 },
    blocked: true
  };
}

function uniqueSecrets(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function redactCredentials(
  value: unknown,
  secrets: readonly string[],
  depth = 0
): { value: unknown; dropped: number; masked: number } {
  if (depth > 12 || value === null) return { value, dropped: 0, masked: 0 };
  if (typeof value === "string") {
    let next = value;
    let masked = 0;
    for (const secret of secrets) {
      if (secret !== "" && next.includes(secret)) {
        next = next.split(secret).join("[REDACTED]");
        masked += 1;
      }
    }
    return { value: next, dropped: 0, masked };
  }
  if (Array.isArray(value)) {
    let dropped = 0;
    let masked = 0;
    const items = value.map((child) => {
      const nested = redactCredentials(child, secrets, depth + 1);
      dropped += nested.dropped;
      masked += nested.masked;
      return nested.value;
    });
    return { value: items, dropped, masked };
  }
  if (typeof value === "object") {
    let dropped = 0;
    let masked = 0;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/(?:api[_-]?key|secret|password|token|credential|private[_-]?key)/iu.test(key)) {
        dropped += 1;
        continue;
      }
      const nested = redactCredentials(child, secrets, depth + 1);
      dropped += nested.dropped;
      masked += nested.masked;
      output[key] = nested.value;
    }
    return { value: output, dropped, masked };
  }
  return { value, dropped: 0, masked: 0 };
}
