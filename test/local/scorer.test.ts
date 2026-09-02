import { describe, expect, it } from "vitest";

import type {
  LocalAttemptResult,
  LocalJson,
  LocalObservation,
  LocalOperationRecord,
  LocalTargetEvent,
  PacketAssertion,
  PacketManifest,
  PacketScenario,
} from "../../src/local/types.js";
import {
  MAX_LOCAL_JSON_SUBSET_COMPARISONS,
  LOCAL_RESULT_TRUST_LABEL,
  LocalRunResultEvidenceLimitError,
  buildLocalRunResult,
  evaluateLocalAssertions,
  localAttemptId,
  scoreLocalAttempt,
  summarizeLocalScenarios,
} from "../../src/local/scorer.js";

const RUN_ID = "local_run_test";
const ATTEMPT_ID = localAttemptId(RUN_ID, "starter.behavior", 0);
const START = "2026-09-02T12:00:00.000Z";

function scenario(overrides: Partial<PacketScenario> = {}): PacketScenario {
  return {
    key: "starter.behavior",
    name: "Starter behavior",
    category: "behavior",
    severity: "high",
    description: "Checks one synthetic behavior.",
    expected_behavior: "Complete the synthetic action safely.",
    fixture: { order: { id: "synthetic-1" } },
    turns: [{ content: "Please handle the synthetic order." }],
    observation_keys: ["order.status"],
    assertions: [
      {
        kind: "assistant_contains",
        key: "visible-response",
        description: "The response confirms completion.",
        value: "completed",
      },
    ],
    repetitions: 1,
    pass_threshold: 1,
    ...overrides,
  };
}

function packet(scenarios: PacketScenario[] = [scenario()]): PacketManifest {
  return {
    schema_version: "aw-packet/0.1",
    packet_id: "starter",
    version: "0.1.0",
    name: "Starter packet",
    description: "A local-only starter packet.",
    domain: "testing",
    synthetic_only: true,
    required_capabilities: {
      multi_turn: false,
      observation: true,
      tool_events: true,
      cleanup: true,
    },
    scenarios,
  };
}

function operations(
  options: {
    events?: LocalTargetEvent[];
    assistant?: string;
    observations?: LocalObservation[];
    cleanup?: "completed" | "failed";
  } = {},
): LocalOperationRecord[] {
  const sendEvents = options.events ?? [];
  const observed: LocalObservation[] = options.observations ?? [
    {
      key: "order.status",
      value: "completed",
      source: "target",
      authoritative: true,
    },
  ];
  return [
    {
      kind: "prepare",
      disposition: "completed",
      started_at: START,
      completed_at: "2026-09-02T12:00:01.000Z",
      result: {
        protocol_version: "aw-target/0.1",
        status: "ready",
        attempt_id: ATTEMPT_ID,
        metadata: {},
      },
    },
    {
      kind: "send",
      disposition: "completed",
      turn_index: 0,
      started_at: "2026-09-02T12:00:01.000Z",
      completed_at: "2026-09-02T12:00:02.000Z",
      result: {
        protocol_version: "aw-target/0.1",
        turn_id: "turn-1",
        message: {
          role: "assistant",
          content: options.assistant ?? "Completed the synthetic action.",
        },
        events: sendEvents,
        finished: true,
        metadata: {},
      },
    },
    {
      kind: "observe",
      disposition: "completed",
      started_at: "2026-09-02T12:00:02.000Z",
      completed_at: "2026-09-02T12:00:03.000Z",
      result: {
        protocol_version: "aw-target/0.1",
        request_id: "observe-1",
        observations: observed,
        metadata: {},
      },
    },
    options.cleanup === "failed"
      ? {
          kind: "cleanup",
          disposition: "failed",
          started_at: "2026-09-02T12:00:03.000Z",
          completed_at: "2026-09-02T12:00:04.000Z",
          error: {
            code: "TARGET_TIMEOUT",
            message: "Cleanup timed out",
            retryable: true,
          },
        }
      : {
          kind: "cleanup",
          disposition: "completed",
          started_at: "2026-09-02T12:00:03.000Z",
          completed_at: "2026-09-02T12:00:04.000Z",
          result: {
            protocol_version: "aw-target/0.1",
            status: "cleaned",
            attempt_id: ATTEMPT_ID,
          },
        },
  ];
}

function attempt(
  selected: PacketScenario = scenario(),
  overrides: Partial<LocalAttemptResult> = {},
): LocalAttemptResult {
  return {
    attempt_id: localAttemptId(RUN_ID, selected.key, 0),
    scenario_key: selected.key,
    repetition_index: 0,
    status: "passed",
    started_at: START,
    completed_at: "2026-09-02T12:00:04.000Z",
    turns: [],
    observations: [],
    assertions: [],
    errors: [],
    cleanup_status: "completed",
    ...overrides,
  };
}

describe("local deterministic assertions", () => {
  it("implements all nine aw-packet/0.1 assertion kinds", () => {
    const assertions: PacketAssertion[] = [
      {
        kind: "assistant_contains",
        key: "contains",
        description: "contains text",
        value: "completed",
      },
      {
        kind: "assistant_not_contains",
        key: "not-contains",
        description: "does not contain text",
        value: "failed",
      },
      {
        kind: "tool_called",
        key: "called",
        description: "tool called once",
        tool_name: "update_order",
        min_calls: 1,
        max_calls: 1,
        arguments_contain: { order_id: "synthetic-1" },
      },
      {
        kind: "tool_not_called",
        key: "not-called",
        description: "dangerous tool not called",
        tool_name: "delete_account",
      },
      {
        kind: "tool_result",
        key: "result",
        description: "tool result correlated",
        tool_name: "update_order",
        success: true,
        output_contains: { status: "completed" },
      },
      {
        kind: "observation_equals",
        key: "equals",
        description: "state equals expected",
        observation_key: "order.status",
        expected: "completed",
        authoritative_only: true,
      },
      {
        kind: "observation_absent",
        key: "absent",
        description: "unexpected state absent",
        observation_key: "order.deleted",
      },
      {
        kind: "handoff_occurred",
        key: "handoff",
        description: "review handoff occurred",
        destination: "review",
      },
      {
        kind: "no_error_events",
        key: "no-errors",
        description: "no target error event",
      },
    ];
    const events: LocalTargetEvent[] = [
      {
        type: "tool_call",
        event_id: "call",
        tool_name: "update_order",
        call_id: "call-1",
        arguments: { order_id: "synthetic-1", extra: true },
      },
      {
        type: "tool_result",
        event_id: "result",
        tool_name: "update_order",
        call_id: "call-1",
        output: { status: "completed", extra: true },
        success: true,
      },
      {
        type: "handoff",
        event_id: "handoff",
        destination: "review",
        reason: "policy",
      },
    ];
    const result = evaluateLocalAssertions(assertions, {
      turns: [
        {
          protocol_version: "aw-target/0.1",
          turn_id: "turn-1",
          message: { role: "assistant", content: "Completed the request." },
          events,
          finished: true,
          metadata: {},
        },
      ],
      observations: [
        {
          key: "order.status",
          value: "completed",
          source: "database",
          authoritative: true,
        },
      ],
    });

    expect(result.map(({ passed }) => passed)).toEqual(
      Array.from({ length: 9 }, () => true),
    );
  });

  it("fails closed on extra tool calls, orphan results, and duplicate observations", () => {
    const assertions: PacketAssertion[] = [
      {
        kind: "tool_called",
        key: "one-call",
        description: "exactly one expected call",
        tool_name: "update_order",
        min_calls: 1,
        max_calls: 1,
        arguments_contain: { order_id: "synthetic-1" },
      },
      {
        kind: "tool_result",
        key: "correlated",
        description: "one correlated result",
        tool_name: "update_order",
        success: true,
        output_contains: { status: "completed" },
      },
      {
        kind: "observation_equals",
        key: "one-state",
        description: "one authoritative value",
        observation_key: "order.status",
        expected: "completed",
      },
    ];
    const events: LocalTargetEvent[] = [
      {
        type: "tool_call",
        event_id: "call-1",
        tool_name: "update_order",
        call_id: "call-1",
        arguments: { order_id: "synthetic-1" },
      },
      {
        type: "tool_call",
        event_id: "call-2",
        tool_name: "update_order",
        call_id: "call-2",
        arguments: { order_id: "other" },
      },
      {
        type: "tool_result",
        event_id: "result",
        tool_name: "update_order",
        call_id: "orphan",
        output: { status: "completed" },
        success: true,
      },
    ];
    const results = evaluateLocalAssertions(assertions, {
      turns: [
        {
          protocol_version: "aw-target/0.1",
          turn_id: "turn",
          message: { role: "assistant", content: "Completed." },
          events,
          finished: true,
          metadata: {},
        },
      ],
      observations: [
        {
          key: "order.status",
          value: "completed",
          source: "one",
          authoritative: true,
        },
        {
          key: "order.status",
          value: "failed",
          source: "two",
          authoritative: true,
        },
      ],
    });

    expect(results.map(({ passed }) => passed)).toEqual([false, false, false]);
  });

  it("rejects inherited subset properties and fails closed at the comparison budget", () => {
    const inherited = Object.create({ order_id: "synthetic-1" }) as Record<
      string,
      LocalJson
    >;
    const actualItems: LocalJson[] = [
      ...Array.from({ length: 250 }, () => 0),
      1,
    ];
    const expectedItems: LocalJson[] = Array.from(
      { length: Math.ceil(MAX_LOCAL_JSON_SUBSET_COMPARISONS / 250) + 2 },
      () => 1,
    );
    const assertions: PacketAssertion[] = [
      {
        kind: "tool_called",
        key: "own-properties-only",
        description: "does not match inherited arguments",
        tool_name: "inherited",
        arguments_contain: { order_id: "synthetic-1" },
      },
      {
        kind: "tool_called",
        key: "bounded-subset-search",
        description: "stops an adversarial subset search",
        tool_name: "budget",
        arguments_contain: { items: expectedItems },
      },
    ];
    const events: LocalTargetEvent[] = [
      {
        type: "tool_call",
        event_id: "inherited",
        tool_name: "inherited",
        call_id: "inherited",
        arguments: inherited,
      },
      {
        type: "tool_call",
        event_id: "budget",
        tool_name: "budget",
        call_id: "budget",
        arguments: { items: actualItems },
      },
    ];
    const results = evaluateLocalAssertions(assertions, {
      turns: [
        {
          protocol_version: "aw-target/0.1",
          turn_id: "turn",
          message: { role: "assistant", content: "Completed." },
          events,
          finished: true,
          metadata: {},
        },
      ],
      observations: [],
    });

    expect(results.map(({ passed }) => passed)).toEqual([false, false]);
  });
});

describe("local attempt scoring", () => {
  it("scores a completed attempt and redacts every normalized evidence surface", () => {
    const secret = "super-secret-value";
    const selected = scenario({
      assertions: [
        {
          kind: "assistant_contains",
          key: "contains",
          description: `The response omits ${secret}`,
          value: "completed",
        },
        {
          kind: "observation_equals",
          key: "state",
          description: "state is complete",
          observation_key: "order.status",
          expected: { status: "completed", note: secret },
        },
      ],
    });
    const result = scoreLocalAttempt({
      scenario: selected,
      repetitionIndex: 0,
      attemptId: ATTEMPT_ID,
      operations: operations({
        assistant: `Completed. Bearer abcdefghijklmnop ${secret}`,
        observations: [
          {
            key: "order.status",
            value: { status: "completed", note: secret },
            source: `database-${secret}`,
            authoritative: true,
          },
        ],
      }),
      secrets: [secret],
    });

    expect(result.status).toBe("passed");
    expect(result.cleanup_status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("marks an indeterminate send inconclusive, observes state, and preserves cleanup", () => {
    const records = operations();
    records[1] = {
      kind: "send",
      disposition: "outcome_indeterminate",
      turn_index: 0,
      started_at: "2026-09-02T12:00:01.000Z",
      completed_at: "2026-09-02T12:00:02.000Z",
      error: {
        code: "TARGET_OUTCOME_INDETERMINATE",
        message: "Response was lost",
      },
    };
    const result = scoreLocalAttempt({
      scenario: scenario(),
      repetitionIndex: 0,
      attemptId: ATTEMPT_ID,
      operations: records,
    });

    expect(result).toMatchObject({
      status: "inconclusive",
      cleanup_status: "completed",
      turns: [{ turn_index: 0, ambiguous: true }],
    });
    expect(result.observations).toHaveLength(1);
    expect(result.assertions).toEqual([]);
  });

  it("makes cleanup failure override deterministic assertion success", () => {
    const result = scoreLocalAttempt({
      scenario: scenario(),
      repetitionIndex: 0,
      attemptId: ATTEMPT_ID,
      operations: operations({ cleanup: "failed" }),
    });

    expect(result.status).toBe("error");
    expect(result.cleanup_status).toBe("failed");
    expect(result.errors.map(({ code }) => code)).toContain("cleanup_failed");
  });

  it("does not require cleanup for a fixture-free send-only scenario", () => {
    const selected = scenario({ fixture: {}, observation_keys: [] });
    const result = scoreLocalAttempt({
      scenario: selected,
      repetitionIndex: 0,
      attemptId: ATTEMPT_ID,
      operations: [
        {
          kind: "send",
          disposition: "completed",
          turn_index: 0,
          started_at: START,
          completed_at: "2026-09-02T12:00:01.000Z",
          result: {
            protocol_version: "aw-target/0.1",
            turn_id: "turn-1",
            message: {
              role: "assistant",
              content: "Completed the synthetic action.",
            },
            events: [],
            finished: true,
            metadata: {},
          },
        },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.cleanup_status).toBe("not_required");
  });

  it("nulls assertion actuals when duplicated evidence exceeds its cap", () => {
    const assertions: PacketAssertion[] = Array.from(
      { length: 30 },
      (_, index) => ({
        kind: "assistant_contains",
        key: `contains-${index}`,
        description: "assistant responded",
        value: "completed",
      }),
    );
    const result = scoreLocalAttempt({
      scenario: scenario({ assertions }),
      repetitionIndex: 0,
      attemptId: ATTEMPT_ID,
      operations: operations({ assistant: `Completed ${"x".repeat(10_000)}` }),
    });

    expect(result.status).toBe("error");
    expect(result.assertions).toHaveLength(30);
    expect(result.assertions.every(({ actual }) => actual === null)).toBe(true);
    expect(result.errors).toContainEqual({
      code: "attempt_evidence_too_large",
      message: "Assertion evidence exceeds the per-attempt evidence limit",
      retryable: false,
    });
  });
});

describe("local result aggregation", () => {
  it("applies threshold and error precedence conservatively", () => {
    const selected = scenario({ repetitions: 2, pass_threshold: 0.5 });
    const summaries = summarizeLocalScenarios(
      [selected],
      [
        attempt(selected),
        attempt(selected, {
          attempt_id: localAttemptId(RUN_ID, selected.key, 1),
          repetition_index: 1,
          status: "failed",
        }),
      ],
    );
    expect(summaries[0]).toMatchObject({ pass_rate: 0.5, outcome: "passed" });

    const withError = summarizeLocalScenarios(
      [selected],
      [
        attempt(selected),
        attempt(selected, {
          attempt_id: localAttemptId(RUN_ID, selected.key, 1),
          repetition_index: 1,
          status: "error",
        }),
      ],
    );
    expect(withError[0]).toMatchObject({ pass_rate: 1, outcome: "error" });
  });

  it("fills missing repetitions after cleanup failure and labels local provenance", () => {
    const first = scenario({ key: "starter.first", repetitions: 1 });
    const second = scenario({ key: "starter.second", repetitions: 2 });
    const firstAttempt = attempt(first, {
      status: "error",
      cleanup_status: "failed",
      errors: [
        { code: "cleanup_failed", message: "Cleanup failed", retryable: true },
      ],
    });
    const result = buildLocalRunResult({
      runId: RUN_ID,
      cliVersion: "0.2.0",
      packet: packet([first, second]),
      packetSha256: "a".repeat(64),
      targetName: "local-target",
      configSha256: "b".repeat(64),
      attempts: [firstAttempt],
      stoppedReason: {
        code: "not_run_after_cleanup_failure",
        message: "No later attempt ran after cleanup became unconfirmed.",
        at: "2026-09-02T12:00:05.000Z",
      },
    });

    expect(result.schema_version).toBe("AW-LOCAL-RESULT-1");
    expect(result.outcome).toBe("error");
    expect(result.attempts).toHaveLength(3);
    expect(
      result.attempts
        .slice(1)
        .every(({ cleanup_status }) => cleanup_status === "not_required"),
    ).toBe(true);
    expect(
      result.attempts.slice(1).map(({ errors }) => errors[0]?.code),
    ).toEqual([
      "not_run_after_cleanup_failure",
      "not_run_after_cleanup_failure",
    ]);
    expect(result.provenance).toMatchObject({
      execution_mode: "local",
      customer_executed: true,
      platform_received: false,
      augmentworks_verified: false,
      signed: false,
      managed_review: false,
      uploaded: false,
      cloud_contacted: false,
      trust_label: LOCAL_RESULT_TRUST_LABEL,
    });
    expect(result.result_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.results[0]?.evaluator).toBe(
      "Local deterministic packet assertions",
    );
  });

  it("fills cancellation placeholders without claiming cleanup ran", () => {
    const selected = scenario({ repetitions: 2 });
    const result = buildLocalRunResult({
      runId: RUN_ID,
      cliVersion: "0.2.0",
      packet: packet([selected]),
      packetSha256: "a".repeat(64),
      targetName: "local-target",
      configSha256: "b".repeat(64),
      attempts: [],
      stoppedReason: {
        code: "run_cancelled",
        message: "The local run was cancelled before this attempt started.",
        at: START,
      },
    });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every(({ status }) => status === "error")).toBe(
      true,
    );
    expect(
      result.attempts.every(
        ({ cleanup_status }) => cleanup_status === "not_required",
      ),
    ).toBe(true);
    expect(
      result.attempts.every(
        ({ errors }) => errors[0]?.code === "run_cancelled",
      ),
    ).toBe(true);
  });

  it("rejects a normalized local result over the run evidence cap", () => {
    const scenarios = Array.from({ length: 60 }, (_, index) =>
      scenario({
        key: `starter.large-${index}`,
        name: `Large ${index}`,
        repetitions: 1,
      }),
    );
    const attempts = scenarios.map((selected, index) =>
      attempt(selected, {
        attempt_id: localAttemptId(RUN_ID, selected.key, 0),
        turns: [
          {
            turn_index: 0,
            user_content: "user",
            assistant_content: `${index}-${"x".repeat(8_000)}`,
          },
        ],
        observations: [
          {
            key: "order.status",
            value: `completed-${"y".repeat(8_000)}`,
            source: "database",
            authoritative: true,
          },
        ],
        assertions: [
          {
            key: "large",
            kind: "assistant_contains",
            description: "large bounded assertion",
            passed: true,
            actual: `${index}-${"z".repeat(8_000)}` as LocalJson,
          },
        ],
      }),
    );

    expect(() =>
      buildLocalRunResult({
        runId: RUN_ID,
        cliVersion: "0.2.0",
        packet: packet(scenarios),
        packetSha256: "a".repeat(64),
        targetName: "local-target",
        configSha256: "b".repeat(64),
        attempts,
      }),
    ).toThrow(LocalRunResultEvidenceLimitError);
  });
});
