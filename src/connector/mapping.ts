import type { JsonValue, RequestTemplate } from "../config/types.js";
import { AwError } from "../errors.js";
import {
  isSensitiveKey,
  redactSecrets as redactSecretText
} from "../system/redact.js";
import { LIMITS, assertJsonLimits } from "../util/limits.js";

type PathToken = string | number;

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const PROPERTY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

export function mapRequestTemplate(template: RequestTemplate, input: unknown): JsonValue {
  assertSafeJson(input, "operation input");
  const mapped = mapNode(template, input, 0);
  assertSafeJson(mapped, "mapped request");
  return mapped;
}

export function selectResponse(root: unknown, selector: string): JsonValue {
  assertSafeJson(root, "target response");
  const tokens = parsePath(selector, "$", "response selector");
  return cloneJson(resolveTokens(root, tokens, selector));
}

export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const usable = [...new Set(secrets.filter((secret) => secret.length > 0))];
  return redactNode(value, usable, new WeakSet<object>()) as T;
}

export function redactText(value: string, secrets: readonly string[]): string {
  return redactSecretText(value, secrets);
}

function mapNode(template: JsonValue, input: unknown, depth: number): JsonValue {
  if (depth > LIMITS.maxDepth) {
    throw mappingError("REQUEST_MAPPING_LIMIT", "Request mapping exceeds the maximum nesting depth.");
  }
  if (typeof template === "string" && template.startsWith("$input")) {
    const tokens = parsePath(template, "$input", "input reference");
    return cloneJson(resolveTokens(input, tokens, template));
  }
  if (Array.isArray(template)) {
    if (template.length > LIMITS.maxArrayItems) {
      throw mappingError("REQUEST_MAPPING_LIMIT", "Request template has too many array items.");
    }
    return template.map((child) => mapNode(child, input, depth + 1));
  }
  if (template !== null && typeof template === "object") {
    const entries = Object.entries(template);
    if (entries.length > LIMITS.maxObjectKeys) {
      throw mappingError("REQUEST_MAPPING_LIMIT", "Request template has too many object keys.");
    }
    const mapped: Record<string, JsonValue> = {};
    for (const [key, child] of entries) {
      assertSafeSegment(key, "request template key");
      Object.defineProperty(mapped, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: mapNode(child, input, depth + 1)
      });
    }
    return mapped;
  }
  return template;
}

function parsePath(value: string, root: "$" | "$input", label: string): PathToken[] {
  if (!value.startsWith(root)) {
    throw mappingError("INVALID_SELECTOR", `${label} must begin with ${root}.`);
  }
  let offset = root.length;
  const tokens: PathToken[] = [];
  while (offset < value.length) {
    const marker = value[offset];
    if (marker === ".") {
      const start = ++offset;
      while (offset < value.length && value[offset] !== "." && value[offset] !== "[") {
        offset += 1;
      }
      const segment = value.slice(start, offset);
      if (!PROPERTY.test(segment)) {
        throw mappingError("INVALID_SELECTOR", `${label} contains an invalid property segment.`);
      }
      assertSafeSegment(segment, label);
      tokens.push(segment);
      continue;
    }
    if (marker === "[") {
      const closing = value.indexOf("]", offset + 1);
      if (closing === -1) {
        throw mappingError("INVALID_SELECTOR", `${label} contains an unterminated array index.`);
      }
      const indexText = value.slice(offset + 1, closing);
      if (!/^(0|[1-9][0-9]*)$/u.test(indexText)) {
        throw mappingError("INVALID_SELECTOR", `${label} contains an invalid array index.`);
      }
      const index = Number(indexText);
      if (!Number.isSafeInteger(index) || index >= LIMITS.maxArrayItems) {
        throw mappingError("INVALID_SELECTOR", `${label} array index is outside the supported range.`);
      }
      tokens.push(index);
      offset = closing + 1;
      continue;
    }
    throw mappingError("INVALID_SELECTOR", `${label} contains unsupported syntax.`);
  }
  return tokens;
}

function resolveTokens(root: unknown, tokens: readonly PathToken[], source: string): unknown {
  let current = root;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || token >= current.length) {
        throw mappingError("MAPPING_VALUE_MISSING", `No value exists at ${source}.`);
      }
      current = current[token];
      continue;
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      throw mappingError("MAPPING_VALUE_MISSING", `No value exists at ${source}.`);
    }
    assertSafeSegment(token, "path segment");
    const descriptor = Object.getOwnPropertyDescriptor(current, token);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw mappingError("MAPPING_VALUE_MISSING", `No value exists at ${source}.`);
    }
    current = descriptor.value;
  }
  return current;
}

function assertSafeSegment(segment: string, label: string): void {
  if (FORBIDDEN_SEGMENTS.has(segment)) {
    throw mappingError("UNSAFE_SELECTOR", `${label} contains a forbidden prototype segment.`);
  }
}

function cloneJson(value: unknown): JsonValue {
  assertSafeJson(value, "mapped JSON value");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  const copy: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneJson(child)
    });
  }
  return copy;
}

function assertSafeJson(value: unknown, label: string): asserts value is JsonValue {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > LIMITS.maxDepth) {
      throw mappingError("INVALID_JSON_VALUE", `${label} exceeds the maximum nesting depth.`);
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw mappingError("INVALID_JSON_VALUE", `${label} contains a non-finite number.`);
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw mappingError("INVALID_JSON_VALUE", `${label} must contain only JSON values.`);
    }
    if (seen.has(candidate)) {
      throw mappingError("INVALID_JSON_VALUE", `${label} contains a cycle.`);
    }
    seen.add(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
      throw mappingError("INVALID_JSON_VALUE", `${label} contains a non-JSON object.`);
    }
    const entries = Array.isArray(candidate)
      ? candidate.map((child, index) => [String(index), child] as const)
      : Object.entries(candidate as Record<string, unknown>);
    for (const [, child] of entries) {
      visit(child, depth + 1);
    }
    seen.delete(candidate);
  };
  visit(value, 0);
  assertJsonLimits(value, label);
}

function redactNode(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED:CYCLE]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((child) => redactNode(child, secrets, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = redactText(key, secrets);
    Object.defineProperty(result, safeKey, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: isSensitiveKey(key) ? "[REDACTED]" : redactNode(child, secrets, seen)
    });
  }
  seen.delete(value);
  return result;
}

function mappingError(code: string, message: string): AwError {
  return new AwError({ code, category: "config", message });
}
