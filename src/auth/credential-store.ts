import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { AwError } from "../errors.js";
import { credentialFilePath, originScopedCredentialFilePath } from "../system/paths.js";
import { findExecutable, runProcess } from "../system/process.js";
import { CloudAuthClient } from "./client.js";
import type { CredentialStore, ResolvedCredential, StoredCredential } from "./types.js";

export const TOKEN_ENV = "AUGMENTWORKS_TOKEN";
const ACCOUNT_PREFIX = "augmentworks-cli";
const MAX_CREDENTIAL_BYTES = 128 * 1024;

function validateToken(token: unknown, field = "access token"): string {
  if (
    typeof token !== "string" ||
    token.length < 8 ||
    token.length > 32 * 1024 ||
    /[\r\n\0]/.test(token)
  ) {
    throw new AwError({
      code: "CREDENTIAL_STORE",
      category: "auth",
      message: `The stored ${field} is invalid.`
    });
  }
  return token;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseStoredCredential(serialized: string): StoredCredential {
  if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw new AwError({
      code: "CREDENTIAL_STORE",
      category: "auth",
      message: "The stored AugmentWorks credential is too large."
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (cause) {
    throw new AwError({
      code: "CREDENTIAL_STORE",
      category: "auth",
      message: "The stored AugmentWorks credential is not valid JSON.",
      cause
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AwError({
      code: "CREDENTIAL_STORE",
      category: "auth",
      message: "The stored AugmentWorks credential is invalid."
    });
  }
  const record = value as Record<string, unknown>;
  if (record["tokenType"] !== "Bearer") {
    throw new AwError({
      code: "CREDENTIAL_STORE",
      category: "auth",
      message: "The stored AugmentWorks token type is invalid."
    });
  }
  const refreshToken = asOptionalString(record["refreshToken"]);
  if (refreshToken !== undefined) validateToken(refreshToken, "refresh token");
  const scopes = record["scopes"];
  if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string"))) {
    throw new AwError({
      code: "CREDENTIAL_STORE",
      category: "auth",
      message: "The stored AugmentWorks scopes are invalid."
    });
  }

  return {
    accessToken: validateToken(record["accessToken"]),
    tokenType: "Bearer",
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(asOptionalString(record["expiresAt"]) === undefined ? {} : { expiresAt: asOptionalString(record["expiresAt"])! }),
    ...(scopes === undefined ? {} : { scopes: scopes as string[] }),
    ...(asOptionalString(record["workspaceId"]) === undefined ? {} : { workspaceId: asOptionalString(record["workspaceId"])! }),
    ...(asOptionalString(record["workspaceName"]) === undefined ? {} : { workspaceName: asOptionalString(record["workspaceName"])! }),
    ...(asOptionalString(record["connectorId"]) === undefined ? {} : { connectorId: asOptionalString(record["connectorId"])! }),
    ...(asOptionalString(record["connectorName"]) === undefined ? {} : { connectorName: asOptionalString(record["connectorName"])! })
  };
}

export function serializeCredential(credential: StoredCredential): string {
  validateToken(credential.accessToken);
  if (credential.refreshToken !== undefined) validateToken(credential.refreshToken, "refresh token");
  return `${JSON.stringify(credential)}\n`;
}

export class FileCredentialStore implements CredentialStore {
  readonly kind = "file" as const;
  readonly description: string;
  readonly #filePath: string;

  constructor(filePath = credentialFilePath()) {
    this.#filePath = filePath;
    this.description = filePath;
  }

  async load(): Promise<StoredCredential | null> {
    let handle;
    try {
      const noFollowFlag =
        process.platform === "win32" || typeof fsConstants.O_NOFOLLOW !== "number"
          ? 0
          : fsConstants.O_NOFOLLOW;
      handle = await open(this.#filePath, fsConstants.O_RDONLY | noFollowFlag);
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return null;
      throw credentialIoError("Could not safely open the credential file.", cause);
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw credentialIoError("Refusing to read a non-regular credential file.");
      }
      if (metadata.size > MAX_CREDENTIAL_BYTES) {
        throw credentialIoError("The stored AugmentWorks credential is too large.");
      }
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw credentialIoError("Credential file permissions are too broad; expected mode 0600.");
      }
      return parseStoredCredential(await handle.readFile("utf8"));
    } catch (cause) {
      if (cause instanceof AwError) throw cause;
      throw credentialIoError("Could not read the credential file.", cause);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async save(credential: StoredCredential): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await ensurePrivateDirectory(directory);
    await rejectSymlinkIfPresent(this.#filePath);
    const temporaryPath = path.join(
      directory,
      `.credentials.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    );
    let handle;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600
      );
      await handle.writeFile(serializeCredential(credential), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.#filePath);
      await chmod(this.#filePath, 0o600);
    } catch (cause) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw credentialIoError("Could not save the credential file.", cause);
    }
  }

  async delete(): Promise<void> {
    await rejectSymlinkIfPresent(this.#filePath);
    try {
      await unlink(this.#filePath);
    } catch (cause) {
      if (!isNodeError(cause, "ENOENT")) {
        throw credentialIoError("Could not delete the credential file.", cause);
      }
    }
  }
}

class SecretToolCredentialStore implements CredentialStore {
  readonly kind = "native" as const;
  readonly description = "Secret Service keyring (secret-tool)";

  constructor(
    private readonly executable: string,
    private readonly apiOrigin: URL
  ) {}

  async load(): Promise<StoredCredential | null> {
    const result = await runProcess(
      this.executable,
      ["lookup", "application", ACCOUNT_PREFIX, "api-origin", this.apiOrigin.origin],
      { allowFailure: true }
    );
    if (result.code !== 0 || result.stdout.trim() === "") return null;
    return parseStoredCredential(result.stdout.trim());
  }

  async save(credential: StoredCredential): Promise<void> {
    await runProcess(
      this.executable,
      [
        "store",
        "--label=AugmentWorks CLI",
        "application",
        ACCOUNT_PREFIX,
        "api-origin",
        this.apiOrigin.origin
      ],
      { input: serializeCredential(credential) }
    );
  }

  async delete(): Promise<void> {
    await runProcess(
      this.executable,
      ["clear", "application", ACCOUNT_PREFIX, "api-origin", this.apiOrigin.origin],
      { allowFailure: true }
    );
  }
}

export interface CredentialStoreOptions {
  readonly apiOrigin: URL;
  readonly allowFileFallback?: boolean;
  readonly filePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly onWarning?: (message: string) => void;
}

export async function createCredentialStore(options: CredentialStoreOptions): Promise<CredentialStore> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "linux" && env["DBUS_SESSION_BUS_ADDRESS"] !== undefined) {
    const secretTool = await findExecutable("secret-tool", { env, platform });
    if (secretTool !== null) return new SecretToolCredentialStore(secretTool, options.apiOrigin);
  }

  const fileStore = new FileCredentialStore(
    options.filePath ?? originScopedCredentialFilePath(options.apiOrigin, env, platform)
  );
  const alreadyExists = await fileExists(fileStore.description);
  if (alreadyExists || options.allowFileFallback === true) {
    options.onWarning?.(
      `OS credential storage is unavailable; using a mode-0600 credential file at ${fileStore.description}.`
    );
    return fileStore;
  }

  throw new AwError({
    code: "CREDENTIAL_STORE_UNAVAILABLE",
    category: "auth",
    message:
      "No supported OS credential store is available. Re-run login with --allow-file-credentials to use a warned mode-0600 fallback, or set AUGMENTWORKS_TOKEN for CI."
  });
}

export function credentialFromEnvironment(env: NodeJS.ProcessEnv = process.env): ResolvedCredential | null {
  const token = env[TOKEN_ENV];
  if (token === undefined || token === "") return null;
  return {
    credential: { accessToken: validateToken(token), tokenType: "Bearer" },
    source: "environment"
  };
}

export interface GetCredentialOptions {
  readonly apiOrigin: URL;
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
  readonly allowFileFallback?: boolean;
  readonly onWarning?: (message: string) => void;
}

export async function getCredential(options: GetCredentialOptions): Promise<ResolvedCredential> {
  const envCredential = credentialFromEnvironment(options.env);
  if (envCredential !== null) return envCredential;
  const store =
    options.store ??
    (await createCredentialStore({
      apiOrigin: options.apiOrigin,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.allowFileFallback === undefined ? {} : { allowFileFallback: options.allowFileFallback }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning })
    }));
  const credential = await store.load();
  if (credential === null) {
    throw new AwError({
      code: "AUTH_REQUIRED",
      category: "auth",
      message: "Not authenticated. Run `augmentworks login` first."
    });
  }
  return { credential, source: store.kind };
}

export interface ResolveAccessTokenOptions extends GetCredentialOptions {
  readonly client?: CloudAuthClient;
  readonly now?: () => number;
}

export async function resolveAccessToken(options: ResolveAccessTokenOptions): Promise<string> {
  const environmentCredential = credentialFromEnvironment(options.env);
  if (environmentCredential !== null) return environmentCredential.credential.accessToken;
  const store =
    options.store ??
    (await createCredentialStore({
      apiOrigin: options.apiOrigin,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.allowFileFallback === undefined
        ? {}
        : { allowFileFallback: options.allowFileFallback }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning })
    }));
  const resolved = await getCredential({ ...options, store });
  const credential = resolved.credential;
  if (credential.refreshToken === undefined || !credentialExpiresSoon(credential, options.now ?? Date.now)) {
    return credential.accessToken;
  }
  const refreshed = await (options.client ?? new CloudAuthClient({ apiOrigin: options.apiOrigin })).refresh(
    credential.refreshToken
  );
  const merged: StoredCredential = {
    ...credential,
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? credential.refreshToken
  };
  await store.save(merged);
  return merged.accessToken;
}

function credentialExpiresSoon(credential: StoredCredential, now: () => number): boolean {
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

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw credentialIoError("Refusing to use a non-directory or symlinked credential directory.");
    }
    if (process.platform !== "win32") await chmod(directory, 0o700);
  } catch (cause) {
    if (cause instanceof AwError) throw cause;
    throw credentialIoError("Could not create the credential directory.", cause);
  }
}

async function rejectSymlinkIfPresent(filePath: string): Promise<void> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw credentialIoError("Refusing to use a non-regular or symlinked credential file.");
    }
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return;
    if (cause instanceof AwError) throw cause;
    throw credentialIoError("Could not inspect the credential file.", cause);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return false;
    throw credentialIoError("Could not inspect the credential file.", cause);
  }
}

function credentialIoError(message: string, cause?: unknown): AwError {
  return new AwError({
    code: "CREDENTIAL_STORE",
    category: "local",
    message,
    ...(cause === undefined ? {} : { cause })
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
