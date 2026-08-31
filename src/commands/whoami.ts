import { Command } from "commander";

import { getApiOrigin } from "../auth/api-origin.js";
import { CloudAuthClient } from "../auth/client.js";
import {
  createAccessTokenManager,
  type CredentialRefreshLock
} from "../auth/credential-store.js";
import type { AuthIdentity, CredentialSource, CredentialStore } from "../auth/types.js";
import { AwError, sanitizeTerminal } from "../errors.js";
import { identityJson } from "./login.js";

export interface WhoamiOptions {
  readonly json?: boolean;
}

export interface WhoamiDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: CloudAuthClient;
  readonly store?: CredentialStore;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
  readonly now?: () => number;
  readonly refreshLock?: CredentialRefreshLock;
}

export interface WhoamiResult {
  readonly identity: AuthIdentity;
  readonly source: CredentialSource;
}

export async function runWhoami(
  options: WhoamiOptions = {},
  dependencies: WhoamiDependencies = {}
): Promise<WhoamiResult> {
  const env = dependencies.env ?? process.env;
  const apiOrigin = dependencies.client?.apiOrigin ?? getApiOrigin(env);
  const client = dependencies.client ?? new CloudAuthClient({ apiOrigin });
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const manager = await createAccessTokenManager({
    apiOrigin,
    env,
    client,
    ...(dependencies.store === undefined ? {} : { store: dependencies.store }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.refreshLock === undefined
      ? {}
      : { refreshLock: dependencies.refreshLock }),
    onWarning: (message) => stderr(sanitizeTerminal(message))
  });
  let accessToken = await manager.getAccessToken();

  let identity: AuthIdentity;
  try {
    identity = await client.me(accessToken);
  } catch (cause) {
    if (
      cause instanceof AwError &&
      cause.code === "TOKEN_REVOKED" &&
      manager.source !== "environment"
    ) {
      const replacement = await manager.getAccessToken({
        forceRefresh: true,
        rejectedAccessToken: accessToken
      });
      if (replacement === accessToken) throw cause;
      accessToken = replacement;
      identity = await client.me(accessToken);
    } else {
      throw cause;
    }
  }

  const result = { identity, source: manager.source };
  if (options.json === true) {
    stdout(JSON.stringify({ source: result.source, identity: identityJson(identity) }));
  } else {
    const connector = identity.connectorName ?? identity.connectorId;
    const workspace = identity.workspaceName ?? identity.workspaceId;
    stdout(`${sanitizeTerminal(connector)} — ${sanitizeTerminal(workspace)}`);
  }
  return result;
}

export function createWhoamiCommand(dependencies: WhoamiDependencies = {}): Command {
  return new Command("whoami")
    .description("Show the authenticated AugmentWorks connector")
    .option("--json", "write the authenticated identity as JSON")
    .action(async (values: WhoamiOptions) => {
      await runWhoami(values, dependencies);
    });
}
