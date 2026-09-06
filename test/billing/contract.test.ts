import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AW_BILLING_CONTRACT } from "../../src/billing/generated/contract.js";
import { EXIT, exitCodeFor, AwError } from "../../src/errors.js";
import { formatUsageHuman } from "../../src/billing/format.js";
import {
  parseBillingCapabilitiesResponse,
  parseBillingUsageResponse
} from "../../src/billing/validate.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function readJson(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(root, relative), "utf8"));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("vendored aw-billing/1 contract", () => {
  it("matches the locked main-repository SHA-256 digests", async () => {
    const schema = await readFile(resolve(root, "contracts/aw-billing-v1.schema.json"));
    const fixtures = await readFile(resolve(root, "contracts/aw-billing-v1.fixtures.json"));
    expect(sha256(schema)).toBe(AW_BILLING_CONTRACT.files["contracts/aw-billing-v1.schema.json"]);
    expect(sha256(fixtures)).toBe(AW_BILLING_CONTRACT.files["contracts/aw-billing-v1.fixtures.json"]);
    expect(AW_BILLING_CONTRACT.files["contracts/aw-billing-v1.schema.json"]).toBe(
      "2ea0236b9fa1bac4a7e50dbd5d016c9b9b32a4b7b31298cfc53104308bdace8d"
    );
    expect(AW_BILLING_CONTRACT.files["contracts/aw-billing-v1.fixtures.json"]).toBe(
      "6ef4e83f2dfa5f5ffc22dd97ec35c106ef7d012d7433e107cf551841b0eb7556"
    );
    expect(AW_BILLING_CONTRACT.source.commit).toBe("e037958ba3c9f38a436b6065cddb5fb8ee3943fa");
  });

  it("reuses the 200 granted / 10 reserved-then-consumed fixture as 190 available", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(document.fixtures["partially_consumed_trial"]?.response);
    expect(usage.availableUnits).toBe(190);
    expect(usage.reservedUnits).toBe(0);
    expect(usage.consumedUnits).toBe(10);
    expect(usage.availableUnits).not.toBe(180);
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).toContain("Available credits: 190");
    expect(human).toContain("Reserved credits: 0");
    expect(human).toContain("Consumed credits: 10");
    expect(human).not.toContain("180");
    expect(human).toContain("server snapshot");
    expect(human).not.toMatch(/expires 20\d{2}-09-07/u);
  });

  it("displays reserved and consumed fields with their contract meanings", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(document.fixtures["active_reservation"]?.response);
    expect(usage.availableUnits).toBe(190);
    expect(usage.reservedUnits).toBe(7);
    expect(usage.consumedUnits).toBe(3);
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).toContain("held for in-progress scenario attempts");
    expect(human).toContain("first durable target-command lease");
    expect(human).toContain("Trial/promotional");
    expect(human).toContain("no expiry");
  });

  it("tolerates unknown capabilities and a later non-null subscription object", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(
      document.fixtures["unknown_capability_ignored"]?.response
    );
    expect(usage.availableUnits).toBe(200);
    expect(usage.subscription).toEqual({
      status: "future_stage",
      unsupportedDetail: "ignore"
    });
    expect(usage.capabilities).toContain("future_unreleased_v9");
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).not.toContain("future_stage");
    expect(human).toContain("does not grant credits");
  });

  it("rejects the malformed producer fixture", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    expect(() => parseBillingUsageResponse(document.fixtures["malformed_data"]?.response)).toThrow(
      expect.objectContaining({ code: "INVALID_CLOUD_RESPONSE" })
    );
  });

  it("accepts the absent reserved-capability document", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const capabilities = parseBillingCapabilitiesResponse(
      document.fixtures["absent_capability"]?.response
    );
    expect(capabilities.capabilities).toEqual(["usage_v1"]);
    expect(capabilities.capabilities).not.toContain("quote_v1");
  });

  it("fails closed on an unknown access state", () => {
    const document = {
      schemaVersion: "aw-billing/1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      billingAccountId: "22222222-2222-4222-8222-222222222222",
      asOf: "2026-09-06T17:00:00.000Z",
      ledgerRevision: 1,
      accessState: "time_travel",
      availableUnits: 200,
      reservedUnits: 0,
      consumedUnits: 0,
      grantBalances: [],
      subscription: null,
      billingPageUrl: "https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111",
      capabilities: ["usage_v1"]
    };
    expect(() => parseBillingUsageResponse(document)).toThrow(
      expect.objectContaining({ code: "BILLING_UNSUPPORTED_STATE", category: "billing" })
    );
  });

  it("keeps closed-workspace usage readable without inventing spendable access", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(
      document.fixtures["closed_workspace_readable"]?.response
    );
    expect(usage.accessState).toBe("closed");
    expect(usage.availableUnits).toBe(197);
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).toContain("Workspace access: closed.");
    expect(human).toContain("New hosted tests are rejected");
    expect(human).toContain("Available credits: 197");
  });

  it("assigns unused exit code 13 to billing errors", () => {
    expect(EXIT.BILLING).toBe(13);
    expect(
      exitCodeFor(
        new AwError({
          code: "USAGE_UNSUPPORTED",
          category: "billing",
          message: "unsupported"
        })
      )
    ).toBe(13);
  });
});
