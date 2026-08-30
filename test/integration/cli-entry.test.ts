import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CLI_VERSION } from "../../src/version.js";
import { runSourceCli } from "../util/cli-process.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("CLI entrypoint", () => {
  it("prints exactly the package-facing version", async () => {
    const result = await runSourceCli(["--version"], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${CLI_VERSION}\n`);
    expect(result.stderr).toBe("");
  });

  it("advertises the complete v0.1 command surface", async () => {
    const result = await runSourceCli(["--help"], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of ["login", "logout", "whoami", "init", "doctor", "test", "schema"]) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command}(?: \\[options\\])?`, "m"));
    }
    expect(result.stdout).not.toMatch(/^  connect\b/m);
  });

  it("uses Commander errors, suggestions, help, and a non-zero exit for invalid commands", async () => {
    const result = await runSourceCli(["tset"], { cwd: projectRoot });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command 'tset'");
    expect(result.stderr).toContain("Did you mean test?");
    expect(result.stderr).toContain("Usage: augmentworks");
    expect(result.stderr).not.toMatch(/[\u001b\u009b]/u);
  });

  it("returns the documented config exit code when doctor fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "augmentworks-cli-entry-"));
    temporaryDirectories.push(cwd);

    const result = await runSourceCli(["doctor", "-c", "missing.yaml", "--offline"], { cwd });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("CONFIG_FILE_NOT_FOUND");
    expect(result.stdout).toContain("Doctor found configuration errors.");
    expect(result.stderr).toBe("");
  });

  it("can be imported as a library without parsing the host process arguments", async () => {
    const entry = await import("../../src/index.js");

    expect(entry.CLI_VERSION).toBe(CLI_VERSION);
    expect(entry.createCli).toBeTypeOf("function");
    expect(entry.runCli).toBeTypeOf("function");
  });
});
