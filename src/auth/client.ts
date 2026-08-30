import { AwError } from "../errors.js";
import { isTrustedApiOrigin } from "./api-origin.js";
import {
  CLI_OAUTH_CLIENT_ID,
  type AuthIdentity,
  type DeviceAuthorization,
  type StoredCredential,
  type TokenResponse
} from "./types.js";

export const AUTH_ENDPOINTS = {
  authorize: "/api/v1/cli/auth/authorize",
  token: "/api/v1/cli/auth/token",
  device: "/api/v1/cli/auth/device",
  revoke: "/api/v1/cli/auth/revoke",
  me: "/api/v1/cli/auth/me"
} as const;

const MAX_AUTH_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type FetchImplementation = typeof fetch;

export interface CloudAuthClientOptions {
  readonly apiOrigin: URL;
  readonly fetch?: FetchImplementation;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class CloudAuthClient {
  readonly apiOrigin: URL;
  readonly #fetch: FetchImplementation;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: CloudAuthClientOptions) {
    if (!isTrustedApiOrigin(options.apiOrigin)) {
      throw new AwError({
        code: "UNSAFE_CLOUD_URL",
        category: "auth",
        message: "Refusing to authenticate with an untrusted AugmentWorks API origin."
      });
    }
    this.apiOrigin = new URL(`${options.apiOrigin.origin}/`);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleep;
  }

  buildAuthorizationUrl(input: {
    readonly redirectUri: URL;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes: readonly string[];
  }): URL {
    if (
      input.redirectUri.protocol !== "http:" ||
      input.redirectUri.hostname !== "127.0.0.1" ||
      input.redirectUri.username !== "" ||
      input.redirectUri.password !== ""
    ) {
      throw new AwError({
        code: "AUTH_CALLBACK_INVALID",
        category: "auth",
        message: "The OAuth callback must use a 127.0.0.1 loopback address."
      });
    }
    const url = this.#endpoint(AUTH_ENDPOINTS.authorize);
    url.searchParams.set("client_id", CLI_OAUTH_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", input.redirectUri.toString());
    url.searchParams.set("scope", input.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly redirectUri: URL;
    readonly codeVerifier: string;
  }): Promise<StoredCredential> {
    const token = await this.#tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLI_OAUTH_CLIENT_ID,
        code: input.code,
        redirect_uri: input.redirectUri.toString(),
        code_verifier: input.codeVerifier
      })
    );
    return this.#toStoredCredential(token);
  }

  async startDeviceAuthorization(scopes: readonly string[]): Promise<DeviceAuthorization> {
    const response = await this.#request(AUTH_ENDPOINTS.device, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLI_OAUTH_CLIENT_ID,
        scope: scopes.join(" ")
      }).toString()
    });
    const body = await parseJsonObject(response);
    if (!response.ok) throw authResponseError(response.status, body);
    const deviceCode = requiredString(body, "device_code");
    const userCode = requiredString(body, "user_code");
    const expiresIn = boundedInteger(body["expires_in"], "expires_in", 60, 1_800);
    const intervalSeconds =
      body["interval"] === undefined ? 5 : boundedInteger(body["interval"], "interval", 1, 60);
    const verificationUri = this.#trustedVerificationUrl(requiredString(body, "verification_uri"));
    const complete = optionalString(body, "verification_uri_complete");
    return {
      deviceCode,
      userCode,
      verificationUri,
      ...(complete === undefined
        ? {}
        : { verificationUriComplete: this.#trustedVerificationUrl(complete) }),
      expiresAt: this.#now() + expiresIn * 1_000,
      intervalMs: intervalSeconds * 1_000
    };
  }

  async pollDeviceToken(
    authorization: DeviceAuthorization,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<StoredCredential> {
    let intervalMs = authorization.intervalMs;
    while (this.#now() < authorization.expiresAt) {
      throwIfAborted(options.signal);
      await this.#sleep(intervalMs, options.signal);
      throwIfAborted(options.signal);
      if (this.#now() >= authorization.expiresAt) break;
      const response = await this.#request(AUTH_ENDPOINTS.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: CLI_OAUTH_CLIENT_ID,
          device_code: authorization.deviceCode
        }).toString(),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      const body = await parseJsonObject(response);
      if (response.ok) return this.#toStoredCredential(asTokenResponse(body));
      const oauthError = optionalString(body, "error");
      if (oauthError === "authorization_pending") {
        continue;
      }
      if (oauthError === "slow_down") {
        intervalMs = Math.min(intervalMs + 5_000, 60_000);
        continue;
      }
      if (oauthError === "access_denied") {
        throw new AwError({
          code: "AUTH_DENIED",
          category: "auth",
          message: "AugmentWorks authorization was denied."
        });
      }
      if (oauthError === "expired_token") break;
      throw authResponseError(response.status, body);
    }
    throw new AwError({
      code: "AUTH_EXPIRED",
      category: "auth",
      message: "The AugmentWorks device authorization expired. Run login again."
    });
  }

  async refresh(refreshToken: string): Promise<StoredCredential> {
    const token = await this.#tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLI_OAUTH_CLIENT_ID,
        refresh_token: refreshToken
      })
    );
    return this.#toStoredCredential(token);
  }

  async revoke(accessToken: string): Promise<void> {
    const response = await this.#request(AUTH_ENDPOINTS.revoke, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: CLI_OAUTH_CLIENT_ID,
        token: accessToken,
        token_type_hint: "access_token"
      }).toString()
    });
    const body = await parseJsonObject(response, true);
    if (!response.ok && response.status !== 401) throw authResponseError(response.status, body);
  }

  async me(accessToken: string): Promise<AuthIdentity> {
    const response = await this.#request(AUTH_ENDPOINTS.me, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const body = await parseJsonObject(response);
    if (!response.ok) throw authResponseError(response.status, body);
    const scopes = body["scopes"];
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
      throw invalidAuthResponse("scopes");
    }
    return {
      subject: requiredString(body, "subject"),
      ...(optionalString(body, "email") === undefined ? {} : { email: optionalString(body, "email")! }),
      workspaceId: requiredString(body, "workspace_id"),
      ...(optionalString(body, "workspace_name") === undefined
        ? {}
        : { workspaceName: optionalString(body, "workspace_name")! }),
      connectorId: requiredString(body, "connector_id"),
      ...(optionalString(body, "connector_name") === undefined
        ? {}
        : { connectorName: optionalString(body, "connector_name")! }),
      scopes: scopes as string[]
    };
  }

  async #tokenRequest(parameters: URLSearchParams): Promise<TokenResponse> {
    const response = await this.#request(AUTH_ENDPOINTS.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: parameters.toString()
    });
    const body = await parseJsonObject(response);
    if (!response.ok) throw authResponseError(response.status, body);
    return asTokenResponse(body);
  }

  #toStoredCredential(token: TokenResponse): StoredCredential {
    if (token.token_type.toLowerCase() !== "bearer") throw invalidAuthResponse("token_type");
    const scopes = token.scope
      ?.split(/\s+/u)
      .map((scope) => scope.trim())
      .filter(Boolean);
    return {
      accessToken: token.access_token,
      tokenType: "Bearer",
      ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
      ...(token.expires_in === undefined
        ? {}
        : { expiresAt: new Date(this.#now() + token.expires_in * 1_000).toISOString() }),
      ...(scopes === undefined ? {} : { scopes }),
      ...(token.workspace_id === undefined ? {} : { workspaceId: token.workspace_id }),
      ...(token.workspace_name === undefined ? {} : { workspaceName: token.workspace_name }),
      ...(token.connector_id === undefined ? {} : { connectorId: token.connector_id }),
      ...(token.connector_name === undefined ? {} : { connectorName: token.connector_name })
    };
  }

  #trustedVerificationUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value, this.apiOrigin);
    } catch (cause) {
      throw new AwError({
        code: "AUTH_RESPONSE_INVALID",
        category: "auth",
        message: "AugmentWorks returned an invalid verification URL.",
        cause
      });
    }
    if (url.origin !== this.apiOrigin.origin || url.username !== "" || url.password !== "") {
      throw new AwError({
        code: "UNSAFE_CLOUD_URL",
        category: "auth",
        message: "AugmentWorks returned an untrusted verification URL."
      });
    }
    return url;
  }

  #endpoint(endpointPath: string): URL {
    const url = new URL(endpointPath, this.apiOrigin);
    if (url.origin !== this.apiOrigin.origin) {
      throw new AwError({
        code: "UNSAFE_CLOUD_URL",
        category: "auth",
        message: "Refusing to contact an untrusted authentication origin."
      });
    }
    return url;
  }

  async #request(endpointPath: string, init: RequestInit): Promise<Response> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();
    const sourceSignal = init.signal;
    const onAbort = (): void => timeoutController.abort(sourceSignal?.reason);
    sourceSignal?.addEventListener("abort", onAbort, { once: true });
    if (sourceSignal?.aborted === true) onAbort();
    try {
      const response = await this.#fetch(this.#endpoint(endpointPath), {
        ...init,
        redirect: "manual",
        signal: timeoutController.signal
      });
      if (response.status >= 300 && response.status < 400) {
        throw new AwError({
          code: "UNSAFE_CLOUD_URL",
          category: "auth",
          message: "The AugmentWorks authentication API returned an unexpected redirect."
        });
      }
      return response;
    } catch (cause) {
      if (cause instanceof AwError) throw cause;
      if (sourceSignal?.aborted === true) {
        throw new AwError({
          code: "INTERRUPTED",
          category: "local",
          message: "Authentication was interrupted.",
          cause
        });
      }
      throw new AwError({
        code: "AUTH_UNAVAILABLE",
        category: "auth",
        message: "Could not reach the AugmentWorks authentication service.",
        retryable: true,
        cause
      });
    } finally {
      clearTimeout(timeout);
      sourceSignal?.removeEventListener("abort", onAbort);
    }
  }
}

function asTokenResponse(body: Record<string, unknown>): TokenResponse {
  const expiresIn =
    body["expires_in"] === undefined
      ? undefined
      : boundedInteger(body["expires_in"], "expires_in", 1, 31_536_000);
  return {
    access_token: requiredString(body, "access_token"),
    token_type: requiredString(body, "token_type"),
    ...(optionalString(body, "refresh_token") === undefined
      ? {}
      : { refresh_token: optionalString(body, "refresh_token")! }),
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    ...(optionalString(body, "scope") === undefined ? {} : { scope: optionalString(body, "scope")! }),
    ...(optionalString(body, "workspace_id") === undefined
      ? {}
      : { workspace_id: optionalString(body, "workspace_id")! }),
    ...(optionalString(body, "workspace_name") === undefined
      ? {}
      : { workspace_name: optionalString(body, "workspace_name")! }),
    ...(optionalString(body, "connector_id") === undefined
      ? {}
      : { connector_id: optionalString(body, "connector_id")! }),
    ...(optionalString(body, "connector_name") === undefined
      ? {}
      : { connector_name: optionalString(body, "connector_name")! })
  };
}

async function parseJsonObject(response: Response, allowEmpty = false): Promise<Record<string, unknown>> {
  const text = await readBoundedText(response);
  if (allowEmpty && text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new AwError({
      code: "AUTH_RESPONSE_INVALID",
      category: "auth",
      message: "AugmentWorks returned an invalid authentication response.",
      cause
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidAuthResponse("body");
  }
  return value as Record<string, unknown>;
}

async function readBoundedText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, REQUEST_TIMEOUT_MS);
  timer.unref();
  try {
    while (true) {
      const item = await reader.read();
      if (timedOut) {
        throw new AwError({
          code: "AUTH_UNAVAILABLE",
          category: "auth",
          message: "The AugmentWorks authentication response timed out.",
          retryable: true
        });
      }
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_AUTH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AwError({
          code: "AUTH_RESPONSE_INVALID",
          category: "auth",
          message: "AugmentWorks returned an oversized authentication response."
        });
      }
      chunks.push(item.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

function authResponseError(status: number, body: Record<string, unknown>): AwError {
  const error = optionalString(body, "error");
  if (status === 401 || error === "invalid_token" || error === "invalid_grant") {
    return new AwError({
      code: "TOKEN_REVOKED",
      category: "auth",
      message: "The AugmentWorks credential is expired or revoked. Run login again."
    });
  }
  if (status === 403 || error === "insufficient_scope") {
    return new AwError({
      code: "SCOPE_DENIED",
      category: "auth",
      message: "The AugmentWorks credential does not have the required connector scope."
    });
  }
  if (error === "access_denied") {
    return new AwError({
      code: "AUTH_DENIED",
      category: "auth",
      message: "AugmentWorks authorization was denied."
    });
  }
  return new AwError({
    code: "AUTH_RESPONSE_ERROR",
    category: "auth",
    message: `AugmentWorks authentication failed with HTTP ${status}.`,
    retryable: status === 429 || status >= 500,
    details: { status }
  });
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "" || value.length > 32 * 1024 || /[\r\n\0]/.test(value)) {
    throw invalidAuthResponse(field);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (record[field] === undefined) return undefined;
  return requiredString(record, field);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidAuthResponse(field);
  }
  return value as number;
}

function invalidAuthResponse(field: string): AwError {
  return new AwError({
    code: "AUTH_RESPONSE_INVALID",
    category: "auth",
    message: `AugmentWorks returned an invalid authentication response field: ${field}.`
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new AwError({
      code: "INTERRUPTED",
      category: "local",
      message: "Authentication was interrupted."
    });
  }
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const onAbort = (): void => {
      finish(() =>
        reject(
          new AwError({
            code: "INTERRUPTED",
            category: "local",
            message: "Authentication was interrupted."
          })
        )
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}
