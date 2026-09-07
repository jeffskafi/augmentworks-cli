import { Command } from "commander";

import { CloudAuthClient, remapAuthError } from "../auth/client.js";
import { getApiOrigin } from "../auth/api-origin.js";
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
    const remapped = remapAuthError(cause, manager.source);
    if (
      remapped instanceof AwError &&
      remapped.code === "TOKEN_REVOKED" &&
      (manager.source === "native" || manager.source === "file")
    ) {
      const replacement = await manager.getAccessToken({
        forceRefresh: true,
        rejectedAccessToken: accessToken
      });
      if (replacement === accessToken) throw remapped;
      accessToken = replacement;
      identity = await client.me(accessToken);
    } else {
      throw remapped;
    }
  }

  const result = { identity, source: manager.source };
  if (options.json === true) {
    stdout(JSON.stringify({ source: result.source, identity: identityJson(identity) }));
  } else {
    stdout(formatWhoami(identity));
  }
  return result;
}

function formatWhoami(identity: AuthIdentity): string {
  const connector = identity.connectorName ?? identity.connectorId;
  const workspace = identity.workspaceName ?? identity.workspaceId;
  const kind = identity.principalKind === "machine" ? "machine credential" : "connector";
  const credential =
    identity.credentialId === undefined ? "" : ` ${sanitizeTerminal(identity.credentialId)}`;
  const expiry =
    identity.expiresAt === undefined ? "" : ` (expires ${sanitizeTerminal(identity.expiresAt)})`;
  return `${sanitizeTerminal(kind)}${credential} — ${sanitizeTerminal(connector)} — ${sanitizeTerminal(workspace)}${expiry}`;
}

export function createWhoamiCommand(dependencies: WhoamiDependencies = {}): Command {
  return new Command("whoami")
    .description("Show the authenticated AugmentWorks workspace and credential metadata")
    .option("--json", "write the authenticated identity as JSON")
    .action(async (values: WhoamiOptions) => {
      await runWhoami(values, dependencies);
    });
}
