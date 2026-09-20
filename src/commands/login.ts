import { Command } from "commander";

import { CloudAuthClient, remapAuthError } from "../auth/client.js";
import { getApiOrigin } from "../auth/api-origin.js";
import {
  createCredentialStore,
  credentialFromEnvironment,
  type CredentialStoreOptions
} from "../auth/credential-store.js";
import { loginWithLoopback } from "../auth/loopback.js";
import {
  DEFAULT_AUTH_SCOPES,
  type AuthIdentity,
  type CredentialStore,
  type LoginResult,
  type StoredCredential
} from "../auth/types.js";
import {
  addWorkspaceOption,
  assertExpectedWorkspace,
  formatConnectorLabel,
  formatOverriddenApiOriginLine,
  formatWorkspaceLabel,
  parseWorkspaceExpectation,
  workspaceMismatchError,
  type WorkspaceExpectation
} from "../auth/workspace-expectation.js";
import { AwError, sanitizeTerminal } from "../errors.js";
import { LOGIN_NEXT_STEPS } from "../release.js";
import { openBrowserUrl, type BrowserOpener } from "../system/browser.js";

export interface LoginOptions {
  readonly device?: boolean;
  readonly open?: boolean;
  readonly allowFileCredentials?: boolean;
  readonly json?: boolean;
  readonly signal?: AbortSignal;
  readonly workspace?: string;
}

export interface LoginDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: CloudAuthClient;
  readonly store?: CredentialStore;
  readonly openBrowser?: BrowserOpener;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
}

export async function runLogin(
  options: LoginOptions = {},
  dependencies: LoginDependencies = {}
): Promise<LoginResult> {
  const env = dependencies.env ?? process.env;
  const expected = parseWorkspaceExpectation({
    ...(options.workspace === undefined ? {} : { flag: options.workspace }),
    env
  });
  const apiOrigin = dependencies.client?.apiOrigin ?? getApiOrigin(env);
  const client = dependencies.client ?? new CloudAuthClient({ apiOrigin });
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const environmentCredential = credentialFromEnvironment(env);

  if (environmentCredential !== null) {
    let identity: AuthIdentity;
    try {
      identity = await client.me(environmentCredential.credential.accessToken);
    } catch (cause) {
      throw remapAuthError(cause, environmentCredential.source);
    }
    assertExpectedWorkspace(identity, expected);
    const result = {
      credential: environmentCredential.credential,
      identity,
      source: environmentCredential.source
    };
    writeLoginResult(result, options.json === true, stdout, stderr, apiOrigin, env);
    return result;
  }

  const store =
    dependencies.store ??
    (await createCredentialStore(
      credentialStoreOptions(apiOrigin, env, options.allowFileCredentials, stderr)
    ));

  let credential: StoredCredential;
  if (options.device === true) {
    const authorization = await client.startDeviceAuthorization(DEFAULT_AUTH_SCOPES, {
      ...(expected === undefined ? {} : { expectedWorkspaceId: expected.workspaceId })
    });
    const url = authorization.verificationUriComplete ?? authorization.verificationUri;
    stderr(`Open ${sanitizeTerminal(url.toString())}`);
    stderr(`Enter code: ${sanitizeTerminal(authorization.userCode)}`);
    if (options.open !== false) {
      await openWithManualFallback(
        url,
        dependencies.openBrowser ?? ((value) => openBrowserUrl(value, [apiOrigin.origin])),
        stderr
      );
    }
    credential = await client.pollDeviceToken(authorization, {
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  } else {
    const opener = dependencies.openBrowser ?? ((value) => openBrowserUrl(value, [apiOrigin.origin]));
    credential = await loginWithLoopback(client, {
      scopes: DEFAULT_AUTH_SCOPES,
      openBrowser:
        options.open === false
          ? async () => undefined
          : async (url) => await openWithManualFallback(url, opener, stderr),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onAuthorizationUrl: (url) => stderr(`Open ${sanitizeTerminal(url.toString())}`),
      ...(expected === undefined ? {} : { expectedWorkspaceId: expected.workspaceId })
    });
  }

  const identity = await verifyLoginIdentity(client, credential, expected);
  await store.save(credential);
  const result = { credential, identity, source: store.kind };
  writeLoginResult(result, options.json === true, stdout, stderr, apiOrigin, env);
  return result;
}

async function verifyLoginIdentity(
  client: CloudAuthClient,
  credential: StoredCredential,
  expected: WorkspaceExpectation | undefined
): Promise<AuthIdentity> {
  const identity = await client.me(credential.accessToken);
  if (expected === undefined) return identity;
  if (identity.workspaceId.trim().toLowerCase() === expected.workspaceId) return identity;
  try {
    await client.revoke(credential.accessToken);
  } catch {
    // The unused grant is best-effort; never overwrite the previous stored credential.
  }
  throw workspaceMismatchError({
    expectedWorkspaceId: expected.workspaceId,
    actualWorkspaceId: identity.workspaceId,
    compatibility: true
  });
}

export function createLoginCommand(dependencies: LoginDependencies = {}): Command {
  return addWorkspaceOption(
    new Command("login")
      .description("Authenticate this connector with AugmentWorks")
      .option("--device", "use device authorization for SSH or headless environments")
      .option("--no-open", "print the authorization URL without opening a browser")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
      .option("--json", "write the authenticated identity as JSON")
  ).action(async (values: LoginOptions) => {
    await runLogin(values, dependencies);
  });
}

async function openWithManualFallback(
  url: URL,
  opener: BrowserOpener,
  stderr: (message: string) => void
): Promise<void> {
  try {
    await opener(url);
  } catch (cause) {
    if (!(cause instanceof AwError) || cause.code !== "BROWSER_OPEN_FAILED") throw cause;
    stderr("The browser could not be opened; use the URL above to continue.");
  }
}

function credentialStoreOptions(
  apiOrigin: URL,
  env: NodeJS.ProcessEnv,
  allowFileFallback: boolean | undefined,
  stderr: (message: string) => void
): CredentialStoreOptions {
  return {
    apiOrigin,
    env,
    ...(allowFileFallback === undefined ? {} : { allowFileFallback }),
    onWarning: (message) => stderr(sanitizeTerminal(message))
  };
}

function writeLoginResult(
  result: { readonly identity: AuthIdentity; readonly source: "environment" | "api_key" | "native" | "file" },
  json: boolean,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
  apiOrigin: URL,
  env: NodeJS.ProcessEnv
): void {
  if (json) {
    stdout(
      JSON.stringify({
        authenticated: true,
        source: result.source,
        identity: identityJson(result.identity),
        ...overriddenOriginJson(apiOrigin, env)
      })
    );
    return;
  }
  const connector = formatConnectorLabel(result.identity);
  const workspace = formatWorkspaceLabel(result.identity);
  stderr(`Connected ${connector} to ${workspace}.`);
  const originLine = formatOverriddenApiOriginLine(apiOrigin, env);
  if (originLine !== undefined) stderr(originLine);
  stderr(LOGIN_NEXT_STEPS);
}

function overriddenOriginJson(apiOrigin: URL, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const origin = formatOverriddenApiOriginLine(apiOrigin, env);
  if (origin === undefined) return {};
  return { api_origin: apiOrigin.origin };
}

export function identityJson(identity: AuthIdentity): Record<string, unknown> {
  return {
    subject: identity.subject,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    workspace_id: identity.workspaceId,
    ...(identity.workspaceName === undefined ? {} : { workspace_name: identity.workspaceName }),
    connector_id: identity.connectorId,
    ...(identity.connectorName === undefined ? {} : { connector_name: identity.connectorName }),
    scopes: identity.scopes,
    ...(identity.principalKind === undefined ? {} : { principal_kind: identity.principalKind }),
    ...(identity.credentialId === undefined ? {} : { credential_id: identity.credentialId }),
    ...(identity.actions === undefined ? {} : { actions: identity.actions }),
    ...(identity.expiresAt === undefined ? {} : { expires_at: identity.expiresAt })
  };
}
