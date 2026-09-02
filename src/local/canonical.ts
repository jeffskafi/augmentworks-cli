import { createHash } from "node:crypto";

import type { LocalJson } from "./types.js";

export function canonicalJson(value: LocalJson): string {
  if (value === undefined) {
    throw new TypeError("canonical JSON cannot contain undefined values");
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  return `{${Object.keys(value)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function sha256Json(value: LocalJson): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function stableKey(kind: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");
  return `${kind}_${digest}`;
}

export function stableId(kind: string, ...parts: string[]): string {
  const namespace = uuidBytes("fbf2cffa-026b-4e78-b808-c5df7d82bf5d");
  const digest = createHash("sha1")
    .update(namespace)
    .update(parts.join(":"), "utf8")
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return `${kind}_${Buffer.from(bytes).toString("hex")}`;
}

export function findingId(runId: string, scenarioKey: string, outcome: string): string {
  const namespace = uuidBytes("26ca44ca-a7c9-4ea8-bc40-fb0f3987ef20");
  const digest = createHash("sha1")
    .update(namespace)
    .update(`${runId}:${scenarioKey}:${outcome}`, "utf8")
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("canonical JSON numbers must be finite");
  if (Object.is(value, -0) || value === 0) return "0";
  const rendered = value.toString();
  if (!/[eE]/.test(rendered)) return rendered;
  const negative = rendered.startsWith("-");
  const unsigned = negative ? rendered.slice(1) : rendered;
  const [coefficient, exponentText] = unsigned.toLowerCase().split("e");
  if (coefficient === undefined || exponentText === undefined) {
    throw new TypeError("invalid canonical JSON number");
  }
  const exponent = Number.parseInt(exponentText, 10);
  const [integer = "", fraction = ""] = coefficient.split(".");
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + exponent;
  const plain =
    decimalPosition <= 0
      ? `0.${"0".repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return negative ? `-${plain}` : plain;
}

function uuidBytes(value: string): Buffer {
  const hex = value.replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new TypeError("invalid UUID namespace");
  return Buffer.from(hex, "hex");
}
