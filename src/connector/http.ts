import { Buffer } from "node:buffer";

import type { HttpOperationConfig, JsonValue, ResolvedConfig } from "../config/types.js";
import { AwError, type OperationKind } from "../errors.js";
import { LIMITS } from "../util/limits.js";
import { mapRequestTemplate, selectResponse } from "./mapping.js";
import { normalizeConnectorResult } from "./normalize.js";
import type {
  ConnectorExecutionContext,
  ConnectorResult,
  HttpConnectorOptions
} from "./types.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
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

export class HttpConnector {
  readonly #resolved: ResolvedConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(resolved: ResolvedConfig, options: HttpConnectorOptions = {}) {
    this.#resolved = resolved;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw configError("FETCH_UNAVAILABLE", "This Node.js runtime does not provide fetch.");
    }
  }

  async execute(
    kind: OperationKind,
    input: unknown,
    context: ConnectorExecutionContext
  ): Promise<ConnectorResult> {
    const operation = this.#operation(kind);
    const idempotent = operation.idempotent === true;
    this.#validateMethod(kind, operation);
    const targetUrl = this.#operationUrl(operation.path);
    const effectiveInput = this.#filterObserveInput(kind, this.#withContext(input, context));
    const headers = this.#headers(kind, effectiveInput, context);
    const requestBody = this.#requestBody(operation, effectiveInput);
    if (requestBody !== undefined) headers.set("Content-Type", "application/json");

    const timeoutMs = this.#timeout(operation);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("operation timeout"));
    }, timeoutMs);
    timeout.unref?.();
    const abortFromCaller = (): void => controller.abort(context.signal?.reason);
    if (signalIsAborted(context.signal)) abortFromCaller();
    else context.signal?.addEventListener("abort", abortFromCaller, { once: true });

    let dispatched = false;
    try {
      const request: RequestInit = {
        method: operation.method,
        headers,
        redirect: "manual",
        signal: controller.signal
      };
      if (requestBody !== undefined) request.body = requestBody;

      if (signalIsAborted(context.signal)) {
        throw operationFailure("OPERATION_CANCELLED", kind, "The target operation was cancelled.", false);
      }

      let response: Response;
      try {
        dispatched = true;
        response = await this.#fetch(targetUrl, request);
      } catch (cause) {
        if (timedOut) {
          throw operationFailure(
            idempotent ? "TARGET_TIMEOUT" : "TARGET_OUTCOME_INDETERMINATE",
            kind,
            !idempotent
              ? "The target timed out; the operation may have completed. Observe state before retrying."
              : "The target operation timed out.",
            idempotent,
            cause
          );
        }
        if (signalIsAborted(context.signal)) {
          throw operationFailure("OPERATION_CANCELLED", kind, "The target operation was cancelled.", false, cause);
        }
        throw operationFailure(
          idempotent ? "TARGET_UNREACHABLE" : "TARGET_OUTCOME_INDETERMINATE",
          kind,
          !idempotent
            ? "The target connection failed; the operation may have completed. Observe state before retrying."
            : "The target could not be reached.",
          idempotent,
          cause
        );
      }

      if (response.status >= 300 && response.status < 400) {
        await discardCapped(response, this.#responseLimit(), controller);
        throw operationFailure(
          "TARGET_REDIRECT_REJECTED",
          kind,
          "The target returned a redirect. Connector redirects are disabled.",
          false
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await readCapped(response, this.#responseLimit(), controller, kind);
      } catch (cause) {
        if (cause instanceof AwError) throw cause;
        if (timedOut) {
          throw operationFailure("TARGET_TIMEOUT", kind, "The target response timed out.", idempotent);
        }
        if (signalIsAborted(context.signal)) {
          throw operationFailure("OPERATION_CANCELLED", kind, "The target operation was cancelled.", false);
        }
        throw operationFailure(
          "TARGET_RESPONSE_READ_FAILED",
          kind,
          "The target response could not be read.",
          idempotent
        );
      }
      if (!response.ok) {
        throw operationFailure(
          "TARGET_HTTP_ERROR",
          kind,
          `The target returned HTTP ${response.status}.`,
          idempotent &&
            (response.status === 408 || response.status === 429 || response.status >= 500),
          undefined,
          { status: response.status }
        );
      }

      let responseJson: JsonValue | undefined;
      if (bytes.byteLength > 0) {
        if (!isJsonContentType(response.headers.get("content-type"))) {
          throw operationFailure(
            "TARGET_CONTENT_TYPE_INVALID",
            kind,
            "The target response must use an application/json content type.",
            false
          );
        }
        responseJson = parseJson(bytes, kind);
      } else if (kind !== "cleanup" && kind !== "prepare") {
        throw operationFailure(
          "TARGET_RESPONSE_EMPTY",
          kind,
          "The target returned an empty response where JSON was required.",
          false
        );
      }

      return normalizeConnectorResult({
        kind,
        input: effectiveInput,
        context,
        response: responseJson,
        responseMap: operation.response,
        allowToolEvents: this.#resolved.config.telemetry?.allow_tool_events === true,
        allowedObservations: this.#permittedOutputObservations(kind, effectiveInput),
        secrets: this.#resolved.secrets
      });
    } catch (cause) {
      if (!idempotent && dispatched) {
        if (cause instanceof AwError && cause.code === "TARGET_OUTCOME_INDETERMINATE") throw cause;
        const reasonCode = cause instanceof AwError ? cause.code : "TARGET_FAILURE_AFTER_DISPATCH";
        throw new AwError({
          code: "TARGET_OUTCOME_INDETERMINATE",
          category: "target",
          message:
            "The operation was dispatched, but complete evidence was not received. Observe state before retrying.",
          retryable: false,
          operation: kind,
          commandId: context.commandId,
          details: { reason_code: reasonCode }
        });
      }
      throw cause;
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  isIdempotent(kind: OperationKind): boolean {
    const operation = this.#operation(kind);
    return operation.idempotent === true;
  }

  #operation(kind: OperationKind): HttpOperationConfig {
    const operation = this.#resolved.config.target.operations[kind];
    if (operation === undefined) {
      throw configError(
        "CONNECTOR_OPERATION_NOT_CONFIGURED",
        `The ${kind} operation is not configured.`,
        kind
      );
    }
    return operation;
  }

  #validateMethod(kind: OperationKind, operation: HttpOperationConfig): void {
    if (operation.method === "DELETE" && kind !== "cleanup") {
      throw configError(
        "DELETE_OPERATION_FORBIDDEN",
        "DELETE is allowed only for the cleanup operation.",
        kind
      );
    }
    if (operation.method === "GET" && operation.request !== undefined) {
      throw configError("GET_BODY_FORBIDDEN", "GET operations cannot configure a request body.", kind);
    }
  }

  #operationUrl(path: string): URL {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.includes("#") ||
      /[\u0000-\u001f\u007f]/u.test(path)
    ) {
      throw configError(
        "OPERATION_PATH_INVALID",
        "Operation paths must be fixed root-relative paths without fragments."
      );
    }
    let target: URL;
    try {
      target = new URL(path, this.#resolved.baseUrl);
    } catch (cause) {
      throw new AwError({
        code: "OPERATION_PATH_INVALID",
        category: "config",
        message: "Operation path is not a valid URL path.",
        cause
      });
    }
    if (
      target.origin !== this.#resolved.baseUrl.origin ||
      target.username !== "" ||
      target.password !== ""
    ) {
      throw configError("OPERATION_ORIGIN_FORBIDDEN", "Operation paths must stay on the configured target origin.");
    }
    return target;
  }

  #headers(kind: OperationKind, input: unknown, context: ConnectorExecutionContext): Headers {
    const headers = new Headers({ Accept: "application/json" });
    for (const [name, value] of Object.entries(this.#resolved.authHeaders)) {
      const lower = name.toLowerCase();
      if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("sec-") || lower.startsWith("aw-")) {
        throw configError("HEADER_FORBIDDEN", `Configured header ${name} is reserved or unsafe.`, kind);
      }
      assertHeaderValue(value, name);
      headers.set(name, value);
    }

    const inputObject = jsonObject(input);
    const ids: ReadonlyArray<readonly [string, string | undefined]> = [
      ["AW-Protocol-Version", "aw-connector/0.1"],
      ["AW-Operation", kind],
      ["AW-Command-Id", context.commandId],
      ["AW-Idempotency-Key", context.idempotencyKey],
      ["AW-Run-Id", correlateHeader(context.runId, inputObject["run_id"], "run_id")],
      ["AW-Attempt-Id", correlateHeader(context.attemptId, inputObject["attempt_id"], "attempt_id")],
      ["AW-Turn-Id", correlateHeader(context.turnId, inputObject["turn_id"], "turn_id")],
      ["AW-Request-Id", correlateHeader(context.requestId, inputObject["request_id"], "request_id")]
    ];
    for (const [name, value] of ids) {
      if (value === undefined) continue;
      assertHeaderValue(value, name);
      headers.set(name, value);
    }
    const inputIdempotency = inputObject["idempotency_key"];
    if (inputIdempotency !== undefined && inputIdempotency !== context.idempotencyKey) {
      throw configError(
        "CORRELATION_MISMATCH",
        "Command context and input disagree on idempotency_key.",
        kind
      );
    }
    return headers;
  }

  #requestBody(operation: HttpOperationConfig, input: unknown): string | undefined {
    if (operation.method === "GET") return undefined;
    const body = mapRequestTemplate(operation.request ?? "$input", input);
    const serialized = JSON.stringify(body);
    const configured = this.#resolved.config.target.limits?.request_bytes ?? LIMITS.targetResponseBytes;
    if (!Number.isSafeInteger(configured) || configured < 1) {
      throw configError("TARGET_REQUEST_LIMIT_INVALID", "Target request byte limit must be positive.");
    }
    const limit = Math.min(configured, LIMITS.targetResponseBytes);
    if (Buffer.byteLength(serialized, "utf8") > limit) {
      throw configError("TARGET_REQUEST_TOO_LARGE", "Mapped target request exceeds the configured byte limit.");
    }
    return serialized;
  }

  #responseLimit(): number {
    const configured = this.#resolved.config.target.limits?.response_bytes ?? LIMITS.targetResponseBytes;
    if (!Number.isSafeInteger(configured) || configured < 1) {
      throw configError("TARGET_RESPONSE_LIMIT_INVALID", "Target response byte limit must be positive.");
    }
    return Math.min(configured, LIMITS.targetResponseBytes);
  }

  #timeout(operation: HttpOperationConfig): number {
    const configured =
      operation.timeout_ms ??
      this.#resolved.config.target.limits?.operation_timeout_ms ??
      DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > 5 * 60_000) {
      throw configError(
        "OPERATION_TIMEOUT_INVALID",
        "Operation timeout must be between 1 and 300000 milliseconds."
      );
    }
    return configured;
  }

  #filterObserveInput(kind: OperationKind, input: unknown): unknown {
    if (kind !== "observe") return input;
    const object = jsonObject(input);
    const probes = object["probe_keys"];
    if (probes === undefined) return input;
    if (!Array.isArray(probes) || probes.some((key) => typeof key !== "string")) {
      throw configError("INVALID_PROBE_KEYS", "observe probe_keys must be an array of strings.", kind);
    }
    const allowed = new Set(this.#resolved.config.telemetry?.allow_observations ?? []);
    if (probes.some((key) => !allowed.has(key as string))) {
      throw new AwError({
        code: "OBSERVATION_NOT_ALLOWED",
        category: "evidence",
        message: "The assessment requested an observation outside the local telemetry allowlist.",
        operation: kind
      });
    }
    return { ...object, probe_keys: [...probes] };
  }

  #withContext(input: unknown, context: ConnectorExecutionContext): Record<string, unknown> {
    const object = jsonObject(input);
    const enriched: Record<string, unknown> = { ...object };
    const correlations: ReadonlyArray<readonly [string, string | undefined]> = [
      ["run_id", context.runId],
      ["attempt_id", context.attemptId],
      ["turn_id", context.turnId],
      ["request_id", context.requestId]
    ];
    for (const [key, contextValue] of correlations) {
      const inputValue = object[key];
      if (inputValue !== undefined && typeof inputValue !== "string") {
        throw configError("CORRELATION_INVALID", `${key} must be a string.`);
      }
      if (contextValue !== undefined && inputValue !== undefined && contextValue !== inputValue) {
        throw configError("CORRELATION_MISMATCH", `Command context and input disagree on ${key}.`);
      }
      if (inputValue === undefined && contextValue !== undefined) enriched[key] = contextValue;
    }
    return enriched;
  }

  #permittedOutputObservations(kind: OperationKind, input: unknown): ReadonlySet<string> {
    const locallyAllowed = new Set(this.#resolved.config.telemetry?.allow_observations ?? []);
    if (kind !== "observe") return locallyAllowed;
    const probes = jsonObject(input)["probe_keys"];
    if (probes === undefined) return locallyAllowed;
    return new Set((probes as readonly string[]).filter((key) => locallyAllowed.has(key)));
  }
}

async function readCapped(
  response: Response,
  limit: number,
  controller: AbortController,
  kind: OperationKind
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      controller.abort();
      throw operationFailure(
        "TARGET_CONTENT_LENGTH_INVALID",
        kind,
        "The target returned an invalid Content-Length header.",
        false
      );
    }
    if (length > limit) {
      controller.abort();
      throw operationFailure(
        "TARGET_RESPONSE_TOO_LARGE",
        kind,
        "The target response exceeds the configured byte limit.",
        false
      );
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > limit - size) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw operationFailure(
          "TARGET_RESPONSE_TOO_LARGE",
          kind,
          "The target response exceeds the configured byte limit.",
          false
        );
      }
      chunks.push(chunk.value);
      size += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function discardCapped(
  response: Response,
  limit: number,
  controller: AbortController
): Promise<void> {
  try {
    await readCapped(response, limit, controller, "send");
  } catch {
    controller.abort();
  }
}

function parseJson(bytes: Uint8Array, kind: OperationKind): JsonValue {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw operationFailure(
      "TARGET_JSON_INVALID",
      kind,
      "The target response is not valid UTF-8 JSON.",
      false,
      cause
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw operationFailure("TARGET_JSON_INVALID", kind, "The target response is not valid JSON.", false, cause);
  }
  return selectResponse(parsed, "$" as const);
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configError("INVALID_OPERATION_INPUT", "Operation input must be a JSON object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw configError("INVALID_OPERATION_INPUT", "Operation input must be a plain JSON object.");
  }
  return value as Record<string, unknown>;
}

function correlateHeader(
  contextValue: string | undefined,
  inputValue: unknown,
  label: string
): string | undefined {
  if (inputValue !== undefined && typeof inputValue !== "string") {
    throw configError("CORRELATION_INVALID", `${label} must be a string.`);
  }
  if (contextValue !== undefined && inputValue !== undefined && contextValue !== inputValue) {
    throw configError("CORRELATION_MISMATCH", `Command context and input disagree on ${label}.`);
  }
  return contextValue ?? (inputValue as string | undefined);
}

function assertHeaderValue(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1000 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw configError("HEADER_VALUE_INVALID", `Header ${name} contains an invalid value.`);
  }
}

function configError(code: string, message: string, operation?: OperationKind): AwError {
  return new AwError({
    code,
    category: "config",
    message,
    ...(operation === undefined ? {} : { operation })
  });
}

function operationFailure(
  code: string,
  operation: OperationKind,
  message: string,
  retryable: boolean,
  cause?: unknown,
  details?: Readonly<Record<string, string | number | boolean>>
): AwError {
  // Do not retain transport exception objects: runtimes and mocks may attach
  // request data that includes configured credentials. Safe structured fields
  // are copied explicitly below.
  void cause;
  return new AwError({
    code,
    category: operation === "cleanup" ? "cleanup" : "target",
    message,
    retryable,
    operation,
    ...(details === undefined ? {} : { details })
  });
}
