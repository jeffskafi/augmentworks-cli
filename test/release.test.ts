import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CLI_RELEASE,
  HOSTED_COMMAND_PIN,
  HOSTED_COMMANDS,
  INIT_NEXT_STEPS,
  LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION,
  LOCAL_COMMANDS,
  LOCAL_DISTRIBUTION,
  PUBLISHED_PACKAGE_VERIFIED,
  PUBLISHED_PACKAGE_VERSION,
  REGISTRY_0_3_3_GIT_HEAD,
  SOURCE_PACKAGE_VERSION,
  allowedDocumentedNpxPins,
  formatNpx,
  initNextSteps
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

  it("pins hosted npx commands to this package version, not 0.3.2 or 0.3.3", () => {
    expect(SOURCE_PACKAGE_VERSION).toBe("0.3.4");
    expect(PUBLISHED_PACKAGE_VERSION).toBe("0.3.4");
    expect(HOSTED_COMMAND_PIN).toBe(SOURCE_PACKAGE_VERSION);
    expect(HOSTED_COMMAND_PIN).not.toBe("0.3.2");
    expect(HOSTED_COMMAND_PIN).not.toBe("0.3.3");
    expect(allowedDocumentedNpxPins()).toEqual(["0.3.4"]);
    expect(HOSTED_COMMANDS.login).toBe(formatNpx(HOSTED_COMMAND_PIN, ["login"]));
    expect(HOSTED_COMMANDS.initAgent).toBe(formatNpx(HOSTED_COMMAND_PIN, ["init", "--agent"]));
    expect(HOSTED_COMMANDS.recover).toBe(formatNpx(HOSTED_COMMAND_PIN, ["recover"]));
    expect(HOSTED_COMMANDS.test).toContain(`@augmentworks/cli@${HOSTED_COMMAND_PIN}`);
    expect(HOSTED_COMMANDS.test).toContain("--assessment");
    expect(HOSTED_COMMANDS.test).not.toContain("--local");
    expect(INIT_NEXT_STEPS).not.toContain("Published @augmentworks/cli@0.3.2 does not generate");
  });

  it("separates candidate 0.3.4 metadata from last verified registry evidence", () => {
    expect(PUBLISHED_PACKAGE_VERIFIED).toBe(false);
    expect(CLI_RELEASE.published_package_verified).toBe(false);
    expect(LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION).toBe("0.3.2");
    expect(REGISTRY_0_3_3_GIT_HEAD).toBe("4a08ea0d352f2515e725cb9ca946807112422436");
    expect(CLI_RELEASE.notes).toContain("4a08ea0d352f2515e725cb9ca946807112422436");
    expect(CLI_RELEASE.notes).toContain("first-dollar-registry-acceptance.json");
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

  it("keeps default init next-steps copy and names a custom connector file", () => {
    expect(initNextSteps()).toBe(INIT_NEXT_STEPS);
    expect(INIT_NEXT_STEPS).toContain(
      "created augmentworks.yaml, augmentworks.assessment.yaml, starter references, and the packaged fixture server"
    );
    expect(INIT_NEXT_STEPS).toContain("probe");
    expect(initNextSteps("custom.yaml")).toContain(
      "created custom.yaml, augmentworks.assessment.yaml, starter references, and the packaged fixture server"
    );
    expect(initNextSteps("nested/custom.yaml", "nested/augmentworks.assessment.yaml")).toContain(
      "created nested/custom.yaml, nested/augmentworks.assessment.yaml, starter references, and the packaged fixture server"
    );
  });
});
