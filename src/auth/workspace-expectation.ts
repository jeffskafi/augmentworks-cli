import type { Command } from "commander";

import { DEFAULT_API_ORIGIN } from "./api-origin.js";
import type { AuthIdentity } from "./types.js";
import { AwError, sanitizeTerminal } from "../errors.js";

/** RFC 4122 UUID (versions 1–8, RFC 4122 variant). Same grammar as billing workspace IDs. */
export const WORKSPACE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const WORKSPACE_ID_ENV = "AUGMENTWORKS_WORKSPACE_ID";
export const EXPECTED_WORKSPACE_QUERY = "expected_workspace_id";

export const WORKSPACE_OPTION_FLAGS = "--workspace <uuid>";
export const WORKSPACE_OPTION_HELP =
  "expected workspace UUID; fail before any tenant request if credentials resolve elsewhere (AUGMENTWORKS_WORKSPACE_ID)";

export type WorkspaceExpectationSource = "flag" | "env";

export interface WorkspaceExpectation {
  readonly workspaceId: string;
  readonly source: WorkspaceExpectationSource;
}

export function addWorkspaceOption<T extends Command>(command: T): T {
  command.option(WORKSPACE_OPTION_FLAGS, WORKSPACE_OPTION_HELP);
  return command;
}

export function parseWorkspaceExpectation(input: {
  readonly flag?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): WorkspaceExpectation | undefined {
  const env = input.env ?? process.env;
  const flagRaw = input.flag;
  const envRaw = env[WORKSPACE_ID_ENV];
  const flagPresent = flagRaw !== undefined;
  const parsedFlag = flagPresent ? parseExplicitWorkspaceId(flagRaw, "flag") : undefined;
  const envPresent = envRaw !== undefined && envRaw.trim() !== "";
  const parsedEnv = envPresent ? parseExplicitWorkspaceId(envRaw, "env") : undefined;

  if (parsedFlag !== undefined && parsedEnv !== undefined && parsedFlag !== parsedEnv) {
    throw workspaceConfigConflictError(parsedFlag, parsedEnv);
  }
  if (parsedFlag !== undefined) return { workspaceId: parsedFlag, source: "flag" };
  if (parsedEnv !== undefined) return { workspaceId: parsedEnv, source: "env" };
  return undefined;
}

export function parseExplicitWorkspaceId(
  raw: string,
  source: WorkspaceExpectationSource
): string {
  const trimmed = raw.trim();
  if (trimmed === "" || !WORKSPACE_UUID_PATTERN.test(trimmed)) {
    throw invalidWorkspaceIdError(source);
  }
  return trimmed.toLowerCase();
}

export function assertExpectedWorkspace(
  identity: Pick<AuthIdentity, "workspaceId">,
  expected: WorkspaceExpectation | string | undefined
): void {
  if (expected === undefined) return;
  const expectedId = typeof expected === "string" ? expected.toLowerCase() : expected.workspaceId;
  const actualId = identity.workspaceId.trim().toLowerCase();
  if (actualId === expectedId) return;
  throw workspaceMismatchError({
    expectedWorkspaceId: expectedId,
    actualWorkspaceId: identity.workspaceId
  });
}

export function workspaceMismatchError(details: {
  readonly expectedWorkspaceId: string;
  readonly actualWorkspaceId: string;
  readonly compatibility?: boolean;
}): AwError {
  const expected = sanitizeTerminal(details.expectedWorkspaceId);
  const actual = sanitizeTerminal(details.actualWorkspaceId);
  const compatibility =
    details.compatibility === true
      ? " The previous stored credential was not replaced. If this server ignores expected_workspace_id, update AugmentWorks before treating a selected login as success."
      : "";
  return new AwError({
    code: "WORKSPACE_MISMATCH",
    category: "auth",
    message: `The authenticated workspace ${actual} does not match the expected workspace ${expected}. No quote, upload, or tenant request was sent.${compatibility}`,
    details: {
      expected_workspace_id: expected,
      actual_workspace_id: actual
    }
  });
}

export function workspaceOauthMismatchError(expectedWorkspaceId?: string): AwError {
  return new AwError({
    code: "WORKSPACE_MISMATCH",
    category: "auth",
    message:
      "Authorization did not grant the expected workspace. No credential was stored. The previous stored credential was not replaced.",
    ...(expectedWorkspaceId === undefined
      ? {}
      : { details: { expected_workspace_id: sanitizeTerminal(expectedWorkspaceId) } })
  });
}

export function workspaceConfigConflictError(flagId: string, envId: string): AwError {
  return new AwError({
    code: "WORKSPACE_CONFIG_CONFLICT",
    category: "config",
    message:
      "--workspace and AUGMENTWORKS_WORKSPACE_ID disagree. No network request was made. Supply one value or make them identical.",
    details: {
      flag_workspace_id: sanitizeTerminal(flagId),
      env_workspace_id: sanitizeTerminal(envId)
    }
  });
}

export function invalidWorkspaceIdError(source: WorkspaceExpectationSource): AwError {
  const where = source === "flag" ? "--workspace" : WORKSPACE_ID_ENV;
  return new AwError({
    code: "INVALID_WORKSPACE_ID",
    category: "config",
    message: `${where} must be a UUID. The value was not ignored.`
  });
}

export function localWorkspaceFlagUnsupportedError(): AwError {
  return new AwError({
    code: "LOCAL_WORKSPACE_UNSUPPORTED",
    category: "config",
    message:
      "--workspace applies only to hosted AugmentWorks authentication. Local commands do not contact AugmentWorks and cannot select a cloud workspace. AUGMENTWORKS_WORKSPACE_ID is ignored in local mode."
  });
}

export function formatWorkspaceLabel(identity: Pick<AuthIdentity, "workspaceId" | "workspaceName">): string {
  const id = sanitizeTerminal(identity.workspaceId);
  const name = identity.workspaceName === undefined ? undefined : sanitizeTerminal(identity.workspaceName);
  if (name === undefined || name === "" || name === id) return id;
  return `${name} (${id})`;
}

export function formatConnectorLabel(identity: Pick<AuthIdentity, "connectorId" | "connectorName">): string {
  const id = sanitizeTerminal(identity.connectorId);
  const name = identity.connectorName === undefined ? undefined : sanitizeTerminal(identity.connectorName);
  if (name === undefined || name === "" || name === id) return id;
  return name;
}

export function overriddenApiOrigin(apiOrigin: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const configured = env["AUGMENTWORKS_API_URL"]?.trim();
  if (configured === undefined || configured === "") return undefined;
  if (apiOrigin.origin === DEFAULT_API_ORIGIN) return undefined;
  return apiOrigin;
}

export function formatOverriddenApiOriginLine(apiOrigin: URL, env?: NodeJS.ProcessEnv): string | undefined {
  const overridden = overriddenApiOrigin(apiOrigin, env);
  if (overridden === undefined) return undefined;
  return `API origin: ${sanitizeTerminal(overridden.origin)}`;
}
