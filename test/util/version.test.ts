import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CLI_VERSION, CONFIG_VERSION, RELAY_PROTOCOL_VERSION, RELAY_PROTOCOL_VERSION_V2 } from "../../src/version.js";

interface PackageManifest {
  version?: unknown;
}

describe("version contracts", () => {
  it("keeps the evidence-facing CLI version synchronized with package.json", async () => {
    const manifestUrl = new URL("../../package.json", import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as PackageManifest;

    expect(typeof manifest.version).toBe("string");
    expect(CLI_VERSION).toBe(manifest.version);
  });

  it("uses stable, explicit protocol version identifiers", () => {
    expect(CONFIG_VERSION).toBe(1);
    expect(RELAY_PROTOCOL_VERSION).toMatch(/^aw-relay\/\d+\.\d+$/);
    expect(RELAY_PROTOCOL_VERSION_V2).toBe("aw-relay/0.2");
  });
});
