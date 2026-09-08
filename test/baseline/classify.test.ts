import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyReleasePolicy } from "../../src/baseline/classify.js";
import { normalizeReleasePolicyDocument } from "../../src/baseline/protocol.js";
import { EXIT } from "../../src/errors.js";

const fixturesPath = resolve(fileURLToPath(new URL("../../contracts/aw-release-policy-v1.fixtures.json", import.meta.url)));
const fixtures = JSON.parse(await readFile(fixturesPath, "utf8")) as {
  identities: { candidateRunId: string; baselineId: string };
  fixtures: Record<string, { response: unknown }>;
};

const expected = {
  candidateRunId: fixtures.identities.candidateRunId,
  baselineId: fixtures.identities.baselineId
};

function classify(name: string) {
  const response = fixtures.fixtures[name]?.response;
  const document = normalizeReleasePolicyDocument(response, expected);
  return { document, classification: classifyReleasePolicy(document) };
}

describe("release-policy classifier", () => {
  it("pins the consumer fixture checksum in the lock file", async () => {
    const lock = JSON.parse(
      await readFile(resolve(fileURLToPath(new URL("../../contracts/aw-release-policy-v1.lock.json", import.meta.url))), "utf8")
    ) as { cli: { consumerFixturesChecksum: string }; source: { schemaChecksum: string } };
    const bytes = await readFile(fixturesPath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(lock.cli.consumerFixturesChecksum);
    expect(lock.source.schemaChecksum).toBe(
      "4f026740a349c736e98af95599736a92cb81246bea3a1673b26e7fa94cadc870"
    );
  });
  it("blocks a new required regression when aggregate pass rates match", () => {
    const { document, classification } = classify("blocked_equal_pass_rate");
    expect(document.decision).toBe("block");
    expect(document.groups.new_required_regressions).toHaveLength(1);
    expect(document.groups.fixes).toHaveLength(1);
    expect(classification.assessment).toBe("blocked");
    expect(classification.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(classification.reasonCodes).toContain("new_required_regression");
    expect(classification.observation).toBe("succeeded");
  });

  it("passes only an explicit compatible complete policy pass", () => {
    const { document, classification } = classify("pass_compatible");
    expect(document.decision).toBe("pass");
    expect(document.candidateEvaluationRevision).toBe(5);
    expect(document.baseline.evaluationRevision).toBe(3);
    expect(document.baseline.promotionRevision).toBe(2);
    expect(document.policyVersion).toBe("aw-release-policy/1");
    expect(classification.assessment).toBe("passed");
    expect(classification.exitCode).toBe(EXIT.OK);
  });

  it("does not pass pending, absent, evaluator error, incompatible scope, or missing coverage", () => {
    expect(classify("incomplete_pending").classification).toMatchObject({
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE
    });
    expect(classify("incomplete_absent").classification).toMatchObject({
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE
    });
    expect(classify("evaluator_error").classification).toMatchObject({
      assessment: "evaluator_error",
      exitCode: EXIT.EVALUATION_ERROR
    });
    expect(classify("incompatible_scope").classification).toMatchObject({
      assessment: "incompatible",
      exitCode: EXIT.CONFIG
    });
    expect(classify("missing_required_coverage").classification).toMatchObject({
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE
    });
  });

  it("does not default an unknown server decision to pass", () => {
    const { classification } = classify("unknown_decision");
    expect(classification.assessment).toBe("unknown");
    expect(classification.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(classification.reasonCodes).toContain("unsupported_decision");
  });

  it("treats createsBillableRun as a protocol failure, not a pass", () => {
    const { classification } = classify("creates_billable_run");
    expect(classification.exitCode).toBe(EXIT.RELAY);
    expect(classification.reasonCodes).toContain("creates_billable_run");
  });

  it("normalizes snake_case policy documents", () => {
    const document = normalizeReleasePolicyDocument(
      {
        schema_version: "aw-release-policy/1",
        package_version: "aw-feature/1",
        policy_version: "aw-release-policy/1",
        creates_billable_run: false,
        candidate_run_id: expected.candidateRunId,
        candidate_evaluation_revision: 8,
        selected_baseline_id: expected.baselineId,
        selected_baseline: {
          baseline_id: expected.baselineId,
          evaluation_revision: 1,
          snapshot_hash: "abababababababababababababababababababababababababababababababab",
          promotion_revision: 4
        },
        decision: "pass",
        comparability: "compatible",
        coverage_change: "none",
        evaluation_status: "complete"
      },
      expected
    );
    expect(document.candidateEvaluationRevision).toBe(8);
    expect(document.baseline.promotionRevision).toBe(4);
    expect(classifyReleasePolicy(document).exitCode).toBe(EXIT.OK);
  });

  it("rejects a comparison bound to a different candidate run", () => {
    expect(() =>
      normalizeReleasePolicyDocument(fixtures.fixtures["pass_compatible"]?.response, {
        candidateRunId: "00000000-0000-4000-8000-000000000000",
        baselineId: expected.baselineId
      })
    ).toThrow(/different candidate run/);
  });
});
