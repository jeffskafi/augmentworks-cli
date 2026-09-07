import { z } from "zod";

import { FEATURE_ERROR_SCHEMA_VERSION, SUITE_CONTENT_HASH_PATTERN, SUITE_SCHEMA_VERSION } from "./schema.js";

const SHA256_HEX = z.string().regex(SUITE_CONTENT_HASH_PATTERN);
const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const SuiteCreateRequestSchema = z
  .object({
    schemaVersion: z.literal(SUITE_SCHEMA_VERSION),
    packageVersion: z.string().min(1).max(80).optional(),
    contentHash: SHA256_HEX,
    document: z.unknown()
  })
  .strict();

export type SuiteCreateRequest = z.infer<typeof SuiteCreateRequestSchema>;

export const SuiteCreateResponseSchema = z
  .object({
    suiteId: identifier,
    revisionId: z.string().min(1).max(128),
    contentHash: SHA256_HEX,
    schemaVersion: z.string().min(1).optional(),
    packageVersion: z.string().min(1).optional()
  })
  .passthrough();

export type SuiteCreateResponse = z.infer<typeof SuiteCreateResponseSchema>;

export const SuiteRevisionReadSchema = z
  .object({
    suiteId: identifier,
    revisionId: z.string().min(1).max(128),
    contentHash: SHA256_HEX,
    canonicalDocument: z.unknown().optional(),
    schemaVersion: z.string().min(1).optional()
  })
  .passthrough();

export type SuiteRevisionRead = z.infer<typeof SuiteRevisionReadSchema>;

export function normalizeSuiteIdentity(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    suiteId: record["suiteId"] ?? record["suite_id"],
    revisionId: record["revisionId"] ?? record["revision_id"],
    contentHash: record["contentHash"] ?? record["content_hash"],
    canonicalDocument: record["canonicalDocument"] ?? record["canonical_document"] ?? record["document"]
  };
}

export function parseFeaturePackageError(
  value: unknown
): { code: string; message: string } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const root = value as Record<string, unknown>;
  const nested = root["error"];
  const record =
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : root;
  const schema = record["schemaVersion"] ?? record["schema_version"] ?? root["schemaVersion"] ?? root["schema_version"];
  if (schema !== FEATURE_ERROR_SCHEMA_VERSION) return undefined;
  const rawCode = record["code"];
  const message = record["message"];
  if (typeof rawCode !== "string" || typeof message !== "string") return undefined;
  if (message.length < 1 || message.length > 500) return undefined;
  const mapped = /^[a-z][a-z0-9_]{0,79}$/.test(rawCode) ? rawCode.toUpperCase() : rawCode;
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(mapped)) return undefined;
  return {
    code: mapped,
    message: message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
  };
}
