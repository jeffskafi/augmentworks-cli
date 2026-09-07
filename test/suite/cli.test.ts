import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTestCommand } from "../../src/commands/test.js";
import { EXIT } from "../../src/errors.js";
import { SOURCE_SUITE_PREVIEW_COMMAND, SOURCE_SUITE_VALIDATE_COMMAND } from "../../src/release.js";
import { runSourceCli } from "../util/cli-process.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("suite CLI", () => {
  it("documents validate and preview as offline", async () => {
    const help = await runSourceCli(["suite", "--help"], { cwd: projectRoot });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("validate");
    expect(help.stdout).toContain("preview");
    expect(help.stdout).toMatch(/without calling a target\s+or an LLM/);
    expect(help.stdout).not.toContain("http://");
  });

  it("validates and previews both sample suites offline", async () => {
    for (const file of [
      "examples/customer-suites/faq-non-commerce.yaml",
      "examples/customer-suites/returns-14-day.yaml"
    ]) {
      const validate = await runSourceCli(["suite", "validate", file, "--json"], {
        cwd: projectRoot,
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      });
      expect(validate.exitCode).toBe(0);
      const payload = JSON.parse(validate.stdout) as {
        ok: boolean;
        localPreview: { authoritativePrice: boolean; executesTarget: boolean; callsLlm: boolean };
      };
      expect(payload.ok).toBe(true);
      expect(payload.localPreview).toEqual({
        authoritativePrice: false,
        executesTarget: false,
        callsLlm: false
      });

      const preview = await runSourceCli(["suite", "preview", file], {
        cwd: projectRoot,
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      });
      expect(preview.exitCode).toBe(0);
      expect(preview.stdout).toContain("not a price");
      expect(preview.stdout).toContain("authoritative_price: no");
      expect(preview.stdout).toContain("executes_target: no");
      expect(preview.stdout).toContain("calls_llm: no");
    }
  });

  it("prints useful diagnostics for invalid suites", async () => {
    const invalid = await runSourceCli(
      ["suite", "validate", "test/fixtures/customer-suites/invalid-field.yaml"],
      { cwd: projectRoot }
    );
    expect(invalid.exitCode).toBe(EXIT.CONFIG);
    expect(invalid.stderr).toContain("SUITE_INVALID_FIELD");

    const duplicate = await runSourceCli(
      ["suite", "validate", "test/fixtures/customer-suites/duplicate-case-id.yaml"],
      { cwd: projectRoot }
    );
    expect(duplicate.exitCode).toBe(EXIT.CONFIG);
    expect(duplicate.stderr).toContain("SUITE_DUPLICATE_CASE_ID");

    const missing = await runSourceCli(
      ["suite", "validate", "test/fixtures/customer-suites/missing-reference.yaml"],
      { cwd: projectRoot }
    );
    expect(missing.exitCode).toBe(EXIT.CONFIG);
    expect(missing.stderr).toContain("SUITE_MISSING_REFERENCE");

    const unsupported = await runSourceCli(
      ["suite", "validate", "test/fixtures/customer-suites/unsupported-schema.yaml"],
      { cwd: projectRoot }
    );
    expect(unsupported.exitCode).toBe(EXIT.CONFIG);
    expect(unsupported.stderr).toContain("SUITE_UNSUPPORTED_SCHEMA");

    const feature = await runSourceCli(
      ["suite", "validate", "test/fixtures/customer-suites/unsupported-feature.yaml"],
      { cwd: projectRoot }
    );
    expect(feature.exitCode).toBe(EXIT.CONFIG);
    expect(feature.stderr).toContain("SUITE_UNSUPPORTED_FEATURE");
  });

  it("rejects --suite with --local and with --assessment", async () => {
    const command = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();

    await expect(
      command.parseAsync(
        ["node", "augmentworks", "--suite", "suite.yaml", "--local", "--packet", "x@1.0.0"],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "HOSTED_SUITE_UNSUPPORTED_LOCAL" });

    const conflict = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();
    await expect(
      conflict.parseAsync(
        ["node", "augmentworks", "--suite", "suite.yaml", "--assessment", "file.yaml"],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "SUITE_SELECTION_CONFLICT" });
  });

  it("documents source suite commands without unpublished npx", () => {
    expect(SOURCE_SUITE_VALIDATE_COMMAND).toContain("node dist/index.js");
    expect(SOURCE_SUITE_PREVIEW_COMMAND).toContain("node dist/index.js");
    expect(SOURCE_SUITE_VALIDATE_COMMAND).not.toContain("@0.3.3");
  });
});
