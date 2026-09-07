import {
  CONVERSATION_CAPABILITY_VERSION,
  type TargetBinding
} from "../cloud/protocol.js";
import { AwError } from "../errors.js";
import type {
  AugmentWorksConfig,
  Diagnostic,
  JsonValue,
  ResolvedConfig,
  ResolvedConversation
} from "./types.js";

export { CONVERSATION_CAPABILITY_VERSION };

export const CONVERSATION_STRATEGY_SINGLE_TURN = "single_turn" as const;
export const CONVERSATION_STRATEGY_EXPLICIT_SESSION = "explicit_session_v1" as const;
export const CONVERSATION_STRATEGY_HISTORY_ARRAY = "history_array_v1" as const;

export const SUPPORTED_CONVERSATION_STRATEGIES = [
  CONVERSATION_STRATEGY_SINGLE_TURN,
  CONVERSATION_STRATEGY_EXPLICIT_SESSION
] as const;

export const RESERVED_CONVERSATION_STRATEGIES = [CONVERSATION_STRATEGY_HISTORY_ARRAY] as const;

export const CONVERSATION_ID_INPUT_SELECTOR = "$input.conversation_id" as const;

export type SupportedConversationStrategy = (typeof SUPPORTED_CONVERSATION_STRATEGIES)[number];

export type { ResolvedConversation };

export const SINGLE_TURN_CONVERSATION: ResolvedConversation = {
  version: CONVERSATION_CAPABILITY_VERSION,
  strategy: CONVERSATION_STRATEGY_SINGLE_TURN,
  multiTurn: false,
  mappedRequestFields: []
};

export function isSupportedConversationStrategy(
  value: string
): value is SupportedConversationStrategy {
  return (SUPPORTED_CONVERSATION_STRATEGIES as readonly string[]).includes(value);
}

export function isReservedConversationStrategy(value: string): boolean {
  return (RESERVED_CONVERSATION_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Walk a request template and report every field whose value is exactly
 * `$input.conversation_id`. Whole-body `$input` passthrough is not an explicit
 * session-field mapping.
 */
export function conversationIdMappedFields(
  template: JsonValue | undefined
): readonly string[] {
  if (template === undefined) return [];
  const fields: string[] = [];
  visitConversationSelectors(template, "$input", fields);
  return [...new Set(fields)];
}

export function requestTemplateMapsConversationId(template: JsonValue | undefined): boolean {
  return requestTemplateCopiesWholeInput(template) || conversationIdMappedFields(template).length > 0;
}

function requestTemplateCopiesWholeInput(value: JsonValue | undefined): boolean {
  if (value === undefined) return false;
  if (value === "$input") return true;
  if (Array.isArray(value)) return value.some((child) => requestTemplateCopiesWholeInput(child));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((child) => requestTemplateCopiesWholeInput(child));
  }
  return false;
}

export function resolveConversation(config: AugmentWorksConfig): ResolvedConversation {
  const mappedRequestFields = conversationIdMappedFields(config.target.operations.send.request);
  if (config.target.conversation?.strategy === CONVERSATION_STRATEGY_EXPLICIT_SESSION) {
    return {
      version: CONVERSATION_CAPABILITY_VERSION,
      strategy: CONVERSATION_STRATEGY_EXPLICIT_SESSION,
      multiTurn: true,
      mappedRequestFields
    };
  }
  return {
    ...SINGLE_TURN_CONVERSATION,
    mappedRequestFields
  };
}

/**
 * Hosted capability advertisement. Single-turn omits `multi_turn` and
 * `conversation` so older servers keep accepting genuinely single-turn plans.
 * `explicit_session_v1` is the only advertised multi-turn mode.
 */
export function advertisedTargetCapabilities(resolved: ResolvedConfig): TargetBinding["capabilities"] {
  const observationKeys = resolved.capabilities.observation
    ? [...new Set(resolved.config.telemetry?.allow_observations ?? [])].sort()
    : [];
  const conversation = resolved.conversation;
  const base = {
    prepare: resolved.capabilities.prepare,
    observation: resolved.capabilities.observation,
    cleanup: resolved.capabilities.cleanup,
    tool_events: resolved.capabilities.tool_events,
    observation_keys: observationKeys
  };
  if (!conversation.multiTurn) return base;
  return {
    ...base,
    multi_turn: true,
    conversation: {
      version: conversation.version,
      strategy: CONVERSATION_STRATEGY_EXPLICIT_SESSION
    }
  };
}

export function conversationAdmissionError(message: string, details?: Record<string, string | number | boolean>): AwError {
  return new AwError({
    code: "CONVERSATION_CAPABILITY_INCOMPATIBLE",
    category: "config",
    message,
    ...(details === undefined ? {} : { details })
  });
}

export function assertConversationSupportsPacket(options: {
  readonly resolved: ResolvedConfig;
  readonly packetRequiresMultiTurn: boolean;
  readonly packetLabel?: string;
}): void {
  if (!options.packetRequiresMultiTurn) return;
  if (options.resolved.conversation.multiTurn) return;
  const packet = options.packetLabel ?? "this packet";
  throw conversationAdmissionError(
    `${packet} requires multi-turn conversation, but this connector advertises single-turn. Configure target.conversation.strategy: ${CONVERSATION_STRATEGY_EXPLICIT_SESSION} and map ${CONVERSATION_ID_INPUT_SELECTOR} into the send request. No quote, reservation, or run was created.`,
    { strategy: options.resolved.conversation.strategy }
  );
}

export function conversationValidationDiagnostics(config: AugmentWorksConfig): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const declared = config.target.conversation?.strategy;
  const sendRequest = config.target.operations.send.request;
  const mappedFields = conversationIdMappedFields(sendRequest);
  const mapsExplicitConversationId = mappedFields.length > 0;
  const mapsConversationId = requestTemplateMapsConversationId(sendRequest);

  if (declared === undefined) {
    if (mapsExplicitConversationId) {
      diagnostics.push({
        level: "error",
        code: "SESSION_CONVERSATION_ID_UNEXPECTED",
        message: `${CONVERSATION_ID_INPUT_SELECTOR} is mapped, but target.conversation.strategy is omitted (single-turn). Mapping that selector without ${CONVERSATION_STRATEGY_EXPLICIT_SESSION} would invent a session field. Set target.conversation.strategy: ${CONVERSATION_STRATEGY_EXPLICIT_SESSION}, or remove the mapping.`,
        path: "target.operations.send.request"
      });
    } else {
      diagnostics.push({
        level: "ok",
        code: "CONVERSATION_SINGLE_TURN",
        message:
          "Conversation defaults to single-turn. Hosted multi_turn is not advertised. Correlation IDs (run_id, attempt_id, turn_id) are not a conversation session."
      });
    }
    return diagnostics;
  }

  if (declared === CONVERSATION_STRATEGY_SINGLE_TURN) {
    if (mapsExplicitConversationId) {
      diagnostics.push({
        level: "error",
        code: "SESSION_CONVERSATION_ID_UNEXPECTED",
        message: `${CONVERSATION_ID_INPUT_SELECTOR} cannot be mapped when target.conversation.strategy is ${CONVERSATION_STRATEGY_SINGLE_TURN}. Use ${CONVERSATION_STRATEGY_EXPLICIT_SESSION} for server-side session memory, or remove the mapping.`,
        path: "target.conversation.strategy"
      });
    } else {
      diagnostics.push({
        level: "ok",
        code: "CONVERSATION_SINGLE_TURN",
        message:
          "Conversation strategy is single-turn. Hosted multi_turn is not advertised. Correlation IDs are not a conversation session."
      });
    }
    return diagnostics;
  }

  if (isReservedConversationStrategy(declared) || declared === CONVERSATION_STRATEGY_HISTORY_ARRAY) {
    diagnostics.push({
      level: "error",
      code: "SESSION_STRATEGY_UNSUPPORTED",
      message: `Conversation strategy ${JSON.stringify(declared)} is reserved and not implemented. The only supported multi-turn mode is ${CONVERSATION_STRATEGY_EXPLICIT_SESSION}. Omit target.conversation for single-turn. History-array mode is not advertised.`,
      path: "target.conversation.strategy"
    });
    return diagnostics;
  }

  if (declared !== CONVERSATION_STRATEGY_EXPLICIT_SESSION) {
    diagnostics.push({
      level: "error",
      code: "SESSION_STRATEGY_UNSUPPORTED",
      message: `Conversation strategy ${JSON.stringify(declared)} is not supported. Use ${CONVERSATION_STRATEGY_EXPLICIT_SESSION}, or omit target.conversation for single-turn. Do not infer memory from correlation IDs.`,
      path: "target.conversation.strategy"
    });
    return diagnostics;
  }

  if (!mapsConversationId) {
    diagnostics.push({
      level: "error",
      code: "SESSION_CONVERSATION_ID_UNMAPPED",
      message: `${CONVERSATION_STRATEGY_EXPLICIT_SESSION} requires the send request template to copy ${CONVERSATION_ID_INPUT_SELECTOR} into a target field the server uses as its isolated conversation key. Mapping $input.attempt_id, $input.run_id, or $input.turn_id is correlation only, not a session. The target owns and isolates server-side context for that identifier. This mapping is not a claim that the chatbot remembered prior turns.`,
      path: "target.operations.send.request"
    });
    return diagnostics;
  }

  const fieldList =
    mappedFields.length > 0
      ? mappedFields.join(", ")
      : "$input (whole send body, including conversation_id)";
  diagnostics.push({
    level: "ok",
    code: "CONVERSATION_EXPLICIT_SESSION",
    message: `Advertises ${CONVERSATION_STRATEGY_EXPLICIT_SESSION}. The attempt-scoped conversation identifier equals attempt_id and is mapped to ${fieldList}. The target owns and isolates server-side context. Mapping is not a chatbot-memory claim.`
  });

  if (config.target.operations.send.idempotent !== true) {
    diagnostics.push({
      level: "warning",
      code: "SESSION_IDEMPOTENCY_UNDECLARED",
      message: `${CONVERSATION_STRATEGY_EXPLICIT_SESSION} duplicate suppression depends on the target. Set target.operations.send.idempotent: true only when repeating the same AW-Idempotency-Key, conversation identifier, and turn_id cannot append a second accepted user message. This CLI does not claim arbitrary endpoints are idempotent.`,
      path: "target.operations.send.idempotent"
    });
  }

  return diagnostics;
}

function visitConversationSelectors(value: JsonValue, path: string, fields: string[]): void {
  if (typeof value === "string") {
    if (value === CONVERSATION_ID_INPUT_SELECTOR || value.startsWith(`${CONVERSATION_ID_INPUT_SELECTOR}.`) || value.startsWith(`${CONVERSATION_ID_INPUT_SELECTOR}[`)) {
      fields.push(path === "$input" ? CONVERSATION_ID_INPUT_SELECTOR : path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => visitConversationSelectors(child, `${path}[${String(index)}]`, fields));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visitConversationSelectors(child, path === "$input" ? key : `${path}.${key}`, fields);
    }
  }
}
