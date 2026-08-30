import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  rename,
  unlink
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  type CreateRunRequest,
  type CreateRunResponse,
  type RunStatusResponse
} from "../cloud/protocol.js";
import { AwError } from "../errors.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { getStateDirectory } from "./state-dir.js";
import {
  acquireSecureLock,
  ensureSecureDirectory,
  type SecureLockHandle
} from "./secure-lock.js";

export const RUN_INTENT_VERSION = "aw-run-intent/0.1" as const;
const MAX_INTENT_BYTES = 256 * 1024;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const intentSchema = z
  .object({
    intent_version: z.literal(RUN_INTENT_VERSION),
    phase: z.enum(["pending_create", "bound"]),
    api_origin: z.string().url(),
    request: CreateRunRequestSchema,
    request_sha256: digest,
    binding: CreateRunResponseSchema.optional(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256(canonicalize(value.request)) !== value.request_sha256) {
      context.addIssue({ code: "custom", message: "request digest does not match" });
    }
    if ((value.phase === "bound") !== (value.binding !== undefined)) {
      context.addIssue({ code: "custom", message: "intent phase and binding disagree" });
    }
  });

export type CreateRunIntentRequest = Omit<CreateRunRequest, "create_request_id">;
export type RunIntent = z.infer<typeof intentSchema>;

export interface RunIntentStoreOptions {
  readonly apiOrigin: URL;
  readonly stateDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly createRequestId?: () => string;
  readonly platform?: NodeJS.Platform;
}

export interface LoadedRunIntent {
  readonly intent: RunIntent;
  readonly resumed: boolean;
}

export class RunIntentStore {
  readonly path: string;
  readonly lockPath: string;
  readonly #apiOrigin: string;
  readonly #stateDirectory: string;
  readonly #runsDirectory: string;
  readonly #now: () => Date;
  readonly #createRequestId: () => string;
  readonly #platform: NodeJS.Platform;
  #lock: SecureLockHandle | undefined;
  #intent: RunIntent | undefined;

  constructor(options: RunIntentStoreOptions) {
    this.#apiOrigin = normalizedApiBase(options.apiOrigin);
    this.#stateDirectory =
      options.stateDirectory ?? getStateDirectory(options.env ?? process.env);
    this.#runsDirectory = join(this.#stateDirectory, "runs");
    const originHash = sha256(this.#apiOrigin).slice(0, 32);
    this.path = join(this.#runsDirectory, `active-${originHash}.json`);
    this.lockPath = `${this.path}.lock`;
    this.#now = options.now ?? (() => new Date());
    this.#createRequestId =
      options.createRequestId ?? (() => `crq_${randomBytes(32).toString("base64url")}`);
    this.#platform = options.platform ?? process.platform;
  }

  get intent(): RunIntent | undefined {
    return this.#intent === undefined ? undefined : structuredClone(this.#intent);
  }

  async open(): Promise<this> {
    if (this.#lock !== undefined) return this;
    await ensureSecureDirectory({
      path: this.#stateDirectory,
      recursive: true,
      label: "AugmentWorks state",
      errorCode: "UNSAFE_STATE_DIRECTORY"
    });
    await ensureSecureDirectory({
      path: this.#runsDirectory,
      recursive: false,
      label: "run intent",
      errorCode: "UNSAFE_STATE_DIRECTORY"
    });
    this.#lock = await acquireSecureLock({
      path: this.lockPath,
      label: "run intent",
      errorCodes: {
        locked: "RUN_INTENT_LOCKED",
        unsafe: "UNSAFE_RUN_INTENT_LOCK",
        unknownOwner: "RUN_INTENT_LOCK_OWNER_UNKNOWN",
        foreignOwner: "RUN_INTENT_LOCK_FOREIGN_OWNER",
        changed: "RUN_INTENT_LOCK_CHANGED"
      },
      now: this.#now
    });
    try {
      this.#intent = await readIntent(this.path);
      if (this.#intent !== undefined && this.#intent.api_origin !== this.#apiOrigin) {
        throw intentError(
          "RUN_INTENT_ORIGIN_MISMATCH",
          "The active assessment belongs to a different AugmentWorks API origin."
        );
      }
      return this;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async loadOrCreate(request: CreateRunIntentRequest): Promise<LoadedRunIntent> {
    this.#assertOpen();
    if (this.#intent !== undefined) {
      const candidate = CreateRunRequestSchema.safeParse({
        ...request,
        create_request_id: this.#intent.request.create_request_id
      });
      if (
        !candidate.success ||
        canonicalize(candidate.data) !== canonicalize(this.#intent.request)
      ) {
        throw intentError(
          "ACTIVE_RUN_EXISTS",
          "A different assessment is already active for this AugmentWorks API origin. Resume it before starting another."
        );
      }
      return { intent: structuredClone(this.#intent), resumed: true };
    }

    const parsed = CreateRunRequestSchema.safeParse({
      ...request,
      create_request_id: this.#createRequestId()
    });
    if (!parsed.success) {
      throw intentError(
        "INVALID_RUN_REQUEST",
        "The assessment request cannot be persisted safely."
      );
    }
    const timestamp = this.#now().toISOString();
    const next = parseIntent({
      intent_version: RUN_INTENT_VERSION,
      phase: "pending_create",
      api_origin: this.#apiOrigin,
      request: parsed.data,
      request_sha256: sha256(canonicalize(parsed.data)),
      created_at: timestamp,
      updated_at: timestamp
    });
    await writeIntentAtomic(this.path, this.#runsDirectory, next, this.#platform);
    this.#intent = next;
    return { intent: structuredClone(next), resumed: false };
  }

  async bind(binding: CreateRunResponse): Promise<RunIntent> {
    this.#assertOpen();
    const current = this.#requireIntent();
    validateBinding(current, binding);
    if (
      current.binding !== undefined &&
      canonicalize(immutableBinding(current.binding)) !== canonicalize(immutableBinding(binding))
    ) {
      throw intentError(
        "RUN_BINDING_MISMATCH",
        "AugmentWorks changed the immutable binding of the active assessment."
      );
    }
    const next = parseIntent({
      ...current,
      phase: "bound",
      binding,
      updated_at: this.#now().toISOString()
    });
    await writeIntentAtomic(this.path, this.#runsDirectory, next, this.#platform);
    this.#intent = next;
    return structuredClone(next);
  }

  async removeTerminal(run: RunStatusResponse): Promise<void> {
    this.#assertOpen();
    const current = this.#requireIntent();
    if (current.binding === undefined || current.binding.run_id !== run.run_id) {
      throw intentError(
        "RUN_BINDING_MISMATCH",
        "The terminal assessment does not match the active run intent."
      );
    }
    if (!TERMINAL_STATUSES.has(run.status)) {
      throw intentError(
        "RUN_NOT_TERMINAL",
        "The active run intent cannot be removed before an authoritative terminal status."
      );
    }
    await rejectUnsafeIntentPath(this.path, false);
    await unlink(this.path);
    await syncDirectory(this.#runsDirectory, this.#platform);
    this.#intent = undefined;
  }

  async close(): Promise<void> {
    const lock = this.#lock;
    this.#lock = undefined;
    if (lock !== undefined) await lock.release();
  }

  #assertOpen(): void {
    if (this.#lock === undefined) {
      throw intentError("RUN_INTENT_CLOSED", "The run intent store is closed.");
    }
  }

  #requireIntent(): RunIntent {
    const intent = this.#intent;
    if (intent === undefined) {
      throw intentError("RUN_INTENT_MISSING", "No active run intent has been persisted.");
    }
    return intent;
  }
}

function normalizedApiBase(value: URL): string {
  const normalized = new URL(value);
  normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
  normalized.search = "";
  normalized.hash = "";
  return normalized.toString();
}

function validateBinding(intent: RunIntent, binding: CreateRunResponse): void {
  const request = intent.request;
  const matches =
    binding.create_request_id === request.create_request_id &&
    binding.create_request_sha256 === intent.request_sha256 &&
    binding.packet.key === request.packet.key &&
    binding.packet.version === request.packet.version &&
    binding.config_sha256 === request.config_sha256;
  if (!matches) {
    throw intentError(
      "RUN_BINDING_MISMATCH",
      "AugmentWorks created a run with a different request, packet, or configuration binding."
    );
  }
}

function immutableBinding(binding: CreateRunResponse): Record<string, unknown> {
  return {
    create_request_id: binding.create_request_id,
    create_request_sha256: binding.create_request_sha256,
    run_id: binding.run_id,
    session_id: binding.session_id,
    packet: binding.packet,
    config_sha256: binding.config_sha256,
    fencing_epoch: binding.fencing_epoch,
    dashboard_url: binding.dashboard_url,
    run_expires_at: binding.run_expires_at
  };
}

async function readIntent(path: string): Promise<RunIntent | undefined> {
  let pathIdentity;
  try {
    pathIdentity = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw intentError("UNSAFE_RUN_INTENT", "The active run intent could not be inspected safely.", error);
  }
  assertSafeIntentStat(pathIdentity);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    throw intentError("UNSAFE_RUN_INTENT", "The active run intent could not be opened safely.", error);
  }
  try {
    const stat = await handle.stat();
    if (stat.dev !== pathIdentity.dev || stat.ino !== pathIdentity.ino) {
      throw intentError(
        "UNSAFE_RUN_INTENT",
        "The active run intent changed while it was being opened."
      );
    }
    if (
      !stat.isFile() ||
      stat.size > MAX_INTENT_BYTES ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o777) !== 0o600 || !isCurrentOwner(stat.uid)))
    ) {
      throw intentError(
        "UNSAFE_RUN_INTENT",
        "The active run intent must be a bounded mode-0600 regular file."
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_INTENT_BYTES) {
      throw intentError("UNSAFE_RUN_INTENT", "The active run intent is too large.");
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      throw intentError("RUN_INTENT_CORRUPT", "The active run intent is invalid JSON.", error);
    }
    return parseIntent(value);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseIntent(value: unknown): RunIntent {
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) {
    throw intentError("RUN_INTENT_CORRUPT", "The active run intent failed validation.");
  }
  return parsed.data;
}

async function writeIntentAtomic(
  path: string,
  directory: string,
  intent: RunIntent,
  platform: NodeJS.Platform
): Promise<void> {
  await rejectUnsafeIntentPath(path, true);
  const temporaryPath = join(
    directory,
    `.run-intent-${process.pid}-${randomBytes(12).toString("hex")}.tmp`
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        noFollowFlag(),
      0o600
    );
    await secureFileHandle(handle);
    const serialized = `${canonicalize(intent)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_INTENT_BYTES) {
      throw intentError("RUN_INTENT_TOO_LARGE", "The active run intent is too large.");
    }
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await rejectUnsafeIntentPath(path, false);
    await syncDirectory(directory, platform);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof AwError) throw error;
    throw intentError("RUN_INTENT_WRITE_FAILED", "The active run intent could not be persisted.", error);
  }
}

async function secureFileHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.chmod(0o600);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o777) !== 0o600 || !isCurrentOwner(stat.uid)))
    ) {
      throw new Error("run intent permissions are unsafe");
    }
  } catch (error) {
    throw intentError(
      "UNSAFE_RUN_INTENT",
      "The active run intent permissions could not be secured.",
      error
    );
  }
}

async function rejectUnsafeIntentPath(path: string, allowMissing: boolean): Promise<void> {
  try {
    const stat = await lstat(path);
    assertSafeIntentStat(stat);
  } catch (error) {
    if (allowMissing && isErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

function assertSafeIntentStat(stat: Stats): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > MAX_INTENT_BYTES ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o777) !== 0o600 || !isCurrentOwner(stat.uid)))
  ) {
    throw intentError(
      "UNSAFE_RUN_INTENT",
      "The active run intent must be a current-owner mode-0600 regular file and cannot be a symbolic link."
    );
  }
}

function isCurrentOwner(uid: number): boolean {
  const getuid = process.getuid;
  return getuid === undefined || uid === getuid();
}

async function syncDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (isExpectedWindowsDirectorySyncError(error, platform)) return;
    throw intentError(
      "RUN_INTENT_WRITE_FAILED",
      "The run intent directory could not be synchronized.",
      error
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function isExpectedWindowsDirectorySyncError(
  error: unknown,
  platform: NodeJS.Platform
): boolean {
  return (
    platform === "win32" &&
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    new Set(["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"]).has(
      String((error as { code?: unknown }).code)
    )
  );
}

function noFollowFlag(): number {
  return process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number"
    ? 0
    : constants.O_NOFOLLOW;
}

function intentError(code: string, message: string, cause?: unknown): AwError {
  return new AwError({ code, category: "local", message, cause });
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
