import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionIntentLedger } from "../../src/action-gate/ledger.js";
import type { ActionIntent } from "../../src/action-gate/documents.js";
import { acquireSecureLock } from "../../src/relay/secure-lock.js";
import { runSourceCli } from "../util/cli-process.js";

const directories: string[] = [];
const RECEIPT = "fabricated-signed-receipt-bytes-order_fabricated_001";
const SECRET = "SECRET_MARKER_not_for_errors";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("action intent ledger", () => {
  it.runIf(process.platform !== "win32")(
    "creates mode 0700 directories and mode 0600 files under a permissive umask",
    async () => {
      const parent = await temporaryDirectory();
      const directory = join(parent, "intents");
      const previous = process.umask(0);
      try {
        const ledger = new ActionIntentLedger(directory);
        await ledger.createPrepared(sampleIntent());
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        expect((await lstat(intentPath(directory))).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(previous);
      }
    }
  );

  it.runIf(process.platform !== "win32")(
    "tightens an existing current-user ledger without changing receipt bytes",
    async () => {
      const directory = await temporaryDirectory();
      await chmod(directory, 0o755);
      const intent = sampleIntent();
      const body = `${JSON.stringify(intent)}\n`;
      await writeFile(intentPath(directory), body, { mode: 0o644 });
      const ledger = new ActionIntentLedger(directory);
      const read = await ledger.read(intent.intentId);
      expect(read?.receiptBytes).toBe(RECEIPT);
      expect(await readFile(intentPath(directory), "utf8")).toBe(body);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(intentPath(directory))).mode & 0o777).toBe(0o600);
    }
  );

  it("round-trips a receipt-pending intent across a new ledger instance", async () => {
    const directory = await temporaryDirectory();
    const intent = sampleIntent();
    await new ActionIntentLedger(directory).createPrepared(intent);
    const restarted = await new ActionIntentLedger(directory).read(intent.intentId);
    expect(restarted).toEqual(intent);
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(intentPath(directory))).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps one complete private file after an atomic replace", async () => {
    const directory = await temporaryDirectory();
    const ledger = new ActionIntentLedger(directory);
    const prepared = sampleIntent({ state: "prepared", receiptBytes: null, toolInvocations: 0 });
    await ledger.createPrepared(prepared);
    const next = sampleIntent();
    const stored = await ledger.transition(prepared.intentId, ["prepared"], next);
    expect(stored.receiptBytes).toBe(RECEIPT);
    const names = await readdir(directory);
    expect(names.filter((name) => name.endsWith(".tmp") || name === ".lock")).toEqual([]);
    const body = await readFile(intentPath(directory), "utf8");
    expect(body.endsWith("\n")).toBe(true);
    expect(JSON.parse(body)).toMatchObject({ state: "receipt_pending", receiptBytes: RECEIPT });
    if (process.platform !== "win32") {
      expect((await lstat(intentPath(directory))).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent writers", async () => {
    const directory = await temporaryDirectory();
    const ledger = new ActionIntentLedger(directory);
    const first = sampleIntent();
    const second = sampleIntent({
      intentId: "c".repeat(64),
      commandId: "cmd_fabricated_2"
    });
    const saved = await Promise.all([ledger.createPrepared(first), ledger.createPrepared(second)]);
    expect(saved.map((intent) => intent.intentId).sort()).toEqual([first.intentId, second.intentId].sort());
    expect(await ledger.list()).toHaveLength(2);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a symlinked ledger directory without creating files through it",
    async () => {
      const root = await temporaryDirectory();
      const target = join(root, "target");
      const link = join(root, "link");
      await mkdir(target);
      await symlink(target, link);
      await expect(new ActionIntentLedger(link).list()).rejects.toMatchObject({
        code: "UNSAFE_ACTION_LEDGER"
      });
      expect(await readdir(target)).toEqual([]);
    }
  );

  it.runIf(process.platform !== "win32")(
    "refuses a symlink in the ledger parent chain",
    async () => {
      const root = await temporaryDirectory();
      const outside = join(root, "outside");
      const linkedParent = join(root, "linked-parent");
      await mkdir(outside);
      await symlink(outside, linkedParent);
      await expect(new ActionIntentLedger(join(linkedParent, "intents")).createPrepared(sampleIntent())).rejects.toMatchObject({
        code: "UNSAFE_ACTION_LEDGER"
      });
      expect(await readdir(outside)).toEqual([]);
    }
  );

  it.runIf(process.platform !== "win32")(
    "refuses a symlinked intent file without reading or replacing the target",
    async () => {
      const root = await temporaryDirectory();
      const directory = join(root, "intents");
      await mkdir(directory, { mode: 0o700 });
      const outside = join(root, "outside.json");
      await writeFile(outside, `${SECRET}\n`, { mode: 0o600 });
      await symlink(outside, intentPath(directory));
      const ledger = new ActionIntentLedger(directory);
      const error = await ledger.read(sampleIntent().intentId).then(
        () => {
          throw new Error("symlinked intent was read");
        },
        (caught: unknown) => caught
      );
      expect(error).toMatchObject({ code: "UNSAFE_ACTION_LEDGER" });
      expect(error instanceof Error ? error.message : "").not.toContain(SECRET);
      await expect(ledger.createPrepared(sampleIntent())).rejects.toMatchObject({
        code: "UNSAFE_ACTION_LEDGER"
      });
      expect(await readFile(outside, "utf8")).toBe(`${SECRET}\n`);
    }
  );

  it.runIf(process.platform !== "win32")("refuses a symlinked lock without removing its target", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "intents");
    const decoy = join(root, "decoy");
    await mkdir(directory, { mode: 0o700 });
    await mkdir(decoy);
    await symlink(decoy, join(directory, ".lock"));
    await expect(new ActionIntentLedger(directory).list()).rejects.toMatchObject({
      code: "UNSAFE_ACTION_LEDGER"
    });
    expect(await readdir(decoy)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("refuses a non-regular intent path", async () => {
    const directory = await temporaryDirectory();
    await mkdir(intentPath(directory));
    await expect(new ActionIntentLedger(directory).read(sampleIntent().intentId)).rejects.toMatchObject({
      code: "UNSAFE_ACTION_LEDGER"
    });
  });

  it("refuses a foreign-owned ledger directory", async (context) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      context.skip();
      return;
    }
    const foreign = await foreignOwnedDirectory();
    if (foreign === undefined) {
      context.skip();
      return;
    }
    const before = await lstat(foreign);
    const error = await new ActionIntentLedger(foreign).list().then(
      () => {
        throw new Error("foreign ledger was accepted");
      },
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({ code: "UNSAFE_ACTION_LEDGER" });
    expect(error instanceof Error ? error.message : "").not.toMatch(/root:x:|receiptBytes/u);
    const after = await lstat(foreign);
    expect(after.uid).toBe(before.uid);
    expect(after.mode).toBe(before.mode);
    expect(after.ino).toBe(before.ino);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a foreign-owned intent file when ownership can be changed",
    async (context) => {
      const directory = await temporaryDirectory();
      const intent = sampleIntent();
      const body = `${JSON.stringify({ ...intent, receiptBytes: SECRET })}\n`;
      await writeFile(intentPath(directory), body, { mode: 0o600 });
      try {
        await chown(intentPath(directory), 65534, 65534);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toMatch(/EPERM|EACCES|EINVAL/);
        context.skip();
        return;
      }
      const caught = await new ActionIntentLedger(directory).read(intent.intentId).then(
        () => {
          throw new Error("foreign intent was read");
        },
        (reason: unknown) => reason
      );
      expect(caught).toMatchObject({ code: "UNSAFE_ACTION_LEDGER" });
      expect(caught instanceof Error ? caught.message : "").not.toContain(SECRET);
      expect(await readFile(intentPath(directory), "utf8")).toBe(body);
    }
  );

  it("does not echo a corrupt record in the read error", async () => {
    const directory = await temporaryDirectory();
    if (process.platform !== "win32") await chmod(directory, 0o700);
    await writeFile(intentPath(directory), `{"receiptBytes":"${SECRET}"`, { mode: 0o600 });
    const error = await new ActionIntentLedger(directory).read(sampleIntent().intentId).then(
      () => {
        throw new Error("corrupt intent was accepted");
      },
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({ code: "ACTION_OUTCOME_INDETERMINATE" });
    expect(error instanceof Error ? error.message : "").not.toContain(SECRET);
  });

  it.runIf(process.platform !== "win32")(
    "reclaims an ownerless non-private lock left by a crashed process",
    async () => {
      const directory = await temporaryDirectory();
      const intent = sampleIntent();
      const body = `${JSON.stringify(intent)}\n`;
      await writeFile(intentPath(directory), body, { mode: 0o600 });
      const lock = join(directory, ".lock");
      await mkdir(lock);
      await chmod(lock, 0o755);
      const started = Date.now();
      const listed = await new ActionIntentLedger(directory).list();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(listed).toEqual([intent]);
      expect(await readFile(intentPath(directory), "utf8")).toBe(body);
      await expect(lstat(join(directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("reclaims an empty private lock after the owner record fails to appear", async () => {
    const directory = await temporaryDirectory();
    const lock = join(directory, ".lock");
    await mkdir(lock, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(lock, 0o700);
    const intent = sampleIntent();
    await writeFile(intentPath(directory), `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    const started = Date.now();
    await expect(new ActionIntentLedger(directory).read(intent.intentId)).resolves.toEqual(intent);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(LOCK_UPPER_BOUND_MS);
  });

  it("reclaims a positively dead lock owner and leaves receipt bytes unchanged", async () => {
    const directory = await temporaryDirectory();
    const intent = sampleIntent();
    const body = `${JSON.stringify(intent)}\n`;
    await writeFile(intentPath(directory), body, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(intentPath(directory), 0o600);
    await writeDeadOwnerLock(join(directory, ".lock"), { mode: 0o755 });
    const read = await new ActionIntentLedger(directory).read(intent.intentId);
    expect(read?.receiptBytes).toBe(RECEIPT);
    expect(await readFile(intentPath(directory), "utf8")).toBe(body);
    await expect(lstat(join(directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a live lock fail-closed", async () => {
    const directory = await temporaryDirectory();
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const held = await acquireSecureLock({
      path: join(directory, ".lock"),
      label: "action intent ledger",
      errorCodes: lockErrors
    });
    try {
      const started = Date.now();
      await expect(new ActionIntentLedger(directory).list()).rejects.toMatchObject({
        code: "ACTION_OUTCOME_INDETERMINATE",
        message: expect.stringContaining("locked by another recovery")
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
      expect((await lstat(join(directory, ".lock"))).isDirectory()).toBe(true);
    } finally {
      await held.release();
    }
  });

  it("refuses an unknown or foreign lock owner", async () => {
    const directory = await temporaryDirectory();
    const unknown = join(directory, ".lock");
    await mkdir(unknown, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(unknown, 0o700);
    await writeFile(join(unknown, "owner.json"), "{}\n", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(join(unknown, "owner.json"), 0o600);
    const started = Date.now();
    await expect(new ActionIntentLedger(directory).list()).rejects.toMatchObject({
      code: "ACTION_LEDGER_OWNER_UNKNOWN"
    });
    expect(Date.now() - started).toBeLessThan(LOCK_UPPER_BOUND_MS);
    expect((await lstat(unknown)).isDirectory()).toBe(true);

    await rm(unknown, { recursive: true, force: true });
    await writeDeadOwnerLock(unknown, { hostname: "foreign-host" });
    await expect(new ActionIntentLedger(directory).list()).rejects.toMatchObject({
      code: "UNSAFE_ACTION_LEDGER"
    });
    expect((await lstat(unknown)).isDirectory()).toBe(true);
  });

  it("recovers a pending receipt from a new process without rerunning a tool", async () => {
    const directory = await temporaryDirectory();
    const intent = sampleIntent();
    await new ActionIntentLedger(directory).createPrepared(intent);
    const before = await readFile(intentPath(directory), "utf8");
    const recovered = await runSourceCli(["action", "recover", "--state-dir", directory, "--json"], {
      cwd: directory
    });
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).not.toContain(RECEIPT);
    expect(recovered.stdout).not.toContain(RECEIPT);
    expect(JSON.parse(recovered.stdout)).toEqual({
      controlledActionsAvailable: false,
      retried: 1,
      results: [
        {
          intentId: intent.intentId,
          evidenceStatus: "reported",
          receiptAccepted: false,
          toolInvocations: 1,
          platformSignature: false
        }
      ]
    });
    expect(await readFile(intentPath(directory), "utf8")).toBe(before);
    const listed = await new ActionIntentLedger(directory).read(intent.intentId);
    expect(listed?.toolInvocations).toBe(1);
    expect(listed?.receiptBytes).toBe(RECEIPT);
  });
});

const LOCK_UPPER_BOUND_MS = 5_000;

const lockErrors = {
  locked: "ACTION_LEDGER_LOCKED",
  unsafe: "UNSAFE_ACTION_LEDGER",
  unknownOwner: "ACTION_LEDGER_OWNER_UNKNOWN",
  foreignOwner: "UNSAFE_ACTION_LEDGER",
  changed: "UNSAFE_ACTION_LEDGER"
} as const;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-action-ledger-"));
  directories.push(directory);
  return directory;
}

function intentPath(directory: string, intentId = "a".repeat(64)): string {
  return join(directory, `${intentId}.json`);
}

function sampleIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  const hash = "b".repeat(64);
  return {
    schemaVersion: "aw-action-intent/1",
    intentId: "a".repeat(64),
    state: "receipt_pending",
    mode: "local-offline",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    receiverId: "22222222-2222-4222-8222-222222222222",
    scopeHash: hash,
    policyHash: hash,
    runId: "33333333-3333-4333-8333-333333333333",
    attemptId: "44444444-4444-4444-8444-444444444444",
    commandId: "cmd_fabricated_1",
    actionName: "issue_refund",
    resourceId: "order_fabricated_001",
    argumentRepresentationHash: hash,
    argumentCommitment: {
      algorithm: "hmac-sha256",
      value: hash,
      keyId: "receiver-local-hmac-1"
    },
    amount: { currency: "USD", minorUnits: 2500 },
    permit: null,
    receipt: null,
    receiptBytes: RECEIPT,
    toolInvocations: 1,
    platformSignature: false,
    ...overrides
  };
}

async function foreignOwnedDirectory(): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  for (const candidate of ["/etc", "/usr", "/var"]) {
    try {
      const stat = await lstat(candidate);
      if (!stat.isSymbolicLink() && stat.isDirectory() && stat.uid !== uid) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function writeDeadOwnerLock(
  lockPath: string,
  overrides: { readonly hostname?: string; readonly mode?: number } = {}
): Promise<void> {
  await mkdir(lockPath, { mode: overrides.mode ?? 0o700 });
  if (process.platform !== "win32") await chmod(lockPath, overrides.mode ?? 0o700);
  const owner = {
    lock_version: "aw-secure-lock/0.1",
    pid: await deadPid(),
    hostname: overrides.hostname ?? hostname(),
    boot_id: process.platform === "linux" ? "00000000-0000-4000-8000-000000000000" : null,
    process_start_id: null,
    nonce: "d".repeat(32),
    created_at: new Date().toISOString()
  };
  const ownerPath = join(lockPath, "owner.json");
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(ownerPath, 0o600);
}

async function deadPid(): Promise<number> {
  for (let pid = 1_000_000; pid < 1_004_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("No positively dead pid was available for the stale-lock fixture.");
}
