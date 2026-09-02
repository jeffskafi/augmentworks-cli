import { redactSecrets } from "../connector/mapping.js";
import {
  canonicalJson as canonicalLocalJson,
  findingId as localFindingId,
  sha256Json as sha256LocalJson,
  stableId,
} from "./canonical.js";
import type {
  LocalAttemptOutcome,
  LocalAttemptResult,
  LocalJson,
  LocalJsonObject,
  LocalNormalizedEvent,
  LocalObservation,
  LocalOperationRecord,
  LocalOperationResult,
  LocalRunProvenance,
  LocalRunResult,
  LocalScenarioSummary,
  LocalTargetEvent,
  PacketAssertion,
  PacketManifest,
  PacketScenario,
} from "./types.js";

export const LOCAL_RESULT_SCHEMA_VERSION = "AW-LOCAL-RESULT-1" as const;
export const LOCAL_SCORER_VERSION = "augmentworks-local-scorer/0.1.0" as const;
export const MAX_LOCAL_ATTEMPT_SECTION_BYTES = 220_000;
export const MAX_LOCAL_RUN_RESULT_BYTES = 900_000;
export const MAX_LOCAL_JSON_SUBSET_COMPARISONS = 20_000;
export const LOCAL_RESULT_TRUST_LABEL =
  "Local, customer-executed result. AugmentWorks did not receive or independently verify this run. This artifact is unsigned and is not a certification, audit, or hosted evidence record.";

const MAX_REDACTION_DEPTH = 12;
const MAX_REDACTION_STRING_CHARS = 8_000;
const MAX_REDACTION_COLLECTION_ITEMS = 200;

type SendResult = Extract<LocalOperationResult, { turn_id: string }>;

export interface LocalAssertionContext {
  readonly turns: readonly SendResult[];
  readonly observations: readonly LocalObservation[];
}

export interface ScoreLocalAttemptOptions {
  readonly scenario: PacketScenario;
  readonly repetitionIndex: number;
  readonly attemptId: string;
  readonly operations: readonly LocalOperationRecord[];
  /**
   * Override lifecycle inference when the packet manifest is available to the
   * caller. Without an override, a fixture or prepare operation requires a
   * confirmed cleanup; a fixture-free send-only scenario does not.
   */
  readonly cleanupRequired?: boolean;
  readonly stoppedReason?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
  /** @deprecated Use stoppedReason. */
  readonly interruption?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
  readonly secrets?: readonly string[];
}

export interface MissingAttemptReason {
  readonly code: "not_run_after_cleanup_failure" | "run_cancelled";
  readonly message: string;
  readonly at: string;
}

export interface BuildLocalRunResultOptions {
  readonly runId: string;
  readonly cliVersion: string;
  readonly packet: PacketManifest;
  readonly packetSha256: string;
  readonly targetName: string;
  readonly configSha256: string;
  readonly attempts: readonly LocalAttemptResult[];
  readonly stoppedReason?: MissingAttemptReason;
  /** @deprecated Use stoppedReason. */
  readonly missingAttempts?: MissingAttemptReason;
  readonly scorerVersion?: string;
  readonly secrets?: readonly string[];
}

export class LocalRunResultEvidenceLimitError extends Error {
  readonly code = "local_run_result_too_large";

  constructor() {
    super(
      "normalized local run result exceeds the configured evidence size limit",
    );
    this.name = "LocalRunResultEvidenceLimitError";
  }
}

export function evaluateLocalAssertions(
  assertions: readonly PacketAssertion[],
  context: LocalAssertionContext,
  secrets: readonly string[] = [],
): LocalAttemptResult["assertions"] {
  return assertions.map((assertion) => {
    const [passed, actual] = evaluateAssertion(assertion, context);
    return {
      key: assertion.key,
      kind: assertion.kind,
      description: redactText(assertion.description, secrets),
      passed,
      actual: redactAndBoundJson(actual, secrets),
    };
  });
}

export function scoreLocalAttempt(
  options: ScoreLocalAttemptOptions,
): LocalAttemptResult {
  const { scenario, repetitionIndex, attemptId, operations } = options;
  const secrets = options.secrets ?? [];
  const stoppedReason = options.stoppedReason ?? options.interruption;
  if (operations.length === 0) {
    throw new Error(
      "A started local attempt requires at least one operation record",
    );
  }
  if (!Number.isSafeInteger(repetitionIndex) || repetitionIndex < 0) {
    throw new Error(
      "A local attempt repetition index must be a non-negative integer",
    );
  }

  const rawTurns: SendResult[] = [];
  const rawObservations: LocalObservation[] = [];
  let turns: LocalAttemptResult["turns"] = [];
  let observations: LocalAttemptResult["observations"] = [];
  const errors: LocalAttemptResult["errors"] = [];
  let ambiguousSend = false;
  let operationFailed = stoppedReason !== undefined;
  let visibleOutputTooLarge = false;
  const cleanupRequired =
    options.cleanupRequired ??
    (Object.keys(scenario.fixture).length > 0 ||
      operations.some(({ kind }) => kind === "prepare"));
  let cleanupStatus: LocalAttemptResult["cleanup_status"] = cleanupRequired
    ? "failed"
    : "not_required";

  if (stoppedReason !== undefined) {
    addError(errors, normalizeError(stoppedReason, secrets));
  }

  const seenTurnIndexes = new Set<number>();
  for (const operation of operations) {
    assertTimestamp(operation.started_at, "operation start");
    assertTimestamp(operation.completed_at, "operation completion");
    if (Date.parse(operation.completed_at) < Date.parse(operation.started_at)) {
      throw new Error("A local operation cannot complete before it starts");
    }

    if (operation.disposition !== "completed") {
      const failure = operation.error ?? {
        code: "local_operation_failed",
        message: "The local operation did not return a terminal result",
        retryable: false,
      };
      if (operation.kind === "cleanup") {
        cleanupStatus = "failed";
        addError(errors, cleanupError());
        addError(errors, normalizeError(failure, secrets));
        continue;
      }
      addError(errors, normalizeError(failure, secrets));
      if (
        operation.kind === "send" &&
        operation.disposition === "outcome_indeterminate"
      ) {
        ambiguousSend = true;
        const index =
          operation.turn_index ?? nextUnseenTurnIndex(seenTurnIndexes);
        if (!validTurnIndex(index, scenario)) {
          operationFailed = true;
          addError(
            errors,
            protocolError("Send operation referenced an unknown packet turn"),
          );
          continue;
        }
        seenTurnIndexes.add(index);
        const ambiguousTurn: LocalAttemptResult["turns"][number] = {
          turn_index: index,
          user_content: redactText(scenario.turns[index]!.content, secrets),
          ambiguous: true,
        };
        if (
          projectionSize([...turns, ambiguousTurn] as unknown as LocalJson) <=
          MAX_LOCAL_ATTEMPT_SECTION_BYTES
        ) {
          turns = [...turns, ambiguousTurn];
        } else {
          visibleOutputTooLarge = true;
          operationFailed = true;
          addError(errors, visibleOutputLimitError());
        }
      } else {
        operationFailed = true;
      }
      continue;
    }

    if (operation.result === undefined) {
      operationFailed = true;
      addError(errors, protocolError("Completed operation omitted its result"));
      continue;
    }
    const result = operation.result;

    if (operation.kind === "prepare") {
      if (!isPrepareResult(result) || result.attempt_id !== attemptId) {
        operationFailed = true;
        addError(
          errors,
          protocolError("Prepare result did not match the local attempt"),
        );
      }
      continue;
    }

    if (operation.kind === "send") {
      if (visibleOutputTooLarge) continue;
      if (!isSendResult(result)) {
        operationFailed = true;
        addError(
          errors,
          protocolError("Send operation returned an incompatible result"),
        );
        continue;
      }
      const index =
        operation.turn_index ?? nextUnseenTurnIndex(seenTurnIndexes);
      if (!validTurnIndex(index, scenario) || seenTurnIndexes.has(index)) {
        operationFailed = true;
        addError(
          errors,
          protocolError(
            "Send operation duplicated or referenced an unknown packet turn",
          ),
        );
        continue;
      }
      seenTurnIndexes.add(index);
      const normalizedTurn: LocalAttemptResult["turns"][number] = {
        turn_index: index,
        user_content: redactText(scenario.turns[index]!.content, secrets),
        assistant_content: redactText(result.message.content, secrets),
        finish_reason:
          result.message.finish_reason === undefined ||
          result.message.finish_reason === null
            ? null
            : redactText(result.message.finish_reason, secrets),
        events: result.events.map((event) => normalizeEvent(event, secrets)),
        ambiguous: false,
      };
      if (
        projectionSize([...turns, normalizedTurn] as unknown as LocalJson) >
        MAX_LOCAL_ATTEMPT_SECTION_BYTES
      ) {
        visibleOutputTooLarge = true;
        operationFailed = true;
        turns = [];
        addError(errors, visibleOutputLimitError());
        continue;
      }
      rawTurns.push(result);
      turns = [...turns, normalizedTurn];
      continue;
    }

    if (operation.kind === "observe") {
      if (!isObserveResult(result)) {
        operationFailed = true;
        addError(
          errors,
          protocolError("Observe operation returned an incompatible result"),
        );
        continue;
      }
      const requested = new Set(scenario.observation_keys);
      const observedKeys = result.observations.map(({ key }) => key);
      if (
        new Set(observedKeys).size !== observedKeys.length ||
        observedKeys.some((key) => !requested.has(key))
      ) {
        operationFailed = true;
        addError(
          errors,
          protocolError(
            new Set(observedKeys).size !== observedKeys.length
              ? "Target returned a duplicate observation"
              : "Target returned an observation the local packet did not request",
          ),
        );
        continue;
      }
      rawObservations.push(...result.observations);
      continue;
    }

    if (!isCleanupResult(result) || result.attempt_id !== attemptId) {
      cleanupStatus = "failed";
      addError(errors, cleanupError());
    } else {
      cleanupStatus = "completed";
    }
  }

  if (cleanupStatus === "failed") addError(errors, cleanupError());

  observations = rawObservations.map((observation) =>
    normalizeObservation(observation, secrets),
  );
  let observationEvidenceTooLarge = false;
  if (
    projectionSize(observations as unknown as LocalJson) >
    MAX_LOCAL_ATTEMPT_SECTION_BYTES
  ) {
    observations = [];
    observationEvidenceTooLarge = true;
    addError(errors, observationLimitError());
  }

  let assertions: LocalAttemptResult["assertions"] = [];
  let status: LocalAttemptOutcome;
  if (stoppedReason !== undefined) status = "error";
  else if (ambiguousSend) status = "inconclusive";
  else if (operationFailed) status = "error";
  else {
    assertions = evaluateLocalAssertions(
      scenario.assertions,
      { turns: rawTurns, observations: rawObservations },
      secrets,
    );
    status = assertions.every(({ passed }) => passed) ? "passed" : "failed";
  }

  if (
    projectionSize(assertions as unknown as LocalJson) >
    MAX_LOCAL_ATTEMPT_SECTION_BYTES
  ) {
    assertions = assertions.map((assertion) => ({
      ...assertion,
      actual: null,
    }));
    addError(errors, assertionLimitError());
    status = "error";
  }
  if (observationEvidenceTooLarge || cleanupStatus === "failed")
    status = "error";

  const startedAt = operations[0]!.started_at;
  const completedAt = operations.at(-1)!.completed_at;
  return {
    attempt_id: attemptId,
    scenario_key: scenario.key,
    repetition_index: repetitionIndex,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    turns: [...turns].sort((left, right) => left.turn_index - right.turn_index),
    observations,
    assertions,
    errors,
    cleanup_status: cleanupStatus,
  };
}

export function createMissingLocalAttempt(options: {
  readonly runId: string;
  readonly scenario: PacketScenario;
  readonly repetitionIndex: number;
  readonly reason: MissingAttemptReason;
}): LocalAttemptResult {
  assertTimestamp(options.reason.at, "missing-attempt timestamp");
  return {
    attempt_id: localAttemptId(
      options.runId,
      options.scenario.key,
      options.repetitionIndex,
    ),
    scenario_key: options.scenario.key,
    repetition_index: options.repetitionIndex,
    status: "error",
    started_at: options.reason.at,
    completed_at: options.reason.at,
    turns: [],
    observations: [],
    assertions: [],
    errors: [
      {
        code: options.reason.code,
        message: options.reason.message,
        retryable: false,
      },
    ],
    cleanup_status: "not_required",
  };
}

export function buildLocalRunResult(
  options: BuildLocalRunResultOptions,
): LocalRunResult {
  const packet = options.packet;
  const secrets = options.secrets ?? [];
  const attempts = completeAttemptMatrix(options);
  const normalizedAttempts = attempts.map((attempt) =>
    redactAttempt(attempt, secrets),
  );
  const scenarios = summarizeLocalScenarios(
    packet.scenarios,
    normalizedAttempts,
  ).map((scenario) => ({
    ...scenario,
    name: redactText(scenario.name, secrets),
    description: redactText(scenario.description, secrets),
    expected_behavior: redactText(scenario.expected_behavior, secrets),
  }));
  const counts = {
    scenarios: scenarios.length,
    attempts: normalizedAttempts.length,
    passed: normalizedAttempts.filter(({ status }) => status === "passed")
      .length,
    failed: normalizedAttempts.filter(({ status }) => status === "failed")
      .length,
    inconclusive: normalizedAttempts.filter(
      ({ status }) => status === "inconclusive",
    ).length,
    errors: normalizedAttempts.filter(({ status }) => status === "error")
      .length,
  };
  const outcome = aggregateLocalOutcome(
    scenarios.map(({ outcome: value }) => value),
  );
  const completedAt = latestTimestamp(
    normalizedAttempts.map(({ completed_at }) => completed_at),
  );
  const testedAt = earliestTimestamp(
    normalizedAttempts.map(({ started_at }) => started_at),
  );
  const provenance: LocalRunProvenance = {
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
    trust_label: LOCAL_RESULT_TRUST_LABEL,
  };

  const withoutHash = {
    schema_version: LOCAL_RESULT_SCHEMA_VERSION,
    run_id: options.runId,
    cli_version: options.cliVersion,
    scorer_version: options.scorerVersion ?? LOCAL_SCORER_VERSION,
    packet: {
      id: packet.packet_id,
      version: packet.version,
      sha256: options.packetSha256,
      name: redactText(packet.name, secrets),
    },
    target: {
      name: redactText(options.targetName, secrets),
      config_sha256: options.configSha256,
    },
    tested_at: testedAt,
    completed_at: completedAt,
    outcome,
    counts,
    requirements: packet.scenarios.map((scenario) => ({
      key: scenario.key,
      statement: redactText(scenario.expected_behavior, secrets),
      severity: scenario.severity,
    })),
    results: scenarios.map((scenario) => ({
      scenario_key: scenario.scenario_key,
      title: scenario.name,
      category: scenario.category,
      requirement_key: scenario.scenario_key,
      expected_behavior: scenario.expected_behavior,
      outcome: {
        passed: "pass",
        failed: "fail",
        inconclusive: "uncertain",
        error: "error",
      }[scenario.outcome] as "pass" | "fail" | "uncertain" | "error",
      score: scenario.pass_rate ?? 0,
      evaluator: "Local deterministic packet assertions",
      evidence_summary:
        `${scenario.passed}/${scenario.repetitions} repetitions passed; ` +
        `${scenario.failed} failed, ${scenario.inconclusive} uncertain, ` +
        `and ${scenario.errors} errored. Required pass rate: ${formatPercent(
          scenario.pass_threshold,
        )}.`,
      repetitions: {
        total: scenario.repetitions,
        passed: scenario.passed,
        failed: scenario.failed,
        uncertain: scenario.inconclusive,
        errors: scenario.errors,
        pass_rate: scenario.pass_rate,
        pass_threshold: scenario.pass_threshold,
      },
    })),
    findings: scenarios
      .filter(({ outcome: value }) => value !== "passed")
      .map((scenario) => ({
        id: localFindingId(
          options.runId,
          scenario.scenario_key,
          scenario.outcome,
        ),
        title: `${scenario.name}: ${scenario.outcome}`,
        severity: scenario.severity,
        status: "open" as const,
        category: scenario.category,
        description:
          `${scenario.name} ${outcomeLabel(scenario.outcome)}. ` +
          `${scenario.passed}/${scenario.repetitions} synthetic repetitions passed. ` +
          "Review the bounded failed-attempt details locally.",
        remediation: null,
        scenarioKey: scenario.scenario_key,
      })),
    repetitions: {
      total: counts.attempts,
      passed: counts.passed,
      failed: counts.failed,
      uncertain: counts.inconclusive,
      errors: counts.errors,
    },
    scenarios,
    attempts: normalizedAttempts,
    redaction_applied: true as const,
    provenance,
  };
  const resultSha256 = sha256LocalJson(withoutHash as unknown as LocalJson);
  const result = {
    ...withoutHash,
    result_sha256: resultSha256,
  } as LocalRunResult;
  if (
    projectionSize(result as unknown as LocalJson) > MAX_LOCAL_RUN_RESULT_BYTES
  ) {
    throw new LocalRunResultEvidenceLimitError();
  }
  return result;
}

export function summarizeLocalScenarios(
  scenarios: readonly PacketScenario[],
  attempts: readonly LocalAttemptResult[],
): LocalScenarioSummary[] {
  return scenarios.map((scenario) => {
    const selected = attempts.filter(
      ({ scenario_key }) => scenario_key === scenario.key,
    );
    const indexes = selected.map(({ repetition_index }) => repetition_index);
    if (
      selected.length !== scenario.repetitions ||
      new Set(indexes).size !== indexes.length ||
      indexes.some((index) => index < 0 || index >= scenario.repetitions)
    ) {
      throw new Error(
        `Scenario ${scenario.key} does not contain its exact repetitions`,
      );
    }
    const passed = selected.filter(({ status }) => status === "passed").length;
    const failed = selected.filter(({ status }) => status === "failed").length;
    const inconclusive = selected.filter(
      ({ status }) => status === "inconclusive",
    ).length;
    const errors = selected.filter(({ status }) => status === "error").length;
    const usable = passed + failed;
    const passRate = usable === 0 ? null : passed / usable;
    const outcome: LocalAttemptOutcome = errors
      ? "error"
      : inconclusive
        ? "inconclusive"
        : passRate !== null && passRate >= scenario.pass_threshold
          ? "passed"
          : "failed";
    return {
      scenario_key: scenario.key,
      name: scenario.name,
      category: scenario.category,
      severity: scenario.severity,
      description: scenario.description,
      expected_behavior: scenario.expected_behavior,
      repetitions: selected.length,
      passed,
      failed,
      inconclusive,
      errors,
      pass_rate: passRate,
      pass_threshold: scenario.pass_threshold,
      outcome,
    };
  });
}

export function aggregateLocalOutcome(
  outcomes: readonly LocalAttemptOutcome[],
): LocalAttemptOutcome {
  if (outcomes.includes("error")) return "error";
  if (outcomes.includes("inconclusive")) return "inconclusive";
  if (outcomes.includes("failed")) return "failed";
  return "passed";
}

export function localAttemptId(
  runId: string,
  scenarioKey: string,
  repetitionIndex: number,
): string {
  return stableId("local_attempt", runId, scenarioKey, String(repetitionIndex));
}

function completeAttemptMatrix(
  options: BuildLocalRunResultOptions,
): LocalAttemptResult[] {
  const expected = new Map<
    string,
    { scenario: PacketScenario; repetitionIndex: number }
  >();
  for (const scenario of options.packet.scenarios) {
    for (
      let repetitionIndex = 0;
      repetitionIndex < scenario.repetitions;
      repetitionIndex += 1
    ) {
      expected.set(`${scenario.key}:${repetitionIndex}`, {
        scenario,
        repetitionIndex,
      });
    }
  }
  const actual = new Map<string, LocalAttemptResult>();
  for (const attempt of options.attempts) {
    const key = `${attempt.scenario_key}:${attempt.repetition_index}`;
    if (!expected.has(key) || actual.has(key)) {
      throw new Error("A local run contains an unknown or duplicate attempt");
    }
    actual.set(key, attempt);
  }
  const stoppedReason = options.stoppedReason ?? options.missingAttempts;
  if (actual.size !== expected.size && stoppedReason === undefined) {
    throw new Error(
      "A local result requires every packet repetition or an explicit stop reason",
    );
  }
  return [...expected.entries()].map(([key, cursor]) => {
    const attempt = actual.get(key);
    if (attempt !== undefined) return attempt;
    return createMissingLocalAttempt({
      runId: options.runId,
      scenario: cursor.scenario,
      repetitionIndex: cursor.repetitionIndex,
      reason: stoppedReason!,
    });
  });
}

function evaluateAssertion(
  assertion: PacketAssertion,
  context: LocalAssertionContext,
): [boolean, LocalJson] {
  if (
    assertion.kind === "assistant_contains" ||
    assertion.kind === "assistant_not_contains"
  ) {
    const content = turnContent(context.turns, assertion.turn_index ?? -1);
    if (content === null) return [false, null];
    const actual = assertion.case_sensitive
      ? content
      : content.toLocaleLowerCase("en-US");
    const expected = assertion.case_sensitive
      ? assertion.value
      : assertion.value.toLocaleLowerCase("en-US");
    const contains = actual.includes(expected);
    return [
      assertion.kind === "assistant_not_contains" ? !contains : contains,
      content,
    ];
  }

  const events = context.turns.flatMap(({ events }) => events);
  if (assertion.kind === "tool_called") {
    const calls = toolCalls(events, assertion.tool_name);
    const comparisonBudget = jsonComparisonBudget();
    const matches = calls.filter((event) =>
      containsJson(
        event.arguments,
        assertion.arguments_contain ?? {},
        comparisonBudget,
      ),
    );
    return [
      matches.length >= (assertion.min_calls ?? 1) &&
        (assertion.max_calls === undefined ||
          calls.length <= assertion.max_calls),
      {
        total_calls: calls.length,
        matching_calls: matches.length,
        arguments: calls.map(({ arguments: value }) => value),
      },
    ];
  }
  if (assertion.kind === "tool_not_called") {
    const calls = toolCalls(events, assertion.tool_name);
    return [calls.length === 0, { matching_calls: calls.length }];
  }
  if (assertion.kind === "tool_result") {
    const calls = toolCalls(events, assertion.tool_name);
    const comparisonBudget = jsonComparisonBudget();
    const results = events.filter(
      (event): event is Extract<LocalTargetEvent, { type: "tool_result" }> =>
        event.type === "tool_result" && event.tool_name === assertion.tool_name,
    );
    const matches = results.filter(
      (event) =>
        event.success === assertion.success &&
        containsJson(
          event.output,
          assertion.output_contains ?? null,
          comparisonBudget,
        ),
    );
    const callIds = calls.map(({ call_id }) => call_id);
    const resultIds = results.map(({ call_id }) => call_id);
    const correlated =
      new Set(callIds).size === callIds.length &&
      new Set(resultIds).size === resultIds.length &&
      setEquals(new Set(callIds), new Set(resultIds));
    return [
      calls.length === 1 &&
        results.length === 1 &&
        matches.length === 1 &&
        correlated,
      {
        total_calls: calls.length,
        total_results: results.length,
        matching_results: matches.length,
        correlated,
        outputs: results.map(({ output }) => output),
      },
    ];
  }
  if (assertion.kind === "observation_equals") {
    const matches = context.observations.filter(
      ({ key }) => key === assertion.observation_key,
    );
    const passed =
      matches.length === 1 &&
      (matches[0]!.authoritative || assertion.authoritative_only === false) &&
      jsonEquals(matches[0]!.value, assertion.expected ?? null);
    return [
      passed,
      matches.map(({ value, source, authoritative }) => ({
        value,
        source,
        authoritative,
      })),
    ];
  }
  if (assertion.kind === "observation_absent") {
    const values = context.observations
      .filter(({ key }) => key === assertion.observation_key)
      .map(({ value }) => value);
    return [values.length === 0, values];
  }
  if (assertion.kind === "handoff_occurred") {
    const handoffs = events.filter(
      (event): event is Extract<LocalTargetEvent, { type: "handoff" }> =>
        event.type === "handoff" &&
        (assertion.destination === undefined ||
          event.destination === assertion.destination),
    );
    return [
      handoffs.length > 0,
      handoffs.map(({ destination, reason }) => ({
        destination,
        reason: reason ?? null,
      })),
    ];
  }
  const errorEvents = events.filter(
    (event): event is Extract<LocalTargetEvent, { type: "error" }> =>
      event.type === "error",
  );
  return [
    errorEvents.length === 0,
    errorEvents.map(({ code, message, retryable }) => ({
      code,
      message,
      retryable,
    })),
  ];
}

function normalizeEvent(
  event: LocalTargetEvent,
  secrets: readonly string[],
): LocalNormalizedEvent {
  const { type, event_id, sequence, ...data } = event;
  return {
    type: redactText(type, secrets),
    event_id: redactText(event_id, secrets),
    ...(sequence === undefined ? {} : { sequence }),
    data: redactAndBoundJson(data as LocalJson, secrets) as LocalJsonObject,
  };
}

function normalizeObservation(
  observation: LocalObservation,
  secrets: readonly string[],
): LocalObservation {
  return {
    key: redactText(observation.key, secrets),
    value: redactAndBoundJson(observation.value, secrets),
    source: redactText(observation.source, secrets),
    authoritative: observation.authoritative,
  };
}

function redactAttempt(
  attempt: LocalAttemptResult,
  secrets: readonly string[],
): LocalAttemptResult {
  let status = attempt.status;
  const errors = attempt.errors.map((error) => normalizeError(error, secrets));
  let turns = attempt.turns.map((turn) => ({
    turn_index: turn.turn_index,
    user_content: redactText(turn.user_content, secrets),
    ...(turn.assistant_content === undefined
      ? {}
      : {
          assistant_content:
            turn.assistant_content === null
              ? null
              : redactText(turn.assistant_content, secrets),
        }),
    ...(turn.finish_reason === undefined
      ? {}
      : {
          finish_reason:
            turn.finish_reason === null
              ? null
              : redactText(turn.finish_reason, secrets),
        }),
    ...(turn.events === undefined
      ? {}
      : {
          events: turn.events.map((event) => ({
            type: redactText(event.type, secrets),
            event_id: redactText(event.event_id, secrets),
            ...(event.sequence === undefined
              ? {}
              : { sequence: event.sequence }),
            data: redactAndBoundJson(event.data, secrets) as LocalJsonObject,
          })),
        }),
    ...(turn.ambiguous === undefined ? {} : { ambiguous: turn.ambiguous }),
  }));
  if (
    projectionSize(turns as unknown as LocalJson) >
    MAX_LOCAL_ATTEMPT_SECTION_BYTES
  ) {
    turns = [];
    status = "error";
    addError(errors, visibleOutputLimitError());
  }
  let observations = attempt.observations.map((observation) =>
    normalizeObservation(observation, secrets),
  );
  if (
    projectionSize(observations as unknown as LocalJson) >
    MAX_LOCAL_ATTEMPT_SECTION_BYTES
  ) {
    observations = [];
    status = "error";
    addError(errors, observationLimitError());
  }
  let assertions = attempt.assertions.map((assertion) => ({
    ...assertion,
    description: redactText(assertion.description, secrets),
    actual: redactAndBoundJson(assertion.actual, secrets),
  }));
  if (
    projectionSize(assertions as unknown as LocalJson) >
    MAX_LOCAL_ATTEMPT_SECTION_BYTES
  ) {
    assertions = assertions.map((assertion) => ({
      ...assertion,
      actual: null,
    }));
    status = "error";
    addError(errors, assertionLimitError());
  }
  if (attempt.cleanup_status === "failed") {
    status = "error";
    addError(errors, cleanupError());
  }
  return { ...attempt, status, turns, observations, assertions, errors };
}

function redactAndBoundJson(
  value: LocalJson,
  secrets: readonly string[],
): LocalJson {
  return boundJson(redactSecrets(value, secrets) as LocalJson, 0);
}

function boundJson(value: LocalJson, depth: number): LocalJson {
  if (
    depth >= MAX_REDACTION_DEPTH &&
    (Array.isArray(value) || (value !== null && typeof value === "object"))
  ) {
    return "[TRUNCATED: maximum depth]";
  }
  if (typeof value === "string") {
    const characters = [...value];
    if (characters.length <= MAX_REDACTION_STRING_CHARS) return value;
    const omitted = characters.length - MAX_REDACTION_STRING_CHARS;
    return `${characters.slice(0, MAX_REDACTION_STRING_CHARS).join("")}…[TRUNCATED ${omitted} chars]`;
  }
  if (Array.isArray(value)) {
    const bounded = value
      .slice(0, MAX_REDACTION_COLLECTION_ITEMS)
      .map((item) => boundJson(item, depth + 1));
    if (value.length > bounded.length) {
      bounded.push(`[TRUNCATED ${value.length - bounded.length} items]`);
    }
    return bounded;
  }
  if (value !== null && typeof value === "object") {
    const output: LocalJsonObject = {};
    const entries = Object.entries(value);
    for (const [key, child] of entries.slice(
      0,
      MAX_REDACTION_COLLECTION_ITEMS,
    )) {
      output[key] = boundJson(child, depth + 1);
    }
    if (entries.length > MAX_REDACTION_COLLECTION_ITEMS) {
      output["__truncated__"] = entries.length - MAX_REDACTION_COLLECTION_ITEMS;
    }
    return output;
  }
  return value;
}

function redactText(value: string, secrets: readonly string[]): string {
  return boundJson(redactSecrets(value, secrets), 0) as string;
}

function normalizeError(
  error: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  },
  secrets: readonly string[],
): LocalAttemptResult["errors"][number] {
  return {
    code: redactText(error.code.slice(0, 200), secrets),
    message: redactText(error.message.slice(0, 1_000), secrets),
    retryable: error.retryable ?? false,
  };
}

function protocolError(message: string): LocalAttemptResult["errors"][number] {
  return { code: "invalid_local_result", message, retryable: false };
}

function cleanupError(): LocalAttemptResult["errors"][number] {
  return {
    code: "cleanup_failed",
    message: "The target did not confirm synthetic attempt cleanup",
    retryable: true,
  };
}

function visibleOutputLimitError(): LocalAttemptResult["errors"][number] {
  return {
    code: "attempt_evidence_too_large",
    message: "Visible target output exceeds the per-attempt evidence limit",
    retryable: false,
  };
}

function observationLimitError(): LocalAttemptResult["errors"][number] {
  return {
    code: "attempt_evidence_too_large",
    message: "State observations exceed the per-attempt evidence limit",
    retryable: false,
  };
}

function assertionLimitError(): LocalAttemptResult["errors"][number] {
  return {
    code: "attempt_evidence_too_large",
    message: "Assertion evidence exceeds the per-attempt evidence limit",
    retryable: false,
  };
}

function addError(
  errors: LocalAttemptResult["errors"],
  error: LocalAttemptResult["errors"][number],
): void {
  if (
    error.code === "cleanup_failed" &&
    errors.some(({ code }) => code === error.code)
  )
    return;
  errors.push(error);
}

function turnContent(
  turns: readonly SendResult[],
  index: number,
): string | null {
  if (turns.length === 0) return null;
  const normalized = index < 0 ? turns.length + index : index;
  return turns[normalized]?.message.content ?? null;
}

function toolCalls(events: readonly LocalTargetEvent[], toolName: string) {
  return events.filter(
    (event): event is Extract<LocalTargetEvent, { type: "tool_call" }> =>
      event.type === "tool_call" && event.tool_name === toolName,
  );
}

interface JsonComparisonBudget {
  remaining: number;
  exhausted: boolean;
}

function jsonComparisonBudget(): JsonComparisonBudget {
  return { remaining: MAX_LOCAL_JSON_SUBSET_COMPARISONS, exhausted: false };
}

function containsJson(
  actual: LocalJson,
  expected: LocalJson,
  budget: JsonComparisonBudget = jsonComparisonBudget(),
): boolean {
  if (budget.remaining === 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= 1;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    for (const wanted of expected) {
      let found = false;
      for (const item of actual) {
        if (budget.exhausted) return false;
        if (containsJson(item, wanted, budget)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }
  if (isJsonObject(expected)) {
    if (!isJsonObject(actual)) return false;
    for (const [key, value] of Object.entries(expected)) {
      if (
        !Object.hasOwn(actual, key) ||
        !containsJson(actual[key]!, value, budget)
      ) {
        return false;
      }
    }
    return true;
  }
  return Object.is(actual, expected) || actual === expected;
}

function jsonEquals(left: LocalJson, right: LocalJson): boolean {
  return canonicalLocalJson(left) === canonicalLocalJson(right);
}

function isJsonObject(value: LocalJson): value is LocalJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setEquals(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function isPrepareResult(
  result: LocalOperationResult,
): result is Extract<LocalOperationResult, { status: "ready" }> {
  return "status" in result && result.status === "ready";
}

function isSendResult(result: LocalOperationResult): result is SendResult {
  return "turn_id" in result;
}

function isObserveResult(
  result: LocalOperationResult,
): result is Extract<LocalOperationResult, { request_id: string }> {
  return "request_id" in result;
}

function isCleanupResult(
  result: LocalOperationResult,
): result is Extract<LocalOperationResult, { status: "cleaned" }> {
  return "status" in result && result.status === "cleaned";
}

function validTurnIndex(index: number, scenario: PacketScenario): boolean {
  return (
    Number.isSafeInteger(index) && index >= 0 && index < scenario.turns.length
  );
}

function nextUnseenTurnIndex(seen: ReadonlySet<number>): number {
  let index = 0;
  while (seen.has(index)) index += 1;
  return index;
}

function projectionSize(value: LocalJson): number {
  return Buffer.byteLength(canonicalLocalJson(value), "utf8");
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`Local ${label} is invalid`);
}

function earliestTimestamp(values: readonly string[]): string {
  if (values.length === 0)
    throw new Error("Cannot select a timestamp from an empty local run");
  return values.reduce((earliest, value) =>
    Date.parse(value) < Date.parse(earliest) ? value : earliest,
  );
}

function latestTimestamp(values: readonly string[]): string {
  if (values.length === 0)
    throw new Error("Cannot select a timestamp from an empty local run");
  return values.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function outcomeLabel(outcome: LocalAttemptOutcome): string {
  return {
    passed: "passed",
    failed: "failed its deterministic assertions",
    inconclusive: "had an ambiguous or inconclusive execution",
    error: "could not be completed",
  }[outcome];
}
