import { DISCLOSURE_VERSION } from "../assessment/schema.js";
import type { CreateRunAssessment } from "../cloud/protocol.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import {
  CREATE_RUN_MAX_SELECTED_CASES,
  SUITE_SELECTION_SCHEMA_VERSION_V2,
  isSavedSuiteManifest,
  type ShardManifest,
  type SuiteSelectionManifest
} from "./schema.js";
import {
  emptySelectionError,
  perRunExpandedLimitError,
  savedSuiteBindingInvalidError,
  savedSuiteBindingStaleError,
  savedSuiteBindingUnsupportedError,
  selectionError,
  unexecutableSelectionError
} from "./errors.js";

export function requireExecutableManifest(manifest: SuiteSelectionManifest): void {
  if (manifest.createsBillableRun) {
    throw selectionError(
      "CREATES_BILLABLE_RUN",
      "The suite-selection API advertised createsBillableRun. Compile must not start, reserve, or charge a run.",
      { category: "protocol" }
    );
  }
  if (manifest.incompatible.length > 0 && !manifest.executable) {
    throw unexecutableSelectionError(
      manifest.unexecutableReason ?? "The compiled selection is not executable."
    );
  }
  if (manifest.includedCaseCount === 0 || manifest.shards.length === 0) {
    throw emptySelectionError();
  }
  if (!manifest.executable) {
    throw unexecutableSelectionError(
      manifest.unexecutableReason ?? "The compiled selection is not executable."
    );
  }
}

export function requirePinnedSelectionVersion(
  manifest: SuiteSelectionManifest,
  suiteVersion: string | undefined
): void {
  if (suiteVersion === undefined || suiteVersion === "") return;
  if (manifest.selectionVersion !== suiteVersion) {
    throw selectionError(
      "SELECTION_VERSION_STALE",
      `The compiled selectionVersion ${manifest.selectionVersion} does not match the pinned suite_version ${suiteVersion}. Replace the pin before consent. Do not quote from a stale selection.`,
      {
        details: {
          pinned_suite_version: suiteVersion,
          selection_version: manifest.selectionVersion
        }
      }
    );
  }
}

export function unsignedSavedSuiteManifest(manifest: SuiteSelectionManifest): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    documentKind: manifest.documentKind,
    selectionVersion: manifest.selectionVersion,
    createsBillableRun: manifest.createsBillableRun,
    workspaceId: manifest.workspaceId ?? null,
    suiteRevisionId: manifest.suiteRevisionId ?? null,
    suiteId: manifest.suiteId ?? null,
    semanticRevisionHash: manifest.semanticRevisionHash ?? null,
    catalogChecksum: manifest.catalogChecksum,
    inventoryHash: manifest.inventoryHash,
    normalizedSelection: manifest.normalizedSelection,
    requestedCaseCount: manifest.requestedCaseCount,
    includedCaseCount: manifest.includedCaseCount,
    plannedExecutions: manifest.plannedExecutions,
    plannedCommands: manifest.plannedCommands,
    perRunLimits: manifest.perRunLimits,
    quoteIsAuthoritative: manifest.quoteIsAuthoritative,
    aggregateReleaseRequiresCompleteCoverage: manifest.aggregateReleaseRequiresCompleteCoverage,
    executable: manifest.executable,
    unexecutableReason: manifest.unexecutableReason ?? null,
    included: manifest.included,
    excluded: manifest.excluded,
    incompatible: manifest.incompatible,
    shards: manifest.shards,
    suiteBinding: manifest.suiteBinding
  };
}

export function computeManifestIntegrityHash(manifest: SuiteSelectionManifest): string {
  return sha256(canonicalize(unsignedSavedSuiteManifest(manifest)));
}

export function requireSavedSuiteManifest(
  manifest: SuiteSelectionManifest
): asserts manifest is SuiteSelectionManifest & {
  schemaVersion: typeof SUITE_SELECTION_SCHEMA_VERSION_V2;
  suiteBinding: NonNullable<SuiteSelectionManifest["suiteBinding"]>;
} {
  if (!isSavedSuiteManifest(manifest)) {
    throw savedSuiteBindingUnsupportedError();
  }
  if (manifest.catalogChecksum !== null) {
    throw savedSuiteBindingInvalidError(
      "A saved-suite v2 manifest must use catalogChecksum null; mixed catalog inventory is not an executable saved-suite binding."
    );
  }
  const binding = manifest.suiteBinding;
  if (manifest.suiteId !== binding.suiteId || manifest.suiteRevisionId !== binding.suiteRevisionId) {
    throw savedSuiteBindingInvalidError(
      "The compiled suite identity does not match suiteBinding. Mixed-revision bindings are rejected before quote.",
      {
        manifest_suite_id: manifest.suiteId ?? "",
        binding_suite_id: binding.suiteId,
        manifest_revision: manifest.suiteRevisionId ?? "",
        bound_revision: binding.suiteRevisionId
      }
    );
  }
  if (manifest.semanticRevisionHash !== binding.semanticRevisionHash) {
    throw savedSuiteBindingInvalidError(
      "The compiled semanticRevisionHash does not match suiteBinding. Mixed-revision bindings are rejected before quote."
    );
  }
  if (binding.cases.length > manifest.perRunLimits.maxCases || binding.cases.length > CREATE_RUN_MAX_SELECTED_CASES) {
    throw savedSuiteBindingInvalidError(
      "The saved-suite binding exceeds the frozen per-run case limit.",
      { cases: binding.cases.length, maxCases: manifest.perRunLimits.maxCases }
    );
  }
  const includedIds = manifest.included.map((row) => row.caseId);
  const scenarioIds = binding.cases.map((entry) => entry.scenarioId);
  if (!sameIdentifierSet(includedIds, scenarioIds)) {
    throw savedSuiteBindingInvalidError(
      "suiteBinding.cases scenario IDs must match the compiled included cases exactly."
    );
  }
  const shardCaseIds = manifest.shards.flatMap((shard) => shard.caseIds);
  if (manifest.executable && !sameIdentifierSet(shardCaseIds, scenarioIds)) {
    throw savedSuiteBindingInvalidError(
      "Compiled shard case IDs must match the saved-suite binding scenario IDs."
    );
  }
  const computed = computeManifestIntegrityHash(manifest);
  if (computed !== manifest.manifestHash) {
    throw savedSuiteBindingInvalidError(
      "The compiled saved-suite manifestHash does not match the canonical unsigned document."
    );
  }
}

export function admitCompiledSelection(
  manifest: SuiteSelectionManifest,
  options: {
    readonly requestedSavedSuite: boolean;
    readonly suiteVersion?: string;
    readonly suiteRevisionId?: string;
  }
): void {
  requirePinnedSelectionVersion(manifest, options.suiteVersion);
  if (options.requestedSavedSuite && manifest.schemaVersion !== SUITE_SELECTION_SCHEMA_VERSION_V2) {
    throw savedSuiteBindingUnsupportedError();
  }
  if (manifest.schemaVersion === SUITE_SELECTION_SCHEMA_VERSION_V2) {
    requireSavedSuiteManifest(manifest);
    if (
      options.suiteRevisionId !== undefined &&
      options.suiteRevisionId !== "" &&
      manifest.suiteBinding.suiteRevisionId !== options.suiteRevisionId
    ) {
      throw savedSuiteBindingStaleError({
        requested_revision: options.suiteRevisionId,
        bound_revision: manifest.suiteBinding.suiteRevisionId
      });
    }
  }
}

export function savedSuitePinFromManifest(manifest: SuiteSelectionManifest): {
  readonly suite_id: string;
  readonly suite_revision_id: string;
  readonly suite_content_hash: string;
} | undefined {
  if (!isSavedSuiteManifest(manifest)) return undefined;
  return {
    suite_id: manifest.suiteBinding.suiteId,
    suite_revision_id: manifest.suiteBinding.suiteRevisionId,
    suite_content_hash: manifest.suiteBinding.canonicalHash
  };
}

function sameIdentifierSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  const actual = new Set(left);
  return expected.size === right.length && actual.size === left.length && left.every((value) => expected.has(value));
}

export function selectShard(
  manifest: SuiteSelectionManifest,
  shardId: string | undefined
): ShardManifest {
  requireExecutableManifest(manifest);
  if (shardId === undefined || shardId.trim() === "") {
    if (manifest.shards.length !== 1) {
      throw selectionError(
        "SHARD_REQUIRED",
        "This manifest has more than one shard. Pass --shard <shard-id> or --all-shards with a finite --max-credits ceiling. The CLI will not start unbounded additional runs."
      );
    }
    const only = manifest.shards[0];
    if (only === undefined) throw emptySelectionError();
    assertShardWithinPerRunLimits(manifest, only);
    return only;
  }
  const shard = manifest.shards.find((entry) => entry.shardId === shardId);
  if (shard === undefined) {
    throw selectionError(
      "SHARD_NOT_FOUND",
      `Shard ${shardId} is not in this immutable manifest.`
    );
  }
  assertShardWithinPerRunLimits(manifest, shard);
  return shard;
}

export function assertShardWithinPerRunLimits(
  manifest: SuiteSelectionManifest,
  shard: ShardManifest
): void {
  if (!shard.compileOk) {
    throw unexecutableSelectionError(
      shard.compileMessage ?? "The selected shard did not compile."
    );
  }
  const limits = manifest.perRunLimits;
  if (
    shard.caseIds.length > limits.maxCases ||
    shard.plannedExecutions > limits.maxExecutions ||
    shard.plannedCommands > limits.maxCommands ||
    shard.caseIds.length > CREATE_RUN_MAX_SELECTED_CASES
  ) {
    throw perRunExpandedLimitError({
      cases: shard.caseIds.length,
      executions: shard.plannedExecutions,
      commands: shard.plannedCommands,
      maxCases: limits.maxCases,
      maxExecutions: limits.maxExecutions,
      maxCommands: limits.maxCommands
    });
  }
  const binding = shard.packetBindings[0];
  if (binding === undefined) {
    throw selectionError(
      "SHARD_PACKET_MISSING",
      "The compiled shard did not include packetBindings. The CLI will not invent a packet key."
    );
  }
}

export function shardCreateFields(
  shard: ShardManifest,
  extras: {
    readonly referenceBundle?: CreateRunAssessment["reference_bundle"];
    readonly suitePin?: {
      readonly suite_id: string;
      readonly suite_revision_id: string;
      readonly suite_content_hash: string;
    };
  } = {}
): {
  readonly packet: { readonly key: string; readonly version: string };
  readonly assessment: CreateRunAssessment;
} {
  const binding = shard.packetBindings[0];
  if (binding === undefined) {
    throw selectionError(
      "SHARD_PACKET_MISSING",
      "The compiled shard did not include packetBindings. The CLI will not invent a packet key."
    );
  }
  const assessment: CreateRunAssessment = {
    plan_hash: shard.planHash,
    profile: "custom",
    evaluation_mode: "hybrid",
    disclosure_version: DISCLOSURE_VERSION,
    selected_scenario_ids: [...shard.caseIds],
    packet_bindings: shard.packetBindings.map((entry) => ({
      key: entry.key,
      version: entry.version
    })),
    reference_bundle: extras.referenceBundle ?? {
      bundleId: `bundle_${shard.planHash.slice(0, 12)}`,
      entries: [],
      refundPolicy: null,
      knowledgeBoundary: null,
      targetAlreadyConfigured: true
    },
    ...(extras.suitePin === undefined
      ? {}
      : {
          suite_id: extras.suitePin.suite_id,
          suite_revision_id: extras.suitePin.suite_revision_id,
          suite_content_hash: extras.suitePin.suite_content_hash
        })
  };
  return {
    packet: { key: binding.key, version: binding.version },
    assessment
  };
}
