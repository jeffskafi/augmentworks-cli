import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { AUTH_ENDPOINTS, AUTH_USER_MESSAGES, CloudAuthClient } from "../../src/auth/client.js";
import { loginWithLoopback } from "../../src/auth/loopback.js";
import { listenLoopback } from "../util/http-server.js";

const API_ORIGIN = new URL("http://127.0.0.1:43119/");
const PRODUCTION_EQUIVALENT_CSP =
  "default-src 'self'; form-action 'self'; upgrade-insecure-requests; base-uri 'none'";

describe("CLI browser callback (C01)", () => {
  it("CSP-01: a same-origin form 303 reaches the real loopback listener and completes exchange", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe(AUTH_ENDPOINTS.token);
      expect(new URLSearchParams(init?.body as string).get("code")).toBe("loopback-code");
      return Response.json({
        access_token: "aw_connector_test_access_token_123",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "aw_connector_test_refresh_token_456",
        scope: "connector:identity connector:run"
      });
    });
    const client = new CloudAuthClient({ apiOrigin: API_ORIGIN, fetch: fetchMock as typeof fetch });
    const authorize = await listenLoopback(
      createServer((request, response) => {
        void handleAuthorize(request, response);
      })
    );

    try {
      const credential = await loginWithLoopback(client, {
        openBrowser: async (authorizationUrl) => {
          expect(authorizationUrl.searchParams.get("redirect_uri")).toMatch(
            /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/[A-Za-z0-9_-]+$/
          );
          const form = await fetch(`${authorize.baseUrl}/authorize`, {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              state: authorizationUrl.searchParams.get("state") ?? "",
              redirect_uri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
              decision: "approve"
            })
          });
          expect(form.status).toBe(303);
          expect(form.headers.get("content-security-policy")).toContain("form-action 'self'");
          expect(form.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
          const location = form.headers.get("location");
          expect(location).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
          const callback = await fetch(location ?? "", { redirect: "manual", headers: { referer: authorize.baseUrl } });
          expect(callback.status).toBe(200);
          expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
          expect(callback.headers.get("cache-control")).toBe("no-store");
        }
      });
      expect(credential.accessToken).toBe("aw_connector_test_access_token_123");
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await authorize.close();
    }
  });

  it("CSP-02: denial reaches the listener with matching state and cancels", async () => {
    const client = new CloudAuthClient({
      apiOrigin: API_ORIGIN,
      fetch: vi.fn() as unknown as typeof fetch
    });
    const authorize = await listenLoopback(
      createServer((request, response) => {
        void handleAuthorize(request, response);
      })
    );
    try {
      await expect(
        loginWithLoopback(client, {
          openBrowser: async (authorizationUrl) => {
            const form = await fetch(`${authorize.baseUrl}/authorize`, {
              method: "POST",
              redirect: "manual",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                state: authorizationUrl.searchParams.get("state") ?? "",
                redirect_uri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
                decision: "deny"
              })
            });
            const callback = await fetch(form.headers.get("location") ?? "", { redirect: "manual" });
            expect(callback.status).toBe(403);
            expect(await callback.text()).toBe(AUTH_USER_MESSAGES.denied);
          }
        })
      ).rejects.toMatchObject({ code: "AUTH_DENIED" });
    } finally {
      await authorize.close();
    }
  });

  it("CSP-03: invalid host, path, and state remain rejected", async () => {
    const client = new CloudAuthClient({
      apiOrigin: API_ORIGIN,
      fetch: vi.fn() as unknown as typeof fetch
    });
    const authorize = await listenLoopback(
      createServer((request, response) => {
        void handleAuthorize(request, response);
      })
    );
    try {
      const invalidHost = await fetch(`${authorize.baseUrl}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          state: "state",
          redirect_uri: "http://example.com/oauth/callback/not-local",
          decision: "approve"
        })
      });
      expect(invalidHost.status).toBe(400);

      await expect(
        loginWithLoopback(client, {
          openBrowser: async (authorizationUrl) => {
            const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
            expect(redirect.hostname).toBe("127.0.0.1");
            expect(redirect.protocol).toBe("http:");
            expect(redirect.username).toBe("");
            expect(redirect.password).toBe("");
            expect(redirect.hash).toBe("");
            const wrongPath = new URL(redirect);
            wrongPath.pathname = "/oauth/callback/not-the-nonce";
            expect((await fetch(wrongPath)).status).toBe(404);
            const wrongState = new URL(redirect);
            wrongState.searchParams.set("state", "tampered");
            wrongState.searchParams.set("code", "code");
            expect((await fetch(wrongState)).status).toBe(400);
          }
        })
      ).rejects.toMatchObject({ code: "AUTH_STATE_MISMATCH" });
    } finally {
      await authorize.close();
    }
  });

  it("CSP-03: a consumed callback cannot be replayed", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe(AUTH_ENDPOINTS.token);
      expect(new URLSearchParams(init?.body as string).get("code")).toBe("loopback-code");
      return Response.json({
        access_token: "aw_connector_test_access_token_123",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "aw_connector_test_refresh_token_456",
        scope: "connector:identity connector:run"
      });
    });
    const client = new CloudAuthClient({ apiOrigin: API_ORIGIN, fetch: fetchMock as typeof fetch });
    const authorize = await listenLoopback(
      createServer((request, response) => {
        void handleAuthorize(request, response);
      })
    );
    try {
      await loginWithLoopback(client, {
        openBrowser: async (authorizationUrl) => {
          const form = await fetch(`${authorize.baseUrl}/authorize`, {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              state: authorizationUrl.searchParams.get("state") ?? "",
              redirect_uri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
              decision: "approve"
            })
          });
          const location = form.headers.get("location") ?? "";
          const callback = await fetch(location, { redirect: "manual" });
          expect(callback.status).toBe(200);
          const replay = await fetch(location, { redirect: "manual" });
          expect(replay.status).toBe(409);
          expect(await replay.text()).toBe(AUTH_USER_MESSAGES.alreadyUsed);
        }
      });
    } finally {
      await authorize.close();
    }
  });
});

async function handleAuthorize(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/authorize") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PRODUCTION_EQUIVALENT_CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    });
    response.end("<form method=post action=/authorize></form>");
    return;
  }
  if (request.method !== "POST" || request.url !== "/authorize") {
    response.writeHead(404);
    response.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  let location: URL;
  try {
    location = new URL(redirectUri);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  if (
    location.protocol !== "http:" ||
    location.hostname !== "127.0.0.1" ||
    location.username !== "" ||
    location.password !== "" ||
    location.hash !== "" ||
    !/^\/oauth\/callback\/[A-Za-z0-9_-]+$/.test(location.pathname)
  ) {
    response.writeHead(400);
    response.end();
    return;
  }
  location.search = "";
  location.hash = "";
  location.searchParams.set("state", state);
  if (params.get("decision") === "deny") location.searchParams.set("error", "access_denied");
  else location.searchParams.set("code", "loopback-code");
  response.writeHead(303, {
    location: location.toString(),
    "content-security-policy": PRODUCTION_EQUIVALENT_CSP,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer"
  });
  response.end();
}
