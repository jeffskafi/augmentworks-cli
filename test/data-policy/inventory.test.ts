import { describe, expect, it } from "vitest";

import { CONTENT_EGRESS_INVENTORY } from "../../src/data-policy/index.js";

describe("content egress inventory", () => {
  it("lists owned callsites including pending and retry paths", () => {
    const ids = CONTENT_EGRESS_INVENTORY.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "mapping-preview",
        "normalize",
        "journal-success",
        "relay-runner",
        "cloud-client",
        "local-artifacts",
        "assessment-bundle",
        "quote-request",
        "suite-load",
        "suite-native",
        "commands-test",
        "http-connector",
        "local-content-cleanup"
      ])
    );
    expect(CONTENT_EGRESS_INVENTORY.some((item) => item.pendingRetry)).toBe(true);
    expect(CONTENT_EGRESS_INVENTORY.filter((item) => item.owner === "R05").length).toBeGreaterThan(0);
    expect(CONTENT_EGRESS_INVENTORY.filter((item) => item.owner === "R06").length).toBeGreaterThan(0);
  });
});
