import { Command } from "commander";

import { getApiOrigin } from "../auth/api-origin.js";
import { CloudAuthClient } from "../auth/client.js";
import {
  createCredentialStore,
  credentialFromEnvironment,
  getCredential
} from "../auth/credential-store.js";
import type {
  AuthIdentity,
  CredentialSource,
  CredentialStore,
  StoredCredential
} from "../auth/types.js";
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
  const environmentCredential = credentialFromEnvironment(env);
  const store =
    environmentCredential === null
      ? dependencies.store ??
        (await createCredentialStore({
          apiOrigin,
          env,
          onWarning: (message) => stderr(sanitizeTerminal(message))
        }))
      : dependencies.store;

  const resolved =
    environmentCredential ??
    (await getCredential({
      apiOrigin,
      env,
      ...(store === undefined ? {} : { store })
    }));
  let credential = resolved.credential;
  let refreshed = false;
  if (
    resolved.source !== "environment" &&
    credential.refreshToken !== undefined &&
    expiresSoon(credential, dependencies.now ?? Date.now)
  ) {
    credential = await refreshAndPersist(client, credential, store!);
    refreshed = true;
  }

  let identity: AuthIdentity;
  try {
    identity = await client.me(credential.accessToken);
  } catch (cause) {
    if (
      !refreshed &&
      cause instanceof AwError &&
      cause.code === "TOKEN_REVOKED" &&
      credential.refreshToken !== undefined &&
      resolved.source !== "environment"
    ) {
      credential = await refreshAndPersist(client, credential, store!);
      identity = await client.me(credential.accessToken);
    } else {
      throw cause;
    }
  }

  const result = { identity, source: resolved.source };
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

function expiresSoon(credential: StoredCredential, now: () => number): boolean {
  if (credential.expiresAt === undefined) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new AwError({
      code: "CREDENTIAL_STORE",
      category: "auth",
      message: "The stored AugmentWorks credential has an invalid expiry."
    });
  }
  return expiresAt <= now() + 60_000;
}

async function refreshAndPersist(
  client: CloudAuthClient,
  credential: StoredCredential,
  store: CredentialStore
): Promise<StoredCredential> {
  const refreshToken = credential.refreshToken;
  if (refreshToken === undefined) return credential;
  const refreshed = await client.refresh(refreshToken);
  const merged: StoredCredential = {
    ...credential,
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? refreshToken
  };
  await store.save(merged);
  return merged;
}
