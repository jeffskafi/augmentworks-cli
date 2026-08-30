import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { AwError } from "../errors.js";
import {
  acquireSecureLock,
  ensureSecureDirectory,
  type SecureLockRuntime
} from "../relay/secure-lock.js";
import {
  credentialFilePath,
  originScopedCredentialDpapiPath,
  originScopedCredentialFilePath,
  originScopedCredentialRefreshLockPath
} from "../system/paths.js";
import {
  findExecutable,
  runProcess,
  type ProcessResult
} from "../system/process.js";
import { CloudAuthClient } from "./client.js";
import type {
  AccessTokenManager,
  AccessTokenRequest,
  CredentialStore,
  ResolvedCredential,
  StoredCredential
} from "./types.js";

export const TOKEN_ENV = "AUGMENTWORKS_TOKEN";
const ACCOUNT_PREFIX = "augmentworks-cli";
const MACOS_KEYCHAIN_SERVICE = "ai.augmentworks.cli";
const MACOS_SECURITY_PATH = "/usr/bin/security";
const MAX_CREDENTIAL_BYTES = 128 * 1024;
const MAX_WINDOWS_CIPHERTEXT_BYTES = 256 * 1024;
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_POLL_MS = 50;

// Windows PowerShell 5.1 ships with supported Windows releases and exposes
// DPAPI without a native Node add-on. The helper receives only base64 fields on
// stdin; neither the credential nor its encryption entropy appears in argv.
// It also owns and verifies a protected, non-reparse ACL before touching data.
const WINDOWS_DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Decode-Utf8([string] $Value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Assert-NotReparse([string] $Path, [bool] $Directory) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($Directory -and -not $item.PSIsContainer) { throw "not-directory" }
  if (-not $Directory -and $item.PSIsContainer) { throw "not-file" }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "reparse-point"
  }
}

function New-PrivateAcl([bool] $Directory) {
  if ($Directory) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($script:CurrentSid)
  $acl.SetAccessRuleProtection($true, $false)
  $userRule = New-Object -TypeName Security.AccessControl.FileSystemAccessRule -ArgumentList @(
    $script:CurrentSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $systemRule = New-Object -TypeName Security.AccessControl.FileSystemAccessRule -ArgumentList @(
    $script:SystemSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void] $acl.AddAccessRule($userRule)
  [void] $acl.AddAccessRule($systemRule)
  return $acl
}

function Set-PrivateAcl([string] $Path, [bool] $Directory) {
  $acl = New-PrivateAcl $Directory
  if ($Directory) {
    (Get-Item -LiteralPath $Path -Force).SetAccessControl($acl)
  } else {
    (Get-Item -LiteralPath $Path -Force).SetAccessControl($acl)
  }
}

function Assert-PrivateAcl([string] $Path, [bool] $Directory) {
  Assert-NotReparse $Path $Directory
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
  $acl = (Get-Item -LiteralPath $Path -Force).GetAccessControl($sections)
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $script:CurrentSid.Value) { throw "foreign-owner" }
  if (-not $acl.AreAccessRulesProtected) { throw "inherited-acl" }
  $hasCurrentUser = $false
  foreach ($rule in $acl.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  )) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
      throw "unexpected-deny"
    }
    if ($sid -ne $script:CurrentSid.Value -and $sid -ne $script:SystemSid.Value) {
      throw "broad-acl"
    }
    if ($sid -eq $script:CurrentSid.Value) { $hasCurrentUser = $true }
  }
  if (-not $hasCurrentUser) { throw "missing-owner-access" }
}

try {
  $request = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
  $path = [IO.Path]::GetFullPath((Decode-Utf8 $request.path_b64))
  $root = [IO.Path]::GetFullPath((Decode-Utf8 $request.root_b64))
  if ([IO.Path]::GetDirectoryName($path) -ne $root) { throw "path-outside-root" }
  if (-not $path.EndsWith(".dpapi", [StringComparison]::OrdinalIgnoreCase)) {
    throw "wrong-extension"
  }

  $script:CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $script:SystemSid = New-Object -TypeName Security.Principal.SecurityIdentifier -ArgumentList @(
    "S-1-5-18"
  )
  Add-Type -AssemblyName System.Security

  if (Test-Path -LiteralPath $root) {
    Assert-NotReparse $root $true
    $existingOwner = (Get-Item -LiteralPath $root -Force).GetAccessControl().GetOwner(
      [Security.Principal.SecurityIdentifier]
    )
    if ($existingOwner.Value -ne $script:CurrentSid.Value) { throw "foreign-root-owner" }
  } else {
    [void] [IO.Directory]::CreateDirectory($root)
  }
  Set-PrivateAcl $root $true
  Assert-PrivateAcl $root $true

  $entropy = [Convert]::FromBase64String($request.entropy_b64)
  if ($request.operation -eq "load") {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { exit 44 }
    Assert-PrivateAcl $path $false
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Length -lt 1 -or $item.Length -gt 262144) { throw "ciphertext-size" }
    $ciphertext = [IO.File]::ReadAllBytes($path)
    $plaintext = $null
    try {
      $plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
        $ciphertext,
        $entropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      [Console]::Out.Write([Convert]::ToBase64String($plaintext))
    } finally {
      if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
      [Array]::Clear($ciphertext, 0, $ciphertext.Length)
    }
    exit 0
  }

  if ($request.operation -eq "save") {
    if (Test-Path -LiteralPath $path) { Assert-PrivateAcl $path $false }
    $plaintext = [Convert]::FromBase64String($request.credential_b64)
    $ciphertext = $null
    $temporary = Join-Path $root (".credentials." + [Guid]::NewGuid().ToString("N") + ".tmp")
    try {
      $ciphertext = [Security.Cryptography.ProtectedData]::Protect(
        $plaintext,
        $entropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      if ($ciphertext.Length -gt 262144) { throw "ciphertext-size" }
      [IO.File]::WriteAllBytes($temporary, $ciphertext)
      Set-PrivateAcl $temporary $false
      Assert-PrivateAcl $temporary $false
      if (Test-Path -LiteralPath $path) {
        [IO.File]::Replace($temporary, $path, $null)
      } else {
        [IO.File]::Move($temporary, $path)
      }
      Assert-PrivateAcl $path $false
    } finally {
      if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Force
      }
      [Array]::Clear($plaintext, 0, $plaintext.Length)
      if ($null -ne $ciphertext) { [Array]::Clear($ciphertext, 0, $ciphertext.Length) }
    }
    exit 0
  }

  if ($request.operation -eq "delete") {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { exit 44 }
    Assert-PrivateAcl $path $false
    Remove-Item -LiteralPath $path -Force
    exit 0
  }
  throw "unknown-operation"
} catch {
  [Console]::Error.Write("AW_DPAPI_ERROR")
  exit 70
}
`;
const WINDOWS_DPAPI_SCRIPT_BASE64 = Buffer.from(WINDOWS_DPAPI_SCRIPT, "utf16le").toString(
  "base64"
);

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

export type CredentialHelperRunner = (
  executable: string,
  args: readonly string[],
  options?: {
    readonly input?: string;
    readonly timeoutMs?: number;
    readonly allowFailure?: boolean;
    readonly env?: NodeJS.ProcessEnv;
  }
) => Promise<ProcessResult>;

export class MacOsKeychainCredentialStore implements CredentialStore {
  readonly kind = "native" as const;
  readonly description = "macOS login Keychain";
  readonly #account: string;

  constructor(
    private readonly executable: string,
    apiOrigin: URL,
    private readonly runner: CredentialHelperRunner = runProcess
  ) {
    const originDigest = createHash("sha256").update(apiOrigin.origin).digest("hex");
    this.#account = `${ACCOUNT_PREFIX}:${originDigest}`;
  }

  async load(): Promise<StoredCredential | null> {
    const result = await this.runner(
      this.executable,
      [
        "find-generic-password",
        "-a",
        this.#account,
        "-s",
        MACOS_KEYCHAIN_SERVICE,
        "-w"
      ],
      { allowFailure: true }
    );
    if (result.code === 44) return null;
    if (result.code !== 0) {
      throw credentialIoError("Could not read the macOS Keychain credential.");
    }
    return parseStoredCredential(result.stdout.trim());
  }

  async save(credential: StoredCredential): Promise<void> {
    const serialized = serializeCredential(credential);
    const passwordHex = Buffer.from(serialized, "utf8").toString("hex");
    await this.runner(
      this.executable,
      ["-i"],
      {
        // security's ordinary -w prompt uses getpass(3), which requires a TTY.
        // Interactive mode reads commands from stdin, so -X keeps the secret
        // (hex-encoded only for argument parsing) out of argv and process lists.
        input:
          `add-generic-password -a ${this.#account} -s ${MACOS_KEYCHAIN_SERVICE} ` +
          `-l AugmentWorks-CLI -U -X ${passwordHex}\n`
      }
    );
    const persisted = await this.load();
    const normalized = serializeCredential(parseStoredCredential(serialized));
    if (persisted === null || serializeCredential(persisted) !== normalized) {
      throw credentialIoError("Could not verify the saved macOS Keychain credential.");
    }
  }

  async delete(): Promise<void> {
    const result = await this.runner(
      this.executable,
      ["delete-generic-password", "-a", this.#account, "-s", MACOS_KEYCHAIN_SERVICE],
      { allowFailure: true }
    );
    if (result.code !== 0 && result.code !== 44) {
      throw credentialIoError("Could not delete the macOS Keychain credential.");
    }
  }
}

export class WindowsDpapiCredentialStore implements CredentialStore {
  readonly kind = "native" as const;
  readonly description: string;

  constructor(
    private readonly executable: string,
    private readonly filePath: string,
    private readonly apiOrigin: URL,
    private readonly runner: CredentialHelperRunner = runProcess
  ) {
    this.description = `Windows DPAPI credential at ${filePath}`;
  }

  async load(): Promise<StoredCredential | null> {
    const result = await this.run("load");
    if (result.code === 44) return null;
    if (result.code !== 0) {
      throw credentialIoError("Could not read the Windows DPAPI credential.");
    }
    const encoded = result.stdout.trim();
    if (
      encoded.length > Math.ceil(MAX_WINDOWS_CIPHERTEXT_BYTES / 3) * 4 ||
      !isCanonicalBase64(encoded)
    ) {
      throw credentialIoError("The Windows credential helper returned invalid data.");
    }
    const serialized = Buffer.from(encoded, "base64");
    if (serialized.byteLength > MAX_CREDENTIAL_BYTES) {
      throw credentialIoError("The stored AugmentWorks credential is too large.");
    }
    return parseStoredCredential(serialized.toString("utf8"));
  }

  async save(credential: StoredCredential): Promise<void> {
    const result = await this.run("save", serializeCredential(credential));
    if (result.code !== 0) {
      throw credentialIoError("Could not save the Windows DPAPI credential.");
    }
  }

  async delete(): Promise<void> {
    const result = await this.run("delete");
    if (result.code !== 0 && result.code !== 44) {
      throw credentialIoError("Could not delete the Windows DPAPI credential.");
    }
  }

  private async run(
    operation: "load" | "save" | "delete",
    serialized?: string
  ): Promise<ProcessResult> {
    const request = {
      operation,
      path_b64: Buffer.from(this.filePath, "utf8").toString("base64"),
      root_b64: Buffer.from(path.win32.dirname(this.filePath), "utf8").toString("base64"),
      entropy_b64: Buffer.from(
        `${MACOS_KEYCHAIN_SERVICE}:${this.apiOrigin.origin}`,
        "utf8"
      ).toString("base64"),
      ...(serialized === undefined
        ? {}
        : { credential_b64: Buffer.from(serialized, "utf8").toString("base64") })
    };
    return await this.runner(
      this.executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        WINDOWS_DPAPI_SCRIPT_BASE64
      ],
      {
        input: JSON.stringify(request),
        allowFailure: true
      }
    );
  }
}

export interface CredentialRefreshLock {
  run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export class FileCredentialRefreshLock implements CredentialRefreshLock {
  readonly description: string;
  readonly #lockPath: string;
  readonly #timeoutMs: number;
  readonly #pollMs: number;
  readonly #runtime: SecureLockRuntime | undefined;

  constructor(
    lockPath: string,
    options: {
      readonly timeoutMs?: number;
      readonly pollMs?: number;
      readonly runtime?: SecureLockRuntime;
    } = {}
  ) {
    this.#lockPath = lockPath;
    this.description = lockPath;
    this.#timeoutMs = options.timeoutMs ?? REFRESH_LOCK_TIMEOUT_MS;
    this.#pollMs = options.pollMs ?? REFRESH_LOCK_POLL_MS;
    this.#runtime = options.runtime;
  }

  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await ensureSecureDirectory({
      path: path.dirname(this.#lockPath),
      recursive: true,
      label: "credential",
      errorCode: "CREDENTIAL_STORE"
    });
    const deadline = Date.now() + this.#timeoutMs;
    let lock;
    while (lock === undefined) {
      throwIfRefreshAborted(signal);
      try {
        lock = await acquireSecureLock({
          path: this.#lockPath,
          label: "credential refresh",
          errorCodes: {
            locked: "CREDENTIAL_REFRESH_LOCKED",
            unsafe: "UNSAFE_CREDENTIAL_REFRESH_LOCK",
            unknownOwner: "CREDENTIAL_REFRESH_LOCK_OWNER_UNKNOWN",
            foreignOwner: "CREDENTIAL_REFRESH_LOCK_FOREIGN_OWNER",
            changed: "CREDENTIAL_REFRESH_LOCK_CHANGED"
          },
          ...(this.#runtime === undefined ? {} : { runtime: this.#runtime })
        });
      } catch (cause) {
        const occupied =
          cause instanceof AwError &&
          (cause.code === "CREDENTIAL_REFRESH_LOCKED" ||
            cause.code === "CREDENTIAL_REFRESH_LOCK_OWNER_UNKNOWN" ||
            cause.code === "CREDENTIAL_REFRESH_LOCK_FOREIGN_OWNER");
        if (!occupied) {
          throw cause;
        }
        if (Date.now() >= deadline) {
          throw new AwError({
            code: "CREDENTIAL_REFRESH_BUSY",
            category: "auth",
            message: "Another AugmentWorks command is still refreshing this credential. Retry shortly.",
            retryable: true
          });
        }
        await waitForRefreshLock(this.#pollMs, signal);
      }
    }

    try {
      return await action();
    } finally {
      await lock.release();
    }
  }
}

class SecretToolCredentialStore implements CredentialStore {
  readonly kind = "native" as const;
  readonly description = "Secret Service keyring (secret-tool)";

  constructor(
    private readonly executable: string,
    private readonly apiOrigin: URL,
    private readonly runner: CredentialHelperRunner = runProcess
  ) {}

  async load(): Promise<StoredCredential | null> {
    const result = await this.runner(
      this.executable,
      ["lookup", "application", ACCOUNT_PREFIX, "api-origin", this.apiOrigin.origin],
      { allowFailure: true }
    );
    if (result.code !== 0 || result.stdout.trim() === "") return null;
    return parseStoredCredential(result.stdout.trim());
  }

  async save(credential: StoredCredential): Promise<void> {
    await this.runner(
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
    await this.runner(
      this.executable,
      ["clear", "application", ACCOUNT_PREFIX, "api-origin", this.apiOrigin.origin],
      { allowFailure: true }
    );
  }
}

export interface CredentialHelperRuntime {
  readonly findExecutable: typeof findExecutable;
  readonly runProcess: CredentialHelperRunner;
}

const DEFAULT_CREDENTIAL_HELPER_RUNTIME: CredentialHelperRuntime = {
  findExecutable,
  runProcess
};

export interface CredentialStoreOptions {
  readonly apiOrigin: URL;
  readonly allowFileFallback?: boolean;
  readonly filePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly helperRuntime?: CredentialHelperRuntime;
  readonly windowsDpapiPath?: string;
  readonly onWarning?: (message: string) => void;
}

export async function createCredentialStore(options: CredentialStoreOptions): Promise<CredentialStore> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const helperRuntime = options.helperRuntime ?? DEFAULT_CREDENTIAL_HELPER_RUNTIME;
  if (platform === "darwin") {
    const security = await helperRuntime.findExecutable(MACOS_SECURITY_PATH, { env, platform });
    if (security !== null) {
      return new MacOsKeychainCredentialStore(
        security,
        options.apiOrigin,
        helperRuntime.runProcess
      );
    }
  }

  if (platform === "win32") {
    const windowsDirectory = env["SystemRoot"] ?? env["WINDIR"] ?? "C:\\Windows";
    const powerShellCandidate = path.win32.join(
      windowsDirectory,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const powerShell = await helperRuntime.findExecutable(powerShellCandidate, { env, platform });
    if (powerShell !== null) {
      return new WindowsDpapiCredentialStore(
        powerShell,
        options.windowsDpapiPath ?? originScopedCredentialDpapiPath(options.apiOrigin, env),
        options.apiOrigin,
        helperRuntime.runProcess
      );
    }
    throw new AwError({
      code: "CREDENTIAL_STORE_UNAVAILABLE",
      category: "auth",
      message:
        "Windows DPAPI storage requires the built-in Windows PowerShell helper. Plaintext file fallback is disabled on Windows because POSIX mode 0600 cannot be verified."
    });
  }

  if (platform === "linux" && env["DBUS_SESSION_BUS_ADDRESS"] !== undefined) {
    const secretTool = await helperRuntime.findExecutable("secret-tool", { env, platform });
    if (secretTool !== null) {
      return new SecretToolCredentialStore(
        secretTool,
        options.apiOrigin,
        helperRuntime.runProcess
      );
    }
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
      "No supported OS credential store is available. Re-run login with --allow-file-credentials to use a warned mode-0600 fallback."
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
  readonly platform?: NodeJS.Platform;
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
      ...(options.platform === undefined ? {} : { platform: options.platform }),
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

export interface AccessTokenManagerOptions extends GetCredentialOptions {
  readonly client?: CloudAuthClient;
  readonly now?: () => number;
  readonly refreshLock?: CredentialRefreshLock;
}

export interface ResolveAccessTokenOptions
  extends AccessTokenManagerOptions,
    AccessTokenRequest {}

export async function createAccessTokenManager(
  options: AccessTokenManagerOptions
): Promise<AccessTokenManager> {
  const environmentCredential = credentialFromEnvironment(options.env);
  if (environmentCredential !== null) {
    return {
      source: "environment",
      getAccessToken: async () => environmentCredential.credential.accessToken
    };
  }
  const store =
    options.store ??
    (await createCredentialStore({
      apiOrigin: options.apiOrigin,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.allowFileFallback === undefined
        ? {}
        : { allowFileFallback: options.allowFileFallback }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning })
    }));
  let cachedCredential = await loadRequiredCredential(store);
  const client = options.client ?? new CloudAuthClient({ apiOrigin: options.apiOrigin });
  const now = options.now ?? Date.now;
  const refreshLock =
    options.refreshLock ??
    new FileCredentialRefreshLock(
      originScopedCredentialRefreshLockPath(
        options.apiOrigin,
        options.env ?? process.env,
        options.platform ?? process.platform
      )
    );

  return {
    source: store.kind,
    getAccessToken: async (request: AccessTokenRequest = {}) => {
      if (!credentialNeedsRefresh(cachedCredential, request, now)) {
        return cachedCredential.accessToken;
      }

      const expectedAccessToken = cachedCredential.accessToken;
      cachedCredential = await refreshLock.run(async () => {
        const latest = await loadRequiredCredential(store);

        // The lock is process-independent. Always re-read after acquiring it so
        // a second command reuses the winner's rotated token instead of replaying
        // the now-invalid refresh token and revoking the whole token family.
        if (latest.accessToken !== expectedAccessToken) return latest;
        if (!credentialNeedsRefresh(latest, request, now)) return latest;
        if (latest.refreshToken === undefined) return latest;

        const refreshed = await client.refresh(latest.refreshToken, request.signal);
        const merged: StoredCredential = {
          ...latest,
          ...refreshed,
          refreshToken: refreshed.refreshToken ?? latest.refreshToken
        };
        await store.save(merged);
        return merged;
      }, request.signal);
      return cachedCredential.accessToken;
    }
  };
}

export async function resolveAccessToken(options: ResolveAccessTokenOptions): Promise<string> {
  const manager = await createAccessTokenManager(options);
  return await manager.getAccessToken({
    ...(options.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh }),
    ...(options.rejectedAccessToken === undefined
      ? {}
      : { rejectedAccessToken: options.rejectedAccessToken }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

function credentialNeedsRefresh(
  credential: StoredCredential,
  request: AccessTokenRequest,
  now: () => number
): boolean {
  if (credential.refreshToken === undefined) return false;
  if (request.forceRefresh === true) {
    return (
      request.rejectedAccessToken === undefined ||
      credential.accessToken === request.rejectedAccessToken
    );
  }
  return credentialExpiresSoon(credential, now);
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

async function loadRequiredCredential(store: CredentialStore): Promise<StoredCredential> {
  const credential = await store.load();
  if (credential === null) {
    throw new AwError({
      code: "AUTH_REQUIRED",
      category: "auth",
      message: "Not authenticated. Run `augmentworks login` first."
    });
  }
  return credential;
}

async function waitForRefreshLock(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfRefreshAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(refreshInterrupted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfRefreshAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw refreshInterrupted();
}

function refreshInterrupted(): AwError {
  return new AwError({
    code: "INTERRUPTED",
    category: "local",
    message: "Credential refresh was interrupted."
  });
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

function isCanonicalBase64(value: string): boolean {
  if (value === "" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}
