import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadCustomerSuiteFile } from "../../src/suite/load.js";
import { previewCustomerSuite } from "../../src/suite/preview.js";
import { SUITE_SCHEMA_VERSION } from "../../src/suite/schema.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("customer suite load and preview", () => {
  it("validates both sample suites and matches packed assets", async () => {
    for (const name of ["faq-non-commerce.yaml", "returns-14-day.yaml"] as const) {
      const example = await loadCustomerSuiteFile(resolve(projectRoot, "examples/customer-suites", name));
      const packed = await loadCustomerSuiteFile(resolve(projectRoot, "assets/customer-suites", name));
      expect(example.document.schemaVersion).toBe(SUITE_SCHEMA_VERSION);
      expect(example.contentHash).toBe(packed.contentHash);
      expect(example.yamlSha256).toBe(packed.yamlSha256);
      const preview = previewCustomerSuite(example);
      expect(preview.localPreview).toEqual({
        authoritativePrice: false,
        executesTarget: false,
        callsLlm: false
      });
      expect(preview.caseCount).toBeGreaterThanOrEqual(3);
    }
  });

  it("projects bounded counts for the FAQ sample", async () => {
    const loaded = await loadCustomerSuiteFile(
      resolve(projectRoot, "examples/customer-suites/faq-non-commerce.yaml")
    );
    const preview = previewCustomerSuite(loaded);
    expect(preview.caseCount).toBe(5);
    expect(preview.projectedAttemptCount).toBe(5);
    expect(preview.projectedTurnCount).toBe(5);
    expect(preview.requiresMultiTurn).toBe(false);
    expect(preview.evaluationMode).toBe("hybrid");
  });

  it("marks the 14-day sample as multi-turn without advertising hosted multi_turn", async () => {
    const loaded = await loadCustomerSuiteFile(
      resolve(projectRoot, "examples/customer-suites/returns-14-day.yaml")
    );
    const preview = previewCustomerSuite(loaded);
    expect(preview.requiresMultiTurn).toBe(true);
    expect(preview.cases.some((suiteCase) => suiteCase.turns.length > 1)).toBe(true);
  });

  it.each([
    ["invalid-field.yaml", "SUITE_INVALID_FIELD"],
    ["duplicate-case-id.yaml", "SUITE_DUPLICATE_CASE_ID"],
    ["missing-reference.yaml", "SUITE_MISSING_REFERENCE"],
    ["unsupported-schema.yaml", "SUITE_UNSUPPORTED_SCHEMA"],
    ["unsupported-feature.yaml", "SUITE_UNSUPPORTED_FEATURE"],
    ["contradictory-14-vs-30.yaml", "SUITE_CONTRADICTORY_EXPECTATION"]
  ] as const)("diagnoses %s as %s", async (filename, code) => {
    await expect(
      loadCustomerSuiteFile(resolve(projectRoot, "test/fixtures/customer-suites", filename))
    ).rejects.toMatchObject({ code, category: "config" });
  });

  it("includes a field path for an invalid key", async () => {
    await expect(
      loadCustomerSuiteFile(resolve(projectRoot, "test/fixtures/customer-suites/invalid-field.yaml"))
    ).rejects.toMatchObject({
      code: "SUITE_INVALID_FIELD",
      details: expect.objectContaining({ field: "unexpected_widget" })
    });
  });
});

describe("assessment files that are actually suites", () => {
  it("points authors to suite validate / test --suite", async () => {
    const { loadAssessmentFile } = await import("../../src/assessment/load.js");
    await expect(
      loadAssessmentFile({
        path: resolve(projectRoot, "examples/customer-suites/faq-non-commerce.yaml")
      })
    ).rejects.toMatchObject({ code: "ASSESSMENT_SUITE_FILE" });
  });
});

describe("customer suite credential rejection", () => {
  it("rejects judging credentials before network use", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aw-suite-secret-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "suite.yaml"),
      `schema_version: aw-suite/1
suite_id: customer.secret
title: Secret
judge_api_key: sk-test
cases:
  - case_id: secret.one
    turns:
      - content: Hello?
    expected:
      facts:
        - A greeting
    criteria:
      - criterion_id: secret.one.required
        requirement: required
        kind: llm_rubric
        statement: No secrets.
`,
      "utf8"
    );
    await expect(loadCustomerSuiteFile(join(directory, "suite.yaml"))).rejects.toMatchObject({
      code: "SUITE_CREDENTIAL_FORBIDDEN"
    });
  });
});
