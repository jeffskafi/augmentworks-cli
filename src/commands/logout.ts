import { Command } from "commander";

import { getApiOrigin } from "../auth/api-origin.js";
import { CloudAuthClient } from "../auth/client.js";
import {
  createCredentialStore,
  credentialFromEnvironment
} from "../auth/credential-store.js";
import type { CredentialStore, LogoutResult, StoredCredential } from "../auth/types.js";
import { AwError, sanitizeTerminal } from "../errors.js";

export interface LogoutOptions {
  readonly json?: boolean;
}

export interface LogoutDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: CloudAuthClient;
  readonly store?: CredentialStore;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
}

export async function runLogout(
  options: LogoutOptions = {},
  dependencies: LogoutDependencies = {}
): Promise<LogoutResult> {
  const env = dependencies.env ?? process.env;
  const apiOrigin = dependencies.client?.apiOrigin ?? getApiOrigin(env);
  const client = dependencies.client ?? new CloudAuthClient({ apiOrigin });
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const environmentCredential = credentialFromEnvironment(env);
  const warnings: string[] = [];
  let store = dependencies.store;
  if (store === undefined) {
    try {
      store = await createCredentialStore({
        apiOrigin,
        env,
        onWarning: (message) => warnings.push(message)
      });
    } catch (cause) {
      if (!(cause instanceof AwError) || cause.code !== "CREDENTIAL_STORE_UNAVAILABLE") throw cause;
    }
  }

  let storedCredential: StoredCredential | null = null;
  if (store !== undefined) storedCredential = await store.load();
  const credentials = uniqueCredentials(
    environmentCredential?.credential,
    storedCredential ?? undefined
  );
  let revoked = true;
  for (const credential of credentials) {
    try {
      await client.revoke(credential.accessToken);
    } catch {
      revoked = false;
      warnings.push("Could not confirm server-side revocation; local credentials were still removed.");
    }
  }

  let removed = false;
  if (store !== undefined) {
    await store.delete();
    removed = storedCredential !== null;
  }
  if (environmentCredential !== null) {
    warnings.push("AUGMENTWORKS_TOKEN is still set in this process; unset it in your shell or CI secret manager.");
  }

  const result: LogoutResult = {
    ...(environmentCredential === null
      ? store === undefined
        ? {}
        : { source: store.kind }
      : { source: "environment" }),
    revoked,
    removed,
    warnings
  };
  if (options.json === true) {
    stdout(JSON.stringify(result));
  } else {
    stderr(credentials.length === 0 ? "No stored AugmentWorks login was found." : "Logged out of AugmentWorks.");
    for (const warning of warnings) stderr(`Warning: ${sanitizeTerminal(warning)}`);
  }
  return result;
}

export function createLogoutCommand(dependencies: LogoutDependencies = {}): Command {
  return new Command("logout")
    .description("Revoke and remove the local AugmentWorks connector credential")
    .option("--json", "write logout status as JSON")
    .action(async (values: LogoutOptions) => {
      await runLogout(values, dependencies);
    });
}

function uniqueCredentials(
  first: StoredCredential | undefined,
  second: StoredCredential | undefined
): StoredCredential[] {
  if (first === undefined) return second === undefined ? [] : [second];
  if (second === undefined || first.accessToken === second.accessToken) return [first];
  return [first, second];
}
