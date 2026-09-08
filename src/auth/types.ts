export const CLI_OAUTH_CLIENT_ID = "augmentworks-cli";
export const DEFAULT_AUTH_SCOPES = ["connector:identity", "connector:run"] as const;

/** Fine-grained workspace actions from GET /api/v1/cli/auth/me (AW-QA-1 / AUG-19). */
export const FEATURE_ACTIONS = {
  suiteRead: "suite:read",
  runExecute: "run:execute",
  runCancel: "run:cancel",
  runRead: "run:read",
  evaluationRead: "evaluation:read",
  criterionDetailRead: "criterion_detail:read",
  billingRead: "billing:read",
  baselinePromote: "baseline:promote"
} as const;

export type FeatureAction = (typeof FEATURE_ACTIONS)[keyof typeof FEATURE_ACTIONS];

/**
 * Minimum actions for a hosted CI admit (quote + create). Transport scopes
 * `connector:identity` / `connector:run` are not sufficient on a machine principal.
 * Report-only keys omit `run:execute` and must not quote or start a run.
 */
export const MACHINE_HOSTED_EXECUTE_ACTIONS = [FEATURE_ACTIONS.runExecute] as const;

export const MACHINE_SUITE_EXECUTE_ACTIONS = [
  FEATURE_ACTIONS.runExecute,
  FEATURE_ACTIONS.suiteRead
] as const;

export const MACHINE_CI_RECOMMENDED_ACTIONS = [
  FEATURE_ACTIONS.suiteRead,
  FEATURE_ACTIONS.runExecute,
  FEATURE_ACTIONS.runCancel,
  FEATURE_ACTIONS.runRead,
  FEATURE_ACTIONS.evaluationRead,
  FEATURE_ACTIONS.criterionDetailRead,
  FEATURE_ACTIONS.billingRead
] as const;

export interface StoredCredential {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes?: readonly string[];
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly connectorId?: string;
  readonly connectorName?: string;
}

export type CredentialSource = "environment" | "api_key" | "native" | "file";
export type PrincipalKind = "user" | "machine";

export interface ResolvedCredential {
  readonly credential: StoredCredential;
  readonly source: CredentialSource;
}

export interface AccessTokenRequest {
  readonly forceRefresh?: boolean;
  readonly rejectedAccessToken?: string;
  readonly signal?: AbortSignal;
}

export type AccessTokenProvider = (request?: AccessTokenRequest) => Promise<string>;

export interface AccessTokenManager {
  readonly source: CredentialSource;
  readonly getAccessToken: AccessTokenProvider;
}

export interface CredentialStore {
  readonly kind: "native" | "file";
  readonly description: string;
  load(): Promise<StoredCredential | null>;
  save(credential: StoredCredential): Promise<void>;
  delete(): Promise<void>;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly workspace_id?: string;
  readonly workspace_name?: string;
  readonly connector_id?: string;
  readonly connector_name?: string;
}

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: URL;
  readonly verificationUriComplete?: URL;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

export interface AuthIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly connectorId: string;
  readonly connectorName?: string;
  readonly scopes: readonly string[];
  readonly principalKind?: PrincipalKind;
  readonly credentialId?: string;
  readonly actions?: readonly string[];
  readonly expiresAt?: string;
}

export interface LoginResult {
  readonly credential: StoredCredential;
  readonly identity: AuthIdentity;
  readonly source: CredentialSource;
}

export interface LogoutResult {
  readonly source?: CredentialSource;
  readonly revoked: boolean;
  readonly removed: boolean;
  readonly warnings: readonly string[];
}
