import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/commands/doctor.js";
import { runInit } from "../../src/commands/init.js";
import { runSchema } from "../../src/commands/schema.js";
import { HOSTED_COMMAND_PIN, LOCAL_DISTRIBUTION, SOURCE_PACKAGE_VERSION } from "../../src/release.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-init-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("configuration commands", () => {
  it("initializes atomically and never replaces an existing .env", async () => {
    const directory = await temporaryDirectory();
    const initial = await runInit({ cwd: directory, agent: true });
    expect(initial.created).toEqual(expect.arrayContaining([
      resolve(directory, "augmentworks.yaml"),
      resolve(directory, ".env"),
      resolve(directory, ".env.example"),
      resolve(directory, "augmentworks.agent.md")
    ]));
    if (process.platform !== "win32") {
      expect((await lstat(resolve(directory, ".env"))).mode & 0o077).toBe(0);
    }
    await writeFile(resolve(directory, ".env"), "CHATBOT_API_KEY=keep-me\n", { encoding: "utf8", mode: 0o600 });
    const forced = await runInit({ cwd: directory, agent: true, force: true });
    expect(forced.preserved).toContain(resolve(directory, ".env"));
    expect(await readFile(resolve(directory, ".env"), "utf8")).toBe("CHATBOT_API_KEY=keep-me\n");
    expect(await readFile(resolve(directory, ".gitignore"), "utf8")).toContain(".env\n");
    expect(await readFile(resolve(directory, ".gitignore"), "utf8")).toContain(
      ".augmentworks/\n"
    );
    const agent = await readFile(resolve(directory, "augmentworks.agent.md"), "utf8");
    expect(agent).toContain(`npx --yes @augmentworks/cli@${HOSTED_COMMAND_PIN} doctor -c augmentworks.yaml`);
    if (LOCAL_DISTRIBUTION === "git") {
      expect(agent).not.toContain(`npx --yes @augmentworks/cli@${SOURCE_PACKAGE_VERSION}`);
    }
  });

  it("adds the local artifact directory even when .env is already ignored", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, ".gitignore"), ".env\n", "utf8");
    await runInit({ cwd: directory });
    expect(await readFile(resolve(directory, ".gitignore"), "utf8")).toBe(
      ".env\n.augmentworks/\n"
    );
  });

  it("refuses to overwrite generated files without --force", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory });
    await expect(runInit({ cwd: directory })).rejects.toMatchObject({ code: "INIT_FILE_EXISTS" });
  });

  it("doctor validates locally and reports the capability", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory });
    const report = await runDoctor({
      cwd: directory,
      processEnv: {
        CHATBOT_BASE_URL: "http://localhost:8000",
        CHATBOT_API_KEY: "local-test-value"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.offline).toBe(true);
    expect(report.resolvedConfig?.capabilities.level).toBe("stateful");
    expect(report.diagnostics.map((item) => item.code)).toContain("OFFLINE_CHECK_COMPLETE");
  });

  it("prints a valid bundled schema", async () => {
    const schema = JSON.parse(await runSchema()) as Record<string, unknown>;
    expect(schema["$id"]).toBe("https://augmentworks.ai/schemas/v1/augmentworks.schema.json");
    expect(schema["additionalProperties"]).toBe(false);

    const packet = JSON.parse(await runSchema(false, "local-packet")) as Record<string, unknown>;
    const result = JSON.parse(await runSchema(true, "local-result")) as Record<string, unknown>;
    expect(packet["$id"]).toBe("https://augmentworks.ai/schemas/v1/local-packet.schema.json");
    expect(result["$id"]).toBe("https://augmentworks.ai/schemas/v1/local-result.schema.json");
  });
});
