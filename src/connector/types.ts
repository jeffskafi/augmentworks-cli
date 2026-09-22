import type {
  CleanupResult,
  ObserveResult,
  PrepareResult,
  RelayResult,
  SendResult
} from "../cloud/protocol.js";

import type { DataPolicyContext } from "../data-policy/index.js";

export type {
  AssistantMessage,
  ErrorEvent,
  HandoffEvent,
  Observation,
  TargetEvent,
  ToolCallEvent,
  ToolResultEvent
} from "../cloud/protocol.js";

export interface ConnectorExecutionContext {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly conversationId?: string;
  readonly signal?: AbortSignal;
  readonly dataPolicy?: DataPolicyContext;
}

export interface HttpConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly dataPolicy?: DataPolicyContext;
}

export type PrepareConnectorResult = PrepareResult;
export type SendConnectorResult = SendResult;
export type ObserveConnectorResult = ObserveResult;
export type CleanupConnectorResult = CleanupResult;
export type ConnectorResult = RelayResult;
