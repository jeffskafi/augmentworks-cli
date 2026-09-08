import { CloudAuthClient, remapAuthError } from "../auth/client.js";
import { getApiOrigin } from "../auth/api-origin.js";
import {
  createAccessTokenManager,
  inspectCredentialEnvironment,
  resolveAccessToken
} from "../auth/credential-store.js";
import {
  FEATURE_ACTIONS,
  MACHINE_HOSTED_EXECUTE_ACTIONS,
  MACHINE_SUITE_EXECUTE_ACTIONS,
  type AccessTokenProvider,
  type AuthIdentity,
  type CredentialSource
} from "../auth/types.js";
import { CloudClient } from "../cloud/client.js";
import { AwError, sanitizeTerminal } from "../errors.js";
import type { RunIntentTenantBinding } from "../relay/run-intent.js";

export interface HostedAuthOptions {
  readonly allowFileCredentials?: boolean;
  readonly headless?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface HostedAuthDependencies {
  readonly apiOrigin?: (env: NodeJS.ProcessEnv) => URL;
  readonly accessToken?: (options: Parameters<typeof resolveAccessToken>[0]) => Promise<string>;
  readonly identity?: (options: {
    readonly apiOrigin: URL;
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }) => Promise<AuthIdentity>;
  readonly cloud?: (options: {
    apiOrigin: URL;
    accessToken: string;
    accessTokenProvider: AccessTokenProvider;
  }) => CloudClient;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}

export interface HostedAuthSession {
  readonly apiOrigin: URL;
  readonly identity: AuthIdentity;
  readonly tenant: RunIntentTenantBinding;
  readonly cloud: CloudClient;
  readonly source: CredentialSource;
  readonly accessTokenProvider: AccessTokenProvider;
}

export async function authenticateHostedSession(
  options: HostedAuthOptions,
  dependencies: HostedAuthDependencies = {}
): Promise<HostedAuthSession> {
  const env = options.env ?? process.env;
  const inspected = inspectCredentialEnvironment(env);
  if (
    isHeadlessEnvironment(env, options) &&
    inspected.mode === "none" &&
    dependencies.accessToken === undefined
  ) {
    throw headlessAuthRequiredError();
  }
  const apiOrigin = (dependencies.apiOrigin ?? getApiOrigin)(env);
  const accessTokenOptions = {
    apiOrigin,
    env,
    ...(options.allowFileCredentials === undefined
      ? {}
      : { allowFileFallback: options.allowFileCredentials }),
    onWarning: (message: string) => writeLine(dependencies.stderr ?? process.stderr, message)
  };
  const manager =
    dependencies.accessToken === undefined
      ? await createAccessTokenManager(accessTokenOptions)
      : undefined;
  const source: CredentialSource =
    manager?.source ?? (inspected.mode === "api_key" ? "api_key" : "environment");
  const rawAccessTokenProvider: AccessTokenProvider =
    manager === undefined
      ? async (request = {}) =>
          await dependencies.accessToken!({
            ...accessTokenOptions,
            ...request
          })
      : manager.getAccessToken;
  const authClient = new CloudAuthClient({ apiOrigin });
  const lookupIdentity =
    dependencies.identity ??
    (async (identityOptions: { readonly accessToken: string; readonly signal?: AbortSignal }) =>
      await authClient.me(identityOptions.accessToken));
  let accessToken = await rawAccessTokenProvider();
  let identity: AuthIdentity;
  try {
    identity = await lookupIdentity({
      apiOrigin,
      accessToken,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  } catch (cause) {
    const remapped = remapAuthError(cause, source);
    const canRefresh =
      remapped instanceof AwError &&
      remapped.code === "TOKEN_REVOKED" &&
      source !== "api_key";
    if (!canRefresh) throw remapped;
    const replacement = await rawAccessTokenProvider({
      forceRefresh: true,
      rejectedAccessToken: accessToken,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (replacement === accessToken) throw remapped;
    accessToken = replacement;
    identity = await lookupIdentity({
      apiOrigin,
      accessToken,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }
  const tenant = tenantBinding(identity);
  let verifiedAccessToken = accessToken;
  const accessTokenProvider: AccessTokenProvider = async (request = {}) => {
    const current = await rawAccessTokenProvider(request);
    if (current === verifiedAccessToken) return current;
    const currentIdentity = await lookupIdentity({
      apiOrigin,
      accessToken: current,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });
    assertSameTenant(tenant, currentIdentity);
    verifiedAccessToken = current;
    return current;
  };
  const cloud =
    dependencies.cloud?.({ apiOrigin, accessToken, accessTokenProvider }) ??
    new CloudClient({ apiUrl: apiOrigin, accessToken, accessTokenProvider });
  return { apiOrigin, identity, tenant, cloud, source, accessTokenProvider };
}

export function tenantBinding(identity: AuthIdentity): RunIntentTenantBinding {
  return {
    workspace_id: identity.workspaceId,
    connector_id: identity.connectorId
  };
}

export function assertSameTenant(expected: RunIntentTenantBinding, identity: AuthIdentity): void {
  if (
    identity.workspaceId !== expected.workspace_id ||
    identity.connectorId !== expected.connector_id
  ) {
    throw new AwError({
      code: "AUTH_TENANT_CHANGED",
      category: "auth",
      message:
        "The authenticated AugmentWorks connector or workspace changed while the assessment was starting. No request was sent with the changed credential."
    });
  }
}

export function isHeadlessEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly headless?: boolean } = {}
): boolean {
  if (options.headless === true) return true;
  const explicit = env["AUGMENTWORKS_HEADLESS"];
  if (explicit === "1" || explicit === "true") return true;
  const ci = env["CI"];
  return ci === "1" || ci === "true";
}

export function headlessAuthRequiredError(): AwError {
  return new AwError({
    code: "AUTH_REQUIRED",
    category: "auth",
    message:
      "Headless hosted commands require AUGMENTWORKS_API_KEY (or a compatible AUGMENTWORKS_TOKEN). The CLI will not load a keychain, launch a browser, or invent a workspace credential. Issue a scoped machine key at [REDACTED]/portal/settings/api-keys."
  });
}

export function machineActionDeniedError(missing: readonly string[]): AwError {
  const listed = missing.map((action) => sanitizeTerminal(action)).join(", ");
  return new AwError({
    code: "MACHINE_ACTION_DENIED",
    category: "auth",
    message:
      missing.includes(FEATURE_ACTIONS.runExecute)
        ? `This machine credential cannot admit hosted work (missing ${listed}). Report-only keys may export a retained report but cannot quote, reserve, or start a run. Issue a CI key with run:execute (and suite:read for --suite). Machine keys cannot buy credits or administer the workspace.`
        : `This machine credential is missing required actions: ${listed}. No quote, reservation, or run was created.`
  });
}

export function assertMachineHostedAdmission(
  identity: AuthIdentity,
  options: { readonly suite?: boolean } = {}
): void {
  if (identity.principalKind !== "machine") return;
  const required = options.suite === true ? MACHINE_SUITE_EXECUTE_ACTIONS : MACHINE_HOSTED_EXECUTE_ACTIONS;
  const actions = identity.actions;
  if (actions === undefined) return;
  const granted = new Set(actions);
  const missing = required.filter((action) => !granted.has(action));
  if (missing.length > 0) throw machineActionDeniedError(missing);
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, value: string): void {
  stream.write(`${sanitizeTerminal(value)}\n`);
}
