import { describe, expect, it, vi } from "vitest";

import { AUTH_ENDPOINTS } from "../../src/auth/client.js";
import {
  WORKSPACE_ID_ENV,
  WORKSPACE_UUID_PATTERN,
  assertExpectedWorkspace,
  formatWorkspaceLabel,
  parseWorkspaceExpectation,
  workspaceConfigConflictError,
  workspaceMismatchError
} from "../../src/auth/workspace-expectation.js";
import { authenticateHostedSession } from "../../src/commands/hosted-auth.js";
import { EXIT, exitCodeFor } from "../../src/errors.js";
import type { AuthIdentity } from "../../src/auth/types.js";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const API_ORIGIN = new URL("http://127.0.0.1:43119/");

function identity(workspaceId: string): AuthIdentity {
  return {
    subject: "user_test",
    workspaceId,
    connectorId: "connector_test",
    scopes: ["connector:identity", "connector:run"]
  };
}

describe("workspace expectation parsing", () => {
  it("accepts a flag UUID, lowercases it, and ignores blank env", () => {
    expect(
      parseWorkspaceExpectation({
        flag: WORKSPACE_A.toUpperCase(),
        env: { [WORKSPACE_ID_ENV]: "  " }
      })
    ).toEqual({ workspaceId: WORKSPACE_A, source: "flag" });
  });

  it("reads AUGMENTWORKS_WORKSPACE_ID when --workspace is omitted", () => {
    expect(
      parseWorkspaceExpectation({
        env: { [WORKSPACE_ID_ENV]: ` ${WORKSPACE_B.toUpperCase()} ` }
      })
    ).toEqual({ workspaceId: WORKSPACE_B, source: "env" });
  });

  it("treats missing and empty env as no expectation", () => {
    expect(parseWorkspaceExpectation({ env: {} })).toBeUndefined();
    expect(parseWorkspaceExpectation({ env: { [WORKSPACE_ID_ENV]: "" } })).toBeUndefined();
  });

  it("fails closed when flag and env disagree before any caller can network", () => {
    const error = workspaceConfigConflictError(WORKSPACE_A, WORKSPACE_B);
    expect(error.code).toBe("WORKSPACE_CONFIG_CONFLICT");
    expect(error.category).toBe("config");
    expect(exitCodeFor(error)).toBe(EXIT.CONFIG);
    expect(() =>
      parseWorkspaceExpectation({
        flag: WORKSPACE_A,
        env: { [WORKSPACE_ID_ENV]: WORKSPACE_B }
      })
    ).toThrowError(expect.objectContaining({ code: "WORKSPACE_CONFIG_CONFLICT" }));
  });

  it("allows identical flag and env values with different case", () => {
    expect(
      parseWorkspaceExpectation({
        flag: WORKSPACE_A,
        env: { [WORKSPACE_ID_ENV]: WORKSPACE_A.toUpperCase() }
      })
    ).toEqual({ workspaceId: WORKSPACE_A, source: "flag" });
  });

  it("never silently ignores an invalid explicit value", () => {
    expect(() => parseWorkspaceExpectation({ flag: "acme" })).toThrowError(
      expect.objectContaining({ code: "INVALID_WORKSPACE_ID", category: "config" })
    );
    expect(() => parseWorkspaceExpectation({ flag: "" })).toThrowError(
      expect.objectContaining({ code: "INVALID_WORKSPACE_ID" })
    );
    expect(() =>
      parseWorkspaceExpectation({ env: { [WORKSPACE_ID_ENV]: "workspace_test" } })
    ).toThrowError(expect.objectContaining({ code: "INVALID_WORKSPACE_ID" }));
    try {
      parseWorkspaceExpectation({ flag: "not-a-uuid" });
      expect.unreachable("invalid flag must throw");
    } catch (error) {
      expect(exitCodeFor(error)).toBe(EXIT.CONFIG);
    }
  });

  it("matches the RFC 4122 billing UUID grammar", () => {
    expect(WORKSPACE_UUID_PATTERN.test(WORKSPACE_A)).toBe(true);
    expect(WORKSPACE_UUID_PATTERN.test("workspace_test")).toBe(false);
    expect(WORKSPACE_UUID_PATTERN.test("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("workspace mismatch preflight", () => {
  it("is a safe auth failure with expected and actual IDs", () => {
    const error = workspaceMismatchError({
      expectedWorkspaceId: WORKSPACE_A,
      actualWorkspaceId: WORKSPACE_B
    });
    expect(error.code).toBe("WORKSPACE_MISMATCH");
    expect(error.category).toBe("auth");
    expect(exitCodeFor(error)).toBe(EXIT.AUTH);
    expect(error.details).toEqual({
      expected_workspace_id: WORKSPACE_A,
      actual_workspace_id: WORKSPACE_B
    });
    expect(error.message).toContain(WORKSPACE_A);
    expect(error.message).toContain(WORKSPACE_B);
    expect(error.message).not.toContain("aw_api_");
  });

  it("accepts the no-expectation path including non-UUID workspace IDs", () => {
    expect(() => assertExpectedWorkspace(identity("workspace_test"), undefined)).not.toThrow();
  });

  it("compares expected and actual IDs case-insensitively", () => {
    expect(() =>
      assertExpectedWorkspace(identity(WORKSPACE_A.toUpperCase()), {
        workspaceId: WORKSPACE_A,
        source: "flag"
      })
    ).not.toThrow();
  });

  it("shows the workspace name and UUID together", () => {
    expect(
      formatWorkspaceLabel({
        workspaceId: WORKSPACE_A,
        workspaceName: "Acme Staging"
      })
    ).toBe(`Acme Staging (${WORKSPACE_A})`);
    expect(formatWorkspaceLabel({ workspaceId: WORKSPACE_A })).toBe(WORKSPACE_A);
  });
});

describe("authenticateHostedSession workspace guards", () => {
  it("fails WORKSPACE_CONFIG_CONFLICT before resolving a credential", async () => {
    const accessToken = vi.fn(async () => "token");
    const lookup = vi.fn();
    const cloud = vi.fn();
    await expect(
      authenticateHostedSession(
        {
          workspace: WORKSPACE_A,
          env: {
            AUGMENTWORKS_API_URL: API_ORIGIN.origin,
            AUGMENTWORKS_WORKSPACE_ID: WORKSPACE_B
          }
        },
        { accessToken, identity: lookup, cloud }
      )
    ).rejects.toMatchObject({ code: "WORKSPACE_CONFIG_CONFLICT", category: "config" });
    expect(accessToken).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(cloud).not.toHaveBeenCalled();
  });

  it("fails INVALID_WORKSPACE_ID before /auth/me", async () => {
    const accessToken = vi.fn(async () => "token");
    const lookup = vi.fn();
    await expect(
      authenticateHostedSession(
        {
          workspace: "acme-workspace",
          env: { AUGMENTWORKS_API_URL: API_ORIGIN.origin }
        },
        { accessToken, identity: lookup }
      )
    ).rejects.toMatchObject({ code: "INVALID_WORKSPACE_ID", category: "config" });
    expect(accessToken).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects an API key for workspace B when A is expected and does not construct a cloud client", async () => {
    const cloud = vi.fn();
    const lookup = vi.fn(async () => identity(WORKSPACE_B));
    await expect(
      authenticateHostedSession(
        {
          workspace: WORKSPACE_A,
          env: {
            AUGMENTWORKS_API_URL: API_ORIGIN.origin,
            AUGMENTWORKS_API_KEY: "aw_api_workspace_b_key_value"
          }
        },
        {
          accessToken: async () => "aw_api_workspace_b_key_value",
          identity: lookup,
          cloud
        }
      )
    ).rejects.toMatchObject({
      code: "WORKSPACE_MISMATCH",
      category: "auth",
      details: {
        expected_workspace_id: WORKSPACE_A,
        actual_workspace_id: WORKSPACE_B
      }
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(cloud).not.toHaveBeenCalled();
  });

  it("allows a matching machine key and records the expected workspace", async () => {
    const session = await authenticateHostedSession(
      {
        workspace: WORKSPACE_A.toUpperCase(),
        env: { AUGMENTWORKS_API_URL: API_ORIGIN.origin }
      },
      {
        apiOrigin: () => API_ORIGIN,
        accessToken: async () => "aw_api_workspace_a_key_value",
        identity: async () => identity(WORKSPACE_A),
        cloud: () => ({ tag: "cloud" }) as never
      }
    );
    expect(session.expectedWorkspaceId).toBe(WORKSPACE_A);
    expect(session.identity.workspaceId).toBe(WORKSPACE_A);
    expect(session.tenant.workspace_id).toBe(WORKSPACE_A);
  });

  it("preserves compatible single-workspace behavior when no expectation is configured", async () => {
    const session = await authenticateHostedSession(
      { env: { AUGMENTWORKS_API_URL: API_ORIGIN.origin } },
      {
        apiOrigin: () => API_ORIGIN,
        accessToken: async () => "token",
        identity: async () => identity("workspace_test"),
        cloud: () => ({ tag: "cloud" }) as never
      }
    );
    expect(session.expectedWorkspaceId).toBeUndefined();
    expect(session.identity.workspaceId).toBe("workspace_test");
  });

  it("re-checks the expected workspace after a refresh identity change", async () => {
    let token = "access-one";
    const lookup = vi.fn(async ({ accessToken }: { readonly accessToken: string }) =>
      identity(accessToken === "access-one" ? WORKSPACE_A : WORKSPACE_B)
    );
    const session = await authenticateHostedSession(
      {
        workspace: WORKSPACE_A,
        env: { AUGMENTWORKS_API_URL: API_ORIGIN.origin }
      },
      {
        apiOrigin: () => API_ORIGIN,
        accessToken: async () => token,
        identity: lookup,
        cloud: () => ({ tag: "cloud" }) as never
      }
    );
    token = "access-two";
    await expect(session.accessTokenProvider({ forceRefresh: true })).rejects.toMatchObject({
      code: "AUTH_TENANT_CHANGED"
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe("authorization endpoint workspace_mismatch mapping", () => {
  it("maps OAuth workspace_mismatch ahead of a generic 403", async () => {
    const { CloudAuthClient, remapAuthError } = await import("../../src/auth/client.js");
    const { AwError } = await import("../../src/errors.js");
    const client = new CloudAuthClient({
      apiOrigin: API_ORIGIN,
      fetch: (async () =>
        new Response(JSON.stringify({ error: "workspace_mismatch" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })) as typeof fetch
    });
    await expect(client.me("token")).rejects.toMatchObject({
      code: "WORKSPACE_MISMATCH",
      category: "auth"
    });
    const remapped = remapAuthError(
      new AwError({
        code: "WORKSPACE_MISMATCH",
        category: "auth",
        message: "mismatch"
      }),
      "api_key"
    );
    expect(remapped).toMatchObject({ code: "WORKSPACE_MISMATCH" });
    expect(AUTH_ENDPOINTS.me).toBe("/api/v1/cli/auth/me");
  });
});
