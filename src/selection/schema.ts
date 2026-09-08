import { z } from "zod";

export const SUITE_SELECTION_SCHEMA_VERSION = "aw-suite-selection/1" as const;
export const SUITE_SELECTION_DOCUMENT_KIND = "suite_selection_manifest" as const;
export const MANIFEST_RELEASE_POLICY_SCHEMA_VERSION = "aw-manifest-release-policy/1" as const;
export const MANIFEST_RELEASE_POLICY_DOCUMENT_KIND = "manifest_release_policy_result" as const;
export const SELECTION_PROGRESS_SCHEMA_VERSION = "aw-selection-progress/1" as const;
export const SELECTION_ARTIFACT_SCHEMA_VERSION = "aw-selection-artifact/1" as const;

export const SELECTION_PATHS = {
  compile: "/v1/suite-selections/compile",
  evaluateManifest: "/v1/release-gates/evaluate-manifest"
} as const;

export const CREATE_RUN_MAX_SELECTED_CASES = 20 as const;
export const INVENTORY_CASE_BOUND = 48 as const;

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const semver = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/);

export const SelectionProfileSchema = z.enum(["smoke", "release"]);
export type SelectionProfile = z.infer<typeof SelectionProfileSchema>;
export const SelectionConversationModeSchema = z.enum(["single_turn", "explicit_session_v1"]);

export const CompileSuiteSelectionRequestSchema = z
  .object({
    schemaVersion: z.literal(SUITE_SELECTION_SCHEMA_VERSION),
    profile: SelectionProfileSchema,
    conversationMode: SelectionConversationModeSchema,
    includeCatalog: z.boolean().optional(),
    includeTags: z.array(z.string().min(1).max(80)).max(16).optional(),
    excludeTags: z.array(z.string().min(1).max(80)).max(16).optional(),
    requestedCaseIds: z.array(identifier).max(INVENTORY_CASE_BOUND).optional(),
    excludedCaseIds: z.array(identifier).max(INVENTORY_CASE_BOUND).optional(),
    suiteRevisionId: z.string().min(1).max(128).optional()
  })
  .strict();

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

export const SuiteSelectionManifestSchema = z
  .object({
    schemaVersion: z.literal(SUITE_SELECTION_SCHEMA_VERSION),
    documentKind: z.literal(SUITE_SELECTION_DOCUMENT_KIND),
    selectionVersion: semver,
    createsBillableRun: z.boolean(),
    workspaceId: z.string().min(1).max(200).nullable().optional(),
    suiteRevisionId: z.string().max(128).nullable().optional(),
    suiteId: z.string().max(300).nullable().optional(),
    semanticRevisionHash: z.string().max(128).nullable().optional(),
    catalogChecksum: sha256,
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
    manifestHash: sha256
  })
  .passthrough();

export type SuiteSelectionManifest = z.infer<typeof SuiteSelectionManifestSchema>;

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
