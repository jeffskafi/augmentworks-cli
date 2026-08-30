import { AwError } from "../errors.js";

export const LIMITS = {
  envelopeBytes: 256 * 1024,
  evidenceBytes: 256 * 1024,
  targetResponseBytes: 1024 * 1024,
  maxDepth: 20,
  maxObjectKeys: 1000,
  maxArrayItems: 1000,
  maxMessageBytes: 64 * 1024,
  maxObservations: 64,
  maxEvents: 100,
  maxCommands: 100,
  maxRunMs: 30 * 60 * 1000
} as const;

export function assertJsonLimits(value: unknown, label = "JSON value", depth = 0): void {
  if (depth > LIMITS.maxDepth) {
    throw new AwError({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      category: "evidence",
      message: `${label} exceeds the maximum nesting depth.`
    });
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxArrayItems) {
      throw new AwError({ code: "EVIDENCE_LIMIT_EXCEEDED", category: "evidence", message: `${label} has too many items.` });
    }
    for (const child of value) assertJsonLimits(child, label, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > LIMITS.maxObjectKeys) {
      throw new AwError({ code: "EVIDENCE_LIMIT_EXCEEDED", category: "evidence", message: `${label} has too many keys.` });
    }
    for (const [, child] of entries) assertJsonLimits(child, label, depth + 1);
  }
}
