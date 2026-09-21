import type { JsonValue } from "../config/types.js";
import { isPlainObject } from "./pointers.js";
import { PLACEHOLDERS, type EvidenceSpan, type RetainedEvidenceEvaluation } from "./types.js";

const PLACEHOLDER_VALUES = new Set<string>(Object.values(PLACEHOLDERS));

export function findCodePointSpan(text: string, needle: string): EvidenceSpan | undefined {
  if (needle.length === 0) return undefined;
  const haystack = [...text];
  const target = [...needle];
  if (target.length > haystack.length) return undefined;
  for (let start = 0; start <= haystack.length - target.length; start += 1) {
    if (target.every((character, offset) => haystack[start + offset] === character)) {
      return { start, end: start + target.length };
    }
  }
  return undefined;
}

export function representationContainsFact(representation: JsonValue, fact: string): boolean {
  if (fact.length === 0 || PLACEHOLDER_VALUES.has(fact)) return false;
  return collectStrings(representation).some((text) => {
    if (PLACEHOLDER_VALUES.has(text)) return false;
    return findCodePointSpan(text, fact) !== undefined;
  });
}

export function evaluateRetainedEvidence(
  representation: JsonValue,
  expectedFacts: readonly string[]
): RetainedEvidenceEvaluation {
  const missingFacts = expectedFacts.filter((fact) => !representationContainsFact(representation, fact));
  if (missingFacts.length === 0) {
    return { ok: true, outcome: "accepted", missingFacts: [] };
  }
  return { ok: false, outcome: "insufficient_evidence", missingFacts };
}

export function evidenceSpansForFacts(
  representation: JsonValue,
  facts: readonly string[]
): Readonly<Record<string, EvidenceSpan>> {
  const spans: Record<string, EvidenceSpan> = {};
  const texts = collectStrings(representation);
  for (const fact of facts) {
    for (const text of texts) {
      const span = findCodePointSpan(text, fact);
      if (span !== undefined) {
        spans[fact] = span;
        break;
      }
    }
  }
  return spans;
}

function collectStrings(value: JsonValue, bucket: string[] = []): string[] {
  if (typeof value === "string") {
    bucket.push(value);
    return bucket;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectStrings(child as JsonValue, bucket);
    return bucket;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectStrings(child as JsonValue, bucket);
  }
  return bucket;
}
