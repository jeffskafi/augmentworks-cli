import type { SavedSuiteBinding, SuiteSelectionManifest } from "../../src/selection/schema.js";
import { computeManifestIntegrityHash } from "../../src/selection/admit.js";

export const WORKSPACE = "11111111-1111-4111-8111-111111111111";
export const SUITE_ID = "policy-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SUITE_REVISION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_REVISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const CANONICAL_HASH = "c".repeat(64);
export const SEMANTIC_HASH = "d".repeat(64);
export const INVENTORY_HASH = "e".repeat(64);
export const SHARD_IDENTITY_HASH = "f".repeat(64);
export const PLAN_HASH = "1".repeat(64);
export const PACKET_SHA = "2".repeat(64);
export const POLICY_SCENARIO_IDS = [
  "aw-customer-suite/1.0.0/policy-p01",
  "aw-customer-suite/1.0.0/policy-p02"
] as const;

export function savedSuiteAssessmentYaml(options: { readonly revisionId?: string } = {}): string {
  const revision = options.revisionId ?? SUITE_REVISION;
  return `schema_version: aw-assessment-file/1
profile: custom
evaluation_mode: hybrid
packets:
  - key: aw-customer-suite
    version: 1.0.0
    scenarios:
      - ${POLICY_SCENARIO_IDS[0]}
      - ${POLICY_SCENARIO_IDS[1]}
target_already_configured: true
selection:
  profile: release
  suite_version: 2.0.0
  suite_revision_id: ${revision}
  requested_case_ids:
    - ${POLICY_SCENARIO_IDS[0]}
    - ${POLICY_SCENARIO_IDS[1]}
`;
}

export function savedSuiteBinding(options: {
  readonly cases?: SavedSuiteBinding["cases"];
  readonly suiteId?: string;
  readonly suiteRevisionId?: string;
  readonly canonicalHash?: string;
  readonly semanticRevisionHash?: string;
} = {}): SavedSuiteBinding {
  return {
    schemaVersion: "aw-saved-suite-binding/1",
    suiteId: options.suiteId ?? SUITE_ID,
    suiteRevisionId: options.suiteRevisionId ?? SUITE_REVISION,
    canonicalHash: options.canonicalHash ?? CANONICAL_HASH,
    semanticRevisionHash: options.semanticRevisionHash ?? SEMANTIC_HASH,
    cases: options.cases ?? [
      { caseId: "policy-p01", scenarioId: POLICY_SCENARIO_IDS[0], repetitions: 1 },
      { caseId: "policy-p02", scenarioId: POLICY_SCENARIO_IDS[1], repetitions: 1 }
    ]
  };
}

export function savedSuiteManifest(options: {
  readonly binding?: SavedSuiteBinding;
  readonly catalogChecksum?: string | null;
  readonly suiteId?: string | null;
  readonly suiteRevisionId?: string | null;
  readonly semanticRevisionHash?: string | null;
  readonly executable?: boolean;
  readonly maxCases?: number;
  readonly tamperHash?: boolean;
} = {}): SuiteSelectionManifest {
  const binding = options.binding ?? savedSuiteBinding();
  const scenarioIds = binding.cases.map((entry) => entry.scenarioId);
  const draft: SuiteSelectionManifest = {
    schemaVersion: "aw-suite-selection/2",
    documentKind: "suite_selection_manifest",
    selectionVersion: "2.0.0",
    createsBillableRun: false,
    workspaceId: WORKSPACE,
    suiteRevisionId: options.suiteRevisionId === undefined ? binding.suiteRevisionId : options.suiteRevisionId,
    suiteId: options.suiteId === undefined ? binding.suiteId : options.suiteId,
    semanticRevisionHash:
      options.semanticRevisionHash === undefined ? binding.semanticRevisionHash : options.semanticRevisionHash,
    catalogChecksum: options.catalogChecksum === undefined ? null : options.catalogChecksum,
    inventoryHash: INVENTORY_HASH,
    normalizedSelection: {
      profile: "release",
      includeTags: [],
      excludeTags: [],
      conversationMode: "single_turn",
      excludedCaseIds: [],
      requestedCaseIds: [...scenarioIds]
    },
    requestedCaseCount: scenarioIds.length,
    includedCaseCount: scenarioIds.length,
    plannedExecutions: scenarioIds.length,
    plannedCommands: scenarioIds.length,
    perRunLimits: {
      maxCases: options.maxCases ?? 20,
      maxExecutions: 60,
      maxCommands: 512
    },
    quoteIsAuthoritative: true,
    aggregateReleaseRequiresCompleteCoverage: true,
    executable: options.executable ?? true,
    unexecutableReason: null,
    included: scenarioIds.map((caseId) => ({
      caseId,
      reasonCode: "included",
      message: `Case ${caseId} is included once in the normalized selection.`
    })),
    excluded: [],
    incompatible: [],
    shards: [
      {
        shardId: "shard-000",
        shardIndex: 0,
        shardIdentityHash: SHARD_IDENTITY_HASH,
        caseIds: [...scenarioIds],
        plannedExecutions: scenarioIds.length,
        plannedCommands: scenarioIds.length,
        planHash: PLAN_HASH,
        packetBindings: [{ key: "aw-customer-suite", version: "1.0.0", sha256: PACKET_SHA }],
        compileOk: true,
        compileReasonCode: null,
        compileMessage: null
      }
    ],
    suiteBinding: binding,
    manifestHash: "0".repeat(64)
  };
  const hashed: SuiteSelectionManifest = {
    ...draft,
    manifestHash: computeManifestIntegrityHash(draft)
  };
  if (options.tamperHash === true) {
    return {
      ...hashed,
      suiteBinding: {
        ...binding,
        canonicalHash: "9".repeat(64)
      }
    };
  }
  return hashed;
}
