import { describe, expect, it } from "vitest";

import { createTestCommand } from "../../src/commands/test.js";
import {
  SOURCE_INVESTIGATION_EXPORT_COMMAND,
  SOURCE_INVESTIGATION_FETCH_COMMAND,
  SOURCE_INVESTIGATION_INSPECT_COMMAND,
  SOURCE_INVESTIGATION_INSPECT_JSON_COMMAND,
  SOURCE_INVESTIGATION_TEST_COMMAND
} from "../../src/release.js";
import { runSourceCli } from "../util/cli-process.js";
import { projectRoot } from "./helpers.js";

describe("investigation CLI", () => {
  it("documents inspect, fetch, and export-regression as observation-only", async () => {
    const help = await runSourceCli(["investigation", "--help"], { cwd: projectRoot });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("inspect");
    expect(help.stdout).toContain("fetch");
    expect(help.stdout).toContain("export-regression");
    expect(help.stdout).toContain("without running a target");

    const inspect = await runSourceCli(["investigation", "inspect", "--help"], { cwd: projectRoot });
    expect(inspect.stdout).toContain("without running a");
    expect(inspect.stdout).toContain("shell command");
    expect(inspect.stdout).toContain("evaluator");
    expect(inspect.stdout).toContain("--json");

    const fetchHelp = await runSourceCli(["investigation", "fetch", "--help"], { cwd: projectRoot });
    expect(fetchHelp.stdout).toContain("Observation only");
    expect(fetchHelp.stdout).toContain("does not quote");
    expect(fetchHelp.stdout).toContain("execute the target");
    expect(fetchHelp.stdout).toContain("--run");
    expect(fetchHelp.stdout).toContain("--evaluation");
    expect(fetchHelp.stdout).toContain("--attempt");
    expect(fetchHelp.stdout).toContain("--criterion");

    const testHelp = await runSourceCli(["test", "--help"], { cwd: projectRoot });
    expect(testHelp.stdout).toContain("--investigation");
    expect(testHelp.stdout).toContain("new quote");
  });

  it("rejects --investigation with --local, --suite, and --assessment", async () => {
    const local = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();
    await expect(
      local.parseAsync(
        ["node", "augmentworks", "--investigation", "inv.json", "--local", "--packet", "x@1.0.0"],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "HOSTED_INVESTIGATION_UNSUPPORTED_LOCAL" });

    const conflict = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();
    await expect(
      conflict.parseAsync(
        ["node", "augmentworks", "--investigation", "inv.json", "--suite", "suite.yaml"],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "INVESTIGATION_SELECTION_CONFLICT" });
  });

  it("documents source investigation commands without unpublished npx", () => {
    expect(SOURCE_INVESTIGATION_INSPECT_COMMAND).toContain("node dist/index.js investigation inspect");
    expect(SOURCE_INVESTIGATION_INSPECT_JSON_COMMAND).toContain("--json");
    expect(SOURCE_INVESTIGATION_FETCH_COMMAND).toContain("investigation fetch");
    expect(SOURCE_INVESTIGATION_EXPORT_COMMAND).toContain("export-regression");
    expect(SOURCE_INVESTIGATION_TEST_COMMAND).toContain("--investigation");
    expect(SOURCE_INVESTIGATION_INSPECT_COMMAND).not.toContain("@0.3.3");
    expect(SOURCE_INVESTIGATION_TEST_COMMAND).not.toContain("@0.3.3");
  });
});
