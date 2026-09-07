import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_ENDPOINTS, CloudAuthClient } from "../../src/auth/client.js";
import {
  API_KEY_ENV,
  REFRESH_TOKEN_ENV,
  TOKEN_ENV,
  createAccessTokenManager,
  credentialFromEnvironment,
  getCredential,
  inspectCredentialEnvironment
} from "../../src/auth/credential-store.js";
import type { CredentialStore, StoredCredential } from "../../src/auth/types.js";
import { authenticateHostedSession } from "../../src/commands/hosted-auth.js";
import { runLogin } from "../../src/commands/login.js";
import { runLogout } from "../../src/commands/logout.js";
import { runWhoami } from "../../src/commands/whoami.js";
import { AwError } from "../../src/errors.js";

const API_ORIGIN = new URL("http://127.0.0.1:43119/");
const API_KEY = "aw_api_test_explicit_key_value_123";
const TOKEN = "aw_connector_test_access_token_123";
const REFRESH = "aw_connector_test_refresh_token_456";

class MemoryStore implements CredentialStore {
  readonly kind = "native" as const;
  readonly description = "in-memory test store";
  loads = 0;
  saves = 0;

  constructor(private credential: StoredCredential | null = null) {}

  async load(): Promise<StoredCredential | null> {
    this.loads += 1;
    return this.credential;
  }

  async save(credential: StoredCredential): Promise<void> {
    this.saves += 1;
    this.credential = credential;
  }

  async delete(): Promise<void> {
    this.credential = null;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function machineIdentity(): Record<string, unknown> {
  return {
    subject: "machine_cred_report_only",
    workspace_id: "workspace_test",
    workspace_name: "QA Workspace",
    connector_id: "connector_qa",
    connector_name: "QA Connector",
    scopes: ["connector:identity", "connector:run"],
    principal_kind: "machine",
    credential_id: "cred_report_only",
    actions: ["run:read", "evaluation:read", "criterion_detail:read"],
    expires_at: "2026-10-07T12:00:00.000Z"
  };
}

function authClient(handler: (url: URL) => Promise<Response>): CloudAuthClient {
  return new CloudAuthClient({
    apiOrigin: API_ORIGIN,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return await handler(url);
    }) as typeof fetch
  });
}

describe("AUGMENTWORKS_API_KEY explicit mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects differing nonempty API_KEY and TOKEN values before store or network access", () => {
    const store = new MemoryStore({ accessToken: "stored_access_token", tokenType: "Bearer" });
    expect(() =>
      inspectCredentialEnvironment({
        [API_KEY_ENV]: API_KEY,
        [TOKEN_ENV]: TOKEN
      })
    ).toThrowError(expect.objectContaining({ code: "AUTH_ENV_CONFLICT" }));
    expect(() =>
      credentialFromEnvironment({
        [API_KEY_ENV]: API_KEY,
        [TOKEN_ENV]: TOKEN
      })
    ).toThrowError(expect.objectContaining({ code: "AUTH_ENV_CONFLICT" }));
    expect(store.loads).toBe(0);
  });

  it("fails hosted authentication on env conflict before identity or store access", async () => {
    const store = new MemoryStore({ accessToken: "stored_access_token", tokenType: "Bearer" });
    const identity = vi.fn();
    await expect(
      authenticateHostedSession(
        {
          env: {
            [API_KEY_ENV]: API_KEY,
            [TOKEN_ENV]: TOKEN,
            AUGMENTWORKS_API_URL: API_ORIGIN.toString()
          }
        },
        {
          accessToken: async () => {
            throw new Error("must not resolve a token after an env conflict");
          },
          identity
        }
      )
    ).rejects.toMatchObject({ code: "AUTH_ENV_CONFLICT" });
    expect(identity).not.toHaveBeenCalled();
    expect(store.loads).toBe(0);
  });

  it("treats equal nonempty API_KEY and TOKEN values as the same explicit key", async () => {
    const store = new MemoryStore({
      accessToken: "stored_access_token",
      refreshToken: REFRESH,
      tokenType: "Bearer"
    });
    const resolved = await getCredential({
      apiOrigin: API_ORIGIN,
      env: { [API_KEY_ENV]: API_KEY, [TOKEN_ENV]: API_KEY, [REFRESH_TOKEN_ENV]: REFRESH },
      store
    });
    expect(resolved.source).toBe("api_key");
    expect(resolved.credential.accessToken).toBe(API_KEY);
    expect(resolved.credential.refreshToken).toBeUndefined();
    expect(store.loads).toBe(0);
  });

  it("does not use a stale REFRESH_TOKEN, load the keychain, persist, or refresh", async () => {
    const store = new MemoryStore({
      accessToken: "stored_access_token",
      refreshToken: REFRESH,
      tokenType: "Bearer"
    });
    const fetchMock = vi.fn();
    const client = new CloudAuthClient({
      apiOrigin: API_ORIGIN,
      fetch: fetchMock as unknown as typeof fetch
    });
    const manager = await createAccessTokenManager({
      apiOrigin: API_ORIGIN,
      env: { [API_KEY_ENV]: API_KEY, [REFRESH_TOKEN_ENV]: REFRESH },
      store,
      client
    });
    await expect(manager.getAccessToken()).resolves.toBe(API_KEY);
    await expect(
      manager.getAccessToken({ forceRefresh: true, rejectedAccessToken: API_KEY })
    ).resolves.toBe(API_KEY);
    expect(manager.source).toBe("api_key");
    expect(store.loads).toBe(0);
    expect(store.saves).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves TOKEN+REFRESH_TOKEN rotation when API_KEY is absent", async () => {
    const rotated = "aw_connector_env_rotated_access_token";
    const store = new MemoryStore({ accessToken: "stored_access_token", tokenType: "Bearer" });
    const client = authClient(async (url) => {
      expect(url.pathname).toBe(AUTH_ENDPOINTS.token);
      return jsonResponse({
        access_token: rotated,
        token_type: "Bearer",
        expires_in: 3_600,
        scope: "connector:identity connector:run"
      });
    });
    const manager = await createAccessTokenManager({
      apiOrigin: API_ORIGIN,
      env: { [TOKEN_ENV]: TOKEN, [REFRESH_TOKEN_ENV]: REFRESH },
      store,
      client
    });
    await expect(
      manager.getAccessToken({ forceRefresh: true, rejectedAccessToken: TOKEN })
    ).resolves.toBe(rotated);
    expect(manager.source).toBe("environment");
    expect(store.loads).toBe(0);
    expect(store.saves).toBe(0);
  });

  it("whoami reports machine credential metadata without the bearer", async () => {
    const store = new MemoryStore({ accessToken: "stored_access_token", tokenType: "Bearer" });
    const outputs: string[] = [];
    const client = authClient(async (url) => {
      expect(url.pathname).toBe(AUTH_ENDPOINTS.me);
      return jsonResponse(machineIdentity());
    });
    const result = await runWhoami(
      { json: true },
      {
        env: { [API_KEY_ENV]: API_KEY },
        client,
        store,
        stdout: (message) => outputs.push(message),
        stderr: () => undefined
      }
    );
    expect(result.source).toBe("api_key");
    expect(result.identity.principalKind).toBe("machine");
    expect(result.identity.credentialId).toBe("cred_report_only");
    expect(result.identity.email).toBeUndefined();
    expect(outputs.join("\n")).toContain("cred_report_only");
    expect(outputs.join("\n")).not.toContain(API_KEY);
    expect(store.loads).toBe(0);
  });

  it("maps expired or revoked API keys to typed auth remediation", async () => {
    const store = new MemoryStore();
    const client = authClient(async () => jsonResponse({ error: "invalid_token" }, 401));
    await expect(
      runWhoami(
        { json: true },
        {
          env: { [API_KEY_ENV]: API_KEY },
          client,
          store,
          stdout: () => undefined,
          stderr: () => undefined
        }
      )
    ).rejects.toMatchObject({ code: "API_KEY_REVOKED", category: "auth" });
    expect(store.loads).toBe(0);
  });

  it("login in API-key mode calls /me and never persists or launches a store write", async () => {
    const store = new MemoryStore();
    const outputs: string[] = [];
    const client = authClient(async (url) => {
      expect(url.pathname).toBe(AUTH_ENDPOINTS.me);
      return jsonResponse(machineIdentity());
    });
    const result = await runLogin(
      { json: true },
      {
        env: { [API_KEY_ENV]: API_KEY },
        client,
        store,
        stdout: (message) => outputs.push(message),
        stderr: () => undefined
      }
    );
    expect(result.source).toBe("api_key");
    expect(store.saves).toBe(0);
    expect(store.loads).toBe(0);
    expect(outputs.join("\n")).not.toContain(API_KEY);
  });

  it("logout in API-key mode does not load the credential store", async () => {
    const store = new MemoryStore({ accessToken: "stored_access_token", tokenType: "Bearer" });
    const client = authClient(async (url) => {
      expect(url.pathname).toBe(AUTH_ENDPOINTS.revoke);
      return new Response(null, { status: 200 });
    });
    const result = await runLogout(
      { json: true },
      {
        env: { [API_KEY_ENV]: API_KEY },
        client,
        store,
        stdout: () => undefined,
        stderr: () => undefined
      }
    );
    expect(result.source).toBe("api_key");
    expect(result.removed).toBe(false);
    expect(store.loads).toBe(0);
    expect(await store.load()).not.toBeNull();
  });

  it("rejects an unknown principal_kind without requiring a machine email", async () => {
    const client = authClient(async () =>
      jsonResponse({
        subject: "machine_x",
        workspace_id: "workspace_test",
        connector_id: "connector_qa",
        scopes: ["connector:identity"],
        principal_kind: "service"
      })
    );
    await expect(client.me(API_KEY)).rejects.toMatchObject({ code: "AUTH_RESPONSE_INVALID" });
    const ok = await authClient(async () => jsonResponse(machineIdentity())).me(API_KEY);
    expect(ok.principalKind).toBe("machine");
    expect(ok.email).toBeUndefined();
  });
});

describe("AUTH_ENV_CONFLICT is an auth failure", () => {
  it("uses the auth category", () => {
    try {
      inspectCredentialEnvironment({ [API_KEY_ENV]: API_KEY, [TOKEN_ENV]: TOKEN });
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(AwError);
      expect((error as AwError).category).toBe("auth");
    }
  });
});
