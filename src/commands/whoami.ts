import { Command } from "commander";

import { CloudAuthClient } from "../auth/client.js";
import { getApiOrigin } from "../auth/api-origin.js";
import type { CredentialRefreshLock } from "../auth/credential-store.js";
import type { AuthIdentity, CredentialSource, CredentialStore } from "../auth/types.js";
import {
  addWorkspaceOption,
  formatConnectorLabel,
  formatOverriddenApiOriginLine,
  formatWorkspaceLabel
} from "../auth/workspace-expectation.js";
import { sanitizeTerminal } from "../errors.js";
import { identityJson } from "./login.js";
import { authenticateHostedSession, type HostedAuthOptions } from "./hosted-auth.js";

export interface WhoamiOptions extends HostedAuthOptions {
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
  const env = options.env ?? dependencies.env ?? process.env;
  const apiOrigin = dependencies.client?.apiOrigin ?? getApiOrigin(env);
  const client = dependencies.client ?? new CloudAuthClient({ apiOrigin });
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const session = await authenticateHostedSession(
    {
      ...options,
      env
    },
    {
      authClient: client,
      ...(dependencies.store === undefined ? {} : { store: dependencies.store }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.refreshLock === undefined ? {} : { refreshLock: dependencies.refreshLock }),
      identity: async ({ accessToken }) => await client.me(accessToken),
      stderr: {
        write: (value) => {
          const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
          stderr(text.endsWith("\n") ? text.slice(0, -1) : text);
          return true;
        }
      }
    }
  );

  const result = { identity: session.identity, source: session.source };
  if (options.json === true) {
    const originLine = formatOverriddenApiOriginLine(session.apiOrigin, env);
    stdout(
      JSON.stringify({
        source: result.source,
        identity: identityJson(session.identity),
        ...(originLine === undefined ? {} : { api_origin: session.apiOrigin.origin })
      })
    );
  } else {
    stdout(formatWhoami(session.identity, session.apiOrigin, env));
  }
  return result;
}

function formatWhoami(identity: AuthIdentity, apiOrigin: URL, env: NodeJS.ProcessEnv): string {
  const connector = formatConnectorLabel(identity);
  const workspace = formatWorkspaceLabel(identity);
  const kind = identity.principalKind === "machine" ? "machine credential" : "connector";
  const credential =
    identity.credentialId === undefined ? "" : ` ${sanitizeTerminal(identity.credentialId)}`;
  const expiry =
    identity.expiresAt === undefined ? "" : ` (expires ${sanitizeTerminal(identity.expiresAt)})`;
  const origin = formatOverriddenApiOriginLine(apiOrigin, env);
  const originSuffix = origin === undefined ? "" : ` — ${origin}`;
  return `${sanitizeTerminal(kind)}${credential} — ${connector} — ${workspace}${expiry}${originSuffix}`;
}

export function createWhoamiCommand(dependencies: WhoamiDependencies = {}): Command {
  return addWorkspaceOption(
    new Command("whoami")
      .description("Show the authenticated AugmentWorks workspace and credential metadata")
      .option("--json", "write the authenticated identity as JSON")
  ).action(async (values: WhoamiOptions) => {
    await runWhoami(values, dependencies);
  });
}
