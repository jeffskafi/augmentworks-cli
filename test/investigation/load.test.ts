import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { parseInvestigationValue, loadInvestigationFile } from "../../src/investigation/load.js";
import { evaluateInvestigationPrerequisites } from "../../src/investigation/prerequisites.js";
import { regressionDraftYaml } from "../../src/investigation/export-regression.js";
import { runSourceCli } from "../util/cli-process.js";
import {
  cleanupDirs,
  copyInvestigation,
  projectRoot,
  resolvedFor,
  tempDir
} from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await cleanupDirs(temporaryDirectories);
});

function poisonEnv(): Record<string, string> {
  return {
    AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
    AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
  };
}

function sha256Lf(buffer: Buffer): string {
  return createHash("sha256")
    .update(Buffer.from(buffer.toString("utf8").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n"), "utf8"))
    .digest("hex");
}

describe("investigation load and inspect", () => {
  it("pins the consumer fixture checksum in the lock file", async () => {
    const lock = JSON.parse(
      await readFile(resolve(projectRoot, "contracts/aw-investigation-export-v1.lock.json"), "utf8")
    ) as {
      cli: { consumerFixturesChecksum: string };
      source: { schemaChecksum: string; consumedCommitCited: string };
    };
    const bytes = await readFile(
      resolve(projectRoot, "contracts/aw-investigation-export-v1.fixtures.json")
    );
    expect(sha256Lf(bytes)).toBe(lock.cli.consumerFixturesChecksum);
    expect(lock.cli.consumerFixturesChecksum).toBe(
      "48422512afa62dbac67bf634a58cfa5821b035db9d58c9d1fb44ca5b9decbdbc"
    );
    expect(lock.source.schemaChecksum).toBe(
      "4f026740a349c736e98af95599736a92cb81246bea3a1673b26e7fa94cadc870"
    );
    expect(lock.source.consumedCommitCited).toBe("a8e5ad17ce60f9b199d6a45f34188546d075e4bf");
  });

  it("validates the packed response-only and stateful fixtures without calling a target", async () => {
    for (const relative of [
      "examples/investigations/response-only.json",
      "examples/investigations/stateful.json",
      "assets/investigations/response-only.json",
      "assets/investigations/stateful.json"
    ]) {
      const loaded = await loadInvestigationFile(resolve(projectRoot, relative));
      expect(loaded.document.createsBillableRun).toBe(false);
      expect(loaded.document.schemaVersion).toBe("aw-investigation-export/1");
    }
  });

  it("inspects both sample investigations offline with a poisoned hosted token", async () => {
    const marker = resolve(projectRoot, "test/fixtures/investigations/.must-not-be-created");
    await rm(marker, { force: true });
    for (const file of [
      "examples/investigations/response-only.json",
      "examples/investigations/stateful.json"
    ]) {
      const result = await runSourceCli(["investigation", "inspect", file, "--json"], {
        cwd: projectRoot,
        env: poisonEnv()
      });
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        action: string;
        admissionCalls: number;
        executesShell: boolean;
        executesTarget: boolean;
        callsEvaluator: boolean;
        copiedCommandsAreData: boolean;
        createsBillableRun: boolean;
      };
      expect(payload).toMatchObject({
        ok: true,
        action: "inspect",
        admissionCalls: 0,
        executesShell: false,
        executesTarget: false,
        callsEvaluator: false,
        copiedCommandsAreData: true,
        createsBillableRun: false
      });
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stdout).not.toContain("poison-hosted-token-must-not-be-used");
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints human inspect text that treats command fragments as data", async () => {
    const result = await runSourceCli(
      ["investigation", "inspect", "examples/investigations/response-only.json"],
      { cwd: projectRoot, env: poisonEnv() }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("read-only");
    expect(result.stdout).toContain("copied_commands_are_data: yes");
    expect(result.stdout).toContain("executes_target: no");
    expect(result.stdout).toContain("executes_shell: no");
    expect(result.stdout).toContain("admission_calls: 0");
    expect(result.stdout).toMatch(/command_fragment: augmentworks test --investigation/);
    expect(result.stdout).toContain("not ground truth");
  });

  it("rewrites snake_case investigation keys", async () => {
    const loaded = await loadInvestigationFile(
      resolve(projectRoot, "test/fixtures/investigations/snake-case.json")
    );
    expect(loaded.document.runId).toBe("run_snake_faq");
    expect(loaded.document.identities.suiteId).toBe("customer.faq.non_commerce");
  });

  it("rejects stale schema, billable observation, credentials, and share links", async () => {
    await expect(
      loadInvestigationFile(resolve(projectRoot, "test/fixtures/investigations/stale-schema.json"))
    ).rejects.toMatchObject({ code: "INVESTIGATION_UNSUPPORTED_SCHEMA" });
    await expect(
      loadInvestigationFile(resolve(projectRoot, "test/fixtures/investigations/creates-billable.json"))
    ).rejects.toMatchObject({ code: "CREATES_BILLABLE_RUN" });
    await expect(
      loadInvestigationFile(resolve(projectRoot, "test/fixtures/investigations/credentials.json"))
    ).rejects.toMatchObject({ code: "INVESTIGATION_CREDENTIAL_FORBIDDEN" });
    await expect(
      loadInvestigationFile(resolve(projectRoot, "test/fixtures/investigations/share-link.json"))
    ).rejects.toMatchObject({ code: "INVESTIGATION_PUBLICATION_FORBIDDEN" });
  });

  it("returns machine-readable JSON failures on stdout", async () => {
    const result = await runSourceCli(
      ["investigation", "inspect", "test/fixtures/investigations/stale-schema.json", "--json"],
      { cwd: projectRoot }
    );
    expect(result.exitCode).toBe(EXIT.CONFIG);
    const payload = JSON.parse(result.stdout) as { ok: boolean; code: string; admissionCalls: number };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("INVESTIGATION_UNSUPPORTED_SCHEMA");
    expect(payload.admissionCalls).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("does not treat failing chatbot output as the expected condition", () => {
    const yaml = regressionDraftYaml(
      parseInvestigationValue(
        JSON.parse(
          `{
            "schemaVersion": "aw-investigation-export/1",
            "workspaceId": "11111111-1111-4111-8111-111111111111",
            "runId": "run_orig_faq_status",
            "evaluationId": "eval_orig_faq_status",
            "evaluationRevision": 1,
            "attemptId": "attempt_orig_faq_status",
            "criterionId": "faq.status-page.required",
            "verdict": "fail",
            "reproductionKind": "response_only",
            "fullyReproducible": true,
            "createsBillableRun": false,
            "identities": {
              "suiteId": "customer.faq.non_commerce",
              "suiteRevisionId": "rev_pinned_faq_1",
              "suiteContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "caseId": "faq.status-page"
            },
            "evidence": {
              "expected": { "facts": ["The status page is https://status.example.test"] },
              "actual": { "text": "You can check our marketing site for updates." }
            },
            "prerequisites": {}
          }`
        )
      )
    );
    expect(yaml).toContain("The status page is https://status.example.test");
    expect(yaml).not.toContain("You can check our marketing site for updates.");
    expect(yaml).toContain("schema_version: aw-suite/1");
    expect(yaml).toContain("not a local deterministic packet");
  });

  it("refuses a regression draft without a reviewed expected condition", async () => {
    await expect(
      async () =>
        regressionDraftYaml(
          await loadInvestigationFile(
            resolve(projectRoot, "test/fixtures/investigations/missing-expected.json")
          ).then((loaded) => loaded.document)
        )
    ).rejects.toMatchObject({ code: "REGRESSION_EXPECTED_UNREVIEWED" });
  });

  it("qualifies response-only overclaim and blocks missing stateful mappings", () => {
    const overclaim = parseInvestigationValue({
      schemaVersion: "aw-investigation-export/1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      runId: "run_overclaim",
      evaluationId: "eval_overclaim",
      evaluationRevision: 1,
      attemptId: "attempt_overclaim",
      criterionId: "faq.status-page.required",
      verdict: "fail",
      reproductionKind: "response_only",
      fullyReproducible: true,
      createsBillableRun: false,
      identities: {
        suiteId: "customer.faq.non_commerce",
        suiteRevisionId: "rev_pinned_faq_1",
        suiteContentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        caseId: "faq.status-page"
      },
      evidence: { expected: { facts: ["The status page is https://status.example.test"] } },
      prerequisites: { mapping: { prepare: true, observe: true, cleanup: true, session: true } }
    });
    const qualified = evaluateInvestigationPrerequisites(overclaim, resolvedFor());
    expect(qualified.readyForPaidExecution).toBe(true);
    expect(qualified.findings.some((finding) => finding.code === "RESPONSE_ONLY_OVERCLAIM")).toBe(true);

    const stateful = parseInvestigationValue(
      JSON.parse(
        `{
          "schemaVersion": "aw-investigation-export/1",
          "workspaceId": "11111111-1111-4111-8111-111111111111",
          "runId": "run_state",
          "evaluationId": "eval_state",
          "evaluationRevision": 1,
          "attemptId": "attempt_state",
          "criterionId": "refund.limit.required",
          "verdict": "fail",
          "reproductionKind": "stateful",
          "fullyReproducible": true,
          "createsBillableRun": false,
          "identities": {
            "suiteId": "customer.refund.limit",
            "suiteRevisionId": "rev_pinned_refund_1",
            "suiteContentHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "caseId": "refund.limit-order-remains-paid"
          },
          "evidence": { "expected": { "facts": ["policy.maximum_refund is $50"] } },
          "prerequisites": { "mapping": { "prepare": true, "observe": true, "cleanup": true, "session": true } }
        }`
      )
    );
    const blocked = evaluateInvestigationPrerequisites(stateful, resolvedFor());
    expect(blocked.readyForPaidExecution).toBe(false);
    expect(blocked.blocking.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["MISSING_PREPARE", "MISSING_OBSERVE", "MISSING_CLEANUP", "MISSING_SESSION"])
    );
  });

  it("exports a hosted aw-suite/1 draft and inspects it without admission", async () => {
    const directory = await tempDir("aw-inv-export-");
    temporaryDirectories.push(directory);
    await copyInvestigation("response-only.json", directory);
    const out = resolve(directory, "regression.yaml");
    const result = await runSourceCli(
      ["investigation", "export-regression", "response-only.json", "--out", "regression.yaml", "--json"],
      { cwd: directory, env: poisonEnv() }
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      admissionCalls: number;
      actualIsNotGroundTruth: boolean;
      expectedSource: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.admissionCalls).toBe(0);
    expect(payload.actualIsNotGroundTruth).toBe(true);
    expect(payload.expectedSource).toBe("original_expected_condition");
    const yaml = await readFile(out, "utf8");
    expect(yaml).toContain("schema_version: aw-suite/1");
    expect(yaml).toContain("The status page is https://status.example.test");
    expect(yaml).not.toContain("You can check our marketing site for updates.");
  });

  it("does not execute a command fragment written as a local file drop", async () => {
    const directory = await tempDir("aw-inv-shell-");
    temporaryDirectories.push(directory);
    const marker = resolve(directory, "must-not-be-created");
    const artifact = {
      schemaVersion: "aw-investigation-export/1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      runId: "run_shell",
      evaluationId: "eval_shell",
      evaluationRevision: 1,
      attemptId: "attempt_shell",
      criterionId: "faq.status-page.required",
      verdict: "fail",
      reproductionKind: "response_only",
      fullyReproducible: true,
      createsBillableRun: false,
      identities: {
        suiteId: "customer.faq.non_commerce",
        suiteRevisionId: "rev_pinned_faq_1",
        suiteContentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        caseId: "faq.status-page"
      },
      evidence: { expected: { facts: ["The status page is https://status.example.test"] } },
      prerequisites: {
        commandFragment: {
          argv: ["touch", marker],
          text: `touch ${marker}`
        }
      }
    };
    await writeFile(resolve(directory, "investigation.json"), `${JSON.stringify(artifact)}\n`, "utf8");
    const result = await runSourceCli(["investigation", "inspect", "investigation.json", "--json"], {
      cwd: directory,
      env: poisonEnv()
    });
    expect(result.exitCode).toBe(0);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
