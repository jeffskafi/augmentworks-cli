import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getApiOrigin } from "../../src/auth/api-origin.js";
import { AUTH_ENDPOINTS, CloudAuthClient } from "../../src/auth/client.js";
import {
  FileCredentialStore,
  createCredentialStore,
  credentialFromEnvironment,
  getCredential,
  resolveAccessToken
} from "../../src/auth/credential-store.js";
import { loginWithLoopback } from "../../src/auth/loopback.js";
import type { CredentialStore, StoredCredential } from "../../src/auth/types.js";
import { runLogin } from "../../src/commands/login.js";
import { runLogout } from "../../src/commands/logout.js";
import { runWhoami } from "../../src/commands/whoami.js";
import { AwError } from "../../src/errors.js";
import { SecretRedactor } from "../../src/system/redact.js";

const temporaryDirectories: string[] = [];
const API_ORIGIN = new URL("http://127.0.0.1:43119/");
const TOKEN = "aw_connector_test_access_token_123";
const REFRESH = "aw_connector_test_refresh_token_456";

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }
});

describe("trusted API origin", () => {
  it("uses the production origin by default and permits loopback development", () => {
    expect(getApiOrigin({}).origin).toBe("https://augmentworks.ai");
    expect(getApiOrigin({ AUGMENTWORKS_API_URL: "http://127.0.0.1:9090" }).origin).toBe(
      "http://127.0.0.1:9090"
    );
  });

  it("rejects arbitrary, credential-bearing, and path-bearing API URLs", () => {
    for (const value of [
      "https://example.com",
      "http://augmentworks.ai",
      "https://user:pass@augmentworks.ai",
      "http://127.0.0.1:9090/prefix"
    ]) {
      expect(() => getApiOrigin({ AUGMENTWORKS_API_URL: value })).toThrowError(
        expect.objectContaining({ code: "UNSAFE_CLOUD_URL" })
      );
    }
  });
});

describe("PKCE loopback login", () => {
  it("binds 127.0.0.1, verifies state, and exchanges the PKCE verifier", async () => {
    let challenge = "";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe(AUTH_ENDPOINTS.token);
      const form = new URLSearchParams(init?.body as string);
      expect(form.get("grant_type")).toBe("authorization_code");
      const verifier = form.get("code_verifier")!;
      expect(createHash("sha256").update(verifier, "ascii").digest("base64url")).toBe(challenge);
      return jsonResponse(tokenBody());
    });
    const client = new CloudAuthClient({ apiOrigin: API_ORIGIN, fetch: fetchMock as typeof fetch });

    const credential = await loginWithLoopback(client, {
      openBrowser: async (authorizationUrl) => {
        challenge = authorizationUrl.searchParams.get("code_challenge")!;
        expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
        const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
        expect(redirect.hostname).toBe("127.0.0.1");
        redirect.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
        redirect.searchParams.set("code", "single-use-code");
        const callback = await fetch(redirect);
        expect(callback.status).toBe(200);
      }
    });

    expect(credential.accessToken).toBe(TOKEN);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched callback state", async () => {
    const client = new CloudAuthClient({
      apiOrigin: API_ORIGIN,
      fetch: vi.fn() as unknown as typeof fetch
    });
    await expect(
      loginWithLoopback(client, {
        openBrowser: async (authorizationUrl) => {
          const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
          redirect.searchParams.set("state", "wrong-state");
          redirect.searchParams.set("code", "code");
          expect((await fetch(redirect)).status).toBe(400);
        }
      })
    ).rejects.toMatchObject({ code: "AUTH_STATE_MISMATCH" });
  });
});

describe("device authorization", () => {
  it("honors the polling interval and authorization_pending", async () => {
    let now = 10_000;
    let polls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === AUTH_ENDPOINTS.device) {
        return jsonResponse({
          device_code: "device-code-value",
          user_code: "ABCD-EFGH",
          verification_uri: `${API_ORIGIN.origin}/activate`,
          expires_in: 600,
          interval: 2
        });
      }
      polls += 1;
      if (polls === 1) return jsonResponse({ error: "authorization_pending" }, 400);
      return jsonResponse(tokenBody());
    });
    const sleeps: number[] = [];
    const client = new CloudAuthClient({
      apiOrigin: API_ORIGIN,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }
    });

    const authorization = await client.startDeviceAuthorization(["connector:run"]);
    const credential = await client.pollDeviceToken(authorization);
    expect(credential.accessToken).toBe(TOKEN);
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  it("refuses a verification URL on another origin", async () => {
    const client = new CloudAuthClient({
      apiOrigin: API_ORIGIN,
      fetch: (async () =>
        jsonResponse({
          device_code: "device-code-value",
          user_code: "ABCD-EFGH",
          verification_uri: "https://attacker.invalid/activate",
          expires_in: 600
        })) as typeof fetch
    });
    await expect(client.startDeviceAuthorization(["connector:run"])).rejects.toMatchObject({
      code: "UNSAFE_CLOUD_URL"
    });
  });
});

describe("credential storage and resolution", () => {
  it("gives AUGMENTWORKS_TOKEN precedence over the stored credential", async () => {
    const store = new MemoryStore({ accessToken: "stored_access_token", tokenType: "Bearer" });
    const resolved = await getCredential({
      apiOrigin: API_ORIGIN,
      env: { AUGMENTWORKS_TOKEN: TOKEN },
      store
    });
    expect(resolved.source).toBe("environment");
    expect(resolved.credential.accessToken).toBe(TOKEN);
    expect(store.loads).toBe(0);
    expect(credentialFromEnvironment({ AUGMENTWORKS_TOKEN: TOKEN })?.source).toBe("environment");
  });

  it("writes a regular mode-0600 fallback file and rejects symlinks", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const credentialPath = path.join(directory, "nested", "credentials.json");
    const store = new FileCredentialStore(credentialPath);
    await store.save({ accessToken: TOKEN, refreshToken: REFRESH, tokenType: "Bearer" });
    expect((await lstat(credentialPath)).mode & 0o777).toBe(0o600);
    expect((await store.load())?.refreshToken).toBe(REFRESH);

    const target = path.join(directory, "target.json");
    await mkdir(path.dirname(target), { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(target, "{}", { mode: 0o600 }));
    const link = path.join(directory, "linked-credentials.json");
    await symlink(target, link);
    await expect(new FileCredentialStore(link).load()).rejects.toMatchObject({
      code: "CREDENTIAL_STORE"
    });
  });

  it("rejects an overly broad credential file", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const credentialPath = path.join(directory, "credentials.json");
    const store = new FileCredentialStore(credentialPath);
    await store.save({ accessToken: TOKEN, tokenType: "Bearer" });
    await chmod(credentialPath, 0o644);
    await expect(store.load()).rejects.toMatchObject({ code: "CREDENTIAL_STORE" });
  });

  it("scopes fallback credential files to the API origin", async () => {
    const directory = await temporaryDirectory();
    const env = { XDG_CONFIG_HOME: directory, PATH: "" };
    const production = await createCredentialStore({
      apiOrigin: new URL("https://augmentworks.ai"),
      env,
      platform: "linux",
      allowFileFallback: true
    });
    const development = await createCredentialStore({
      apiOrigin: new URL("http://127.0.0.1:43119"),
      env,
      platform: "linux",
      allowFileFallback: true
    });
    expect(production.description).not.toBe(development.description);
    await production.save({ accessToken: TOKEN, tokenType: "Bearer" });
    expect(await development.load()).toBeNull();
  });

  it("refreshes an expiring token before relay use", async () => {
    const store = new MemoryStore({
      accessToken: "old_access_token",
      refreshToken: REFRESH,
      tokenType: "Bearer",
      expiresAt: new Date(1_000).toISOString()
    });
    const client = authClient(async (url) => {
      expect(url.pathname).toBe(AUTH_ENDPOINTS.token);
      return jsonResponse(tokenBody());
    }, 0);
    const token = await resolveAccessToken({
      apiOrigin: API_ORIGIN,
      env: {},
      store,
      client,
      now: () => 0
    });
    expect(token).toBe(TOKEN);
    expect((await store.load())?.refreshToken).toBe(REFRESH);
  });
});

describe("commands", () => {
  it("uses the environment token without writing it to a store", async () => {
    const store = new MemoryStore();
    const outputs: string[] = [];
    const client = authClient(async (url) => {
      expect(url.pathname).toBe(AUTH_ENDPOINTS.me);
      return jsonResponse(identityBody());
    });
    const result = await runLogin(
      { json: true },
      {
        env: { AUGMENTWORKS_TOKEN: TOKEN },
        client,
        store,
        stdout: (message) => outputs.push(message),
        stderr: () => undefined
      }
    );
    expect(result.source).toBe("environment");
    expect(store.saves).toBe(0);
    expect(outputs[0]).not.toContain(TOKEN);
  });

  it("refreshes an expiring stored credential before whoami", async () => {
    const store = new MemoryStore({
      accessToken: "old_access_token",
      refreshToken: REFRESH,
      tokenType: "Bearer",
      expiresAt: new Date(1_000).toISOString()
    });
    const calls: string[] = [];
    const client = authClient(async (url) => {
      calls.push(url.pathname);
      if (url.pathname === AUTH_ENDPOINTS.token) return jsonResponse(tokenBody());
      return jsonResponse(identityBody());
    }, 0);
    const result = await runWhoami(
      { json: true },
      {
        env: {},
        client,
        store,
        now: () => 0,
        stdout: () => undefined,
        stderr: () => undefined
      }
    );
    expect(result.identity.connectorId).toBe("connector_test");
    expect(calls).toEqual([AUTH_ENDPOINTS.token, AUTH_ENDPOINTS.me]);
    expect((await store.load())?.refreshToken).toBe(REFRESH);
  });

  it("revokes and removes the stored credential on logout", async () => {
    const store = new MemoryStore({ accessToken: TOKEN, tokenType: "Bearer" });
    const client = authClient(async (url) => {
      expect(url.pathname).toBe(AUTH_ENDPOINTS.revoke);
      return new Response(null, { status: 200 });
    });
    const result = await runLogout(
      { json: true },
      {
        env: {},
        client,
        store,
        stdout: () => undefined,
        stderr: () => undefined
      }
    );
    expect(result).toMatchObject({ revoked: true, removed: true });
    expect(await store.load()).toBeNull();
  });

  it("removes and revokes a stored credential even when an environment token takes precedence", async () => {
    const storedToken = "aw_connector_stored_access_token_789";
    const store = new MemoryStore({ accessToken: storedToken, tokenType: "Bearer" });
    const revoked = new Set<string>();
    const output: string[] = [];
    const client = authClient(async (url, init) => {
      expect(url.pathname).toBe(AUTH_ENDPOINTS.revoke);
      const form = new URLSearchParams(init?.body as string);
      const token = form.get("token");
      expect(token).not.toBeNull();
      revoked.add(token!);
      return new Response(null, { status: 200 });
    });
    const result = await runLogout(
      { json: true },
      {
        env: { AUGMENTWORKS_TOKEN: TOKEN },
        client,
        store,
        stdout: (message) => output.push(message),
        stderr: (message) => output.push(message)
      }
    );
    expect(result).toMatchObject({ source: "environment", revoked: true, removed: true });
    expect(revoked).toEqual(new Set([TOKEN, storedToken]));
    expect(await store.load()).toBeNull();
    expect(output.join("\n")).not.toContain(TOKEN);
    expect(output.join("\n")).not.toContain(storedToken);
  });
});

describe("redaction", () => {
  it("removes explicit, bearer, and AugmentWorks token forms", () => {
    const redactor = new SecretRedactor(["custom-secret-value"]);
    const output = redactor.redact(
      "Bearer abcdefghijkl custom-secret-value aw_connector_abcdefghijk"
    );
    expect(output).not.toContain("abcdefghijkl");
    expect(output).not.toContain("custom-secret-value");
    expect(output).not.toContain("aw_connector_abcdefghijk");
  });
});

function authClient(
  handler: (url: URL, init?: RequestInit) => Promise<Response>,
  now = Date.now()
): CloudAuthClient {
  return new CloudAuthClient({
    apiOrigin: API_ORIGIN,
    now: () => now,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return await handler(url, init);
    }) as typeof fetch
  });
}

function tokenBody(): Record<string, unknown> {
  return {
    access_token: TOKEN,
    refresh_token: REFRESH,
    token_type: "Bearer",
    expires_in: 3_600,
    scope: "connector:identity connector:run",
    workspace_id: "workspace_test",
    connector_id: "connector_test"
  };
}

function identityBody(): Record<string, unknown> {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspace_id: "workspace_test",
    workspace_name: "Test Workspace",
    connector_id: "connector_test",
    connector_name: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"]
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

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

async function temporaryDirectory(): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "augmentworks-auth-test-"))
  );
  temporaryDirectories.push(directory);
  return directory;
}
