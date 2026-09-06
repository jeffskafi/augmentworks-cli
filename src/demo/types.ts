import type { LocalArtifactPaths } from "../local/artifacts.js";
import type { LocalAttemptOutcome, LocalJson, LocalRunResult } from "../local/types.js";

export const DEMO_SUMMARY_SCHEMA = "AW-DEMO-SUMMARY-1" as const;
export const DEMO_KIND = "synthetic_local_demo" as const;
export const DEMO_PACKET_ID = "support-refunds-demo";
export const DEMO_PACKET_VERSION = "0.1.0";
export const EXPECTED_FAILED_ASSERTION_KEY = "policy-limit-order-remains-paid";
export const POLICY_CORRECTION =
  "Enforce fixture.policy.maximum_refund before calling refund_order; an amount above that limit must leave order.status paid and order.refunded_amount 0.";

export type DemoMode = "full" | "faulty" | "corrected";
export type DemoPolicy = "ignore-limit" | "enforce-limit";

export const DEMO_DISCLAIMER =
  "This is a deterministic, loopback-only, synthetic demonstration with no model calls after installation. It is not a production chatbot, an accuracy benchmark, a certification, or hosted AugmentWorks evidence." as const;

export interface DemoRunRecord {
  readonly role: "faulty" | "corrected";
  readonly policy: DemoPolicy;
  readonly expectedOutcome: "failed" | "passed";
  readonly outcome: LocalAttemptOutcome;
  readonly exitCode: number;
  readonly artifacts: LocalArtifactPaths;
  readonly result: LocalRunResult;
}

export interface DemoStory {
  readonly fixture: LocalJson;
  readonly policyCorrection: string;
  readonly faultyObservation: LocalJson;
  readonly failedAssertion: LocalJson;
}

export interface DemoSummary {
  readonly schema_version: typeof DEMO_SUMMARY_SCHEMA;
  readonly kind: typeof DEMO_KIND;
  readonly ok: boolean;
  readonly mode: DemoMode;
  readonly package: {
    readonly name: string;
    readonly version: string;
  };
  readonly disclaimer: typeof DEMO_DISCLAIMER;
  readonly story: DemoStory | null;
  readonly runs: {
    readonly faulty: DemoRunSummary | null;
    readonly corrected: DemoRunSummary | null;
  };
  readonly cleanup: {
    readonly ok: boolean;
    readonly error: string | null;
  };
}

export interface DemoRunSummary {
  readonly role: "faulty" | "corrected";
  readonly expected_outcome: "failed" | "passed";
  readonly outcome: LocalAttemptOutcome;
  readonly exit_code: number;
  readonly reports: {
    readonly json: string;
    readonly junit: string;
    readonly html: string;
  };
}

export interface DemoCommandOptions {
  readonly cwd?: string;
  readonly outputDirectory?: string;
  readonly mode?: DemoMode;
  readonly json?: boolean;
  readonly open?: boolean;
  readonly timeoutMs?: number;
  readonly runDeadlineMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
}

export interface DemoCommandResult {
  readonly summary: DemoSummary;
  readonly exitCode: number;
  readonly records: readonly DemoRunRecord[];
}
