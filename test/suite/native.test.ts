import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NativeSuiteSourceSchema, nativeSuiteContentHash, nativeSuiteSource } from "../../src/suite/native.js";
import { loadCustomerSuiteFile } from "../../src/suite/load.js";
import { suiteCreateFields } from "../../src/suite/admit.js";
import { normalizeSuiteIdentity, SuiteCreateResponseSchema } from "../../src/suite/protocol.js";
import { sha256 } from "../../src/util/canonical.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function repoFile(...segments: string[]): string {
  return resolve(projectRoot, ...segments);
}

describe("real hosted customer-suite producer contract", () => {
  it("pins the byte-for-byte upstream schema and fixtures and accepts producer sources", async () => {
    const lock = JSON.parse(await readFile(repoFile("contracts/aw-suite-v1.lock.json"), "utf8"));
    const schema = await readFile(repoFile("contracts/aw-feature-v1.producer.schema.json"));
    const fixtures = await readFile(repoFile("contracts/aw-feature-v1.producer.fixtures.json"));
    expect(sha256(schema)).toBe(lock.source.schemaChecksum);
    expect(sha256(fixtures)).toBe(lock.source.fixturesChecksum);
    for (const key of ["suite_14_day_policy", "suite_multi_turn_session"]) {
      expect(NativeSuiteSourceSchema.safeParse(JSON.parse(fixtures.toString()).fixtures[key].document).success).toBe(true);
    }
  });

  it("maps the actual website owned-fixture file to native IDs, references, and required criteria", async () => {
    const loaded = await loadCustomerSuiteFile(repoFile("test/fixtures/native-suite-producer/owned-widget.suite.yaml"));
    const source = nativeSuiteSource(loaded);
    expect(source).toMatchObject({ schemaVersion: "aw-customer-suite/1", documentKind: "customer_suite_source", syntheticOnly: true, suiteId: "owned-widget.fixture.pilot" });
    expect(source).not.toHaveProperty("title");
    expect(NativeSuiteSourceSchema.safeParse(source).success).toBe(true);
    // Golden independently sealed/materialized/compiled by augmentworks@7ee82d2f:
    // source + hybrid packet schemas passed, 3 executions/commands/judge jobs, no exclusions.
    expect(nativeSuiteContentHash(source)).toBe("bc5a3edd26a26879a2d9684768fcb3930bbb71604b5005cfab560863e1654377");
    expect(nativeSuiteContentHash(source)).not.toBe(loaded.contentHash);
    const fields = suiteCreateFields(loaded, { suiteId: loaded.document.suiteId, revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", contentHash: nativeSuiteContentHash(source) });
    expect(fields.packet_bindings).toEqual([{ key: "aw-customer-suite", version: "1.0.0" }]);
    expect(fields.selected_scenario_ids).toEqual(["aw-customer-suite/1.0.0/owned-widget.free-plan", "aw-customer-suite/1.0.0/owned-widget.starter-price", "aw-customer-suite/1.0.0/owned-widget.kb-sync"]);
    expect(fields.suite_content_hash).toBe(nativeSuiteContentHash(source));
    const cases = source["cases"] as Array<Record<string, unknown>>;
    // The producer source allows empty descriptions, but its materialized
    // hybrid packet requires nonempty scenario descriptions at admission.
    expect(cases.map((item) => item["description"])).toEqual(loaded.document.cases.map((item) => item.name ?? item.caseId));
    expect(cases.every((item) => typeof item["description"] === "string" && item["description"].trim().length > 0)).toBe(true);
    expect(cases.flatMap((item) => item["criteria"] as unknown[])).toHaveLength(6);
    expect(JSON.stringify(source)).toContain("deliberate negative control");
    expect(JSON.stringify(source)).toContain("$1,188");
  });

  it("rejects unsupported observations instead of discarding their assertions", async () => {
    const loaded = await loadCustomerSuiteFile(repoFile("examples/customer-suites/returns-14-day.yaml"));
    expect(() => nativeSuiteSource(loaded)).toThrowError(/does not execute deterministic observations/);
  });

  it("rejects authoring values outside native limits without truncating them", async () => {
    const loaded = await loadCustomerSuiteFile(repoFile("examples/customer-suites/faq-non-commerce.yaml"));
    expect(() => nativeSuiteSource({ ...loaded, document: { ...loaded.document, description: "x".repeat(2001) } })).toThrowError(/exceeds the hosted customer-suite contract/);
  });

  it("keeps descriptions nonempty when optional authoring text is omitted or whitespace", async () => {
    const loaded = await loadCustomerSuiteFile(repoFile("examples/customer-suites/faq-non-commerce.yaml"));
    const document = { ...loaded.document, description: "  ", cases: loaded.document.cases.map((item) => ({ ...item, name: "  " })) };
    const source = nativeSuiteSource({ ...loaded, document });
    expect(source["description"]).toBe(loaded.document.title);
    expect((source["cases"] as Array<Record<string, unknown>>).map((item) => item["description"])).toEqual(loaded.document.cases.map((item) => item.caseId));
  });

  it("consumes the real native response identity and retains old aliases for explicit old producers", () => {
    const native = SuiteCreateResponseSchema.parse(normalizeSuiteIdentity({ schemaVersion: "aw-customer-suite/1", suiteId: "demo", suiteRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", canonicalHash: "a".repeat(64) }));
    expect(native.revisionId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(native.contentHash).toBe("a".repeat(64));
    expect(SuiteCreateResponseSchema.parse(normalizeSuiteIdentity({ suite_id: "demo", revision_id: "legacy", content_hash: "b".repeat(64) })).revisionId).toBe("legacy");
  });
});
