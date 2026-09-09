import type { CompileSuiteSelectionCapabilities } from "../../src/selection/schema.js";
import type { SuiteSelectionManifest } from "../../src/selection/schema.js";

export const ACTION_QUICK_OBSERVATION_KEYS = [
  "order.refundable",
  "order.refunded_amount",
  "order.status"
] as const;

export const ACTION_QUICK_CASE_IDS = [
  "support-refunds/0.2.0/S01",
  "support-refunds/0.2.0/S02",
  "support-refunds/0.2.0/S03",
  "support-refunds/0.2.0/S04",
  "support-refunds/0.2.0/S05"
] as const;

export const ACTION_CONNECTOR_CAPABILITIES: CompileSuiteSelectionCapabilities = {
  prepare: true,
  observation: true,
  toolEvents: true,
  cleanup: true,
  multiTurn: false,
  observationKeys: [...ACTION_QUICK_OBSERVATION_KEYS]
};

export const SESSION_CONNECTOR_CAPABILITIES: CompileSuiteSelectionCapabilities = {
  ...ACTION_CONNECTOR_CAPABILITIES,
  multiTurn: true
};

export const CAPABILITY_FREE_SNAPSHOT: CompileSuiteSelectionCapabilities = {
  prepare: false,
  observation: false,
  toolEvents: false,
  cleanup: false,
  multiTurn: false,
  observationKeys: []
};

const HOOK_REASONS = {
  prepare: "capability_prepare",
  observation: "capability_observation",
  toolEvents: "capability_tool_events",
  cleanup: "capability_cleanup"
} as const;

export function actionQuickIncompatibilityReasons(
  capabilities: CompileSuiteSelectionCapabilities
): string[] {
  const reasons: string[] = [];
  for (const hook of ["prepare", "observation", "toolEvents", "cleanup"] as const) {
    if (capabilities[hook] !== true) reasons.push(HOOK_REASONS[hook]);
  }
  const have = new Set(capabilities.observationKeys);
  for (const key of ACTION_QUICK_OBSERVATION_KEYS) {
    if (!have.has(key)) reasons.push("capability_observation_key");
  }
  return reasons;
}

export function actionConnectorYaml(options: {
  readonly allowToolEvents?: boolean;
  readonly observationKeys?: readonly string[];
  readonly session?: boolean;
  readonly omitPrepare?: boolean;
  readonly omitObserve?: boolean;
  readonly omitCleanup?: boolean;
} = {}): string {
  const allowToolEvents = options.allowToolEvents ?? true;
  const observationKeys = options.observationKeys ?? ["order.status", "order.refunded_amount", "order.refundable"];
  const sendRequest = options.session
    ? `        message: $input.message.content
        conversation_id: $input.conversation_id
        turn_id: $input.turn_id`
    : `        message: $input.message.content
        turn_id: $input.turn_id
        attempt_id: $input.attempt_id`;
  const conversation = options.session
    ? `  conversation:
    strategy: explicit_session_v1\n`
    : "";
  const prepare = options.omitPrepare
    ? ""
    : `    prepare:
      method: POST
      path: /__augmentworks/prepare
      idempotent: true
      request:
        attempt_id: $input.attempt_id
        fixture: $input.fixture
`;
  const observe = options.omitObserve
    ? ""
    : `    observe:
      method: POST
      path: /__augmentworks/observe
      idempotent: true
      request:
        attempt_id: $input.attempt_id
        probe_keys: $input.probe_keys
      response:
        order.status: $.order.status
        order.refunded_amount: $.order.refunded_amount
        order.refundable: $.order.refundable
`;
  const cleanup = options.omitCleanup
    ? ""
    : `    cleanup:
      method: POST
      path: /__augmentworks/cleanup
      idempotent: true
      request:
        attempt_id: $input.attempt_id
`;
  return `version: 1
target:
  name: refunds-staging
  connector: http
  base_url: http://127.0.0.1:9
${conversation}  operations:
${prepare}    send:
      method: POST
      path: /chat
      idempotent: ${options.session ? "true" : "false"}
      request:
${sendRequest}
      response:
        content: $.answer
        tool_events: $.events
${observe}${cleanup}telemetry:
  allow_tool_events: ${allowToolEvents ? "true" : "false"}
  allow_observations:
${observationKeys.map((key) => `    - ${key}`).join("\n")}
`;
}

export function chatConnectorYaml(session = false): string {
  const conversation = session
    ? `  conversation:
    strategy: explicit_session_v1
`
    : "";
  const request = session
    ? `        message: $input.message.content
        conversation_id: $input.conversation_id`
    : `        message: $input.message.content`;
  return `version: 1
target:
  name: chat-staging
  connector: http
  base_url: http://127.0.0.1:9
${conversation}  operations:
    send:
      method: POST
      path: /chat
      ${session ? "idempotent: true\n      " : ""}request:
${request}
      response:
        content: $.answer
`;
}

export function actionQuickAssessmentYaml(): string {
  return `schema_version: aw-assessment-file/1
profile: quick
evaluation_mode: hybrid
packets:
  - key: support-refunds
    version: 0.2.0
selection:
  profile: smoke
  include_catalog: true
  requested_case_ids:
${ACTION_QUICK_CASE_IDS.map((id) => `    - ${id}`).join("\n")}
references:
  local:
    - path: references/refund-policy.md
      id: refund-policy-current
      kind: approved_policy
`;
}

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function includedRow(caseId: string): { caseId: string; reasonCode: string; message: string } {
  return {
    caseId,
    reasonCode: "included",
    message: `Case ${caseId} is included once in the normalized selection.`
  };
}

export function actionQuickIncludedManifest(): SuiteSelectionManifest {
  const caseIds = [...ACTION_QUICK_CASE_IDS];
  return {
    schemaVersion: "aw-suite-selection/1",
    documentKind: "suite_selection_manifest",
    selectionVersion: "1.0.0",
    createsBillableRun: false,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    suiteRevisionId: null,
    suiteId: null,
    semanticRevisionHash: null,
    catalogChecksum: HASH,
    inventoryHash: HASH,
    normalizedSelection: {
      profile: "smoke",
      includeTags: [],
      excludeTags: [],
      conversationMode: "single_turn",
      excludedCaseIds: [],
      requestedCaseIds: caseIds
    },
    requestedCaseCount: caseIds.length,
    includedCaseCount: caseIds.length,
    plannedExecutions: 10,
    plannedCommands: 40,
    perRunLimits: { maxCases: 20, maxExecutions: 60, maxCommands: 512 },
    quoteIsAuthoritative: true,
    aggregateReleaseRequiresCompleteCoverage: true,
    executable: true,
    unexecutableReason: null,
    included: caseIds.map((caseId) => includedRow(caseId)),
    excluded: [],
    incompatible: [],
    shards: [
      {
        shardId: "shard-000",
        shardIndex: 0,
        shardIdentityHash: HASH,
        caseIds,
        plannedExecutions: 10,
        plannedCommands: 40,
        planHash: HASH,
        packetBindings: [{ key: "support-refunds", version: "0.2.0", sha256: HASH }],
        compileOk: true,
        compileReasonCode: null,
        compileMessage: null
      }
    ],
    manifestHash: HASH
  };
}

export function actionQuickIncompatibleManifest(reasons: readonly string[]): SuiteSelectionManifest {
  const uniqueReasons = [...new Set(reasons)];
  const incompatible = uniqueReasons.map((reasonCode) => ({
    caseId: "support-refunds/0.2.0/S01",
    reasonCode,
    message: `This case requires ${reasonCode.replace("capability_", "").replaceAll("_", " ")}, but the connector does not advertise it.`
  }));
  return {
    schemaVersion: "aw-suite-selection/1",
    documentKind: "suite_selection_manifest",
    selectionVersion: "1.0.0",
    createsBillableRun: false,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    suiteRevisionId: null,
    suiteId: null,
    semanticRevisionHash: null,
    catalogChecksum: HASH,
    inventoryHash: HASH,
    normalizedSelection: {
      profile: "smoke",
      includeTags: [],
      excludeTags: [],
      conversationMode: "single_turn",
      excludedCaseIds: [],
      requestedCaseIds: [...ACTION_QUICK_CASE_IDS]
    },
    requestedCaseCount: ACTION_QUICK_CASE_IDS.length,
    includedCaseCount: 0,
    plannedExecutions: 0,
    plannedCommands: 0,
    perRunLimits: { maxCases: 20, maxExecutions: 60, maxCommands: 512 },
    quoteIsAuthoritative: true,
    aggregateReleaseRequiresCompleteCoverage: true,
    executable: false,
    unexecutableReason: "No compatible cases remain after filters and capability checks.",
    included: [],
    excluded: [],
    incompatible,
    shards: [],
    manifestHash: HASH
  };
}

export function compileResponseForCapabilities(
  capabilities: CompileSuiteSelectionCapabilities
): { status: number; response: SuiteSelectionManifest } {
  const reasons = actionQuickIncompatibilityReasons(capabilities);
  if (reasons.length === 0) {
    return { status: 200, response: actionQuickIncludedManifest() };
  }
  return { status: 200, response: actionQuickIncompatibleManifest(reasons) };
}
