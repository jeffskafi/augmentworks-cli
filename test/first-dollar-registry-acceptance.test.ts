import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION,
  NPM_PACKAGE,
  PUBLISHED_PACKAGE_VERIFIED,
  REGISTRY_0_3_3_GIT_HEAD,
  SOURCE_PACKAGE_VERSION
} from "../src/release.js";

const evidenceUrl = new URL(
  "../docs/feature-readiness/first-dollar-registry-acceptance.json",
  import.meta.url
);

type CheckStatus = "pass" | "fail" | "not_run";

interface FirstDollarEvidence {
  schemaVersion: string;
  verifiedAt: string | null;
  cli: {
    packageName: string;
    version: string;
    gitHead: string | null;
    integrity: string | null;
    registryUrl: string;
  };
  mainContractSha: string;
  bundlePaths: string[];
  commands: string[];
  checks: Array<{
    name: string;
    artifactKind: "registry";
    status: CheckStatus;
    evidence: string;
  }>;
  limitations: string[];
}

describe("first-dollar registry acceptance handoff", () => {
  it("keeps aw-first-dollar-release/1 separate from discovery schemaVersion 1", async () => {
    const evidence = JSON.parse(await readFile(evidenceUrl, "utf8")) as FirstDollarEvidence;

    expect(evidence.schemaVersion).toBe("aw-first-dollar-release/1");
    expect(evidence.cli.packageName).toBe(NPM_PACKAGE);
    expect(evidence.cli.version).toBe(SOURCE_PACKAGE_VERSION);
    expect(evidence.cli.version).toBe("0.3.4");
    expect(evidence.cli.registryUrl).toBe("https://registry.npmjs.org/@augmentworks/cli/0.3.4");
    expect(evidence.mainContractSha).toBe("650472d91442a6866a7b6ef18e6dacc23a2a9260");
    expect(evidence.bundlePaths).toEqual(expect.arrayContaining([
      "assets/starters/response-quality/own-chatbot.suite.yaml",
      "assets/starters/workflow/server.mjs",
      "assets/customer-suites/faq-non-commerce.yaml"
    ]));
    expect(evidence.commands).toEqual(expect.arrayContaining([
      "probe",
      "suite validate",
      "test --suite",
      "run report"
    ]));
    expect(evidence.checks.length).toBeGreaterThan(0);
    expect(evidence.checks.every((check) => check.artifactKind === "registry")).toBe(true);
    expect(evidence.checks.every((check) => ["pass", "fail", "not_run"].includes(check.status))).toBe(
      true
    );
    expect(JSON.stringify(evidence)).not.toMatch(/sk-(?:ant-)?api/iu);
    expect(JSON.stringify(evidence)).not.toMatch(/npx --yes @augmentworks\/cli@0\.3\.2\b/u);
  });

  it("does not treat candidate 0.3.4 as independently verified registry evidence", async () => {
    const evidence = JSON.parse(await readFile(evidenceUrl, "utf8")) as FirstDollarEvidence;
    const registryIdentity = evidence.checks.find(
      (check) => check.name === "registry-tarball-gitHead-integrity"
    );

    expect(PUBLISHED_PACKAGE_VERIFIED).toBe(false);
    expect(LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION).toBe("0.3.2");
    expect(REGISTRY_0_3_3_GIT_HEAD).toBe("4a08ea0d352f2515e725cb9ca946807112422436");
    expect(registryIdentity?.status).toBe("not_run");
    expect(evidence.cli.gitHead).toBeNull();
    expect(evidence.cli.integrity).toBeNull();
    expect(evidence.verifiedAt).toBeNull();
    expect(evidence.limitations.some((line) => line.includes("0.3.3"))).toBe(true);
  });
});
