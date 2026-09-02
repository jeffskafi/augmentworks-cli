import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  preflightLocalOutputDirectory,
  writeLocalArtifacts
} from "../../src/local/artifacts.js";
import { sha256Json } from "../../src/local/canonical.js";
import { escapeHtml, LOCAL_TRUST_NOTICE } from "../../src/local/report-html.js";
import { escapeXml } from "../../src/local/report-junit.js";
import type { LocalJson, LocalRunResult } from "../../src/local/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("local report artifacts", () => {
  it("preflights a fresh exact leaf without creating it", async () => {
    const root = await temporaryRoot();
    const output = join(root, "new-parent", "local-run-1");

    await expect(preflightLocalOutputDirectory(output)).resolves.toBe(output);
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "new-parent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes one private, mutually consistent, redacted report set", async () => {
    const root = await temporaryRoot();
    const output = join(root, "reports", "local-run-1");
    const paths = await writeLocalArtifacts({
      result: localResult(),
      outputDirectory: output,
      secrets: ["secret-value"]
    });

    expect(paths.directory).toBe(output);
    expect((await readdir(output)).sort()).toEqual(["junit.xml", "report.html", "report.json"]);
    const [jsonSource, junit, html] = await Promise.all([
      readFile(paths.json, "utf8"),
      readFile(paths.junit, "utf8"),
      readFile(paths.html, "utf8")
    ]);
    const json = JSON.parse(jsonSource) as Record<string, unknown>;
    const serializedHash = json["result_sha256"];
    delete json["result_sha256"];

    expect(serializedHash).toBe(paths.resultSha256);
    expect(paths.safeResult).toEqual(JSON.parse(jsonSource));
    expect(sha256Json(json as LocalJson)).toBe(paths.resultSha256);
    expect(json["schema_version"]).toBe("AW-LOCAL-RESULT-1");
    expect(jsonSource.endsWith("\n")).toBe(true);
    expect(json["provenance"]).toMatchObject({
      execution_mode: "local",
      executor: "customer_environment",
      customer_executed: true,
      platform_received: false,
      augmentworks_verified: false,
      verification: "unverified",
      signed: false,
      signature: null,
      managed_review: false,
      uploaded: false,
      cloud_contacted: false,
      trust_label: LOCAL_TRUST_NOTICE
    });

    for (const source of [jsonSource, junit, html]) {
      expect(source).toContain(LOCAL_TRUST_NOTICE);
      expect(source).not.toContain("secret-value");
      expect(source).not.toContain("remote-token-value");
      expect(source).not.toContain("unconfigured-api-key");
      expect(source).not.toContain("/private/config/path");
    }
    expect(jsonSource).toContain("[REDACTED]");
    expect(jsonSource).not.toContain('"config_path"');
    expect(jsonSource).not.toContain('"path"');

    expect(junit).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(junit).toContain('augmentworks.execution_mode" value="local"');
    expect(junit).toContain('augmentworks.verified" value="false"');
    expect(junit).toContain(`augmentworks.result_sha256" value="${paths.resultSha256}"`);
    expect(junit).toContain("&lt;requirement&gt; &amp; proof");
    expect(junit).not.toContain("\u0000");
    expect(junit).not.toContain("<![CDATA[");

    expect(html).toContain("default-src 'none'");
    expect(html).toContain('name="robots" content="noindex,nofollow,noarchive,nosnippet"');
    expect(html).toContain(paths.resultSha256);
    expect(html).not.toMatch(/<script\b/iu);
    expect(html).not.toMatch(/<img\b/iu);
    expect(html).not.toMatch(/https?:\/\//iu);
    expect(html).not.toContain("\u0000");

    if (process.platform !== "win32") {
      expect((await stat(output)).mode & 0o777).toBe(0o700);
      for (const path of [paths.json, paths.junit, paths.html]) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("refuses an existing output directory without touching its contents", async () => {
    const root = await temporaryRoot();
    const output = join(root, "existing");
    await mkdir(output);
    const sentinel = join(output, "keep.txt");
    await writeFile(sentinel, "keep me\n", "utf8");

    await expect(
      writeLocalArtifacts({ result: localResult(), outputDirectory: output })
    ).rejects.toMatchObject({ code: "LOCAL_OUTPUT_EXISTS", category: "config" });
    expect(await readFile(sentinel, "utf8")).toBe("keep me\n");
    expect(await readdir(output)).toEqual(["keep.txt"]);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a symlinked output leaf without writing through it",
    async () => {
      const root = await temporaryRoot();
      const target = join(root, "target");
      const output = join(root, "reports");
      await mkdir(target);
      await symlink(target, output);

      await expect(
        writeLocalArtifacts({ result: localResult(), outputDirectory: output })
      ).rejects.toMatchObject({ code: "LOCAL_OUTPUT_UNSAFE", category: "config" });
      expect(await readdir(target)).toEqual([]);
    }
  );

  it.runIf(process.platform !== "win32")(
    "refuses a symlink in the output parent chain",
    async () => {
      const root = await temporaryRoot();
      const target = join(root, "outside");
      const linkedParent = join(root, "linked-parent");
      await mkdir(target);
      await symlink(target, linkedParent);

      await expect(
        preflightLocalOutputDirectory(join(linkedParent, "nested", "local-run-1"))
      ).rejects.toMatchObject({ code: "LOCAL_OUTPUT_UNSAFE", category: "config" });
      expect(await readdir(target)).toEqual([]);
    }
  );

  it("escapes HTML, XML metacharacters, and invalid XML controls", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    expect(escapeXml(`<>&"'\u0000\u0008`)).toBe(
      "&lt;&gt;&amp;&quot;&apos;\uFFFD\uFFFD"
    );
  });

  it("maps every local attempt outcome to coherent JUnit totals", async () => {
    const root = await temporaryRoot();
    const output = join(root, "reports", "mixed-outcomes");
    const result = localResult();
    const base = result.attempts[0]!;
    result.attempts = [
      {
        ...base,
        attempt_id: "attempt-passed",
        repetition_index: 0,
        status: "passed",
        completed_at: "2026-09-02T00:00:01.000Z",
        assertions: [{ ...base.assertions[0]!, passed: true }],
        errors: [],
        cleanup_status: "not_required"
      },
      {
        ...base,
        attempt_id: "attempt-failed",
        repetition_index: 1,
        status: "failed",
        started_at: "2026-09-02T00:00:01.000Z",
        completed_at: "2026-09-02T00:00:03.000Z",
        assertions: [
          {
            ...base.assertions[0]!,
            description: `hostile ]]><failure injected="yes"> & requirement`,
            passed: false
          }
        ],
        errors: [],
        cleanup_status: "not_required"
      },
      {
        ...base,
        attempt_id: "attempt-error",
        repetition_index: 2,
        status: "error",
        started_at: "2026-09-02T00:00:03.000Z",
        completed_at: "2026-09-02T00:00:06.000Z",
        assertions: [],
        errors: [
          {
            code: `BAD_"<&`,
            message: `hostile ]]><error injected="yes">\u0000`,
            retryable: false
          }
        ],
        cleanup_status: "failed"
      },
      {
        ...base,
        attempt_id: "attempt-inconclusive",
        repetition_index: 3,
        status: "inconclusive",
        started_at: "2026-09-02T00:00:06.000Z",
        completed_at: "2026-09-02T00:00:10.000Z",
        assertions: [],
        errors: [],
        cleanup_status: "completed"
      }
    ];
    result.counts = {
      ...result.counts,
      attempts: 4,
      passed: 1,
      failed: 1,
      inconclusive: 1,
      errors: 1
    };

    const paths = await writeLocalArtifacts({ result, outputDirectory: output });
    const [junit, html] = await Promise.all([
      readFile(paths.junit, "utf8"),
      readFile(paths.html, "utf8")
    ]);

    expect(junit).toContain('tests="4" failures="1" errors="1" skipped="1" time="10.000"');
    expect(junit.match(/<testcase\b/gu)).toHaveLength(4);
    expect(junit.match(/<failure\b/gu)).toHaveLength(1);
    expect(junit.match(/<error\b/gu)).toHaveLength(1);
    expect(junit.match(/<skipped\b/gu)).toHaveLength(1);
    expect(junit).toContain("hostile ]]&gt;&lt;failure injected=&quot;yes&quot;&gt;");
    expect(junit).toContain("hostile ]]&gt;&lt;error injected=&quot;yes&quot;&gt;�");
    expect(junit).not.toContain('<failure injected="yes">');
    expect(junit).not.toContain('<error injected="yes">');
    expect(junit).not.toContain("<![CDATA[");
    for (const status of ["passed", "failed", "error", "inconclusive"]) {
      expect(html).toContain(`status-${status}`);
    }
  });

  it("redacts evidence without corrupting coincidental protocol values", async () => {
    const root = await temporaryRoot();
    const output = join(root, "reports", "structural-redaction");
    const result = localResult();
    result.outcome = "passed";
    result.counts = {
      ...result.counts,
      passed: 1,
      failed: 0
    };
    result.packet.name = "passed status";
    result.attempts[0]!.status = "passed";
    result.attempts[0]!.assertions[0]!.passed = true;
    result.attempts[0]!.assertions[0]!.description = "passed status";
    result.attempts[0]!.assertions[0]!.actual = {
      status: "passed",
      note: "status"
    };

    const paths = await writeLocalArtifacts({
      result,
      outputDirectory: output,
      secrets: ["passed", "status"]
    });

    expect(paths.safeResult.outcome).toBe("passed");
    expect(paths.safeResult.attempts[0]!.status).toBe("passed");
    expect(paths.safeResult.packet.name).toBe("[REDACTED] [REDACTED]");
    expect(paths.safeResult.attempts[0]!.assertions[0]!.description).toBe(
      "[REDACTED] [REDACTED]"
    );
    expect(paths.safeResult.attempts[0]!.assertions[0]!.actual).toEqual({
      "[REDACTED]": "[REDACTED]",
      note: "[REDACTED]"
    });
    expect(paths.safeResult.provenance).toMatchObject({
      execution_mode: "local",
      verification: "unverified"
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "augmentworks-local-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function localResult(): LocalRunResult {
  return {
    schema_version: "AW-LOCAL-RESULT-1",
    run_id: "local-run-1",
    cli_version: "0.1.1",
    scorer_version: "augmentworks-local-scorer/0.1.0",
    packet: {
      id: "safe-local",
      version: "0.1.0",
      sha256: "a".repeat(64),
      name: "<script>alert('report')</script> secret-value"
    },
    target: {
      name: "Synthetic target secret-value",
      config_sha256: "b".repeat(64)
    },
    tested_at: "2026-09-02T00:00:00.000Z",
    completed_at: "2026-09-02T00:00:01.000Z",
    outcome: "failed",
    counts: {
      scenarios: 1,
      attempts: 1,
      passed: 0,
      failed: 1,
      inconclusive: 0,
      errors: 0
    },
    requirements: [
      {
        key: "safe-local.requirement",
        statement: "<requirement> & proof\u0000",
        severity: "high"
      }
    ],
    results: [
      {
        scenario_key: "safe-local.requirement",
        title: "Unsafe </style><script>alert(1)</script>",
        category: "behavior",
        requirement_key: "safe-local.requirement",
        expected_behavior: "Meet <requirement> & proof\u0000",
        outcome: "fail",
        score: 0,
        evaluator: "Local deterministic packet assertions",
        evidence_summary: "0/1 repetitions passed.",
        repetitions: {
          total: 1,
          passed: 0,
          failed: 1,
          uncertain: 0,
          errors: 0,
          pass_rate: 0,
          pass_threshold: 1
        }
      }
    ],
    findings: [
      {
        id: "finding-1",
        title: "Unsafe finding",
        severity: "high",
        status: "open",
        category: "behavior",
        description: "The local requirement failed.",
        remediation: null,
        scenarioKey: "safe-local.requirement"
      }
    ],
    repetitions: { total: 1, passed: 0, failed: 1, uncertain: 0, errors: 0 },
    scenarios: [
      {
        scenario_key: "safe-local.requirement",
        name: "Unsafe </style><script>alert(1)</script>",
        category: "behavior",
        severity: "high",
        description: "A local synthetic case.",
        expected_behavior: "Meet <requirement> & proof\u0000",
        repetitions: 1,
        passed: 0,
        failed: 1,
        inconclusive: 0,
        errors: 0,
        pass_rate: 0,
        pass_threshold: 1,
        outcome: "failed"
      }
    ],
    attempts: [
      {
        attempt_id: "attempt-1",
        scenario_key: "safe-local.requirement",
        repetition_index: 0,
        status: "failed",
        started_at: "2026-09-02T00:00:00.000Z",
        completed_at: "2026-09-02T00:00:01.000Z",
        turns: [
          {
            turn_index: 0,
            user_content: "secret-value",
            assistant_content: "Bearer remote-token-value"
          }
        ],
        observations: [],
        assertions: [
          {
            key: "unsafe-assertion",
            kind: "assistant_contains",
            description: "Meet <requirement> & proof\u0000",
            passed: false,
            actual: {
              api_key: "unconfigured-api-key",
              note: "secret-value",
              path: "/private/config/path"
            }
          }
        ],
        errors: [
          {
            code: "ASSERTION_FAILED",
            message: "token=remote-token-value",
            retryable: false
          }
        ],
        cleanup_status: "completed"
      }
    ],
    redaction_applied: true,
    provenance: {
      execution_mode: "local",
      executor: "customer_environment",
      customer_executed: true,
      platform_received: false,
      augmentworks_verified: false,
      verification: "unverified",
      signed: false,
      signature: null,
      managed_review: false,
      uploaded: false,
      cloud_contacted: false,
      trust_label: LOCAL_TRUST_NOTICE
    },
    result_sha256: "stale-value-that-must-be-recomputed"
  };
}
