import { AwError } from "../errors.js";
import type { AccessTokenProvider, AccessTokenRequest } from "../auth/types.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { assertJsonLimits, LIMITS } from "../util/limits.js";
import { CLI_VERSION } from "../version.js";
import {
  CommandAckSchema,
  ConnectorSessionResponseSchema,
  CreateSessionRequestSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  PollResponseSchema,
  RELAY_PROTOCOL_VERSION,
  RunStatusResponseSchema,
  SessionPollResponseSchema,
  parseRelayCommand,
  type CommandAck,
  type ConnectorSessionResponse,
  type CreateSessionRequest,
  type CreateRunRequest,
  type CreateRunResponse,
  type PollResponse,
  type RelayCommand,
  type RelayResult,
  type RelayProtocolVersion,
  type RunStatusResponse,
  type SessionPollResponse
} from "./protocol.js";

export interface CloudClientOptions {
  apiUrl: string | URL;
  accessToken: string;
  accessTokenProvider?: AccessTokenProvider;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

export interface PollOperationOptions {
  runId: string;
  sessionId: string;
  afterSequence: number;
  fencingEpoch: number;
  waitMs?: number;
  signal?: AbortSignal;
  protocolVersion?: RelayProtocolVersion;
}

export interface SafeRelayFailure {
  code: string;
  safe_message: string;
  retryable: boolean;
}

export type FailureDisposition = "failed" | "outcome_indeterminate";

export class CloudClient {
  readonly apiUrl: URL;
  readonly requestTimeoutMs: number;
  #accessToken: string;
  readonly #accessTokenProvider: AccessTokenProvider | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: CloudClientOptions) {
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.#accessToken = requireAccessToken(options.accessToken);
    this.#accessTokenProvider = options.accessTokenProvider;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async createRun(request: CreateRunRequest, signal?: AbortSignal): Promise<CreateRunResponse> {
    const validated = CreateRunRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_RUN_REQUEST",
        category: "protocol",
        message: "The assessment request does not match the aw-relay create-run contract."
      });
    }
    const requestSha256 = sha256(canonicalize(validated.data));
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const value = await this.#request(
          "POST",
          "/v1/relay/runs",
          validated.data,
          signal,
          this.requestTimeoutMs,
          false,
          { "Idempotency-Key": validated.data.create_request_id }
        );
        const response = parseResponse(CreateRunResponseSchema, value, "create-run response");
        if (
          response.create_request_id !== validated.data.create_request_id ||
          response.create_request_sha256 !== requestSha256
        ) {
          throw new AwError({
            code: "RUN_BINDING_MISMATCH",
            category: "protocol",
            message: "AugmentWorks returned a run for a different create request."
          });
        }
        return response;
      } catch (error) {
        lastError = error;
        if (!(error instanceof AwError) || !error.retryable || attempt === 2 || signal?.aborted) {
          throw error;
        }
        await retryDelay(Math.min(100 * 2 ** attempt, 500), signal);
      }
    }
    throw lastError;
  }

  async createConnectorSession(
    request: CreateSessionRequest,
    signal?: AbortSignal
  ): Promise<ConnectorSessionResponse> {
    const validated = CreateSessionRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_SESSION_REQUEST",
        category: "protocol",
        message: "The connector session request does not match aw-relay/0.1."
      });
    }
    const value = await this.#request("POST", "/v1/relay/sessions", validated.data, signal);
    return parseResponse(ConnectorSessionResponseSchema, value, "connector-session response");
  }

  async pollConnectorSession(options: {
    sessionId: string;
    fencingEpoch: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<SessionPollResponse | null> {
    const waitMs = Math.min(Math.max(options.waitMs ?? 25_000, 0), 30_000);
    const value = await this.#request(
      "POST",
      `/v1/relay/sessions/${segment(options.sessionId)}:poll`,
      {
        protocol_version: RELAY_PROTOCOL_VERSION,
        fencing_epoch: options.fencingEpoch,
        wait_seconds: Math.ceil(waitMs / 1_000)
      },
      options.signal,
      waitMs + 10_000,
      true
    );
    if (value === undefined) return null;
    return parseResponse(SessionPollResponseSchema, value, "connector-session poll response");
  }

  async closeConnectorSession(
    sessionId: string,
    fencingEpoch: number,
    signal?: AbortSignal
  ): Promise<ConnectorSessionResponse> {
    const value = await this.#request(
      "POST",
      `/v1/relay/sessions/${segment(sessionId)}:close`,
      { protocol_version: RELAY_PROTOCOL_VERSION, fencing_epoch: fencingEpoch },
      signal
    );
    return parseResponse(ConnectorSessionResponseSchema, value, "connector-session close response");
  }

  async pollOperation(options: PollOperationOptions): Promise<PollResponse | null> {
    if (!Number.isInteger(options.afterSequence) || options.afterSequence < 0) {
      throw new AwError({
        code: "INVALID_RELAY_CURSOR",
        category: "protocol",
        message: "The relay cursor is invalid."
      });
    }
    const waitMs = Math.min(Math.max(options.waitMs ?? 25_000, 0), 30_000);
    const value = await this.#request(
      "POST",
      `/v1/relay/sessions/${segment(options.sessionId)}/commands:poll`,
      {
        protocol_version: options.protocolVersion ?? RELAY_PROTOCOL_VERSION,
        run_id: options.runId,
        after_sequence: options.afterSequence,
        fencing_epoch: options.fencingEpoch,
        wait_seconds: Math.ceil(waitMs / 1_000)
      },
      options.signal,
      waitMs + 10_000,
      true
    );
    if (value === undefined) return null;
    const response = parseResponse(PollResponseSchema, value, "poll response");
    return response.command === null
      ? response
      : { ...response, command: parseRelayCommand(response.command) };
  }

  async completeOperation(
    command: RelayCommand,
    result: RelayResult,
    resultSha256 = sha256(canonicalize(result)),
    signal?: AbortSignal
  ): Promise<CommandAck> {
    const value = await this.#request(
      "POST",
      `/v1/relay/commands/${segment(command.command_id)}:complete`,
      commandBoundBody(command, { result, result_sha256: resultSha256 }),
      signal
    );
    return parseResponse(CommandAckSchema, value, "completion acknowledgement");
  }

  async failOperation(
    command: RelayCommand,
    failure: SafeRelayFailure,
    disposition: FailureDisposition,
    failureSha256 = sha256(canonicalize({ disposition, error: failure })),
    signal?: AbortSignal
  ): Promise<CommandAck> {
    const value = await this.#request(
      "POST",
      `/v1/relay/commands/${segment(command.command_id)}:fail`,
      commandBoundBody(command, {
        disposition,
        error: failure,
        result_sha256: failureSha256
      }),
      signal
    );
    return parseResponse(CommandAckSchema, value, "failure acknowledgement");
  }

  async cancelRun(
    runId: string,
    reason = "user_requested",
    signal?: AbortSignal,
    protocolVersion: RelayProtocolVersion = RELAY_PROTOCOL_VERSION
  ): Promise<RunStatusResponse> {
    const value = await this.#request(
      "POST",
      `/v1/relay/runs/${segment(runId)}:cancel`,
      { protocol_version: protocolVersion, reason: reason.slice(0, 120) },
      signal
    );
    return parseResponse(RunStatusResponseSchema, value, "cancellation response");
  }

  async getRunStatus(runId: string, signal?: AbortSignal): Promise<RunStatusResponse> {
    const value = await this.#request(
      "GET",
      `/v1/relay/runs/${segment(runId)}`,
      undefined,
      signal
    );
    return parseResponse(RunStatusResponseSchema, value, "run status response");
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    externalSignal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
    allowNoContent = false,
    additionalHeaders: Readonly<Record<string, string>> = {},
    allowAuthRefresh = true
  ): Promise<unknown | undefined> {
    const accessToken = await this.#currentAccessToken(
      externalSignal === undefined ? {} : { signal: externalSignal }
    );
    const url = apiEndpoint(this.apiUrl, path);
    const controller = new AbortController();
    const onAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("request timeout"));
    }, timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-AugmentWorks-CLI-Version": CLI_VERSION,
          ...additionalHeaders,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: canonicalize(body) })
      });
    } catch (error) {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      if (externalSignal?.aborted) {
        throw new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The AugmentWorks request was cancelled.",
          retryable: true,
          cause: error
        });
      }
      throw new AwError({
        code: "RELAY_UNREACHABLE",
        category: "relay",
        message: "Could not reach the AugmentWorks relay.",
        retryable: true,
        cause: error
      });
    }

    if (allowNoContent && response.status === 204) {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      return undefined;
    }
    let text: string;
    try {
      text = await readBoundedText(response, LIMITS.envelopeBytes);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The AugmentWorks request was cancelled.",
          retryable: true,
          cause: error
        });
      }
      if (timedOut) {
        throw new AwError({
          code: "RELAY_UNREACHABLE",
          category: "relay",
          message: "The AugmentWorks relay response timed out.",
          retryable: true,
          cause: error
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
    let value: unknown;
    try {
      value = text.length === 0 ? undefined : JSON.parse(text);
    } catch (error) {
      throw new AwError({
        code: "INVALID_CLOUD_RESPONSE",
        category: "protocol",
        message: "AugmentWorks returned an invalid JSON response.",
        cause: error
      });
    }
    if (value !== undefined) assertJsonLimits(value, "AugmentWorks response");
    if (response.status === 401 && allowAuthRefresh && this.#accessTokenProvider !== undefined) {
      const replacement = requireAccessToken(
        await this.#accessTokenProvider({
          forceRefresh: true,
          rejectedAccessToken: accessToken,
          ...(externalSignal === undefined ? {} : { signal: externalSignal })
        })
      );
      this.#accessToken = replacement;
      if (replacement !== accessToken) {
        return await this.#request(
          method,
          path,
          body,
          externalSignal,
          timeoutMs,
          allowNoContent,
          additionalHeaders,
          false
        );
      }
    }
    if (!response.ok) throw cloudHttpError(response.status, value);
    if (value === undefined) {
      throw new AwError({
        code: "INVALID_CLOUD_RESPONSE",
        category: "protocol",
        message: "AugmentWorks returned an empty response."
      });
    }
    return value;
  }

  async #currentAccessToken(request: AccessTokenRequest): Promise<string> {
    if (this.#accessTokenProvider === undefined) return this.#accessToken;
    const current = requireAccessToken(await this.#accessTokenProvider(request));
    this.#accessToken = current;
    return current;
  }
}

function requireAccessToken(value: string): string {
  if (value.trim() === "" || /[\r\n\0]/u.test(value)) {
    throw new AwError({
      code: "AUTH_REQUIRED",
      category: "auth",
      message: "Log in to AugmentWorks before starting an assessment."
    });
  }
  return value;
}

async function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new AwError({
      code: "RELAY_REQUEST_CANCELLED",
      category: "relay",
      message: "The AugmentWorks request was cancelled.",
      retryable: true
    });
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The AugmentWorks request was cancelled.",
          retryable: true
        })
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function normalizeApiUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AwError({
      code: "INVALID_API_URL",
      category: "config",
      message: "AUGMENTWORKS_API_URL is not a valid URL.",
      cause: error
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AwError({
      code: "INVALID_API_URL",
      category: "config",
      message: "The AugmentWorks API URL cannot contain credentials, a query, or a fragment."
    });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AwError({
      code: "INSECURE_API_URL",
      category: "config",
      message: "The AugmentWorks API URL must use HTTPS, except for a loopback test server."
    });
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function apiEndpoint(base: URL, path: string): URL {
  const url = new URL(base);
  url.pathname = `${base.pathname.replace(/\/$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function commandBoundBody(command: RelayCommand, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol_version: command.protocol_version,
    command_id: command.command_id,
    session_id: command.session_id,
    run_id: command.run_id,
    packet: command.packet,
    config_sha256: command.config_sha256,
    sequence: command.sequence,
    fencing_epoch: command.fencing_epoch,
    ...extra
  };
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw responseTooLarge();
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw responseTooLarge();
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch (error) {
    if (error instanceof AwError) throw error;
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned a response that is not valid UTF-8.",
      cause: error
    });
  }
}

function responseTooLarge(): AwError {
  return new AwError({
    code: "RELAY_ENVELOPE_TOO_LARGE",
    category: "protocol",
    message: "The AugmentWorks response exceeds the relay envelope limit."
  });
}

function cloudHttpError(status: number, value: unknown): AwError {
  const serverError = safeServerError(value);
  const category = status === 401 || status === 403 ? "auth" : status === 409 || status === 410 ? "protocol" : "relay";
  const code =
    serverError?.code ??
    (status === 401 || status === 403
      ? "CLOUD_AUTH_REJECTED"
      : status === 409
        ? "RELAY_CONFLICT"
        : status === 410
          ? "COMMAND_EXPIRED"
          : "CLOUD_REQUEST_FAILED");
  const setupUrl = serverError?.setupUrl;
  const disclosureMissing = isDisclosureError(code);
  const message =
    serverError?.message ??
    (category === "auth"
      ? "AugmentWorks rejected the connector credential."
      : "The AugmentWorks relay rejected the request.");
  const disclosureSuffix = disclosureMissing
    ? setupUrl === undefined
      ? " Complete the authenticated judging disclosure, then re-run the same test command. Target work was not started."
      : ` Complete setup at ${setupUrl}, then re-run the same test command. Target work was not started.`
    : setupUrl === undefined
      ? ""
      : ` Setup: ${setupUrl}`;
  return new AwError({
    code,
    category: disclosureMissing ? "relay" : category,
    message: `${message}${disclosureSuffix}`,
    retryable: status === 408 || status === 429 || status >= 500,
    details: {
      http_status: status,
      ...(setupUrl === undefined ? {} : { setup_url: setupUrl })
    }
  });
}

function isDisclosureError(code: string): boolean {
  return (
    code === "DISCLOSURE_REQUIRED" ||
    code === "DISCLOSURE_MISSING" ||
    code === "JUDGE_DISCLOSURE_REQUIRED" ||
    code === "JUDGE_DISCLOSURE_MISSING" ||
    code === "MISSING_DISCLOSURE"
  );
}

function safeServerError(
  value: unknown
): { code: string; message: string; setupUrl?: string } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = (value as Record<string, unknown>)["error"];
  if (error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const code = record["code"];
  const message = record["message"];
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) return undefined;
  if (typeof message !== "string" || message.length < 1 || message.length > 500) return undefined;
  const setupCandidate = record["setup_url"] ?? record["setupUrl"];
  const setupUrl =
    typeof setupCandidate === "string" && isHttpUrl(setupCandidate) ? setupCandidate : undefined;
  return {
    code,
    message: message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""),
    ...(setupUrl === undefined ? {} : { setupUrl })
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function parseResponse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: `AugmentWorks returned an invalid ${label}.`
    });
  }
  return parsed.data;
}
