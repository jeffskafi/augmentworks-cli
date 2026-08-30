export const CLI_OAUTH_CLIENT_ID = "augmentworks-cli";
export const DEFAULT_AUTH_SCOPES = ["connector:identity", "connector:run"] as const;

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

export type CredentialSource = "environment" | "native" | "file";

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
