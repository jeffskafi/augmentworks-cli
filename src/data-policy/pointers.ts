import type { JsonValue } from "../config/types.js";
import { AwError } from "../errors.js";

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

export type PointerSegment = { readonly type: "key"; readonly value: string } | { readonly type: "wildcard" };

export function parseSelector(selector: string, label = "redaction selector"): PointerSegment[] {
  if (selector === "") return [];
  if (!selector.startsWith("/")) {
    throw unknownSelector(label, selector);
  }
  if (/[()?@]|\[|\]|\.\.|\$/u.test(selector)) {
    throw unknownSelector(label, selector);
  }
  const raw = selector.slice(1).split("/");
  return raw.map((segment) => {
    if (segment === "*") return { type: "wildcard" as const };
    if (segment.includes("*")) throw unknownSelector(label, selector);
    if (/(?:^|[^~])(?:~~)*~(?:$|[^01])/u.test(segment) || segment.endsWith("~")) {
      throw unknownSelector(label, selector);
    }
    const value = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    assertSafeSegment(value, label);
    return { type: "key" as const, value };
  });
}

export function formatPointer(segments: readonly string[]): string {
  if (segments.length === 0) return "";
  return `/${segments.map(escapeSegment).join("/")}`;
}

export function escapeSegment(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

export function assertSafeSegment(segment: string, label: string): void {
  if (FORBIDDEN.has(segment)) {
    throw new AwError({
      code: "UNSAFE_SELECTOR",
      category: "config",
      message: `${label} contains a forbidden prototype segment.`,
      retryable: false
    });
  }
}

export function expandSelector(selector: string, document: unknown): string[] {
  const parsed = parseSelector(selector);
  return expand(parsed, document, []).map((segments) => formatPointer(segments));
}

function expand(selector: readonly PointerSegment[], node: unknown, prefix: readonly string[]): string[][] {
  if (selector.length === 0) return [[...prefix]];
  const [head, ...rest] = selector;
  if (head === undefined) return [[...prefix]];
  if (head.type === "wildcard") {
    if (Array.isArray(node)) {
      return node.flatMap((child, index) => expand(rest, child, [...prefix, String(index)]));
    }
    if (isPlainObject(node)) {
      return Object.keys(node)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .flatMap((key) => {
          assertSafeSegment(key, "document key");
          return expand(rest, node[key], [...prefix, key]);
        });
    }
    return [];
  }
  if (Array.isArray(node)) {
    if (!/^(0|[1-9][0-9]*)$/u.test(head.value)) return [];
    const index = Number(head.value);
    if (!Number.isSafeInteger(index) || index >= node.length) return [];
    return expand(rest, node[index], [...prefix, head.value]);
  }
  if (!isPlainObject(node) || !Object.hasOwn(node, head.value)) return [];
  assertSafeSegment(head.value, "document key");
  return expand(rest, node[head.value], [...prefix, head.value]);
}

export function getAtPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  const segments = parseSelector(pointer).map((segment) => {
    if (segment.type === "wildcard") {
      throw unknownSelector("JSON pointer", pointer);
    }
    return segment.value;
  });
  let current = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!/^(0|[1-9][0-9]*)$/u.test(segment) || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

export function parentPointer(pointer: string): { parent: string; leaf: string } | undefined {
  if (pointer === "") return undefined;
  const segments = parseSelector(pointer).map((segment) => {
    if (segment.type === "wildcard") throw unknownSelector("JSON pointer", pointer);
    return segment.value;
  });
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) return undefined;
  return { parent: formatPointer(segments.slice(0, -1)), leaf };
}

export function isPrefixPointer(prefix: string, pointer: string): boolean {
  if (prefix === "") return true;
  return pointer === prefix || pointer.startsWith(`${prefix}/`);
}

export function setAtPointer(document: JsonValue, pointer: string, value: JsonValue): JsonValue {
  if (pointer === "") return value;
  const location = parentPointer(pointer);
  if (location === undefined) return value;
  const parent = location.parent === "" ? document : getAtPointer(document, location.parent);
  if (Array.isArray(parent)) {
    const index = Number(location.leaf);
    if (!/^(0|[1-9][0-9]*)$/u.test(location.leaf) || index >= parent.length) return document;
    parent[index] = value;
    return document;
  }
  if (!isPlainObject(parent)) return document;
  assertSafeSegment(location.leaf, "document key");
  Object.defineProperty(parent, location.leaf, {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  });
  return document;
}

export function deleteAtPointer(document: JsonValue, pointer: string): JsonValue {
  if (pointer === "") return null;
  const location = parentPointer(pointer);
  if (location === undefined) return null;
  const parent = location.parent === "" ? document : getAtPointer(document, location.parent);
  if (Array.isArray(parent)) {
    const index = Number(location.leaf);
    if (!/^(0|[1-9][0-9]*)$/u.test(location.leaf) || index >= parent.length) return document;
    parent.splice(index, 1);
    return document;
  }
  if (!isPlainObject(parent) || !Object.hasOwn(parent, location.leaf)) return document;
  assertSafeSegment(location.leaf, "document key");
  delete parent[location.leaf];
  return document;
}

export function pointerDepth(pointer: string): number {
  if (pointer === "") return 0;
  return parseSelector(pointer).length;
}

export function comparePointersDeepestFirst(left: string, right: string): number {
  const leftDepth = pointerDepth(left);
  const rightDepth = pointerDepth(right);
  if (leftDepth !== rightDepth) return rightDepth - leftDepth;
  const leftParent = parentPointer(left);
  const rightParent = parentPointer(right);
  if (leftParent !== undefined && rightParent !== undefined && leftParent.parent === rightParent.parent) {
    const leftIndex = /^(0|[1-9][0-9]*)$/u.test(leftParent.leaf) ? Number(leftParent.leaf) : Number.NaN;
    const rightIndex = /^(0|[1-9][0-9]*)$/u.test(rightParent.leaf) ? Number(rightParent.leaf) : Number.NaN;
    if (Number.isInteger(leftIndex) && Number.isInteger(rightIndex) && leftIndex !== rightIndex) {
      return rightIndex - leftIndex;
    }
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownSelector(label: string, selector: string): AwError {
  return new AwError({
    code: "REDACTION_PROFILE_MISMATCH",
    category: "config",
    message: `${label} is not a frozen JSON Pointer subset selector.`,
    retryable: false,
    details: { selectorLength: selector.length }
  });
}
