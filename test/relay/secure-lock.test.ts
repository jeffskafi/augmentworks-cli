import { chmod, lstat, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireSecureLock,
  type SecureLockErrorCodes,
  type SecureLockRuntime
} from "../../src/relay/secure-lock.js";

const temporaryDirectories: string[] = [];
const errorCodes: SecureLockErrorCodes = {
  locked: "TEST_LOCKED",
  unsafe: "TEST_UNSAFE",
  unknownOwner: "TEST_UNKNOWN_OWNER",
  foreignOwner: "TEST_FOREIGN_OWNER",
  changed: "TEST_LOCK_CHANGED"
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-secure-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runtime(overrides: Partial<SecureLockRuntime> = {}): SecureLockRuntime {
  return {
    pid: 9001,
    hostname: "host-a",
    bootId: "boot-a",
    processStartId: "start-9001",
    nonce: () => "b".repeat(32),
    probeProcess: () => "dead",
    processStartIdFor: () => null,
    ...overrides
  };
}

async function staleFixture(
  path: string,
  overrides: Partial<{
    pid: number;
    hostname: string;
    boot_id: string | null;
    process_start_id: string | null;
    nonce: string;
  }> = {}
): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  const owner = {
    lock_version: "aw-secure-lock/0.1",
    pid: 1234,
    hostname: "host-a",
    boot_id: "boot-a",
    process_start_id: "start-1234",
    nonce: "a".repeat(32),
    created_at: new Date().toISOString(),
    ...overrides
  };
  await writeFile(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await chmod(join(path, "owner.json"), 0o600);
}

function options(path: string, lockRuntime: SecureLockRuntime) {
  return { path, label: "test", errorCodes, runtime: lockRuntime } as const;
}

describe("secure lock", () => {
  it("reclaims only a same-host same-boot owner positively known dead", async () => {
    const path = join(await temporaryDirectory(), "run.lock");
    await staleFixture(path);
    const lock = await acquireSecureLock(
      options(path, runtime({ probeProcess: vi.fn(() => "dead" as const) }))
    );
    expect((await lstat(path)).isDirectory()).toBe(true);
    await lock.release();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a live owner", async () => {
    const path = join(await temporaryDirectory(), "run.lock");
    await staleFixture(path);
    await expect(
      acquireSecureLock(
        options(
          path,
          runtime({
            probeProcess: () => "alive",
            processStartIdFor: () => "start-1234"
          })
        )
      )
    ).rejects.toMatchObject({ code: "TEST_LOCKED" });
  });

  it("refuses unknown liveness, missing boot identity, and PID-reuse ambiguity", async () => {
    const root = await temporaryDirectory();
    const unknown = join(root, "unknown.lock");
    await staleFixture(unknown);
    await expect(
      acquireSecureLock(options(unknown, runtime({ probeProcess: () => "unknown" })))
    ).rejects.toMatchObject({ code: "TEST_UNKNOWN_OWNER" });

    const missingBoot = join(root, "missing-boot.lock");
    await staleFixture(missingBoot, { boot_id: null });
    await expect(acquireSecureLock(options(missingBoot, runtime()))).rejects.toMatchObject({
      code: "TEST_UNKNOWN_OWNER"
    });

    const reused = join(root, "reused.lock");
    await staleFixture(reused);
    await expect(
      acquireSecureLock(
        options(
          reused,
          runtime({
            probeProcess: () => "alive",
            processStartIdFor: () => "different-process-start"
          })
        )
      )
    ).rejects.toMatchObject({ code: "TEST_UNKNOWN_OWNER" });
  });

  it("refuses foreign host and boot owners without probing their PIDs", async () => {
    const root = await temporaryDirectory();
    const probe = vi.fn(() => "dead" as const);
    const foreignHost = join(root, "foreign-host.lock");
    await staleFixture(foreignHost, { hostname: "host-b" });
    await expect(
      acquireSecureLock(options(foreignHost, runtime({ probeProcess: probe })))
    ).rejects.toMatchObject({ code: "TEST_FOREIGN_OWNER" });

    const foreignBoot = join(root, "foreign-boot.lock");
    await staleFixture(foreignBoot, { boot_id: "boot-b" });
    await expect(
      acquireSecureLock(options(foreignBoot, runtime({ probeProcess: probe })))
    ).rejects.toMatchObject({ code: "TEST_FOREIGN_OWNER" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses symlinked lock paths and owner records", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryDirectory();
    const target = join(root, "target");
    await mkdir(target);
    const lockLink = join(root, "lock-link");
    await symlink(target, lockLink);
    await expect(acquireSecureLock(options(lockLink, runtime()))).rejects.toMatchObject({
      code: "TEST_UNSAFE"
    });

    const ownerLink = join(root, "owner-link.lock");
    await mkdir(ownerLink, { mode: 0o700 });
    await chmod(ownerLink, 0o700);
    const ownerTarget = join(root, "owner-target");
    await writeFile(ownerTarget, "{}\n");
    await symlink(ownerTarget, join(ownerLink, "owner.json"));
    await expect(acquireSecureLock(options(ownerLink, runtime()))).rejects.toMatchObject({
      code: "TEST_UNSAFE"
    });
  });

  it("refuses reclaim when the nonce or owner inode changes during the death probe", async () => {
    const path = join(await temporaryDirectory(), "run.lock");
    await staleFixture(path);
    const ownerPath = join(path, "owner.json");
    const lockRuntime = runtime({
      probeProcess: async () => {
        await unlink(ownerPath);
        const replacement = {
          lock_version: "aw-secure-lock/0.1",
          pid: 1234,
          hostname: "host-a",
          boot_id: "boot-a",
          process_start_id: "start-1234",
          nonce: "c".repeat(32),
          created_at: new Date().toISOString()
        };
        await writeFile(ownerPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        await chmod(ownerPath, 0o600);
        return "dead" as const;
      }
    });
    await expect(acquireSecureLock(options(path, lockRuntime))).rejects.toMatchObject({
      code: "TEST_LOCK_CHANGED"
    });
    await expect(lstat(path)).resolves.toBeDefined();
  });
});
