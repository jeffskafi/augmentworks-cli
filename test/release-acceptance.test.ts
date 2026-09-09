import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceUrl = new URL("../docs/feature-readiness/release-acceptance.json", import.meta.url);
const scriptPath = resolve(projectRoot, "scripts/packed-core-release-acceptance.mjs");

type CheckStatus = "pass" | "fail" | "not_run";

interface ReleaseAcceptance {
  schemaVersion: string;
  issue: string;
  verifiedAt: string | null;
  releaseReady: boolean;
  source: "registry" | "local_pack";
  cli: {
    packageName: string;
    version: string;
    gitHead: string | null;
    integrity: string | null;
    shasum: string | null;
    tarballSha256: string | null;
    registryUrl: string;
    publishedAt: string | null;
    fileCount: number | null;
  };
  checks: Array<{
    name: string;
    artifactKind: "registry" | "local_pack";
    status: CheckStatus;
    evidence: string;
  }>;
  limitations: string[];
  recovery: string[];
}

const PUBLISHED_0_3_4 = {
  gitHead: "c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f",
  integrity: "sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ==",
  tarballSha256: "a97b1ff77823933defcecac8181c0dc5c925cfe356dfe2d6bad2f39e271d4021"
} as const;

const REQUIRED_CHECKS = [
  "registry-identity",
  "inventory-schemas-fixtures",
  "version-and-help",
  "documentation-pins",
  "offline-suite-session-mapping-probe",
  "invalid-mapping",
  "unsupported-capability",
  "wait-timeout-running",
  "revoked-credential",
  "credit-ceiling",
  "incompatible-baseline",
  "failing-required-criterion",
  "passing-ci-decision",
  "investigation-repro-export",
  "machine-ci-headless",
  "live-authorized-environment"
] as const;

describe("AUG-48 published CLI core release acceptance", () => {
  it("keeps the registry harness free of source-tree imports", async () => {
    const harness = await readFile(scriptPath, "utf8");
    expect(harness).not.toMatch(/from ["']\.\.\/src\//u);
    expect(harness).not.toMatch(/from ["']\.\.\/dist\//u);
    expect(harness).toContain("npm pack");
    expect(harness).toContain("--source");
  });

  it("records aw-core-release-acceptance/1 without calling unpublished evidence a pass", async () => {
    const evidence = JSON.parse(await readFile(evidenceUrl, "utf8")) as ReleaseAcceptance;

    expect(evidence.schemaVersion).toBe("aw-core-release-acceptance/1");
    expect(evidence.issue).toBe("AUG-48");
    expect(evidence.source).toBe("registry");
    expect(evidence.cli.packageName).toBe("@augmentworks/cli");
    expect(evidence.cli.version).toBe("0.3.4");
    expect(evidence.cli.registryUrl).toBe("https://registry.npmjs.org/@augmentworks/cli/0.3.4");
    expect(evidence.cli.gitHead).toBe(PUBLISHED_0_3_4.gitHead);
    expect(evidence.cli.integrity).toBe(PUBLISHED_0_3_4.integrity);
    expect(evidence.cli.tarballSha256).toBe(PUBLISHED_0_3_4.tarballSha256);
    expect(evidence.cli.gitHead).not.toBeNull();
    expect(evidence.cli.integrity).not.toBeNull();

    const byName = Object.fromEntries(evidence.checks.map((check) => [check.name, check]));
    for (const name of REQUIRED_CHECKS) {
      expect(byName[name], name).toBeDefined();
      expect(byName[name]?.artifactKind).toBe("registry");
      expect(["pass", "fail", "not_run"]).toContain(byName[name]?.status);
    }

    expect(evidence.checks.some((check) => check.status === "fail")).toBe(false);
    expect(evidence.releaseReady).toBe(false);
    expect(byName["investigation-repro-export"]?.status).toBe("not_run");
    expect(byName["machine-ci-headless"]?.status).toBe("not_run");
    expect(byName["live-authorized-environment"]?.status).toBe("not_run");
    expect(byName["registry-identity"]?.status).toBe("pass");
    expect(byName["failing-required-criterion"]?.status).toBe("pass");
    expect(byName["passing-ci-decision"]?.status).toBe("pass");

    for (const check of evidence.checks) {
      if (check.status === "pass") {
        expect(check.evidence).not.toMatch(/skipped|not published|QA only|local pack is not/iu);
      }
    }

    expect(JSON.stringify(evidence)).not.toMatch(/sk-(?:ant-)?api/iu);
    expect(JSON.stringify(evidence)).not.toMatch(/aw_api_core_release_fixture_key/u);
    expect(evidence.limitations.some((line) => line.includes("releaseReady is false"))).toBe(true);
    expect(evidence.recovery.some((line) => line.includes("original run"))).toBe(true);
  });

  it("does not treat AUG-47's local pack pin as a substitute for this registry record", async () => {
    const evidence = JSON.parse(await readFile(evidenceUrl, "utf8")) as ReleaseAcceptance;
    expect(evidence.cli.tarballSha256).toBe(PUBLISHED_0_3_4.tarballSha256);
    expect(evidence.releaseReady).toBe(false);
    expect(evidence.checks.every((check) => check.artifactKind === "registry")).toBe(true);
  });
});
