import { describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { runUsage } from "../../src/commands/usage.js";
import type { AuthIdentity } from "../../src/auth/types.js";
import { AwError } from "../../src/errors.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = JSON.parse(
  await readFile(resolve(fileURLToPath(new URL("../..", import.meta.url)), "contracts/aw-billing-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const TOKEN_ONE = "aw_connector_token_one";
const TOKEN_TWO = "aw_connector_token_two";

const identity: AuthIdentity = {
  subject: "user_test",
  email: "developer@example.com",
  workspaceId: WORKSPACE,
  workspaceName: "Fixture workspace",
  connectorId: "connector_test",
  connectorName: "Refunds Staging",
  scopes: ["connector:identity", "connector:run"]
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("usage client", () => {
  it("keeps the same billing account after a simulated token refresh", async () => {
    let token = TOKEN_ONE;
    const bearers: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url.pathname === "/v1/billing/capabilities") {
        return jsonResponse(fixtures.fixtures["absent_capability"]?.response);
      }
      if (url.pathname === "/v1/billing/usage") {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === `Bearer ${TOKEN_ONE}`) {
          return jsonResponse(
            {
              schemaVersion: "aw-billing/1",
              error: {
                code: "unauthenticated",
                message: "A valid CLI connector credential is required.",
                retryable: false
              }
            },
            401
          );
        }
        return jsonResponse(fixtures.fixtures["partially_consumed_trial"]?.response);
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    const result = await runUsage(
      { env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787", AUGMENTWORKS_TOKEN: TOKEN_ONE } },
      {
        accessToken: async (request) => {
          if (request.forceRefresh === true) token = TOKEN_TWO;
          return token;
        },
        identity: async () => identity,
        cloud: (options) =>
          new CloudClient({
            apiUrl: options.apiOrigin,
            accessToken: options.accessToken,
            accessTokenProvider: options.accessTokenProvider,
            fetch: fetchMock
          })
      }
    );

    expect(result.usage.billingAccountId).toBe(ACCOUNT);
    expect(result.usage.availableUnits).toBe(190);
    expect(bearers).toEqual([
      `Bearer ${TOKEN_ONE}`,
      `Bearer ${TOKEN_ONE}`,
      `Bearer ${TOKEN_TWO}`
    ]);
  });

  it("aborts an in-flight usage read", async () => {
    const controller = new AbortController();
    let signalFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      signalFetchStarted?.();
      if (init?.signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
      return jsonResponse(fixtures.fixtures["eligible_trial"]?.response);
    });
    const pending = runUsage(
      {
        signal: controller.signal,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787", AUGMENTWORKS_TOKEN: TOKEN_ONE }
      },
      {
        accessToken: async () => TOKEN_ONE,
        identity: async () => identity,
        cloud: (options) =>
          new CloudClient({
            apiUrl: options.apiOrigin,
            accessToken: options.accessToken,
            accessTokenProvider: options.accessTokenProvider,
            fetch: fetchMock,
            requestTimeoutMs: 10_000
          })
      }
    );
    await fetchStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "RELAY_REQUEST_CANCELLED", retryable: true });
  });

  it("never treats a missing usage_v1 document as a zero balance", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return jsonResponse({
          schemaVersion: "aw-billing/1",
          asOf: "2026-09-06T17:00:00.000Z",
          capabilities: ["quote_v1"]
        });
      }
      throw new Error("usage must not be called");
    });
    await expect(
      runUsage(
        { env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787", AUGMENTWORKS_TOKEN: TOKEN_ONE } },
        {
          accessToken: async () => TOKEN_ONE,
          identity: async () => identity,
          cloud: (options) =>
            new CloudClient({
              apiUrl: options.apiOrigin,
              accessToken: options.accessToken,
              fetch: fetchMock
            })
        }
      )
    ).rejects.toMatchObject({ code: "USAGE_UNSUPPORTED", category: "billing" });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/v1/billing/usage"))).toBe(
      false
    );
  });

  it("directs a missing application profile to first-party recovery without creating an account", async () => {
    await expect(
      runUsage(
        { env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787", AUGMENTWORKS_TOKEN: TOKEN_ONE } },
        {
          accessToken: async () => TOKEN_ONE,
          identity: async () => {
            throw new AwError({
              code: "AUTH_RESPONSE_ERROR",
              category: "auth",
              message: "The application profile is missing for this identity."
            });
          }
        }
      )
    ).rejects.toMatchObject({
      code: "PROFILE_RECOVERY_REQUIRED",
      category: "billing"
    });
  });
});
