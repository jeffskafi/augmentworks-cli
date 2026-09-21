import { isIP } from "node:net";
import { z } from "zod";

import { canonicalize, sha256 } from "../util/canonical.js";
import { isLocalOrPrivateHost } from "../config/resolve.js";
import { suiteError } from "./errors.js";

export const LIVE_TARGET_SCHEMA_VERSION = "aw-live-target/1" as const;
export const LIVE_INFORMATIONAL_MODE = "informational" as const;
export const LIVE_PACKET_SCHEMA_VERSION = "aw-packet/live-informational-1" as const;
export const LIVE_AUTHORIZATION_KINDS = ["owned_target", "written_permission"] as const;
export const LIVE_MAX_MESSAGES_MIN = 1;
export const LIVE_MAX_MESSAGES_MAX = 3;
export const LIVE_MAX_CASES = 3;

export const LIVE_ERROR_CODES = [
  "LIVE_TARGET_NOT_ENABLED",
  "LIVE_TARGET_AUTHORIZATION_EXPIRED",
  "LIVE_TARGET_SCOPE_MISMATCH",
  "LIVE_TARGET_MESSAGE_LIMIT"
] as const;

export type LiveErrorCode = (typeof LIVE_ERROR_CODES)[number];
export type LiveAuthorizationKind = (typeof LIVE_AUTHORIZATION_KINDS)[number];

const UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const AUTHORIZATION_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export const LiveTargetContractSchema = z
  .object({
    schemaVersion: z.literal(LIVE_TARGET_SCHEMA_VERSION),
    mode: z.literal(LIVE_INFORMATIONAL_MODE),
    origin: z.string().min(8).max(2_048),
    authorizationKind: z.enum(LIVE_AUTHORIZATION_KINDS),
    authorizationRef: z.string().min(1).max(200).regex(AUTHORIZATION_REF),
    expiresAt: z.string().regex(UTC_Z, "must be a UTC Z timestamp"),
    maxMessages: z.number().int().min(LIVE_MAX_MESSAGES_MIN).max(LIVE_MAX_MESSAGES_MAX)
  })
  .strict()
  .superRefine((value, context) => {
    try {
      const origin = canonicalHttpsOrigin(value.origin);
      if (origin !== value.origin) {
        context.addIssue({
          code: "custom",
          message: "live origin must already be the exact canonical HTTPS origin",
          path: ["origin"]
        });
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "live origin is not a canonical HTTPS origin",
        path: ["origin"]
      });
    }
  });

export type LiveTargetContract = z.infer<typeof LiveTargetContractSchema>;

export function liveError(
  code: LiveErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>
) {
  return suiteError(code, liveRecoveryCopy(code, message), details);
}

export function liveRecoveryCopy(code: LiveErrorCode, message: string): string {
  const suffix =
    " Do not relabel a live target as synthetic. Live admission is server-allowlisted and is not enabled by submitting a suite.";
  if (message.includes("relabel") || message.includes("synthetic")) {
    return message;
  }
  switch (code) {
    case "LIVE_TARGET_NOT_ENABLED":
      return `${message}${suffix} Ask an operator to review AUGMENTWORKS_LIVE_TARGET_PILOT_ALLOWLIST after deploy; this CLI cannot authorize the origin.`;
    case "LIVE_TARGET_AUTHORIZATION_EXPIRED":
      return `${message} Obtain a new authorization reference and a new quote. Do not reuse an expired live contract.`;
    case "LIVE_TARGET_SCOPE_MISMATCH":
      return `${message} The approved origin, operations, and cases must match exactly. Do not widen the target or describe it as synthetic.`;
    case "LIVE_TARGET_MESSAGE_LIMIT":
      return `${message} The dispatched-message cap includes indeterminate sends. Do not retry a timed-out live send.`;
    default:
      return message;
  }
}

export function canonicalHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live target origin must be an absolute canonical HTTPS origin."
    );
  }
  if (url.protocol !== "https:") {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live target origin must use HTTPS with no credentials, path, query, or wildcard."
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live target origin cannot contain credentials."
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live target origin cannot contain a query or fragment."
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live target origin cannot contain a path. Match the exact approved origin only."
    );
  }
  const hostname = url.hostname.replace(/\.$/u, "").toLowerCase();
  if (
    hostname === "" ||
    hostname.includes("*") ||
    hostname.startsWith(".") ||
    hostname.includes("..") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live target origin cannot use wildcards, relative DNS, or suffix matching."
    );
  }
  if (isIP(hostname) !== 0 || isLocalOrPrivateHost(hostname)) {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live target origin cannot be loopback, private, link-local, or a raw IP address. Loopback is transport only, never the assessed target."
    );
  }
  const port = url.port === "" || url.port === "443" ? "" : `:${url.port}`;
  return `https://${hostname}${port}`;
}

export function parseLiveTargetContract(value: unknown): LiveTargetContract {
  const parsed = LiveTargetContractSchema.safeParse(value);
  if (!parsed.success) {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      `Live target contract is not a complete aw-live-target/1 document (${parsed.error.issues[0]?.message ?? "invalid"}).`
    );
  }
  return {
    ...parsed.data,
    origin: canonicalHttpsOrigin(parsed.data.origin)
  };
}

export function canonicalLiveTarget(contract: LiveTargetContract): Record<string, unknown> {
  return {
    schemaVersion: contract.schemaVersion,
    mode: contract.mode,
    origin: contract.origin,
    authorizationKind: contract.authorizationKind,
    authorizationRef: contract.authorizationRef,
    expiresAt: contract.expiresAt,
    maxMessages: contract.maxMessages
  };
}

export function liveTargetHash(contract: LiveTargetContract): string {
  return sha256(canonicalize(canonicalLiveTarget(contract)));
}

export function liveTargetExpiresAtMs(contract: LiveTargetContract): number {
  const milliseconds = Date.parse(contract.expiresAt);
  if (!Number.isFinite(milliseconds)) {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live target expiry is not a valid absolute timestamp."
    );
  }
  return milliseconds;
}

export function assertLiveTargetNotExpired(contract: LiveTargetContract, now = Date.now()): void {
  if (liveTargetExpiresAtMs(contract) <= now) {
    throw liveError(
      "LIVE_TARGET_AUTHORIZATION_EXPIRED",
      `Live target authorization ${contract.authorizationRef} expired at ${contract.expiresAt}.`
    );
  }
}

export function looksLikeLivePacketDocument(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const version = record["schemaVersion"] ?? record["schema_version"];
  if (version === "aw-packet/local-authorized-1" || version === "aw-packet/authorized-1") return false;
  if (version === LIVE_PACKET_SCHEMA_VERSION) return true;
  if (record["liveTarget"] !== undefined || record["live_target"] !== undefined) return true;
  if (record["syntheticOnly"] === false || record["synthetic_only"] === false) {
    return typeof version === "string" && version.startsWith("aw-packet/");
  }
  return false;
}
