import { LOCAL_TRUST_LABEL, type LocalJson, type LocalRunResult } from "../local/types.js";
import { NPM_PACKAGE, SOURCE_PACKAGE_VERSION } from "../release.js";
import {
  DEMO_DISCLAIMER,
  DEMO_KIND,
  DEMO_SUMMARY_SCHEMA,
  EXPECTED_FAILED_ASSERTION_KEY,
  POLICY_CORRECTION,
  type DemoMode,
  type DemoRunRecord,
  type DemoRunSummary,
  type DemoStory,
  type DemoSummary
} from "./types.js";

export function buildDemoSummary(options: {
  readonly ok: boolean;
  readonly mode: DemoMode;
  readonly records: readonly DemoRunRecord[];
  readonly cleanupOk: boolean;
  readonly cleanupError: string | null;
}): DemoSummary {
  const faulty = options.records.find((record) => record.role === "faulty");
  const corrected = options.records.find((record) => record.role === "corrected");
  return {
    schema_version: DEMO_SUMMARY_SCHEMA,
    kind: DEMO_KIND,
    ok: options.ok,
    mode: options.mode,
    package: {
      name: NPM_PACKAGE,
      version: SOURCE_PACKAGE_VERSION
    },
    disclaimer: DEMO_DISCLAIMER,
    story: faulty === undefined ? null : buildStory(faulty, corrected),
    runs: {
      faulty: faulty === undefined ? null : toRunSummary(faulty),
      corrected: corrected === undefined ? null : toRunSummary(corrected)
    },
    cleanup: {
      ok: options.cleanupOk,
      error: options.cleanupError
    }
  };
}

export function formatDemoJson(summary: DemoSummary): string {
  return `${JSON.stringify(summary)}\n`;
}

export function formatDemoHuman(summary: DemoSummary): string {
  const lines: string[] = [
    "AugmentWorks packaged synthetic demo",
    DEMO_DISCLAIMER,
    LOCAL_TRUST_LABEL,
    ""
  ];
  const story = summary.story;
  if (story !== null) {
    lines.push(`Fixture: ${JSON.stringify(story.fixture)}`);
    lines.push(`Faulty observed state: ${JSON.stringify(story.faultyObservation)}`);
    lines.push(`Failed assertion: ${JSON.stringify(story.failedAssertion)}`);
    lines.push(`Policy correction: ${story.policyCorrection}`);
    lines.push("");
  }
  if (summary.runs.faulty !== null) {
    lines.push(
      `Faulty run: outcome ${summary.runs.faulty.outcome} (exit ${String(summary.runs.faulty.exit_code)}); expected failed.`
    );
    lines.push(`  JSON: ${summary.runs.faulty.reports.json}`);
    lines.push(`  JUnit: ${summary.runs.faulty.reports.junit}`);
    lines.push(`  HTML: ${summary.runs.faulty.reports.html}`);
  }
  if (summary.runs.corrected !== null) {
    lines.push(
      `Corrected run: outcome ${summary.runs.corrected.outcome} (exit ${String(summary.runs.corrected.exit_code)}); expected passed.`
    );
    lines.push(`  JSON: ${summary.runs.corrected.reports.json}`);
    lines.push(`  JUnit: ${summary.runs.corrected.reports.junit}`);
    lines.push(`  HTML: ${summary.runs.corrected.reports.html}`);
  }
  lines.push("");
  lines.push(
    summary.ok
      ? "Demo succeeded: the faulty implementation failed the expected assertion and the corrected implementation passed. This summary is AW-DEMO-SUMMARY-1, not an AW-LOCAL-RESULT-1 report."
      : "Demo failed. Inspect the run records above; do not treat this summary as a local assessment report."
  );
  return `${lines.join("\n")}\n`;
}

function toRunSummary(record: DemoRunRecord): DemoRunSummary {
  return {
    role: record.role,
    expected_outcome: record.expectedOutcome,
    outcome: record.outcome,
    exit_code: record.exitCode,
    reports: {
      json: record.artifacts.json,
      junit: record.artifacts.junit,
      html: record.artifacts.html
    }
  };
}

function buildStory(faulty: DemoRunRecord, _corrected: DemoRunRecord | undefined): DemoStory {
  const attempt = faulty.result.attempts[0];
  const assertion = attempt?.assertions.find((item) => item.key === EXPECTED_FAILED_ASSERTION_KEY);
  const observation = attempt?.observations.find((item) => item.key === "order.status");
  return {
    fixture: (faulty.result.scenarios[0]
      ? {
          order: {
            id: "aw_demo_order_over_limit_001",
            amount: 80,
            status: "paid",
            refundable: true,
            refunded_amount: 0
          },
          policy: { maximum_refund: 50 }
        }
      : null) as LocalJson,
    policyCorrection: POLICY_CORRECTION,
    faultyObservation: (observation?.value ?? null) as LocalJson,
    failedAssertion: (assertion === undefined
      ? null
      : {
          key: assertion.key,
          passed: assertion.passed,
          actual: assertion.actual,
          expected: "paid"
        }) as LocalJson
  };
}

export function inspectFailedAssertion(result: LocalRunResult): {
  readonly key: string;
  readonly passed: boolean;
  readonly actual: LocalJson;
} | undefined {
  const assertion = result.attempts[0]?.assertions.find(
    (item) => item.key === EXPECTED_FAILED_ASSERTION_KEY
  );
  if (assertion === undefined) return undefined;
  return { key: assertion.key, passed: assertion.passed, actual: assertion.actual };
}
