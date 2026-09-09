import { DISCLOSURE_VERSION } from "../assessment/schema.js";
import type { CreateRunAssessment } from "../cloud/protocol.js";
import { CREATE_RUN_MAX_SELECTED_CASES, type ShardManifest, type SuiteSelectionManifest } from "./schema.js";
import {
  emptySelectionError,
  perRunExpandedLimitError,
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
  return {
    packet: { key: binding.key, version: binding.version },
    assessment: {
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
      }
    }
  };
}
