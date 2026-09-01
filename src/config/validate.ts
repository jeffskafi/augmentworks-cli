import { z } from "zod";

import type { AugmentWorksConfig, Diagnostic, JsonValue } from "./types.js";
import { ENV_NAME_PATTERN, EXACT_ENV_REFERENCE_PATTERN } from "./environment.js";
import { LIMITS } from "../util/limits.js";

const ENV_REFERENCE_OR_URL_PATTERN = /^(?:\$\{[A-Z_][A-Z0-9_]*\}|https?:\/\/)/;
const INPUT_SELECTOR_PATTERN = /^\$input(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]*)\])*$/;
const RESPONSE_SELECTOR_PATTERN = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]*)\])+$/;
const OBSERVATION_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HIGH_CONFIDENCE_SECRET_PATTERN = /(?:^|[^A-Za-z0-9_-])(?:aw_(?:project|connector)_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+\S{12,})(?=$|[^A-Za-z0-9_-])/i;
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const RESERVED_OBSERVE_FIELDS = new Set(["protocol_version", "request_id", "observations", "metadata"]);

function isJsonValue(value: unknown, seen = new Set<object>(), depth = 0): value is JsonValue {
  if (depth > LIMITS.maxDepth) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxArrayItems) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((child) => isJsonValue(child, seen, depth + 1));
    seen.delete(value);
    return valid;
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > LIMITS.maxObjectKeys) return false;
  const valid = entries.every(
    ([key, child]) => !["__proto__", "prototype", "constructor"].includes(key) && isJsonValue(child, seen, depth + 1)
  );
  seen.delete(value);
  return valid;
}

const jsonValueSchema = z.custom<JsonValue>(isJsonValue, "Expected a finite JSON value");
const responseMapSchema = z
  .record(z.string().min(1).max(64), z.string().min(1).max(256))
  .refine((value) => Object.keys(value).length <= 64, "Response mappings cannot contain more than 64 fields");

const operationSchema = z
  .object({
    method: z.enum(["GET", "POST", "DELETE"]),
    path: z.string().min(1).max(1024),
    request: jsonValueSchema.optional(),
    response: responseMapSchema.optional(),
    timeout_ms: z.number().int().min(100).max(120_000).optional(),
    idempotent: z.boolean().optional()
  })
  .strict();

const authSchema = z
  .object({
    bearer_env: z.string().regex(ENV_NAME_PATTERN).optional(),
    headers_env: z
      .record(z.string().min(1), z.string().regex(ENV_NAME_PATTERN))
      .refine((value) => Object.keys(value).length <= 32, "Authentication cannot contain more than 32 headers")
      .optional()
  })
  .strict();

const configSchema = z
  .object({
    version: z.literal(1),
    target: z
      .object({
        name: z.string().trim().min(1).max(128),
        connector: z.literal("http"),
        base_url: z.string().min(1).max(2048).regex(ENV_REFERENCE_OR_URL_PATTERN),
        allow_insecure_http: z.boolean().optional(),
        auth: authSchema.optional(),
        operations: z
          .object({
            prepare: operationSchema.optional(),
            send: operationSchema,
            observe: operationSchema.optional(),
            cleanup: operationSchema.optional()
          })
          .strict(),
        limits: z
          .object({
            request_bytes: z.number().int().min(1024).max(1_048_576).optional(),
            response_bytes: z.number().int().min(1024).max(1_048_576).optional(),
            operation_timeout_ms: z.number().int().min(100).max(120_000).optional()
          })
          .strict()
          .optional()
      })
      .strict(),
    telemetry: z
      .object({
        allow_tool_events: z.boolean().optional(),
        allow_observations: z.array(z.string().regex(OBSERVATION_PATTERN)).max(64).optional()
      })
      .strict()
      .optional()
  })
  .strict();

function dottedPath(path: readonly PropertyKey[]): string | undefined {
  if (path.length === 0) return undefined;
  return path.map(String).join(".");
}

function pushError(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
  diagnostics.push({ level: "error", code, message, ...(path === undefined ? {} : { path }) });
}

function pushWarning(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
  diagnostics.push({ level: "warning", code, message, ...(path === undefined ? {} : { path }) });
}

function validateRequestTemplate(value: JsonValue, path: string, diagnostics: Diagnostic[]): void {
  if (typeof value === "string") {
    if (value.includes("$input") && !INPUT_SELECTOR_PATTERN.test(value)) {
      pushError(
        diagnostics,
        "REQUEST_MAPPING_INVALID",
        "Request mappings must be an exact $input selector; interpolation and expressions are not allowed.",
        path
      );
    }
    if (value.includes("${")) {
      pushError(
        diagnostics,
        "ENV_REFERENCE_FORBIDDEN",
        "Environment references are only allowed in target.base_url and explicit *_env authentication fields.",
        path
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateRequestTemplate(child, `${path}[${index}]`, diagnostics));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) validateRequestTemplate(child, `${path}.${key}`, diagnostics);
  }
}

function validateOperation(
  operation: AugmentWorksConfig["target"]["operations"][keyof AugmentWorksConfig["target"]["operations"]],
  kind: "prepare" | "send" | "observe" | "cleanup",
  path: string,
  diagnostics: Diagnostic[]
): void {
  if (operation === undefined) return;
  if (!operation.path.startsWith("/") || operation.path.startsWith("//") || /[\\#\u0000-\u001f]/.test(operation.path)) {
    pushError(
      diagnostics,
      "OPERATION_PATH_INVALID",
      "Operation paths must be fixed same-origin paths beginning with one slash, without fragments or backslashes.",
      `${path}.path`
    );
  }
  if (operation.path.includes("$input") || operation.path.includes("${")) {
    pushError(
      diagnostics,
      "OPERATION_PATH_DYNAMIC",
      "Operation paths are fixed by local configuration and cannot contain input or environment interpolation.",
      `${path}.path`
    );
  }
  if (operation.method === "GET" && operation.request !== undefined) {
    pushError(diagnostics, "GET_BODY_FORBIDDEN", "GET operations cannot define a request body.", `${path}.request`);
  }
  if (operation.method === "DELETE" && kind !== "cleanup") {
    pushError(diagnostics, "DELETE_OPERATION_FORBIDDEN", "DELETE is allowed only for cleanup.", `${path}.method`);
  }
  if (operation.request !== undefined) validateRequestTemplate(operation.request, `${path}.request`, diagnostics);
  if (operation.response !== undefined) {
    for (const [field, selector] of Object.entries(operation.response)) {
      if (!OBSERVATION_PATTERN.test(field) || ["__proto__", "prototype", "constructor"].includes(field)) {
        pushError(diagnostics, "RESPONSE_FIELD_INVALID", "Response field names must be identifiers or dotted observation keys.", `${path}.response.${field}`);
      }
      if (!RESPONSE_SELECTOR_PATTERN.test(selector)) {
        pushError(
          diagnostics,
          "RESPONSE_MAPPING_INVALID",
          "Response mappings support property and numeric-index selection only, for example $.answer or $.events[0].",
          `${path}.response.${field}`
        );
      }
      if (field === "metadata") {
        pushWarning(
          diagnostics,
          "RESPONSE_METADATA_IGNORED",
          "Target response metadata is not uploaded in v0.1; this mapping is ignored.",
          `${path}.response.${field}`
        );
      }
    }
  }
}

function scanLiteralSecrets(value: unknown, path: string, diagnostics: Diagnostic[]): void {
  if (typeof value === "string") {
    if (HIGH_CONFIDENCE_SECRET_PATTERN.test(value)) {
      pushError(
        diagnostics,
        "LITERAL_SECRET_FORBIDDEN",
        "A value that looks like a secret was found in YAML. Store it in .env and reference only its variable name.",
        path
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanLiteralSecrets(child, `${path}[${index}]`, diagnostics));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      scanLiteralSecrets(child, path === "" ? key : `${path}.${key}`, diagnostics);
    }
  }
}

export interface ValidationResult {
  readonly config?: AugmentWorksConfig;
  readonly diagnostics: readonly Diagnostic[];
}

export function validateConfigObject(value: unknown): ValidationResult {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) => {
        const path = dottedPath(issue.path);
        return {
          level: "error",
          code: "CONFIG_SCHEMA_INVALID",
          message: issue.message,
          ...(path === undefined ? {} : { path })
        };
      })
    };
  }

  const config = parsed.data as AugmentWorksConfig;
  const diagnostics: Diagnostic[] = [];
  if (config.target.base_url.includes("${") && !EXACT_ENV_REFERENCE_PATTERN.test(config.target.base_url)) {
    pushError(
      diagnostics,
      "ENV_REFERENCE_INVALID",
      "target.base_url must be a literal URL or one exact ${ENV_NAME} reference.",
      "target.base_url"
    );
  }

  const headers = config.target.auth?.headers_env;
  if (headers !== undefined) {
    const normalized = new Set<string>();
    for (const header of Object.keys(headers)) {
      const lower = header.toLowerCase();
      if (!HEADER_NAME_PATTERN.test(header) || FORBIDDEN_HEADERS.has(lower) || lower.startsWith("sec-") || lower.startsWith("aw-")) {
        pushError(diagnostics, "AUTH_HEADER_FORBIDDEN", `Authentication header ${JSON.stringify(header)} is not allowed.`, `target.auth.headers_env.${header}`);
      }
      if (normalized.has(lower)) {
        pushError(diagnostics, "AUTH_HEADER_DUPLICATE", `Authentication header ${JSON.stringify(header)} is duplicated case-insensitively.`, `target.auth.headers_env.${header}`);
      }
      normalized.add(lower);
      if (lower === "authorization" && config.target.auth?.bearer_env !== undefined) {
        pushError(diagnostics, "AUTH_HEADER_CONFLICT", "Use bearer_env or an Authorization header, not both.", `target.auth.headers_env.${header}`);
      }
    }
  }

  const lifecycle = config.target.operations;
  const lifecycleCount = [lifecycle.prepare, lifecycle.observe, lifecycle.cleanup].filter((operation) => operation !== undefined).length;
  if (lifecycleCount !== 0 && lifecycleCount !== 3) {
    pushError(
      diagnostics,
      "LIFECYCLE_INCOMPLETE",
      "Stateful targets must configure prepare, observe, and cleanup together.",
      "target.operations"
    );
  }

  for (const kind of ["prepare", "send", "observe", "cleanup"] as const) {
    validateOperation(lifecycle[kind], kind, `target.operations.${kind}`, diagnostics);
  }

  const toolEventsMapped =
    Object.hasOwn(lifecycle.send.response ?? {}, "tool_events") ||
    Object.hasOwn(lifecycle.send.response ?? {}, "events");
  if (toolEventsMapped && config.telemetry?.allow_tool_events !== true) {
    pushWarning(
      diagnostics,
      "TOOL_EVENTS_NOT_ALLOWED",
      "send maps structured events, but telemetry.allow_tool_events is not true; those events will not leave this machine.",
      "telemetry.allow_tool_events"
    );
  }

  const allowedObservations = config.telemetry?.allow_observations ?? [];
  if (new Set(allowedObservations).size !== allowedObservations.length) {
    pushError(
      diagnostics,
      "OBSERVATION_ALLOWLIST_DUPLICATE",
      "telemetry.allow_observations cannot contain duplicate keys.",
      "telemetry.allow_observations"
    );
  }
  if (lifecycleCount === 3 && allowedObservations.length === 0) {
    pushWarning(
      diagnostics,
      "OBSERVATIONS_NOT_ALLOWED",
      "Stateful hooks are configured, but no observation keys are allowlisted to leave this machine.",
      "telemetry.allow_observations"
    );
  }
  if (lifecycle.observe === undefined && allowedObservations.length > 0) {
    pushWarning(
      diagnostics,
      "OBSERVE_OPERATION_MISSING",
      "Observation keys are allowlisted, but no observe operation is configured.",
      "target.operations.observe"
    );
  }
  if (lifecycle.observe?.response !== undefined) {
    for (const field of Object.keys(lifecycle.observe.response)) {
      if (!RESERVED_OBSERVE_FIELDS.has(field) && !allowedObservations.includes(field)) {
        pushWarning(
          diagnostics,
          "OBSERVATION_NOT_ALLOWED",
          `Mapped observation ${field} is not in telemetry.allow_observations and will be discarded.`,
          `target.operations.observe.response.${field}`
        );
      }
    }
  }

  scanLiteralSecrets(config, "", diagnostics);
  return { config, diagnostics };
}

export const mappingPatterns = {
  input: INPUT_SELECTOR_PATTERN,
  response: RESPONSE_SELECTOR_PATTERN
} as const;
