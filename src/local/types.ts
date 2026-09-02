import type {
  CleanupResult,
  ObserveResult,
  PrepareResult,
  SendResult,
  TargetEvent
} from "../cloud/protocol.js";
import type { OperationKind } from "../errors.js";

export type LocalJson =
  | null
  | boolean
  | number
  | string
  | LocalJson[]
  | { [key: string]: LocalJson };

export type LocalJsonObject = { [key: string]: LocalJson };

export type LocalAttemptOutcome = "passed" | "failed" | "inconclusive" | "error";
export type LocalSeverity = "critical" | "high" | "medium" | "low";

interface AssertionBase {
  key: string;
  description: string;
}

export type PacketAssertion =
  | (AssertionBase & {
      kind: "assistant_contains" | "assistant_not_contains";
      value: string;
      turn_index?: number;
      case_sensitive?: boolean;
    })
  | (AssertionBase & {
      kind: "tool_called";
      tool_name: string;
      min_calls?: number;
      max_calls?: number;
      arguments_contain?: LocalJsonObject;
    })
  | (AssertionBase & {
      kind: "tool_not_called";
      tool_name: string;
    })
  | (AssertionBase & {
      kind: "tool_result";
      tool_name: string;
      success: boolean;
      output_contains?: LocalJson;
    })
  | (AssertionBase & {
      kind: "observation_equals";
      observation_key: string;
      expected?: LocalJson;
      authoritative_only?: boolean;
    })
  | (AssertionBase & {
      kind: "observation_absent";
      observation_key: string;
    })
  | (AssertionBase & {
      kind: "handoff_occurred";
      destination?: string;
    })
  | (AssertionBase & {
      kind: "no_error_events";
    });

export interface PacketScenario {
  key: string;
  name: string;
  category: string;
  severity: LocalSeverity;
  description: string;
  expected_behavior: string;
  fixture: LocalJsonObject;
  turns: Array<{ content: string }>;
  observation_keys: string[];
  assertions: PacketAssertion[];
  repetitions: number;
  pass_threshold: number;
}

export interface PacketManifest {
  schema_version: "aw-packet/0.1";
  packet_id: string;
  version: string;
  name: string;
  description: string;
  domain: string;
  synthetic_only: true;
  required_capabilities: {
    multi_turn: boolean;
    observation: boolean;
    tool_events: boolean;
    cleanup: boolean;
  };
  scenarios: PacketScenario[];
}

export interface LocalPacketBinding {
  id: string;
  version: string;
  sha256: string;
  name: string;
}

export type LocalTargetEvent = TargetEvent;
export type LocalObservation = ObserveResult["observations"][number];
export type LocalOperationResult = PrepareResult | SendResult | ObserveResult | CleanupResult;

export interface LocalOperationError {
  code: string;
  message: string;
  retryable?: boolean;
}

interface LocalOperationRecordBase {
  kind: OperationKind;
  started_at: string;
  completed_at: string;
  turn_index?: number;
}

export type LocalOperationRecord =
  | (LocalOperationRecordBase & {
      disposition: "completed";
      result: LocalOperationResult;
    })
  | (LocalOperationRecordBase & {
      disposition: "failed" | "outcome_indeterminate";
      error: LocalOperationError;
    });

export interface LocalAssertionResult {
  key: string;
  kind: string;
  description: string;
  passed: boolean;
  actual: LocalJson;
}

export interface LocalAttemptError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface LocalNormalizedEvent {
  type: string;
  event_id: string;
  sequence?: number | null;
  data: LocalJsonObject;
}

export interface LocalAttemptResult {
  attempt_id: string;
  scenario_key: string;
  repetition_index: number;
  status: LocalAttemptOutcome;
  started_at: string;
  completed_at: string;
  turns: Array<{
    turn_index: number;
    user_content: string;
    assistant_content?: string | null;
    finish_reason?: string | null;
    events?: LocalNormalizedEvent[];
    ambiguous?: boolean;
  }>;
  observations: LocalObservation[];
  assertions: LocalAssertionResult[];
  errors: LocalAttemptError[];
  cleanup_status: "completed" | "failed" | "not_required";
}

export interface LocalScenarioSummary {
  scenario_key: string;
  name: string;
  category: string;
  severity: LocalSeverity;
  description: string;
  expected_behavior: string;
  repetitions: number;
  passed: number;
  failed: number;
  inconclusive: number;
  errors: number;
  pass_rate: number | null;
  pass_threshold: number;
  outcome: LocalAttemptOutcome;
}

export interface LocalRunProvenance {
  execution_mode: "local";
  executor: "customer_environment";
  customer_executed: true;
  platform_received: false;
  augmentworks_verified: false;
  verification: "unverified";
  signed: false;
  signature: null;
  managed_review: false;
  uploaded: false;
  cloud_contacted: false;
  trust_label: string;
}

export interface LocalRunResult {
  schema_version: "AW-LOCAL-RESULT-1";
  run_id: string;
  cli_version: string;
  scorer_version: string;
  packet: LocalPacketBinding;
  target: {
    name: string;
    config_sha256: string;
  };
  tested_at: string;
  completed_at: string;
  outcome: LocalAttemptOutcome;
  counts: {
    scenarios: number;
    attempts: number;
    passed: number;
    failed: number;
    inconclusive: number;
    errors: number;
  };
  requirements: Array<{
    key: string;
    statement: string;
    severity: LocalSeverity;
  }>;
  results: Array<{
    scenario_key: string;
    title: string;
    category: string;
    requirement_key: string;
    expected_behavior: string;
    outcome: "pass" | "fail" | "uncertain" | "error";
    score: number;
    evaluator: string;
    evidence_summary: string;
    repetitions: {
      total: number;
      passed: number;
      failed: number;
      uncertain: number;
      errors: number;
      pass_rate: number | null;
      pass_threshold: number;
    };
  }>;
  findings: Array<{
    id: string;
    title: string;
    severity: LocalSeverity;
    status: "open";
    category: string;
    description: string;
    remediation: null;
    scenarioKey: string;
  }>;
  repetitions: {
    total: number;
    passed: number;
    failed: number;
    uncertain: number;
    errors: number;
  };
  scenarios: LocalScenarioSummary[];
  attempts: LocalAttemptResult[];
  redaction_applied: true;
  provenance: LocalRunProvenance;
  result_sha256: string;
}

export const LOCAL_TRUST_LABEL =
  "Local, customer-executed result. AugmentWorks did not receive or independently verify this run. This artifact is unsigned and is not a certification, audit, or hosted evidence record." as const;
