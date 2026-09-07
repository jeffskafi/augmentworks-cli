import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AW_RUN_REPORT_CONTRACT } from "../../src/report/contract.js";
import { RunReportSchema } from "../../src/report/schema.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function canonicalLfBytes(buffer: Buffer): Buffer {
  return Buffer.from(buffer.toString("utf8").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n"), "utf8");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(canonicalLfBytes(buffer)).digest("hex");
}

describe("vendored aw-run-report/1 contract", () => {
  it("matches the locked AW-QA-1 compatibility SHA-256 digests", async () => {
    const lock = JSON.parse(
      await readFile(resolve(root, "contracts/aw-run-report-v1.lock.json"), "utf8")
    ) as {
      files: Record<string, string>;
      source: { producerIssue: string; contract: string };
    };
    const schema = await readFile(resolve(root, "contracts/aw-run-report-v1.schema.json"));
    const fixtures = await readFile(resolve(root, "contracts/aw-run-report-v1.fixtures.json"));
    expect(sha256(schema)).toBe(lock.files["contracts/aw-run-report-v1.schema.json"]);
    expect(sha256(fixtures)).toBe(lock.files["contracts/aw-run-report-v1.fixtures.json"]);
    expect(lock.files["contracts/aw-run-report-v1.schema.json"]).toBe(
      "7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff"
    );
    expect(lock.files["contracts/aw-run-report-v1.fixtures.json"]).toBe(
      "febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806"
    );
    expect(lock.source.producerIssue).toBe("AUG-55");
    expect(lock.source.contract).toBe("AW-QA-1");
    expect(AW_RUN_REPORT_CONTRACT.schemaVersion).toBe("aw-run-report/1");
    expect(AW_RUN_REPORT_CONTRACT.exportSchemaVersion).toBe("aw-run-report-export/1");
    expect(AW_RUN_REPORT_CONTRACT.paths.report).toBe("/v1/relay/runs/{runId}/report");
  });

  it("parses canonical passed and failed report pages without renaming wire fields", async () => {
    const document = JSON.parse(
      await readFile(resolve(root, "contracts/aw-run-report-v1.fixtures.json"), "utf8")
    ) as {
      fixtures: Record<string, { status: number; response: unknown }>;
    };
    for (const name of ["report_all_pass_one_page", "report_required_fail", "report_null_outcome"]) {
      const parsed = RunReportSchema.parse(document.fixtures[name]?.response);
      expect(parsed.schemaVersion).toBe("aw-run-report/1");
      expect(parsed.createsBillableRun).toBe(false);
      expect(parsed.attempts[0]).toHaveProperty("mappedResponse");
      expect(parsed.attempts[0]?.mappedResponse).toHaveProperty("text");
    }
    const failed = RunReportSchema.parse(document.fixtures["report_required_fail"]?.response);
    expect(failed.outcome).toBe("failed");
    expect(failed.attempts[0]?.mappedResponse.text).toContain("365 days");
  });
});
