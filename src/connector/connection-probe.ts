import { randomBytes } from "node:crypto";

import type { Diagnostic, JsonValue, ResolvedConfig } from "../config/types.js";
import { CONVERSATION_STRATEGY_EXPLICIT_SESSION } from "../config/conversation.js";
import { AwError, EXIT, type OperationKind } from "../errors.js";
import { redactText } from "./mapping.js";
import { previewMapping, type MappingPreviewReport } from "./mapping-preview.js";
import { HttpConnector } from "./http.js";
import type { ConnectorExecutionContext } from "./types.js";
import { LIMITS } from "../util/limits.js";

export const CONNECTION_PROBE_SCHEMA_VERSION = "AW-CONNECTION-PROBE-1" as const;

export const CONNECTION_PROBE_DISCLAIMER =
  "This probe is an integration check of endpoint reachability, authentication, response selectors, optional session identifiers, and cleanup. It is not a semantic assessment of chatbot quality, consumes no AugmentWorks credits, and does not contact the hosted API.";

export const PROBE_ACK_MESSAGE = "[aw-connection-probe] Reply with the token probe-ack.";
export const PROBE_SESSION_TURN_ONE = "[aw-connection-probe] The probe color is teal.";
export const PROBE_SESSION_TURN_TWO = "[aw-connection-probe] What color did I just say?";

export const PROBE_OVERALL_TIMEOUT_MS = 45_000;
export const PROBE_MAX_CALLS = 5;

export type ProbePattern = "response-only" | "stateful";
export type ProbePhase = "prepare" | "send" | "send_followup" | "observe" | "cleanup";
export type ProbeFailureClass =
  | "connection_refusal"
  | "timeout"
  | "authentication"
  | "response_selector"
  | "conversation_session"
  | "cleanup"
  | "target";

export interface ProbePlannedCall {
  readonly phase: ProbePhase;
  readonly kind: OperationKind;
  readonly method: string;
  readonly path: string;
  readonly purpose: string;
}

export interface ProbePreflight {
  readonly pattern: ProbePattern;
  readonly conversation_strategy: ResolvedConfig["conversation"]["strategy"];
  readonly operations: readonly ProbePlannedCall[];
  readonly call_count: number;
  readonly time_limit_ms: number;
  readonly request_bytes_limit: number;
  readonly response_bytes_limit: number;
  readonly synthetic_side_effects: readonly string[];
  readonly cleanup: "none" | "always";
  readonly hosted_work: "none";
  readonly confirmation: string;
}

export interface ProbeCallRecord {
  readonly phase: ProbePhase;
  readonly kind: OperationKind;
  readonly ok: boolean;
  readonly http_status: number | null;
  readonly duration_ms: number;
  readonly mapping_ok: boolean | null;
  readonly evidence_sha256: string | null;
}

export interface ProbeCorrelation {
  readonly probe_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly conversation_id: string | null;
  readonly turn_ids: readonly string[];
}

export interface ConnectionProbeReport {
  readonly schema_version: typeof CONNECTION_PROBE_SCHEMA_VERSION;
  readonly ok: boolean;
  readonly executed: boolean;
  readonly credits_consumed: 0;
  readonly hosted_contacted: false;
  readonly pattern: ProbePattern;
  readonly conversation_strategy: ResolvedConfig["conversation"]["strategy"];
  readonly config_path: string;
  readonly correlation: ProbeCorrelation;
  readonly preflight: ProbePreflight;
  readonly calls: readonly ProbeCallRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly failed_phase: ProbePhase | null;
  readonly failure_class: ProbeFailureClass | null;
  readonly corrective_action: string | null;
  readonly disclaimer: typeof CONNECTION_PROBE_DISCLAIMER;
}

export interface RunConnectionProbeOptions {
  readonly resolved: ResolvedConfig;
  readonly execute?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

const SELECTOR_CODES = new Set([
  "MAPPING_VALUE_MISSING",
  "REQUIRED_FIELD_MISSING",
  "INVALID_SELECTOR",
  "UNSAFE_SELECTOR",
  "MAPPING_PREVIEW_FAILED",
  "TARGET_JSON_INVALID",
  "TARGET_CONTENT_TYPE_INVALID",
  "TARGET_RESPONSE_EMPTY"
]);

const SESSION_CODES = new Set([
  "SESSION_CONVERSATION_ID_MISSING",
  "CONVERSATION_IDENTITY_MISMATCH",
  "SESSION_CONVERSATION_ID_UNMAPPED"
]);

const TIMEOUT_CODES = new Set(["TARGET_TIMEOUT", "OPERATION_CANCELLED"]);
const UNREACHABLE_CODES = new Set(["TARGET_UNREACHABLE"]);
const CONNECTION_ERRNO = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"]);

export function probePatternFor(resolved: ResolvedConfig): ProbePattern {
  return resolved.capabilities.level === "stateful" ? "stateful" : "response-only";
}

export function createProbeId(randomId?: () => string): string {
  if (randomId !== undefined) return randomId();
  return `probe_${randomBytes(8).toString("hex")}`;
}

export function planConnectionProbe(resolved: ResolvedConfig): ProbePreflight {
  const operations = resolved.config.target.operations;
  const pattern = probePatternFor(resolved);
  const session = resolved.conversation.strategy === CONVERSATION_STRATEGY_EXPLICIT_SESSION;
  const planned: ProbePlannedCall[] = [];

  if (pattern === "stateful") {
    planned.push(describeOperation(resolved, "prepare", "prepare", "Create one synthetic in-memory fixture keyed by this probe attempt."));
  }

  planned.push(
    describeOperation(
      resolved,
      "send",
      "send",
      session
        ? "Deliver the first synthetic probe turn, including the attempt-scoped conversation identifier."
        : "Deliver one synthetic probe message to the mapped send endpoint."
    )
  );

  if (session) {
    planned.push(
      describeOperation(
        resolved,
        "send",
        "send_followup",
        "Deliver a second turn with the same conversation identifier to confirm the session field is accepted. Success is not a claim that the chatbot remembered a fact."
      )
    );
  }

  if (pattern === "stateful") {
    planned.push(
      describeOperation(
        resolved,
        "observe",
        "observe",
        "Read only allowlisted synthetic observer fields for this probe fixture."
      )
    );
    planned.push(
      describeOperation(
        resolved,
        "cleanup",
        "cleanup",
        "Delete the synthetic probe fixture. Cleanup runs even if a later step fails."
      )
    );
  }

  if (planned.length > PROBE_MAX_CALLS) {
    throw new AwError({
      code: "PROBE_PLAN_TOO_LARGE",
      category: "config",
      message: `Connection probe would make ${String(planned.length)} calls; the bound is ${String(PROBE_MAX_CALLS)}.`
    });
  }

  const requestBytes = Math.min(
    resolved.config.target.limits?.request_bytes ?? LIMITS.targetResponseBytes,
    LIMITS.targetResponseBytes
  );
  const responseBytes = Math.min(
    resolved.config.target.limits?.response_bytes ?? LIMITS.targetResponseBytes,
    LIMITS.targetResponseBytes
  );
  const sideEffects =
    pattern === "stateful"
      ? [
          "Creates one synthetic in-memory order fixture on the target.",
          "May record a probe chat turn against that fixture.",
          "Reads allowlisted observer fields.",
          "Deletes the fixture during cleanup. A hard process kill can skip cleanup; the target still needs a server-side TTL."
        ]
      : session
        ? [
            "Sends two synthetic JSON chat turns that share one conversation identifier.",
            "The target may persist those messages if it stores chat history.",
            "No prepare, observe, or cleanup hooks are invoked."
          ]
        : [
            "Sends one synthetic JSON chat message.",
            "The target may persist that message if it stores chat history.",
            "No prepare, observe, or cleanup hooks are invoked."
          ];

  return {
    pattern,
    conversation_strategy: resolved.conversation.strategy,
    operations: planned,
    call_count: planned.length,
    time_limit_ms: PROBE_OVERALL_TIMEOUT_MS,
    request_bytes_limit: requestBytes,
    response_bytes_limit: responseBytes,
    synthetic_side_effects: sideEffects,
    cleanup: pattern === "stateful" ? "always" : "none",
    hosted_work: "none",
    confirmation:
      "Re-run with --yes to execute this plan. Doctor and init never start a probe. This path does not quote, reserve, or create a hosted run."
  };
}

export async function runConnectionProbe(options: RunConnectionProbeOptions): Promise<ConnectionProbeReport> {
  const resolved = options.resolved;
  const preflight = planConnectionProbe(resolved);
  const probeId = createProbeId(options.randomId);
  const session = resolved.conversation.strategy === CONVERSATION_STRATEGY_EXPLICIT_SESSION;
  const correlation: ProbeCorrelation = {
    probe_id: probeId,
    run_id: probeId,
    attempt_id: probeId,
    conversation_id: session ? probeId : null,
    turn_ids: session ? [`${probeId}_t1`, `${probeId}_t2`] : [`${probeId}_t1`]
  };
  const base: Omit<ConnectionProbeReport, "ok" | "executed" | "calls" | "diagnostics" | "failed_phase" | "failure_class" | "corrective_action"> =
    {
      schema_version: CONNECTION_PROBE_SCHEMA_VERSION,
      credits_consumed: 0,
      hosted_contacted: false,
      pattern: preflight.pattern,
      conversation_strategy: preflight.conversation_strategy,
      config_path: resolved.configPath,
      correlation,
      preflight,
      disclaimer: CONNECTION_PROBE_DISCLAIMER
    };

  if (options.execute !== true) {
    return {
      ...base,
      ok: true,
      executed: false,
      calls: [],
      diagnostics: [
        {
          level: "ok",
          code: "PROBE_PREFLIGHT",
          message:
            "Connection probe was not executed. Review the planned calls and synthetic side effects, then pass --yes."
        }
      ],
      failed_phase: null,
      failure_class: null,
      corrective_action: null
    };
  }

  const capture: HttpCapture = { status: null, json: undefined, errno: undefined };
  const connector = new HttpConnector(resolved, {
    fetch: wrapFetch(options.fetch ?? globalThis.fetch, capture)
  });
  const overall = AbortSignal.timeout(PROBE_OVERALL_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? overall : AbortSignal.any([options.signal, overall]);
  const calls: ProbeCallRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  let prepared = false;
  let failedPhase: ProbePhase | null = null;
  let failureClass: ProbeFailureClass | null = null;
  let corrective: string | null = null;
  const now = options.now ?? Date.now;

  const runStep = async (phase: ProbePhase, kind: OperationKind, input: Record<string, JsonValue>, context: ConnectorExecutionContext): Promise<boolean> => {
    capture.status = null;
    capture.json = undefined;
    capture.errno = undefined;
    const started = now();
    try {
      await connector.execute(kind, input, { ...context, signal });
      const duration = Math.max(0, now() - started);
      const mapping = mappingForCaptured(resolved, kind, capture.json, resolved.secrets);
      const mappingOk = mapping === null ? null : mapping.ok;
      calls.push({
        phase,
        kind,
        ok: mappingOk !== false,
        http_status: capture.status,
        duration_ms: duration,
        mapping_ok: mappingOk,
        evidence_sha256: mapping?.evidence?.sha256 ?? null
      });
      if (mapping !== null && !mapping.ok) {
        const classified = classifyProbeFailure(undefined, phase, capture, mapping);
        failedPhase = phase;
        failureClass = classified.failureClass;
        corrective = classified.correctiveAction;
        diagnostics.push(...classified.diagnostics);
        return false;
      }
      diagnostics.push({
        level: "ok",
        code: "PROBE_STEP_OK",
        message: `${phase} succeeded as an integration check.`,
        path: `target.operations.${kind}`
      });
      return true;
    } catch (error) {
      const duration = Math.max(0, now() - started);
      const mapping = mappingForCaptured(resolved, kind, capture.json, resolved.secrets);
      calls.push({
        phase,
        kind,
        ok: false,
        http_status: capture.status,
        duration_ms: duration,
        mapping_ok: mapping?.ok ?? false,
        evidence_sha256: mapping?.evidence?.sha256 ?? null
      });
      const classified = classifyProbeFailure(error, phase, capture, mapping);
      failedPhase = phase;
      failureClass = classified.failureClass;
      corrective = classified.correctiveAction;
      diagnostics.push(...classified.diagnostics);
      return false;
    }
  };

  const sendContext = (turnId: string, suffix: string): ConnectorExecutionContext => ({
    commandId: probeId,
    idempotencyKey: `${probeId}:send:${suffix}`,
    runId: probeId,
    attemptId: probeId,
    turnId,
    ...(session ? { conversationId: probeId } : {})
  });

  try {
    let continueSteps = true;
    if (preflight.pattern === "stateful") {
      continueSteps = await runStep(
        "prepare",
        "prepare",
        {
          run_id: probeId,
          attempt_id: probeId,
          scenario_key: "connection-probe",
          fixture: probeFixture()
        },
        {
          commandId: probeId,
          idempotencyKey: `${probeId}:prepare:1`,
          runId: probeId,
          attemptId: probeId
        }
      );
      if (continueSteps) prepared = true;
    }

    if (continueSteps) {
      const firstTurn = correlation.turn_ids[0] ?? `${probeId}_t1`;
      const firstMessage = session ? PROBE_SESSION_TURN_ONE : PROBE_ACK_MESSAGE;
      continueSteps = await runStep(
        "send",
        "send",
        sendInput(firstTurn, probeId, firstMessage),
        sendContext(firstTurn, "1")
      );
    }

    if (continueSteps && session) {
      const secondTurn = correlation.turn_ids[1] ?? `${probeId}_t2`;
      continueSteps = await runStep(
        "send_followup",
        "send",
        sendInput(secondTurn, probeId, PROBE_SESSION_TURN_TWO),
        sendContext(secondTurn, "2")
      );
    }

    if (continueSteps && preflight.pattern === "stateful") {
      const requestId = `${probeId}_observe`;
      continueSteps = await runStep(
        "observe",
        "observe",
        {
          attempt_id: probeId,
          request_id: requestId,
          probe_keys: [...(resolved.config.telemetry?.allow_observations ?? [])]
        },
        {
          commandId: probeId,
          idempotencyKey: `${probeId}:observe:1`,
          runId: probeId,
          attemptId: probeId,
          requestId
        }
      );
    }
    void continueSteps;
  } finally {
    if (prepared) {
      const cleanupOk = await runStep(
        "cleanup",
        "cleanup",
        { attempt_id: probeId },
        {
          commandId: probeId,
          idempotencyKey: `${probeId}:cleanup:1`,
          runId: probeId,
          attemptId: probeId
        }
      );
      if (!cleanupOk) {
        failedPhase = "cleanup";
        failureClass = "cleanup";
        corrective = correctiveAction("cleanup");
      }
    }
  }

  const ok = failedPhase === null;
  if (ok) {
    diagnostics.push({
      level: "ok",
      code: "PROBE_COMPLETE",
      message:
        "Bounded connection probe finished. No hosted API was contacted and no credits were consumed. This is not a chatbot quality verdict."
    });
  }
  return finish(base, ok, calls, diagnostics, failedPhase, failureClass, corrective, resolved.secrets);
}

export function probeExitCode(report: ConnectionProbeReport): number {
  if (!report.executed) return EXIT.OK;
  if (report.ok) return EXIT.OK;
  if (report.failure_class === "cleanup") return EXIT.CLEANUP;
  if (
    report.diagnostics.some(
      (item) => item.level === "error" && (item.code === "CONFIG_FILE_NOT_FOUND" || item.code.startsWith("CONFIG_"))
    )
  ) {
    return EXIT.CONFIG;
  }
  return EXIT.TARGET;
}

export function formatConnectionProbeHuman(report: ConnectionProbeReport, secrets: readonly string[] = []): string {
  const marker = { ok: "OK", warning: "WARN", error: "ERROR" } as const;
  const lines: string[] = [
    report.executed ? "Connection probe (explicit, bounded, synthetic)" : "Connection probe preflight (not executed)",
    `Pattern: ${report.pattern}`,
    `Conversation: ${report.conversation_strategy}`,
    `Config: ${report.config_path}`,
    `Probe id: ${report.correlation.probe_id}`,
    `Calls planned: ${String(report.preflight.call_count)}`,
    `Time limit: ${String(report.preflight.time_limit_ms)} ms`,
    `Hosted work: none (credits consumed: 0)`,
    ""
  ];
  lines.push("Planned operations");
  for (const operation of report.preflight.operations) {
    lines.push(`  ${operation.phase}  ${operation.method} ${operation.path}`);
    lines.push(`    ${operation.purpose}`);
  }
  lines.push("", "Synthetic side effects");
  for (const effect of report.preflight.synthetic_side_effects) {
    lines.push(`  - ${effect}`);
  }
  if (report.executed) {
    lines.push("", "Calls");
    if (report.calls.length === 0) {
      lines.push("  (none)");
    } else {
      for (const call of report.calls) {
        const status = call.http_status === null ? "no-http" : `HTTP ${String(call.http_status)}`;
        const mapping = call.mapping_ok === null ? "mapping n/a" : call.mapping_ok ? "mapping ok" : "mapping failed";
        lines.push(
          `  ${call.ok ? "ok" : "fail"}  ${call.phase}  ${status}  ${String(call.duration_ms)} ms  ${mapping}`
        );
      }
    }
  }
  lines.push("", "Diagnostics");
  for (const item of report.diagnostics) {
    const suffix = item.path === undefined ? "" : ` (${item.path})`;
    lines.push(`${marker[item.level]} ${item.code}: ${item.message}${suffix}`);
  }
  if (report.corrective_action !== null) {
    lines.push("", "Corrective action", `  ${report.corrective_action}`);
  }
  if (!report.executed) {
    lines.push("", report.preflight.confirmation);
  }
  lines.push("", report.disclaimer);
  if (report.executed) {
    lines.push(
      report.ok
        ? "Connection probe complete. No hosted run started and no credits were consumed."
        : "Connection probe found an integration problem. This is not a chatbot semantic failure."
    );
  }
  return `${redactText(lines.join("\n"), secrets)}\n`;
}

export function formatConnectionProbeJson(report: ConnectionProbeReport, secrets: readonly string[] = []): string {
  return `${redactText(
    JSON.stringify(
      {
        schema_version: report.schema_version,
        ok: report.ok,
        executed: report.executed,
        credits_consumed: report.credits_consumed,
        hosted_contacted: report.hosted_contacted,
        pattern: report.pattern,
        conversation_strategy: report.conversation_strategy,
        config_path: report.config_path,
        correlation: report.correlation,
        preflight: report.preflight,
        calls: report.calls,
        diagnostics: report.diagnostics,
        failed_phase: report.failed_phase,
        failure_class: report.failure_class,
        corrective_action: report.corrective_action,
        disclaimer: report.disclaimer
      },
      null,
      2
    ),
    secrets
  )}\n`;
}

interface HttpCapture {
  status: number | null;
  json: JsonValue | undefined;
  errno: string | undefined;
}

function describeOperation(
  resolved: ResolvedConfig,
  kind: OperationKind,
  phase: ProbePhase,
  purpose: string
): ProbePlannedCall {
  const operation = resolved.config.target.operations[kind];
  if (operation === undefined) {
    throw new AwError({
      code: "CONNECTOR_OPERATION_NOT_CONFIGURED",
      category: "config",
      message: `The ${kind} operation is not configured.`,
      operation: kind
    });
  }
  return {
    phase,
    kind,
    method: operation.method,
    path: operation.path,
    purpose
  };
}

function sendInput(turnId: string, attemptId: string, content: string): Record<string, JsonValue> {
  return {
    turn_id: turnId,
    attempt_id: attemptId,
    run_id: attemptId,
    message: { role: "user", content }
  };
}

function probeFixture(): JsonValue {
  return {
    order: {
      id: "aw_probe_order",
      amount: 1,
      currency: "USD",
      status: "paid",
      refundable: true,
      refunded_amount: 0
    },
    policy: {
      maximum_refund: 50,
      require_confirmation: false
    }
  };
}

function wrapFetch(fetchImpl: typeof globalThis.fetch, capture: HttpCapture): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      const response = await fetchImpl(input, init);
      capture.status = response.status;
      const cloned = response.clone();
      try {
        const text = await cloned.text();
        if (text !== "") {
          capture.json = JSON.parse(text) as JsonValue;
        }
      } catch {
        capture.json = undefined;
      }
      return response;
    } catch (error) {
      capture.errno = errnoOf(error);
      throw error;
    }
  };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && CONNECTION_ERRNO.has(direct)) return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === "string" && CONNECTION_ERRNO.has(nested)) return nested;
  }
  const name = (error as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") return "ABORT_TIMEOUT";
  const text = errorText(error);
  if (/\bbad port\b/iu.test(text)) return "ECONNREFUSED";
  const fromMessage = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b/u.exec(text);
  return fromMessage?.[1];
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" ");
}

function mappingForCaptured(
  resolved: ResolvedConfig,
  kind: OperationKind,
  response: JsonValue | undefined,
  secrets: readonly string[]
): MappingPreviewReport | null {
  if (kind === "cleanup") return null;
  if (response === undefined && (kind === "prepare" || kind === "observe")) return null;
  if (response === undefined) return null;
  return previewMapping({
    config: resolved.config,
    operation: kind,
    response,
    secrets,
    configPath: resolved.configPath,
    ...(kind === "observe"
      ? { probeKeys: [...(resolved.config.telemetry?.allow_observations ?? [])] }
      : {})
  });
}

function classifyProbeFailure(
  error: unknown,
  phase: ProbePhase,
  capture: HttpCapture,
  mapping: MappingPreviewReport | null
): {
  readonly failureClass: ProbeFailureClass;
  readonly correctiveAction: string;
  readonly diagnostics: readonly Diagnostic[];
} {
  const aw = error instanceof AwError ? error : undefined;
  const reason =
    aw !== undefined && aw.details !== undefined && typeof aw.details["reason_code"] === "string"
      ? aw.details["reason_code"]
      : undefined;
  const code = reason ?? aw?.code;
  const status = capture.status ?? (typeof aw?.details?.["status"] === "number" ? aw.details["status"] : null);
  const bodyError = jsonErrorName(capture.json);

  let failureClass: ProbeFailureClass = "target";
  if (phase === "cleanup") failureClass = "cleanup";
  else if (capture.errno !== undefined && CONNECTION_ERRNO.has(capture.errno)) failureClass = "connection_refusal";
  else if (capture.errno === "ABORT_TIMEOUT" || (code !== undefined && TIMEOUT_CODES.has(code))) failureClass = "timeout";
  else if (code !== undefined && UNREACHABLE_CODES.has(code)) failureClass = "connection_refusal";
  else if (status === 401 || status === 403) failureClass = "authentication";
  else if (
    bodyError === "session_required" ||
    bodyError === "conversation_required" ||
    (code !== undefined && SESSION_CODES.has(code)) ||
    phase === "send_followup" && status === 400 && bodyError === "session_required"
  ) {
    failureClass = "conversation_session";
  } else if (
    (mapping !== null && !mapping.ok && mapping.missing.length > 0) ||
    (code !== undefined && SELECTOR_CODES.has(code))
  ) {
    failureClass = "response_selector";
  } else if (status === 408 || status === 504) failureClass = "timeout";

  const message = safeFailureMessage(failureClass, phase, code, status);
  const diagnostics: Diagnostic[] = [
    {
      level: "error",
      code: probeDiagnosticCode(failureClass),
      message,
      path: `target.operations.${phase === "send_followup" ? "send" : phase}`
    }
  ];
  if (mapping !== null) {
    for (const missing of mapping.missing) {
      diagnostics.push({
        level: "error",
        code: missing.code,
        message: `Mapped field ${missing.field} was missing at ${missing.selector}. This is a connector mapping problem, not a chatbot quality failure.`,
        path: missing.path
      });
    }
  }
  return {
    failureClass,
    correctiveAction: correctiveAction(failureClass),
    diagnostics
  };
}

function jsonErrorName(value: JsonValue | undefined): string | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = value["error"];
  return typeof error === "string" ? error : undefined;
}

function probeDiagnosticCode(failureClass: ProbeFailureClass): string {
  switch (failureClass) {
    case "connection_refusal":
      return "PROBE_CONNECTION_REFUSED";
    case "timeout":
      return "PROBE_TIMEOUT";
    case "authentication":
      return "PROBE_AUTHENTICATION";
    case "response_selector":
      return "PROBE_RESPONSE_SELECTOR";
    case "conversation_session":
      return "PROBE_SESSION";
    case "cleanup":
      return "PROBE_CLEANUP";
    case "target":
      return "PROBE_TARGET";
  }
}

function safeFailureMessage(
  failureClass: ProbeFailureClass,
  phase: ProbePhase,
  code: string | undefined,
  status: number | null
): string {
  const statusText = status === null ? "" : ` HTTP ${String(status)}`;
  const codeText = code === undefined ? "" : ` (${code})`;
  switch (failureClass) {
    case "connection_refusal":
      return `The ${phase} call could not reach the configured target${codeText}. This is a connection problem, not a chatbot quality failure.`;
    case "timeout":
      return `The ${phase} call timed out within the probe bound${codeText}. This is an integration timeout, not a chatbot quality failure.`;
    case "authentication":
      return `The ${phase} call was rejected as unauthenticated${statusText}. Check the target credential environment variable; this is not a chatbot quality failure.`;
    case "response_selector":
      return `The ${phase} response did not match the configured selectors${codeText}. Fix the mapping or the JSON shape. This is not a chatbot quality failure.`;
    case "conversation_session":
      return `The ${phase} call failed the explicit session contract${codeText}${statusText}. Map conversation_id and confirm the target isolates that key. This is not a missed-fact judgment.`;
    case "cleanup":
      return `Synthetic cleanup failed after the probe${codeText}${statusText}. Remaining fixtures may need the target TTL. This is not a chatbot quality failure.`;
    case "target":
      return `The ${phase} call failed as a target integration error${codeText}${statusText}. This is not a chatbot quality failure.`;
  }
}

export function correctiveAction(failureClass: ProbeFailureClass): string {
  switch (failureClass) {
    case "connection_refusal":
      return "Confirm CHATBOT_BASE_URL points at a listening isolated synthetic process. Doctor and init do not start the target.";
    case "timeout":
      return "Confirm the mapped path returns promptly. Operation timeouts can be tightened in YAML; the probe also enforces a 45s overall bound.";
    case "authentication":
      return "Set the environment variable named by target.auth.bearer_env in .env beside the config. Do not put the secret in YAML or command arguments.";
    case "response_selector":
      return "Use preview-mapping --operation <kind> --fixture <saved-json> to inspect selectors offline, then align the target JSON or the YAML mapping.";
    case "conversation_session":
      return "Set target.conversation.strategy: explicit_session_v1 and copy $input.conversation_id into the send body. Correlation IDs are not a session.";
    case "cleanup":
      return "Make cleanup idempotent, keep a server-side fixture TTL, and re-run probe --yes after the endpoint accepts the same attempt id.";
    case "target":
      return "Inspect the failed phase, mapped path, and probe correlation ids. Do not treat this result as a semantic chatbot miss.";
  }
}

function finish(
  base: Omit<
    ConnectionProbeReport,
    "ok" | "executed" | "calls" | "diagnostics" | "failed_phase" | "failure_class" | "corrective_action"
  >,
  ok: boolean,
  calls: readonly ProbeCallRecord[],
  diagnostics: readonly Diagnostic[],
  failedPhase: ProbePhase | null,
  failureClass: ProbeFailureClass | null,
  corrective: string | null,
  secrets: readonly string[]
): ConnectionProbeReport {
  void secrets;
  return {
    ...base,
    ok,
    executed: true,
    calls,
    diagnostics,
    failed_phase: failedPhase,
    failure_class: failureClass,
    corrective_action: corrective
  };
}
