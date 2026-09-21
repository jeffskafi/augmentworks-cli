import { canonicalize, sha256 } from "../util/canonical.js";

export function omitKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): Record<string, unknown> {
  const omitted = new Set(keys);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (omitted.has(key) || child === undefined) continue;
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: child
    });
  }
  return result;
}

export function hashCanonicalObject(value: object, omit: readonly string[] = []): string {
  return sha256(canonicalize(omitKeys(value as Readonly<Record<string, unknown>>, omit)));
}

export function representationHash(value: unknown): string {
  return sha256(canonicalize(value));
}
