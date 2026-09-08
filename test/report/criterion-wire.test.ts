import { describe, expect, it } from "vitest";

import {
  parseCriterionWireDetail,
  parseCriterionWirePage,
  criterionWireVerdictDiagnostics
} from "../../src/report/criterion-wire.js";
import { CriterionIndexSchema } from "../../src/report/schema.js";
import { fixtureResponse } from "./fixtures.js";
import {
  PRODUCER_ATTEMPT_ID,
  PRODUCER_COMMIT,
  PRODUCER_CRITERION_ID,
  PRODUCER_RUN_ID,
  PRODUCER_WORKSPACE_ID,
  producerFixtureResponse
} from "./producer-fixtures.js";

const BINDING = {
  evaluationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  evaluationRevision: 1,
  snapshotHash: "3e4434b5147042a0a249b29cf7c12505c5dc78ab94ecaa789931f5dfea9c0f32",
  executionResultHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  assessmentPlanHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  referenceBundleHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  graderConfigHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
} as const;

const INDEX_URL = new URL(
  `http://127.0.0.1/v1/runs/${PRODUCER_RUN_ID}/evaluations/${BINDING.evaluationId}/attempts/${PRODUCER_ATTEMPT_ID}/criteria`
);

function context(overrides: { workspaceId?: string } = {}) {
  return {
    runId: PRODUCER_RUN_ID,
    attemptId: PRODUCER_ATTEMPT_ID,
    binding: BINDING,
    indexUrl: INDEX_URL,
    ...(overrides.workspaceId === undefined ? { workspaceId: PRODUCER_WORKSPACE_ID } : { workspaceId: overrides.workspaceId })
  };
}

describe("producer criterion-wire adapter", () => {
  it("records the audited main producer commit, not an invented parallel schema", () => {
    expect(PRODUCER_COMMIT).toBe("8068a90f557f7b88e3355212f2b5459cfc03fe3e");
    const invented = CriterionIndexSchema.safeParse(producerFixtureResponse("producer_index_one_page_pass").body);
    expect(invented.success).toBe(false);
    if (!invented.success) {
      const paths = invented.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(expect.arrayContaining(["runId", "criteria", "page"]));
    }
  });

  it("converts a producer one-page index using request runId and nextCursor/totalInAttempt", () => {
    const parsed = parseCriterionWirePage(producerFixtureResponse("producer_index_one_page_pass").body, context());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== "index") throw new Error("expected producer index");
    expect(parsed.index.source).toBe("producer");
    expect(parsed.index.runId).toBe(PRODUCER_RUN_ID);
    expect(parsed.index.criteria).toHaveLength(1);
    expect(parsed.index.criteria[0]?.criterionId).toBe(PRODUCER_CRITERION_ID);
    expect(parsed.index.criteria[0]?.required).toBe(true);
    expect(parsed.index.criteria[0]?.verdict).toBe("pass");
    expect(parsed.index.criteria[0]?.evidence).toBeUndefined();
    expect(parsed.index.criteria[0]?.detailUrl).toBe(`${INDEX_URL.href}/${PRODUCER_CRITERION_ID}`);
    expect(parsed.index.page.hasMore).toBe(false);
    expect(parsed.index.page.nextCursor).toBeNull();
    expect(parsed.index.page.totalCriteria).toBe(1);
    expect(parsed.index.totalInAttempt).toBe(1);
    expect(parsed.index.limit).toBe(8);
  });

  it("converts nested document/inspection details without treating inspection as evidence", () => {
    const parsed = parseCriterionWireDetail(producerFixtureResponse("producer_detail_pass").body, context());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected producer detail");
    expect(parsed.detail.runId).toBe(PRODUCER_RUN_ID);
    expect(parsed.detail.required).toBe(true);
    expect(parsed.detail.verdict).toBe("pass");
    expect(parsed.detail.evidence.availability).toBe("available");
    expect(parsed.detail.evidence.text).toContain("30 days");
    expect(parsed.detail.evidence.truncated).toBe(false);
    expect(JSON.stringify(parsed.detail.evidence)).not.toContain("not_claimed");
    expect(
      (parsed.detail as { document?: { schemaVersion?: string; criterionId?: string } }).document
        ?.schemaVersion
    ).toBe("aw-criterion-detail/1");
    expect(
      (parsed.detail as { document?: { criterionId?: string } }).document?.criterionId
    ).toBe(PRODUCER_CRITERION_ID);
  });

  it("maps producer requirement/verdict/evidence on an embedded index item", () => {
    const parsed = parseCriterionWirePage(producerFixtureResponse("producer_index_embedded_pass").body, context());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== "index") throw new Error("expected producer index");
    expect(parsed.index.criteria[0]?.required).toBe(true);
    expect(parsed.index.criteria[0]?.verdict).toBe("pass");
    expect(parsed.index.criteria[0]?.evidence?.availability).toBe("available");
    expect(parsed.index.criteria[0]?.evidence?.text).toContain("30 days");
  });

  it("follows producer nextCursor and totalInAttempt across pages", () => {
    const first = parseCriterionWirePage(producerFixtureResponse("producer_index_page_1").body, context());
    const second = parseCriterionWirePage(producerFixtureResponse("producer_index_page_2").body, context());
    expect(first.ok && first.kind === "index").toBe(true);
    expect(second.ok && second.kind === "index").toBe(true);
    if (!first.ok || first.kind !== "index" || !second.ok || second.kind !== "index") return;
    expect(first.index.page.hasMore).toBe(true);
    expect(first.index.page.nextCursor).toBe("crit-2");
    expect(first.index.totalInAttempt).toBe(2);
    expect(second.index.page.hasMore).toBe(false);
    expect(second.index.page.nextCursor).toBeNull();
    expect(second.index.criteria[0]?.required).toBe(false);
    expect(second.index.criteria[0]?.criterionId).toBe("dfdfdfdf-dfdf-4dfd-8dfd-dfdfdfdfdfdf");
  });

  it("retains null, inconclusive, and not_applicable instead of inferring pass", () => {
    const nullVerdict = parseCriterionWireDetail(producerFixtureResponse("producer_detail_null_verdict").body, context());
    const inconclusive = parseCriterionWireDetail(producerFixtureResponse("producer_detail_inconclusive").body, context());
    const notApplicable = parseCriterionWireDetail(
      producerFixtureResponse("producer_detail_not_applicable").body,
      context()
    );
    expect(nullVerdict.ok).toBe(true);
    expect(inconclusive.ok).toBe(true);
    expect(notApplicable.ok).toBe(true);
    if (!nullVerdict.ok || !inconclusive.ok || !notApplicable.ok) return;
    expect(nullVerdict.detail.verdict).toBe("not_judged");
    expect(inconclusive.detail.verdict).toBe("uncertain");
    expect(notApplicable.detail.verdict).toBe("not_judged");
    expect((nullVerdict.detail as { wireVerdict?: unknown }).wireVerdict).toBeNull();
    expect((inconclusive.detail as { wireVerdict?: unknown }).wireVerdict).toBe("inconclusive");
    expect((notApplicable.detail as { wireVerdict?: unknown }).wireVerdict).toBe("not_applicable");
    expect(criterionWireVerdictDiagnostics([nullVerdict.detail, inconclusive.detail, notApplicable.detail])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CRITERION_VERDICT_INCOMPLETE" }),
        expect.objectContaining({ code: "CRITERION_VERDICT_INCOMPLETE" }),
        expect.objectContaining({ code: "CRITERION_VERDICT_INCOMPLETE" })
      ])
    );
  });

  it("keeps missing, purged, and truncated evidence exactly and never invents available text", () => {
    const missing = parseCriterionWireDetail(producerFixtureResponse("producer_detail_missing_evidence").body, context());
    const purged = parseCriterionWireDetail(producerFixtureResponse("producer_detail_purged_evidence").body, context());
    const truncated = parseCriterionWireDetail(
      producerFixtureResponse("producer_detail_truncated_evidence").body,
      context()
    );
    expect(missing.ok && purged.ok && truncated.ok).toBe(true);
    if (!missing.ok || !purged.ok || !truncated.ok) return;
    expect(missing.detail.verdict).toBe("pass");
    expect(missing.detail.evidence).toEqual({
      availability: "missing",
      text: null,
      sha256: null,
      truncated: false
    });
    expect(purged.detail.evidence.availability).toBe("purged");
    expect(purged.detail.evidence.text).toBeNull();
    expect(truncated.detail.evidence.truncated).toBe(true);
    expect(truncated.detail.evidence.availability).toBe("available");
  });

  it("rejects wrong revision, hash, and workspace identities that are actually present", () => {
    const revision = parseCriterionWirePage(producerFixtureResponse("producer_index_wrong_revision").body, context());
    const hash = parseCriterionWirePage(producerFixtureResponse("producer_index_wrong_hash").body, context());
    const workspace = parseCriterionWirePage(producerFixtureResponse("producer_index_wrong_workspace").body, context());
    expect(revision.ok).toBe(false);
    expect(hash.ok).toBe(false);
    expect(workspace.ok).toBe(false);
    if (revision.ok || hash.ok || workspace.ok) return;
    expect(revision.diagnostic.code).toBe("CRITERION_BINDING_MISMATCH");
    expect(hash.diagnostic.code).toBe("CRITERION_BINDING_MISMATCH");
    expect(workspace.diagnostic.code).toBe("CRITERION_WORKSPACE_MISMATCH");
    expect(revision.fatal).toBe(true);
  });

  it("accepts an omitted workspaceId when the producer does not name one", () => {
    const parsed = parseCriterionWirePage(producerFixtureResponse("producer_index_embedded_pass").body, {
      ...context(),
      workspaceId: PRODUCER_WORKSPACE_ID
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== "index") return;
    expect(parsed.index.workspaceId).toBeUndefined();
  });

  it("does not convert an unsupported verdict into pass", () => {
    const parsed = parseCriterionWireDetail(
      producerFixtureResponse("producer_detail_unsupported_verdict").body,
      context()
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.fatal).toBe(false);
    expect(parsed.diagnostic.code).toBe("CRITERION_VERDICT_UNSUPPORTED");
  });

  it("rejects a producer page that claims a billable run", () => {
    const parsed = parseCriterionWirePage(producerFixtureResponse("producer_index_creates_billable").body, context());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostic.code).toBe("CRITERION_BILLABLE_CLAIM");
  });

  it("still parses legacy AW-QA-1 invented index and detail fixtures", () => {
    const index = parseCriterionWirePage(fixtureResponse("criterion_index_r01_pass", "http://127.0.0.1").body, context());
    const detail = parseCriterionWireDetail(
      fixtureResponse("criterion_detail_r01_pass", "http://127.0.0.1").body,
      context()
    );
    expect(index.ok && index.kind === "index").toBe(true);
    expect(detail.ok).toBe(true);
    if (!index.ok || index.kind !== "index" || !detail.ok) return;
    expect(index.index.source).toBe("legacy");
    expect(index.index.criteria[0]?.verdict).toBe("pass");
    expect(detail.detail.evidence.availability).toBe("available");
  });
});
