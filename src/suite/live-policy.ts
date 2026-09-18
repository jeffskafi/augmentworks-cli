import type { ResolvedConfig } from "../config/types.js";
import type { RelayCommand } from "../cloud/protocol.js";
import type { RelayJournal } from "../relay/journal.js";
import {
  assertLiveTargetNotExpired,
  canonicalHttpsOrigin,
  liveError,
  type LiveTargetContract
} from "./live-target.js";
import { isLiveCustomerSuite, type CustomerSuite } from "./schema.js";

export type LiveExecutionPolicy = {
  readonly origin: string;
  readonly authorizationKind: LiveTargetContract["authorizationKind"];
  readonly authorizationRef: string;
  readonly expiresAt: string;
  readonly maxMessages: number;
  readonly allowedMessages: readonly string[];
  readonly allowedCaseIds: readonly string[];
};

export function liveExecutionPolicyFromSuite(
  suite: CustomerSuite,
  now = Date.now()
): LiveExecutionPolicy | undefined {
  if (!isLiveCustomerSuite(suite)) return undefined;
  const contract = suite.liveTarget;
  assertLiveTargetNotExpired(contract, now);
  return {
    origin: contract.origin,
    authorizationKind: contract.authorizationKind,
    authorizationRef: contract.authorizationRef,
    expiresAt: contract.expiresAt,
    maxMessages: contract.maxMessages,
    allowedMessages: suite.cases.map((suiteCase) => suiteCase.turns[0]!.content),
    allowedCaseIds: suite.cases.map((suiteCase) => suiteCase.caseId)
  };
}

export function assertLiveSuiteReadyForQuote(
  suite: CustomerSuite,
  resolved: ResolvedConfig,
  now = Date.now()
): void {
  const policy = liveExecutionPolicyFromSuite(suite, now);
  if (policy === undefined) return;
  assertExactApprovedOrigin(resolved, policy.origin);
  assertSendOnlyOperations(resolved);
}

export function assertExactApprovedOrigin(resolved: ResolvedConfig, approvedOrigin: string): void {
  let actual: string;
  try {
    actual = canonicalHttpsOrigin(resolved.baseUrl.origin);
  } catch {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      `Configured target origin ${resolved.baseUrl.origin} is not the exact approved HTTPS origin ${approvedOrigin}.`
    );
  }
  if (actual !== approvedOrigin) {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      `Configured target origin ${actual} does not match the exact approved origin ${approvedOrigin}.`
    );
  }
}

export function assertSendOnlyOperations(resolved: ResolvedConfig): void {
  const extras: string[] = [];
  if (resolved.config.target.operations.prepare !== undefined) extras.push("prepare");
  if (resolved.config.target.operations.observe !== undefined) extras.push("observe");
  if (resolved.config.target.operations.cleanup !== undefined) extras.push("cleanup");
  if (resolved.capabilities.tool_events) extras.push("tool_events");
  if (resolved.conversation.multiTurn) extras.push("multi_turn");
  if (extras.length > 0) {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      `Live informational assessments permit send only. Extra operations are configured: ${extras.join(", ")}.`
    );
  }
}

export function assertLiveCommandAllowed(
  command: RelayCommand,
  policy: LiveExecutionPolicy,
  journal: RelayJournal,
  now = Date.now()
): void {
  assertLiveTargetNotExpired(
    {
      schemaVersion: "aw-live-target/1",
      mode: "informational",
      origin: policy.origin,
      authorizationKind: policy.authorizationKind,
      authorizationRef: policy.authorizationRef,
      expiresAt: policy.expiresAt,
      maxMessages: policy.maxMessages
    },
    now
  );
  if (policy.authorizationRef.trim() === "") {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live authorization reference is missing."
    );
  }
  if (command.kind !== "send") {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      `Live informational assessments do not permit ${command.kind} operations.`
    );
  }
  if (command.input.conversation_id !== undefined) {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live informational assessments admit a single turn per case and reject follow-up conversation identifiers."
    );
  }
  const content = command.input.message.content;
  if (!policy.allowedMessages.includes(content)) {
    throw liveError(
      "LIVE_TARGET_SCOPE_MISMATCH",
      "Live send content is not one of the authorized single-turn cases."
    );
  }
  const existing = journal.state(command.command_id);
  const alreadyStarted = existing?.started === true;
  if (!alreadyStarted && journal.dispatchedSendCount() >= policy.maxMessages) {
    throw liveError(
      "LIVE_TARGET_MESSAGE_LIMIT",
      `Live informational assessment already dispatched ${String(policy.maxMessages)} messages, including indeterminate sends.`
    );
  }
}
