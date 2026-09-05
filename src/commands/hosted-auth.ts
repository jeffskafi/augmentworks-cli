import { CloudAuthClient } from "../auth/client.js";
import { getApiOrigin } from "../auth/api-origin.js";
import { createAccessTokenManager, resolveAccessToken } from "../auth/credential-store.js";
import type { AccessTokenProvider, AuthIdentity } from "../auth/types.js";
import { CloudClient } from "../cloud/client.js";
import { AwError, sanitizeTerminal } from "../errors.js";
import type { RunIntentTenantBinding } from "../relay/run-intent.js";

export interface HostedAuthOptions {
  readonly allowFileCredentials?: boolean;
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
}

export async function authenticateHostedSession(
  options: HostedAuthOptions,
  dependencies: HostedAuthDependencies = {}
): Promise<HostedAuthSession> {
  const env = options.env ?? process.env;
  const apiOrigin = (dependencies.apiOrigin ?? getApiOrigin)(env);
  const accessTokenOptions = {
    apiOrigin,
    env,
    ...(options.allowFileCredentials === undefined
      ? {}
      : { allowFileFallback: options.allowFileCredentials }),
    onWarning: (message: string) => writeLine(dependencies.stderr ?? process.stderr, message)
  };
  const rawAccessTokenProvider: AccessTokenProvider =
    dependencies.accessToken === undefined
      ? (await createAccessTokenManager(accessTokenOptions)).getAccessToken
      : async (request = {}) =>
          await dependencies.accessToken!({
            ...accessTokenOptions,
            ...request
          });
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
    if (!(cause instanceof AwError) || cause.code !== "TOKEN_REVOKED") throw cause;
    const replacement = await rawAccessTokenProvider({
      forceRefresh: true,
      rejectedAccessToken: accessToken,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (replacement === accessToken) throw cause;
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
  return { apiOrigin, identity, tenant, cloud };
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

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, value: string): void {
  stream.write(`${sanitizeTerminal(value)}\n`);
}
