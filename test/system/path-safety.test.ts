import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findUnsafeSymbolicLinkComponent } from "../../src/system/path-safety.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("path component safety", () => {
  it("accepts regular files beneath the system temporary directory", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-path-safety-"));
    directories.push(directory);
    const file = resolve(directory, "packet.json");
    await writeFile(file, "{}", "utf8");

    await expect(findUnsafeSymbolicLinkComponent(file)).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a mutable descendant symlink even beneath a permitted system prefix",
    async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-path-safety-"));
      directories.push(directory);
      const target = resolve(directory, "target");
      const link = resolve(directory, "link");
      await mkdir(target);
      await writeFile(resolve(target, "packet.json"), "{}", "utf8");
      await symlink(target, link);

      await expect(
        findUnsafeSymbolicLinkComponent(resolve(link, "packet.json"))
      ).resolves.toBe(link);
    }
  );
});
