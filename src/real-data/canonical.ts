import { canonicalize, sha256 } from "../util/canonical.js";
import { AUDIT_METADATA_KEYS } from "./constants.js";

const AUDIT = new Set<string>(AUDIT_METADATA_KEYS);

export function stripCanonicalMetadata(
  value: unknown,
  hashField?: string
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => stripCanonicalMetadata(child));
  }
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (AUDIT.has(key)) continue;
    if (hashField !== undefined && key === hashField) continue;
    output[key] = stripCanonicalMetadata(child);
  }
  return output;
}

export function canonicalDocumentBytes(
  document: unknown,
  hashField?: string
): string {
  return canonicalize(stripCanonicalMetadata(document, hashField));
}

export function canonicalDocumentHash(document: unknown, hashField?: string): string {
  return sha256(canonicalDocumentBytes(document, hashField));
}

export function sealDocumentHash<T extends Record<string, unknown>>(
  document: T,
  hashField: keyof T & string
): T {
  return {
    ...document,
    [hashField]: canonicalDocumentHash(document, hashField)
  };
}
