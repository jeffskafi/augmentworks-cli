import { describe, expect, it, vi } from "vitest";

import { remapAuthError } from "../../src/auth/client.js";
import { FEATURE_ACTIONS } from "../../src/auth/types.js";
import { AwError, EXIT, exitCodeFor } from "../../src/errors.js";
import {
  assertMachineHostedAdmission,
  authenticateHostedSession,
  isHeadlessEnvironment,
  machineActionDeniedError
} from "../../src/commands/hosted-auth.js";
import { createTestCommand } from "../../src/commands/test.js";

function machineIdentity(actions: readonly string[]) {
  return {
    subject: "machine_ci",
    workspaceId: "workspace_test",
    workspaceName: "CI Workspace",
    connectorId: "connector_ci",
    scopes: ["connector:identity", "connector:run"],
    principalKind: "machine" as const,
    credentialId: "cred_ci",
    actions
  };
}

describe("headless hosted authentication", () => {
  it("treats CI, AUGMENTWORKS_HEADLESS, and --headless as headless", () => {
    expect(isHeadlessEnvironment({ CI: "true" })).toBe(true);
    expect(isHeadlessEnvironment({ CI: "1" })).toBe(true);
    expect(isHeadlessEnvironment({ AUGMENTWORKS_HEADLESS: "1" })).toBe(true);
    expect(isHeadlessEnvironment({}, { headless: true })).toBe(true);
    expect(isHeadlessEnvironment({})).toBe(false);
  });

  it("fails closed without an environment credential and does not resolve identity", async () => {
    const identity = vi.fn();
    await expect(
      authenticateHostedSession(
        {
          headless: true,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:43119" }
        },
        { identity }
      )
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      category: "auth"
    });
    expect(identity).not.toHaveBeenCalled();
  });

  it("fails closed in CI without a key even when an accessToken helper is not injected", async () => {
    const identity = vi.fn();
    await expect(
      authenticateHostedSession(
        {
          env: {
            CI: "true",
            AUGMENTWORKS_API_URL: "http://127.0.0.1:43119"
          }
        },
        { identity }
      )
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("AUGMENTWORKS_API_KEY")
    });
    expect(identity).not.toHaveBeenCalled();
  });
});

describe("machine hosted admission actions", () => {
  it("allows a CI key with run:execute and skips the check for interactive users", () => {
    expect(() =>
      assertMachineHostedAdmission(
        machineIdentity([
          FEATURE_ACTIONS.runExecute,
          FEATURE_ACTIONS.runRead,
          FEATURE_ACTIONS.evaluationRead,
          FEATURE_ACTIONS.billingRead
        ])
      )
    ).not.toThrow();
    expect(() =>
      assertMachineHostedAdmission({
        subject: "user_1",
        workspaceId: "workspace_test",
        connectorId: "connector_ci",
        scopes: ["connector:identity", "connector:run"]
      })
    ).not.toThrow();
  });

  it("blocks report-only machine keys before quote and requires suite:read for --suite", () => {
    expect(() =>
      assertMachineHostedAdmission(
        machineIdentity([
          FEATURE_ACTIONS.runRead,
          FEATURE_ACTIONS.evaluationRead,
          FEATURE_ACTIONS.criterionDetailRead
        ])
      )
    ).toThrowError(
      expect.objectContaining({
        code: "MACHINE_ACTION_DENIED",
        category: "auth"
      })
    );
    expect(() =>
      assertMachineHostedAdmission(machineIdentity([FEATURE_ACTIONS.runExecute]), { suite: true })
    ).toThrowError(expect.objectContaining({ code: "MACHINE_ACTION_DENIED" }));
    expect(() =>
      assertMachineHostedAdmission(
        machineIdentity([FEATURE_ACTIONS.runExecute, FEATURE_ACTIONS.suiteRead]),
        { suite: true }
      )
    ).not.toThrow();
    expect(exitCodeFor(machineActionDeniedError([FEATURE_ACTIONS.runExecute]))).toBe(EXIT.AUTH);
  });

  it("remaps API-key scope denials to an actionable machine-actions message", () => {
    const remapped = remapAuthError(
      new AwError({
        code: "SCOPE_DENIED",
        category: "auth",
        message: "The AugmentWorks credential does not have the required connector scope."
      }),
      "api_key"
    );
    expect(remapped).toMatchObject({
      code: "SCOPE_DENIED",
      category: "auth"
    });
    expect((remapped as AwError).message).toContain("run:execute");
    expect((remapped as AwError).message).toContain("cannot buy credits");
  });
});

describe("test --headless command boundary", () => {
  it("rejects --headless with --local before any network", async () => {
    const command = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();
    await expect(
      command.parseAsync(
        ["node", "augmentworks", "--local", "--packet", "support-refunds-starter@0.1.0", "--headless"],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "HEADLESS_LOCAL_UNSUPPORTED" });
  });
});
