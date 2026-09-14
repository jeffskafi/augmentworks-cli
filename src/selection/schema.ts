import { z } from "zod";

export const SUITE_SELECTION_SCHEMA_VERSION = "aw-suite-selection/1" as const;
export const SUITE_SELECTION_SCHEMA_VERSION_V2 = "aw-suite-selection/2" as const;
export const SUITE_SELECTION_DOCUMENT_KIND = "suite_selection_manifest" as const;
export const SAVED_SUITE_BINDING_SCHEMA_VERSION = "aw-saved-suite-binding/1" as const;
export const SAVED_SUITE_SELECTION_VERSION = "2.0.0" as const;
export const SAVED_SUITE_ACCEPTED_MANIFEST_VERSIONS = [SUITE_SELECTION_SCHEMA_VERSION_V2] as const;
export const MANIFEST_RELEASE_POLICY_SCHEMA_VERSION = "aw-manifest-release-policy/1" as const;
export const MANIFEST_RELEASE_POLICY_DOCUMENT_KIND = "manifest_release_policy_result" as const;
export const SELECTION_PROGRESS_SCHEMA_VERSION = "aw-selection-progress/1" as const;
export const SELECTION_ARTIFACT_SCHEMA_VERSION = "aw-selection-artifact/1" as const;
/** Local durable attempt document. Distinct from the immutable suite-selection manifest. */
export const SELECTION_EXECUTION_DOCUMENT_KIND = "aw-selection-execution/2" as const;
export const SELECTION_EXECUTION_INDEX_DOCUMENT_KIND = "aw-selection-execution-index/2" as const;

/**
 * Closed aggregate execution states:
 * - `running` — this attempt is active (including a fresh start).
 * - `interrupted` — checkpointed, resumable with `--execution-id`; not a final result.
 * - `completed` — every expected shard finished this attempt.
 * - `blocked` — terminal incomplete coverage (including aggregate budget exhaustion).
 * - `failed` — terminal with at least one failed shard and no in-flight shard.
 */
export const SELECTION_EXECUTION_STATES = [
  "running",
  "interrupted",
  "completed",
  "blocked",
  "failed"
] as const;

/**
 * Closed per-shard execution states:
 * - `pending` — not yet quoted.
 * - `quoted` — durable quote id/units recorded; not admitted.
 * - `admitted` — create/bind recorded a run id; observation may not have started.
 * - `running` — observation/relay in progress.
 * - `completed` — this shard finished; charged units are authoritative.
 * - `blocked` — skipped without a successful completion (budget or stop).
 * - `failed` — this shard failed; do not treat as coverage.
 */
export const SELECTION_EXECUTION_SHARD_STATES = [
  "pending",
  "quoted",
  "admitted",
  "running",
  "completed",
  "blocked",
  "failed"
] as const;

export const SELECTION_PATHS = {
  compile: "/v1/suite-selections/compile",
  evaluateManifest: "/v1/release-gates/evaluate-manifest",
  evaluateManifestAlias: "/api/v1/release-gates/evaluate-manifest"
} as const;

export const MANIFEST_GATE_REQUEST_SCHEMA_VERSION = "aw-manifest-release-gate-request/2" as const;
export const MANIFEST_GATE_DOCUMENT_KIND = "aw-manifest-release-policy/2" as const;
export const MANIFEST_GATE_EVIDENCE_SOURCE = "server" as const;
export const MANIFEST_GATE_MAX_BYTES = 64 * 1024;
export const MANIFEST_GATE_MIN_SHARDS = 1 as const;
export const MANIFEST_GATE_MAX_SHARDS = 16 as const;
export const MANIFEST_GATE_RETRY_AFTER_CAP_MS = 5_000;
export const MANIFEST_GATE_RETRY_ATTEMPTS = 3 as const;

export const MANIFEST_GATE_DECISIONS = ["pass", "block", "incomplete", "incompatible"] as const;
export type ManifestGateDecision = (typeof MANIFEST_GATE_DECISIONS)[number];

export const MANIFEST_GATE_EXECUTION_STATES = [
  "not_started",
  "running",
  "interrupted",
  "failed",
  "completed"
] as const;
export type ManifestGateExecutionState = (typeof MANIFEST_GATE_EXECUTION_STATES)[number];

export const MANIFEST_GATE_EVALUATION_STATUSES = [
  "pending",
  "failed",
  "unavailable",
  "completed"
] as const;
export type ManifestGateEvaluationStatus = (typeof MANIFEST_GATE_EVALUATION_STATUSES)[number];

export const MANIFEST_GATE_SERVER_REASON_CODES = [
  "MANIFEST_NOT_FOUND",
  "MANIFEST_NOT_EXECUTABLE",
  "MANIFEST_EMPTY",
  "MANIFEST_EXPIRED",
  "DECLARATION_DUPLICATE",
  "DECLARATION_MISSING",
  "DECLARATION_EXTRA",
  "SHARD_IDENTITY_MISMATCH",
  "RUN_NOT_FOUND",
  "RUN_WORKSPACE_MISMATCH",
  "RUN_MANIFEST_MISMATCH",
  "RUN_NOT_TERMINAL",
  "EVALUATION_PENDING",
  "EVALUATION_FAILED",
  "EVIDENCE_UNAVAILABLE",
  "EVIDENCE_EXPIRED",
  "EVIDENCE_QUARANTINED",
  "GRADER_IDENTITY_MISMATCH",
  "CONTRACT_UNSUPPORTED"
] as const;
export type ManifestGateServerReasonCode = (typeof MANIFEST_GATE_SERVER_REASON_CODES)[number];
export const MANIFEST_GATE_UNKNOWN_REASON = "MANIFEST_GATE_UNKNOWN_REASON" as const;

export const CREATE_RUN_MAX_SELECTED_CASES = 20 as const;
export const INVENTORY_CASE_BOUND = 48 as const;

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const rfc3339 = z.string().datetime({ offset: true });
const creditUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const semver = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/);

export const SelectionProfileSchema = z.enum(["smoke", "release"]);
export type SelectionProfile = z.infer<typeof SelectionProfileSchema>;
export const SelectionConversationModeSchema = z.enum(["single_turn", "explicit_session_v1"]);
export type SelectionConversationMode = z.infer<typeof SelectionConversationModeSchema>;

const observationKey = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/,
    "must be a dotted observation key"
  );

export const CompileSuiteSelectionCapabilitiesSchema = z
  .object({
    prepare: z.boolean(),
    observation: z.boolean(),
    toolEvents: z.boolean(),
    cleanup: z.boolean(),
    multiTurn: z.boolean(),
    observationKeys: z.array(observationKey).max(64)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.observationKeys).size !== value.observationKeys.length) {
      context.addIssue({
        code: "custom",
        message: "observationKeys must be unique",
        path: ["observationKeys"]
      });
    }
    if (
      value.observationKeys.some(
        (key, index) => index > 0 && value.observationKeys[index - 1]! >= key
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "observationKeys must be sorted in ascending order",
        path: ["observationKeys"]
      });
    }
    if (!value.observation && value.observationKeys.length > 0) {
      context.addIssue({
        code: "custom",
        message: "observationKeys require the observation capability",
        path: ["observationKeys"]
      });
    }
  });

export type CompileSuiteSelectionCapabilities = z.infer<typeof CompileSuiteSelectionCapabilitiesSchema>;

export const CompileSuiteSelectionRequestSchema = z
  .object({
    schemaVersion: z.literal(SUITE_SELECTION_SCHEMA_VERSION),
    profile: SelectionProfileSchema,
    conversationMode: SelectionConversationModeSchema,
    capabilities: CompileSuiteSelectionCapabilitiesSchema,
    includeCatalog: z.boolean().optional(),
    includeTags: z.array(z.string().min(1).max(80)).max(16).optional(),
    excludeTags: z.array(z.string().min(1).max(80)).max(16).optional(),
    requestedCaseIds: z.array(identifier).max(INVENTORY_CASE_BOUND).optional(),
    excludedCaseIds: z.array(identifier).max(INVENTORY_CASE_BOUND).optional(),
    suiteRevisionId: z.string().min(1).max(128).optional(),
    acceptedManifestVersions: z
      .array(z.literal(SUITE_SELECTION_SCHEMA_VERSION_V2))
      .length(1)
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    const session = value.conversationMode === "explicit_session_v1";
    if (session !== value.capabilities.multiTurn) {
      context.addIssue({
        code: "custom",
        message: "conversationMode and capabilities.multiTurn must agree",
        path: ["capabilities", "multiTurn"]
      });
    }
    if (value.acceptedManifestVersions !== undefined && (value.suiteRevisionId === undefined || value.suiteRevisionId === "")) {
      context.addIssue({
        code: "custom",
        message: "acceptedManifestVersions requires suiteRevisionId for a saved-suite compile",
        path: ["acceptedManifestVersions"]
      });
    }
  });

export type CompileSuiteSelectionRequest = z.infer<typeof CompileSuiteSelectionRequestSchema>;

const dispositionSchema = z
  .object({
    caseId: identifier,
    reasonCode: z.string().min(1).max(80),
    message: z.string().min(1).max(1_000)
  })
  .passthrough();

export const ShardManifestSchema = z
  .object({
    shardId: identifier,
    shardIndex: z.number().int().min(0).max(1_000),
    shardIdentityHash: sha256,
    caseIds: z.array(identifier).max(INVENTORY_CASE_BOUND),
    plannedExecutions: z.number().int().min(0).max(10_000),
    plannedCommands: z.number().int().min(0).max(10_000),
    planHash: sha256,
    packetBindings: z
      .array(
        z
          .object({
            key: identifier,
            version: semver,
            sha256: sha256.optional()
          })
          .passthrough()
      )
      .max(4),
    compileOk: z.boolean(),
    compileReasonCode: z.string().min(1).max(80).nullable().optional(),
    compileMessage: z.string().max(1_000).nullable().optional()
  })
  .passthrough();

export type ShardManifest = z.infer<typeof ShardManifestSchema>;

export const SavedSuiteBindingCaseSchema = z
  .object({
    caseId: identifier,
    scenarioId: identifier,
    repetitions: z.literal(1)
  })
  .strict();

export type SavedSuiteBindingCase = z.infer<typeof SavedSuiteBindingCaseSchema>;

export const SavedSuiteBindingSchema = z
  .object({
    schemaVersion: z.literal(SAVED_SUITE_BINDING_SCHEMA_VERSION),
    suiteId: identifier,
    suiteRevisionId: z.string().min(1).max(128),
    canonicalHash: sha256,
    semanticRevisionHash: z.string().min(1).max(128),
    cases: z.array(SavedSuiteBindingCaseSchema).min(1).max(CREATE_RUN_MAX_SELECTED_CASES)
  })
  .strict()
  .superRefine((value, context) => {
    const caseIds = value.cases.map((entry) => entry.caseId);
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({
        code: "custom",
        message: "suiteBinding.cases caseId values must be unique",
        path: ["cases"]
      });
    }
    const scenarioIds = value.cases.map((entry) => entry.scenarioId);
    if (new Set(scenarioIds).size !== scenarioIds.length) {
      context.addIssue({
        code: "custom",
        message: "suiteBinding.cases scenarioId values must be unique",
        path: ["cases"]
      });
    }
    for (const [index, entry] of value.cases.entries()) {
      if (entry.scenarioId !== entry.caseId && !entry.scenarioId.endsWith(`/${entry.caseId}`)) {
        context.addIssue({
          code: "custom",
          message: "suiteBinding scenarioId must equal caseId or end with /caseId",
          path: ["cases", index, "scenarioId"]
        });
      }
    }
  });

export type SavedSuiteBinding = z.infer<typeof SavedSuiteBindingSchema>;

export const SuiteSelectionManifestSchema = z
  .object({
    schemaVersion: z.enum([SUITE_SELECTION_SCHEMA_VERSION, SUITE_SELECTION_SCHEMA_VERSION_V2]),
    documentKind: z.literal(SUITE_SELECTION_DOCUMENT_KIND),
    selectionVersion: semver,
    createsBillableRun: z.boolean(),
    workspaceId: z.string().min(1).max(200).nullable().optional(),
    suiteRevisionId: z.string().max(128).nullable().optional(),
    suiteId: z.string().max(300).nullable().optional(),
    semanticRevisionHash: z.string().max(128).nullable().optional(),
    catalogChecksum: z.union([sha256, z.null()]),
    inventoryHash: sha256,
    normalizedSelection: z
      .object({
        profile: SelectionProfileSchema,
        includeTags: z.array(z.string()).max(16),
        excludeTags: z.array(z.string()).max(16),
        conversationMode: SelectionConversationModeSchema,
        excludedCaseIds: z.array(identifier).max(INVENTORY_CASE_BOUND),
        requestedCaseIds: z.array(identifier).max(INVENTORY_CASE_BOUND)
      })
      .passthrough(),
    requestedCaseCount: z.number().int().min(0).max(10_000),
    includedCaseCount: z.number().int().min(0).max(INVENTORY_CASE_BOUND),
    plannedExecutions: z.number().int().min(0).max(10_000),
    plannedCommands: z.number().int().min(0).max(10_000),
    perRunLimits: z
      .object({
        maxCases: z.number().int().min(1).max(20),
        maxExecutions: z.number().int().min(1).max(60),
        maxCommands: z.number().int().min(1).max(512)
      })
      .strict(),
    quoteIsAuthoritative: z.boolean(),
    aggregateReleaseRequiresCompleteCoverage: z.boolean(),
    executable: z.boolean(),
    unexecutableReason: z.string().max(1_000).nullable().optional(),
    included: z.array(dispositionSchema).max(INVENTORY_CASE_BOUND),
    excluded: z.array(dispositionSchema).max(INVENTORY_CASE_BOUND),
    incompatible: z.array(dispositionSchema).max(INVENTORY_CASE_BOUND),
    shards: z.array(ShardManifestSchema).max(16),
    suiteBinding: SavedSuiteBindingSchema.optional(),
    manifestHash: sha256
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.schemaVersion === SUITE_SELECTION_SCHEMA_VERSION) {
      if (value.catalogChecksum === null) {
        context.addIssue({
          code: "custom",
          message: "aw-suite-selection/1 requires a SHA-256 catalogChecksum",
          path: ["catalogChecksum"]
        });
      }
      if (value.suiteBinding !== undefined) {
        context.addIssue({
          code: "custom",
          message: "aw-suite-selection/1 does not include suiteBinding",
          path: ["suiteBinding"]
        });
      }
      return;
    }
    if (value.selectionVersion !== SAVED_SUITE_SELECTION_VERSION) {
      context.addIssue({
        code: "custom",
        message: `aw-suite-selection/2 requires selectionVersion ${SAVED_SUITE_SELECTION_VERSION}`,
        path: ["selectionVersion"]
      });
    }
    if (value.suiteBinding === undefined) {
      context.addIssue({
        code: "custom",
        message: "aw-suite-selection/2 requires suiteBinding",
        path: ["suiteBinding"]
      });
    }
  });

export type SuiteSelectionManifest = z.infer<typeof SuiteSelectionManifestSchema>;

export function isSavedSuiteManifest(
  manifest: SuiteSelectionManifest
): manifest is SuiteSelectionManifest & {
  schemaVersion: typeof SUITE_SELECTION_SCHEMA_VERSION_V2;
  suiteBinding: SavedSuiteBinding;
} {
  return manifest.schemaVersion === SUITE_SELECTION_SCHEMA_VERSION_V2 && manifest.suiteBinding !== undefined;
}

export function requestsSavedSuiteManifest(request: CompileSuiteSelectionRequest): boolean {
  return (
    request.acceptedManifestVersions?.length === 1 &&
    request.acceptedManifestVersions[0] === SUITE_SELECTION_SCHEMA_VERSION_V2
  );
}

export const DeclaredShardSchema = z
  .object({
    shardId: identifier,
    shardIdentityHash: sha256.optional(),
    runId: identifier
  })
  .strict();

export type DeclaredShard = z.infer<typeof DeclaredShardSchema>;

export const EvaluateManifestRequestSchema = z
  .object({
    schemaVersion: z.literal(SUITE_SELECTION_SCHEMA_VERSION),
    manifest: SuiteSelectionManifestSchema,
    expectedManifestHash: sha256,
    declaredShards: z.array(DeclaredShardSchema).max(16)
  })
  .strict();

export type EvaluateManifestRequest = z.infer<typeof EvaluateManifestRequestSchema>;

export const ManifestReleasePolicyResultSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_RELEASE_POLICY_SCHEMA_VERSION),
    documentKind: z.literal(MANIFEST_RELEASE_POLICY_DOCUMENT_KIND),
    policyVersion: z.string().min(1).max(80),
    createsBillableRun: z.boolean(),
    workspaceId: z.string().min(1).max(200).nullable().optional(),
    suiteRevisionId: z.string().max(128).nullable().optional(),
    semanticRevisionHash: z.string().max(128).nullable().optional(),
    manifestHash: sha256,
    decision: z.enum(["pass", "block", "incomplete", "incompatible"]),
    coverageComplete: z.boolean(),
    reasons: z
      .array(
        z
          .object({
            code: z.string().min(1).max(80),
            shardId: z.string().max(300).nullable().optional(),
            message: z.string().min(1).max(1_000)
          })
          .passthrough()
      )
      .max(64),
    expectedShardIds: z.array(identifier).max(16),
    declaredRunIds: z.array(identifier).max(16),
    shards: z.array(z.record(z.string(), z.unknown())).max(16),
    note: z.string().max(2_000).optional()
  })
  .passthrough();

export type ManifestReleasePolicyResult = z.infer<typeof ManifestReleasePolicyResultSchema>;

const gateUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a lowercase UUID"
  );
const gateReasonCode = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]{0,79}$/);

export const ManifestGateDeclaredShardSchema = z
  .object({
    shardId: identifier,
    shardIdentityHash: sha256,
    runId: gateUuid
  })
  .strict();

export type ManifestGateDeclaredShard = z.infer<typeof ManifestGateDeclaredShardSchema>;

export const EvaluateManifestGateRequestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_GATE_REQUEST_SCHEMA_VERSION),
    manifestHash: sha256,
    declaredShards: z
      .array(ManifestGateDeclaredShardSchema)
      .min(MANIFEST_GATE_MIN_SHARDS)
      .max(MANIFEST_GATE_MAX_SHARDS)
  })
  .strict()
  .superRefine((value, context) => {
    const shardIds = value.declaredShards.map((shard) => shard.shardId);
    const hashes = value.declaredShards.map((shard) => shard.shardIdentityHash);
    const runIds = value.declaredShards.map((shard) => shard.runId);
    if (new Set(shardIds).size !== shardIds.length) {
      context.addIssue({
        code: "custom",
        message: "declaredShards shardId values must be unique",
        path: ["declaredShards"]
      });
    }
    if (new Set(hashes).size !== hashes.length) {
      context.addIssue({
        code: "custom",
        message: "declaredShards shardIdentityHash values must be unique",
        path: ["declaredShards"]
      });
    }
    if (new Set(runIds).size !== runIds.length) {
      context.addIssue({
        code: "custom",
        message: "declaredShards runId values must be unique",
        path: ["declaredShards"]
      });
    }
  });

export type EvaluateManifestGateRequest = z.infer<typeof EvaluateManifestGateRequestSchema>;

export const ManifestGateResolvedShardSchema = z
  .object({
    shardId: identifier,
    shardIdentityHash: sha256,
    runId: gateUuid,
    executionState: z.enum(MANIFEST_GATE_EXECUTION_STATES),
    evaluationStatus: z.enum(MANIFEST_GATE_EVALUATION_STATUSES),
    decision: z.enum(MANIFEST_GATE_DECISIONS)
  })
  .strict();

export type ManifestGateResolvedShard = z.infer<typeof ManifestGateResolvedShardSchema>;

export const ManifestReleasePolicyV2Schema = z
  .object({
    documentKind: z.literal(MANIFEST_GATE_DOCUMENT_KIND),
    manifestHash: sha256,
    decision: z.enum(MANIFEST_GATE_DECISIONS),
    coverageComplete: z.boolean(),
    evidenceSource: z.literal(MANIFEST_GATE_EVIDENCE_SOURCE),
    reasonCodes: z.array(gateReasonCode).max(64),
    resolvedShards: z
      .array(ManifestGateResolvedShardSchema)
      .min(MANIFEST_GATE_MIN_SHARDS)
      .max(MANIFEST_GATE_MAX_SHARDS),
    createsBillableRun: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    const shardIds = value.resolvedShards.map((shard) => shard.shardId);
    const hashes = value.resolvedShards.map((shard) => shard.shardIdentityHash);
    const runIds = value.resolvedShards.map((shard) => shard.runId);
    if (new Set(shardIds).size !== shardIds.length) {
      context.addIssue({
        code: "custom",
        message: "resolvedShards shardId values must be unique",
        path: ["resolvedShards"]
      });
    }
    if (new Set(hashes).size !== hashes.length) {
      context.addIssue({
        code: "custom",
        message: "resolvedShards shardIdentityHash values must be unique",
        path: ["resolvedShards"]
      });
    }
    if (new Set(runIds).size !== runIds.length) {
      context.addIssue({
        code: "custom",
        message: "resolvedShards runId values must be unique",
        path: ["resolvedShards"]
      });
    }
    if (new Set(value.reasonCodes).size !== value.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        message: "reasonCodes must be unique",
        path: ["reasonCodes"]
      });
    }
  });

export type ManifestReleasePolicyV2 = z.infer<typeof ManifestReleasePolicyV2Schema>;

export const MANIFEST_GATE_FORBIDDEN_REQUEST_KEYS = [
  "manifest",
  "expectedManifestHash",
  "status",
  "evaluationStatus",
  "executionState",
  "verdict",
  "decision",
  "comparability",
  "score",
  "transcript",
  "targetUrl",
  "target_url",
  "quote",
  "credits",
  "coverageComplete",
  "reasons",
  "shards",
  "resolvedShards",
  "createsBillableRun"
] as const;

export const SelectionProgressSchema = z
  .object({
    schemaVersion: z.literal(SELECTION_PROGRESS_SCHEMA_VERSION),
    manifestHash: sha256,
    aggregateMaxCredits: z.number().int().min(0),
    remainingCredits: z.number().int().min(0),
    stoppedReason: z.string().max(200).nullable(),
    shards: z
      .array(
        z
          .object({
            shardId: identifier,
            shardIdentityHash: sha256,
            status: z.enum(["pending", "running", "completed", "failed", "skipped", "interrupted"]),
            runId: identifier.optional(),
            quoteUnits: z.number().int().min(0).optional(),
            stoppedReason: z.string().max(200).optional()
          })
          .strict()
      )
      .max(16)
  })
  .strict();

export type SelectionProgress = z.infer<typeof SelectionProgressSchema>;

export const SelectionExecutionStateSchema = z.enum(SELECTION_EXECUTION_STATES);
export type SelectionExecutionState = z.infer<typeof SelectionExecutionStateSchema>;

export const SelectionExecutionShardStateSchema = z.enum(SELECTION_EXECUTION_SHARD_STATES);
export type SelectionExecutionShardState = z.infer<typeof SelectionExecutionShardStateSchema>;

export const SelectionExecutionShardSchema = z
  .object({
    shardId: identifier,
    shardIdentityHash: sha256,
    runId: identifier.nullable(),
    quoteId: z.string().min(1).max(200).nullable(),
    quotedUnits: creditUnits,
    chargedUnits: creditUnits,
    state: SelectionExecutionShardStateSchema
  })
  .strict();

export type SelectionExecutionShard = z.infer<typeof SelectionExecutionShardSchema>;

export const SelectionExecutionSchema = z
  .object({
    documentKind: z.literal(SELECTION_EXECUTION_DOCUMENT_KIND),
    executionId: uuid,
    manifestHash: sha256,
    createdAt: rfc3339,
    updatedAt: rfc3339,
    aggregateMaxCredits: creditUnits,
    remainingCredits: creditUnits,
    state: SelectionExecutionStateSchema,
    terminalReason: z.string().min(1).max(200).nullable(),
    shards: z.array(SelectionExecutionShardSchema).max(16)
  })
  .strict();

export type SelectionExecution = z.infer<typeof SelectionExecutionSchema>;

export const SelectionExecutionIndexSchema = z
  .object({
    documentKind: z.literal(SELECTION_EXECUTION_INDEX_DOCUMENT_KIND),
    manifestHash: sha256,
    unfinishedExecutionId: uuid.nullable(),
    v1Migrated: z.boolean(),
    updatedAt: rfc3339
  })
  .strict();

export type SelectionExecutionIndex = z.infer<typeof SelectionExecutionIndexSchema>;

export const SelectionArtifactSchema = z
  .object({
    schemaVersion: z.literal(SELECTION_ARTIFACT_SCHEMA_VERSION),
    manifestHash: sha256,
    expectedShardIds: z.array(identifier).max(16),
    declaredShards: z.array(DeclaredShardSchema).max(16),
    missingShardIds: z.array(identifier).max(16),
    skippedShardIds: z.array(identifier).max(16),
    failedShardIds: z.array(identifier).max(16),
    createsBillableRun: z.literal(false)
  })
  .strict();

export type SelectionArtifact = z.infer<typeof SelectionArtifactSchema>;
