import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CLI_RELEASE,
  HOSTED_COMMAND_PIN,
  HOSTED_COMMANDS,
  LOCAL_COMMANDS,
  LOCAL_DISTRIBUTION,
  PUBLISHED_PACKAGE_VERSION,
  SOURCE_PACKAGE_VERSION,
  allowedDocumentedNpxPins,
  formatNpx
} from "../src/release.js";
import { CLI_VERSION, CONFIG_VERSION, RELAY_PROTOCOL_VERSION } from "../src/version.js";

const fixtureUrl = new URL("../schemas/v1/cli-release.json", import.meta.url);

describe("CLI release metadata", () => {
  it("keeps source version, protocol, and the checked-in website fixture synchronized", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as typeof CLI_RELEASE;

    expect(SOURCE_PACKAGE_VERSION).toBe(CLI_VERSION);
    expect(CLI_RELEASE.source_package_version).toBe(CLI_VERSION);
    expect(CLI_RELEASE.protocol_version).toBe(RELAY_PROTOCOL_VERSION);
    expect(CLI_RELEASE.config_version).toBe(CONFIG_VERSION);
    expect(CLI_RELEASE).toEqual(fixture);
  });

  it("pins hosted npx commands to the verified published package", () => {
    expect(CLI_RELEASE.published_package_verified).toBe(true);
    expect(HOSTED_COMMAND_PIN).toBe(PUBLISHED_PACKAGE_VERSION);
    expect(allowedDocumentedNpxPins()).toContain(HOSTED_COMMAND_PIN);
    expect(HOSTED_COMMANDS.login).toBe(formatNpx(HOSTED_COMMAND_PIN, ["login"]));
    expect(HOSTED_COMMANDS.test).toContain(`@augmentworks/cli@${HOSTED_COMMAND_PIN}`);
    expect(HOSTED_COMMANDS.test).toContain("support-refunds@0.1.0");
    expect(HOSTED_COMMANDS.test).not.toContain("--local");
  });

  it("does not advertise unpublished local npx pins", () => {
    if (LOCAL_DISTRIBUTION === "git") {
      expect(SOURCE_PACKAGE_VERSION).not.toBe(PUBLISHED_PACKAGE_VERSION);
      expect(allowedDocumentedNpxPins()).not.toContain(SOURCE_PACKAGE_VERSION);
      expect(LOCAL_COMMANDS.test).toBe(
        [
          "node dist/index.js test \\",
          "  --local \\",
          "  -c augmentworks.yaml \\",
          "  --packet support-refunds-starter@0.1.0 \\",
          "  --open"
        ].join("\n")
      );
      expect(LOCAL_COMMANDS.test).toContain("node dist/index.js");
      expect(LOCAL_COMMANDS.test).not.toMatch(/npx\s+--yes\s+@augmentworks\/cli@0\.2\.0/u);
    } else {
      expect(LOCAL_COMMANDS.test).toContain(`@augmentworks/cli@${PUBLISHED_PACKAGE_VERSION}`);
    }
  });
});
