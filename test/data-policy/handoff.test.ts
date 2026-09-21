import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HOSTED_REAL_DATA_RELEASE,
  R01_FIXTURES_SHA256,
  R01_SCHEMA_SHA256,
  R06_HANDOFF,
  R06_HANDOFF_SCHEMA_VERSION
} from "../../src/data-policy/index.js";

const fixturePath = resolve(fileURLToPath(new URL("../fixtures/data-policy/r06-handoff.json", import.meta.url)));

describe("R06 integration handoff", () => {
  it("documents exact hook signatures for AUG-188 in a shared fixture", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      schemaVersion: string;
      hostedRealDataRelease: string;
      r01SchemaSha256: string;
      r01FixturesSha256: string;
      hooks: Record<string, { signature: string }>;
    };
    expect(fixture.schemaVersion).toBe(R06_HANDOFF_SCHEMA_VERSION);
    expect(fixture.hostedRealDataRelease).toBe(HOSTED_REAL_DATA_RELEASE);
    expect(fixture.r01SchemaSha256).toBe(R01_SCHEMA_SHA256);
    expect(fixture.r01FixturesSha256).toBe(R01_FIXTURES_SHA256);
    expect(R06_HANDOFF.hooks.inspectOutbound.signature).toBe(fixture.hooks["inspectOutbound"]?.signature);
    expect(R06_HANDOFF.hooks.applyRedactionProfile.signature).toBe(
      fixture.hooks["applyRedactionProfile"]?.signature
    );
    expect(R06_HANDOFF.hooks.sealDataHandlingReceipt.signature).toBe(
      fixture.hooks["sealDataHandlingReceipt"]?.signature
    );
    expect(R06_HANDOFF.hooks.projectRelayResult.signature).toBe(fixture.hooks["projectRelayResult"]?.signature);
    expect(R06_HANDOFF.hooks.planLocalContentCleanup.signature).toBe(
      fixture.hooks["planLocalContentCleanup"]?.signature
    );
    expect(R06_HANDOFF.consumer).toBe("AUG-188");
    expect(R06_HANDOFF.hostedRealDataRelease).toBe("unavailable");
  });
});
