import { randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse as parsePath, relative, resolve, sep } from "node:path";

import { AwError, EXIT } from "../errors.js";
import {
  acquireSecureLock,
  type SecureLockHandle
} from "../relay/secure-lock.js";
import { isExpectedWindowsDirectorySyncError } from "../relay/run-intent.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import {
  selectionError,
  selectionLegacyUnboundError,
  selectionProgressMigrationRequiredError,
  selectionResumeRequiredError
} from "./errors.js";
import {
  SELECTION_ARTIFACT_SCHEMA_VERSION,
  SELECTION_EXECUTION_DOCUMENT_KIND,
  SELECTION_EXECUTION_DOCUMENT_KIND_V2,
  SELECTION_EXECUTION_INDEX_DOCUMENT_KIND,
  SELECTION_EXECUTION_INDEX_DOCUMENT_KIND_V2,
  LegacySelectionExecutionIndexSchema,
  LegacySelectionExecutionSchema,
  SelectionExecutionIndexSchema,
  SelectionExecutionSchema,
  SelectionProgressSchema,
  findCrossShardBindingDuplicate,
  type LegacySelectionExecution,
  type SelectionArtifact,
  type SelectionExecution,
  type SelectionExecutionIndex,
  type SelectionExecutionShard,
  type SelectionExecutionShardState,
  type SelectionExecutionState,
  type SelectionExecutionTenant,
  type SelectionProgress,
  type SuiteSelectionManifest
} from "./schema.js";
import {
  assertSelectionTenantMatch,
  originalRunIdsFromShards,
  parseSelectionTenant
} from "./tenant.js";

export const EXECUTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANIFEST_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EXECUTION_BYTES = 64 * 1024;
const IN_FLIGHT_SHARD_STATES = new Set<SelectionExecutionShardState>([
  "quoted",
  "admitted",
  "running"
]);
const TERMINAL_EXECUTION_STATES = new Set<SelectionExecutionState>([
  "completed",
  "blocked",
  "failed"
]);

export type SelectionExecutionKind = "created" | "resumed" | "rerun";

export type SelectionExecutionPaths = {
  readonly root: string;
  readonly executions: string;
  readonly index: string;
  readonly v1Progress: string;
};

export type OpenedSelectionExecution = {
  readonly execution: SelectionExecution;
  readonly kind: SelectionExecutionKind;
  readonly lock: SecureLockHandle;
  readonly paths: SelectionExecutionPaths;
};

export type SelectionExecutionClock = {
  readonly now?: () => Date;
  readonly createExecutionId?: () => string;
};

export type ResolveSelectionExecutionInput = SelectionExecutionClock & {
  readonly stateDirectory: string;
  readonly manifest: SuiteSelectionManifest;
  readonly aggregateMaxCredits: number;
  readonly tenant?: SelectionExecutionTenant;
  readonly executionId?: string;
  readonly manifestPath?: string;
  readonly yes?: boolean;
};

export type SelectionExecutionPreflightInput = SelectionExecutionClock & {
  readonly stateDirectory: string;
  readonly manifest: SuiteSelectionManifest;
  readonly aggregateMaxCredits: number;
  readonly executionId?: string;
  readonly manifestPath?: string;
  readonly yes?: boolean;
};

type LoadedDocument<T> = { readonly status: "missing" } | { readonly status: "ok"; readonly value: T };

type AnyExecutionRecord =
  | { readonly version: "current"; readonly execution: SelectionExecution }
  | { readonly version: "legacy"; readonly execution: LegacySelectionExecution };

type LoadedIndex = {
  readonly documentKind: string;
  readonly manifestHash: string;
  readonly unfinishedExecutionId: string | null;
  readonly v1Migrated: boolean;
  readonly updatedAt: string;
  readonly api_origin?: string;
  readonly tenant?: SelectionExecution["tenant"];
  readonly binding?: SelectionExecutionTenant;
};

export function parseExecutionId(value: string): string {
  const trimmed = value.trim();
  if (!EXECUTION_ID_PATTERN.test(trimmed)) {
    throw selectionError(
      "EXECUTION_ID_INVALID",
      "--execution-id must be a UUID. The CLI will not guess or resume a different attempt."
    );
  }
  return trimmed.toLowerCase();
}

export function isUnfinishedExecutionState(state: SelectionExecutionState): boolean {
  return state === "running" || state === "interrupted";
}

export function isTerminalExecutionState(state: SelectionExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.has(state);
}

export function formatSelectionResumeCommand(options: {
  readonly executionId: string;
  readonly maxCredits: number;
  readonly manifestPath?: string;
  readonly yes?: boolean;
}): string {
  const parts = ["augmentworks", "test"];
  if (options.manifestPath !== undefined && options.manifestPath !== "") {
    parts.push("--manifest", options.manifestPath);
  }
  parts.push(
    "--all-shards",
    "--execution-id",
    options.executionId,
    "--max-credits",
    String(options.maxCredits)
  );
  if (options.yes === true) parts.push("--yes");
  return parts.join(" ");
}

export function initialExecution(
  manifest: SuiteSelectionManifest,
  aggregateMaxCredits: number,
  options: SelectionExecutionClock & { readonly tenant: SelectionExecutionTenant }
): SelectionExecution {
  const timestamp = isoNow(options.now);
  const tenant = parseSelectionTenant(options.tenant);
  return reconcileExecution(
    {
      documentKind: SELECTION_EXECUTION_DOCUMENT_KIND,
      executionId: (options.createExecutionId ?? randomUUID)().toLowerCase(),
      manifestHash: manifest.manifestHash,
      createdAt: timestamp,
      updatedAt: timestamp,
      aggregateMaxCredits,
      remainingCredits: aggregateMaxCredits,
      state: "running",
      terminalReason: null,
      api_origin: tenant.api_origin,
      tenant: tenant.tenant,
      shards: manifest.shards.map((shard) => ({
        shardId: shard.shardId,
        shardIdentityHash: shard.shardIdentityHash,
        runId: null,
        quoteId: null,
        quotedUnits: 0,
        chargedUnits: 0,
        state: "pending" as const
      }))
    },
    { strict: true }
  );
}

export function inFlightShard(
  execution: SelectionExecution
): SelectionExecutionShard | undefined {
  return execution.shards.find((shard) => IN_FLIGHT_SHARD_STATES.has(shard.state));
}

export function nextRunnableShard(
  execution: SelectionExecution
): SelectionExecutionShard | undefined {
  const running = inFlightShard(execution);
  if (running !== undefined) return running;
  if (isTerminalExecutionState(execution.state)) return undefined;
  return execution.shards.find((shard) => shard.state === "pending");
}

export function assertResumeSameShard(execution: SelectionExecution, shardId: string): void {
  const running = inFlightShard(execution);
  if (running !== undefined && running.shardId !== shardId) {
    throw selectionError(
      "SHARD_PROGRESS_BLOCKED",
      `Shard ${running.shardId} is ${running.state}. Status and recovery resume that original run. The CLI will not start a different shard after a retry or partial failure.`
    );
  }
}

export function resumeExecution(
  execution: SelectionExecution,
  now: () => Date = () => new Date()
): SelectionExecution {
  return reconcileExecution({
    ...execution,
    updatedAt: isoNow(now),
    state: "running",
    terminalReason: null
  });
}

export function interruptExecution(
  execution: SelectionExecution,
  now: () => Date = () => new Date()
): SelectionExecution {
  if (isTerminalExecutionState(execution.state)) return execution;
  return reconcileExecution({
    ...execution,
    updatedAt: isoNow(now),
    state: "interrupted",
    terminalReason: null
  });
}

export function markShardQuoted(
  execution: SelectionExecution,
  shardId: string,
  extras: { readonly quoteId: string; readonly quotedUnits: number },
  now: () => Date = () => new Date()
): SelectionExecution {
  if (!Number.isSafeInteger(extras.quotedUnits) || extras.quotedUnits < 0) {
    throw budgetInvariantError("quotedUnits must be a finite nonnegative integer.");
  }
  return mapShard(execution, shardId, now, (shard) => {
    if (shard.state === "completed" || shard.state === "blocked" || shard.state === "failed") {
      throw selectionError(
        "SHARD_PROGRESS_BLOCKED",
        `Shard ${shardId} is ${shard.state} and will not be quoted again.`
      );
    }
    if (
      shard.quoteId !== null &&
      shard.quoteId !== extras.quoteId &&
      (shard.state === "admitted" || shard.state === "running")
    ) {
      throw selectionError(
        "SHARD_PROGRESS_BLOCKED",
        `Shard ${shardId} already has an admitted quote and will not replace it.`
      );
    }
    return {
      ...shard,
      quoteId: extras.quoteId,
      quotedUnits: extras.quotedUnits,
      state: shard.state === "pending" || shard.state === "quoted" ? "quoted" : shard.state
    };
  });
}

export function markShardAdmitted(
  execution: SelectionExecution,
  shardId: string,
  extras: { readonly runId: string; readonly quoteId?: string; readonly quotedUnits?: number },
  now: () => Date = () => new Date()
): SelectionExecution {
  return mapShard(execution, shardId, now, (shard) => {
    if (shard.state === "completed" || shard.state === "blocked" || shard.state === "failed") {
      throw selectionError(
        "SHARD_PROGRESS_BLOCKED",
        `Shard ${shardId} is ${shard.state} and will not be admitted again.`
      );
    }
    return {
      ...shard,
      runId: extras.runId,
      quoteId: extras.quoteId ?? shard.quoteId,
      quotedUnits: extras.quotedUnits ?? shard.quotedUnits,
      state: shard.state === "running" ? "running" : "admitted"
    };
  });
}

export function markShardObserving(
  execution: SelectionExecution,
  shardId: string,
  now: () => Date = () => new Date()
): SelectionExecution {
  return mapShard(execution, shardId, now, (shard) => {
    if (shard.state === "completed" || shard.state === "blocked" || shard.state === "failed") {
      return shard;
    }
    if (shard.state === "pending") {
      throw selectionError(
        "SHARD_PROGRESS_BLOCKED",
        `Shard ${shardId} cannot enter observation before quote or admission.`
      );
    }
    return { ...shard, state: "running" };
  });
}

export function markShardCompleted(
  execution: SelectionExecution,
  shardId: string,
  extras: { readonly runId?: string; readonly chargedUnits?: number; readonly quoteId?: string } = {},
  now: () => Date = () => new Date()
): SelectionExecution {
  return mapShard(execution, shardId, now, (shard) => {
    if (shard.state === "completed") {
      const charged = extras.chargedUnits ?? shard.chargedUnits;
      if (charged !== shard.chargedUnits) {
        throw budgetInvariantError("A completed shard cannot change chargedUnits.");
      }
      return shard;
    }
    const chargedUnits = extras.chargedUnits ?? shard.quotedUnits;
    if (!Number.isSafeInteger(chargedUnits) || chargedUnits < 0) {
      throw budgetInvariantError("chargedUnits must be a finite nonnegative integer.");
    }
    if (chargedUnits > 0 && shard.quotedUnits > 0 && chargedUnits > shard.quotedUnits) {
      throw budgetInvariantError("chargedUnits cannot exceed quotedUnits.");
    }
    return {
      ...shard,
      runId: extras.runId ?? shard.runId,
      quoteId: extras.quoteId ?? shard.quoteId,
      chargedUnits,
      quotedUnits: Math.max(shard.quotedUnits, chargedUnits),
      state: "completed" as const
    };
  });
}

export function markShardFailed(
  execution: SelectionExecution,
  shardId: string,
  extras: { readonly runId?: string; readonly chargedUnits?: number } = {},
  now: () => Date = () => new Date()
): SelectionExecution {
  return mapShard(execution, shardId, now, (shard) => {
    const admitted = shard.state === "admitted" || shard.state === "running" || shard.state === "completed";
    const chargedUnits =
      extras.chargedUnits ?? (admitted ? shard.quotedUnits : shard.chargedUnits);
    return {
      ...shard,
      runId: extras.runId ?? shard.runId,
      chargedUnits,
      state: "failed" as const
    };
  });
}

export function markShardBlocked(
  execution: SelectionExecution,
  shardId: string,
  now: () => Date = () => new Date()
): SelectionExecution {
  return mapShard(execution, shardId, now, (shard) => {
    if (shard.state === "completed" || shard.state === "failed") return shard;
    return {
      ...shard,
      state: "blocked" as const,
      chargedUnits: shard.state === "admitted" || shard.state === "running" ? shard.chargedUnits : 0
    };
  });
}

export function skipRemainingPendingShards(
  execution: SelectionExecution,
  terminalReason: string,
  now: () => Date = () => new Date()
): SelectionExecution {
  let updated = execution;
  for (const shard of execution.shards) {
    if (shard.state === "pending") {
      updated = markShardBlocked(updated, shard.shardId, now);
    }
  }
  return finalizeExecution(
    { ...updated, terminalReason, updatedAt: isoNow(now) },
    now
  );
}

export function hasOpenShardWork(execution: SelectionExecution): boolean {
  return (
    inFlightShard(execution) !== undefined ||
    execution.shards.some((shard) => shard.state === "pending")
  );
}

export function finalizeExecution(
  execution: SelectionExecution,
  now: () => Date = () => new Date()
): SelectionExecution {
  if (execution.state === "interrupted") {
    return reconcileExecution({ ...execution, updatedAt: isoNow(now), terminalReason: null });
  }
  if (hasOpenShardWork(execution)) {
    return reconcileExecution({
      ...execution,
      updatedAt: isoNow(now),
      state: "running",
      terminalReason: null
    });
  }
  const shards = execution.shards;
  if (shards.length > 0 && shards.every((shard) => shard.state === "completed")) {
    return reconcileExecution({
      ...execution,
      updatedAt: isoNow(now),
      state: "completed",
      terminalReason: null
    });
  }
  if (shards.some((shard) => shard.state === "failed")) {
    return reconcileExecution({
      ...execution,
      updatedAt: isoNow(now),
      state: "failed",
      terminalReason: execution.terminalReason ?? "shard_failed"
    });
  }
  return reconcileExecution({
    ...execution,
    updatedAt: isoNow(now),
    state: "blocked",
    terminalReason: execution.terminalReason ?? "incomplete_coverage"
  });
}


export function derivedRemainingCredits(execution: SelectionExecution): number {
  const { reserved, charged } = ledgerUnits(execution);
  if (!Number.isSafeInteger(reserved) || !Number.isSafeInteger(charged)) {
    throw budgetInvariantError("Credit ledger overflowed a safe integer.");
  }
  const used = reserved + charged;
  if (!Number.isSafeInteger(used) || used < 0) {
    throw budgetInvariantError("Credit ledger overflowed a safe integer.");
  }
  const remaining = execution.aggregateMaxCredits - used;
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw budgetInvariantError(
      "remainingCredits underflowed the aggregate cap. The CLI will not clamp or continue."
    );
  }
  if (remaining > execution.aggregateMaxCredits) {
    throw budgetInvariantError("remainingCredits exceeded the original aggregate cap.");
  }
  return remaining;
}

export function coverageSummary(execution: SelectionExecution): {
  readonly expectedShardCount: number;
  readonly completedShardCount: number;
  readonly coverageComplete: boolean;
  readonly chargedUnits: number;
  readonly remainingCredits: number;
} {
  const expectedShardCount = execution.shards.length;
  const completedShardCount = execution.shards.filter((shard) => shard.state === "completed").length;
  return {
    expectedShardCount,
    completedShardCount,
    coverageComplete: expectedShardCount > 0 && completedShardCount === expectedShardCount,
    chargedUnits: ledgerUnits(execution).charged,
    remainingCredits: execution.remainingCredits
  };
}

export function aggregateExecutionExitCode(
  execution: SelectionExecution,
  lastShardExit?: number
): number {
  if (execution.state === "interrupted") return EXIT.INTERRUPTED;
  if (execution.state === "failed" || execution.shards.some((shard) => shard.state === "failed")) {
    return EXIT.ASSESSMENT_FAILED;
  }
  if (!coverageSummary(execution).coverageComplete) return EXIT.EVALUATION_INCOMPLETE;
  return lastShardExit ?? EXIT.OK;
}

export function artifactFromExecution(
  manifest: SuiteSelectionManifest,
  execution: SelectionExecution
): SelectionArtifact {
  const declared: SelectionArtifact["declaredShards"] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const shard of execution.shards) {
    if (shard.runId !== null) {
      declared.push({
        shardId: shard.shardId,
        shardIdentityHash: shard.shardIdentityHash,
        runId: shard.runId
      });
    }
    if (
      shard.state === "pending" ||
      shard.state === "quoted" ||
      shard.state === "admitted" ||
      shard.state === "running"
    ) {
      if (shard.runId === null) missing.push(shard.shardId);
    }
    if (shard.state === "blocked") skipped.push(shard.shardId);
    if (shard.state === "failed") failed.push(shard.shardId);
  }
  for (const expected of manifest.shards) {
    if (
      !execution.shards.some((shard) => shard.shardId === expected.shardId && shard.runId !== null)
    ) {
      if (
        !missing.includes(expected.shardId) &&
        !skipped.includes(expected.shardId) &&
        !failed.includes(expected.shardId)
      ) {
        missing.push(expected.shardId);
      }
    }
  }
  return {
    schemaVersion: SELECTION_ARTIFACT_SCHEMA_VERSION,
    manifestHash: manifest.manifestHash,
    expectedShardIds: manifest.shards.map((shard) => shard.shardId),
    declaredShards: declared,
    missingShardIds: [...new Set(missing)],
    skippedShardIds: skipped,
    failedShardIds: failed,
    createsBillableRun: false
  };
}

export function executionJsonFields(execution: SelectionExecution): Record<string, unknown> {
  const coverage = coverageSummary(execution);
  const recoveryAction =
    isUnfinishedExecutionState(execution.state)
      ? "resume_execution"
      : coverage.coverageComplete
        ? "start_new_execution"
        : isTerminalExecutionState(execution.state)
          ? "start_new_execution"
          : "resume_execution";
  return {
    execution_id: execution.executionId,
    manifest_hash: execution.manifestHash,
    expected_shard_count: coverage.expectedShardCount,
    completed_shard_count: coverage.completedShardCount,
    coverage_complete: coverage.coverageComplete,
    aggregate_max_credits: execution.aggregateMaxCredits,
    charged_units: coverage.chargedUnits,
    remaining_credits: coverage.remainingCredits,
    execution_state: execution.state,
    recovery_action: recoveryAction,
    workspace_id: execution.tenant.workspace_id
  };
}

export function executionPaths(stateDirectory: string, manifestHash: string): SelectionExecutionPaths {
  assertManifestHash(manifestHash);
  const root = join(resolve(stateDirectory), "selections", manifestHash);
  return {
    root,
    executions: join(root, "executions"),
    index: join(root, "current.json"),
    v1Progress: join(resolve(stateDirectory), "selections", `${manifestHash}.progress.json`)
  };
}

export async function assertSelectionExecutionPreflight(
  input: SelectionExecutionPreflightInput
): Promise<void> {
  const paths = executionPaths(input.stateDirectory, input.manifest.manifestHash);
  await ensureExecutionDirectories(paths.root);
  const lock = await acquireSelectionExecutionLock(paths, input.now);
  try {
    await prepareSelectionExecutionStore(input, paths);
    if (input.executionId !== undefined) {
      await inspectRequestedExecution(input, paths);
      return;
    }
    await throwIfUnfinishedSelection(input, paths, await readIndex(paths));
  } finally {
    await lock.release().catch(() => undefined);
  }
}

export async function openSelectionExecution(
  input: ResolveSelectionExecutionInput
): Promise<OpenedSelectionExecution> {
  const tenant = requireInputTenant(input);
  const manifestHash = input.manifest.manifestHash;
  const paths = executionPaths(input.stateDirectory, manifestHash);
  await ensureExecutionDirectories(paths.root);
  const lock = await acquireSelectionExecutionLock(paths, input.now);
  try {
    await prepareSelectionExecutionStore(input, paths);
    const latestIndex = (await readIndex(paths)) ?? emptyIndex(manifestHash, tenant, input.now);
    if (input.executionId !== undefined) {
      return await openRequestedExecution({ ...input, tenant }, paths, lock);
    }
    const unfinishedId = await unresolvedExecutionId(paths, latestIndex);
    if (unfinishedId !== null) {
      const unfinished = await readAnyExecutionFile(paths, unfinishedId);
      throwIfLegacyUnbound(unfinished, manifestHash);
      assertSelectionTenantMatch(executionTenant(unfinished.execution as SelectionExecution), tenant, {
        executionId: unfinished.execution.executionId,
        recoveryAction: "resume_execution"
      });
      throw selectionResumeRequiredError({
        executionId: unfinished.execution.executionId,
        manifestHash,
        command: formatSelectionResumeCommand({
          executionId: unfinished.execution.executionId,
          maxCredits: unfinished.execution.aggregateMaxCredits,
          ...(input.manifestPath === undefined ? {} : { manifestPath: input.manifestPath }),
          ...(input.yes === undefined ? {} : { yes: input.yes })
        })
      });
    }
    const created = await persistOpened(
      paths,
      initialExecution(input.manifest, input.aggregateMaxCredits, { ...input, tenant }),
      input.now
    );
    const kind: SelectionExecutionKind = (await hasTerminalReceipt(paths, created.executionId))
      ? "rerun"
      : "created";
    return { execution: created, kind, lock, paths };
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}

export async function saveSelectionExecution(
  paths: SelectionExecutionPaths,
  execution: SelectionExecution,
  now: () => Date = () => new Date()
): Promise<SelectionExecution> {
  return persistOpened(paths, execution, now);
}

export async function readExecutionFile(
  paths: SelectionExecutionPaths,
  executionId: string
): Promise<SelectionExecution> {
  const loaded = await readAnyExecutionFile(paths, executionId);
  throwIfLegacyUnbound(loaded, loaded.execution.manifestHash);
  return reconcileExecution(normalizeExecution(loaded.execution as SelectionExecution), { strict: true });
}

export function executionDocumentPath(paths: SelectionExecutionPaths, executionId: string): string {
  return join(paths.root, "executions", `${parseExecutionId(executionId)}.json`);
}

async function openRequestedExecution(
  input: ResolveSelectionExecutionInput & { readonly tenant: SelectionExecutionTenant },
  paths: SelectionExecutionPaths,
  lock: SecureLockHandle
): Promise<OpenedSelectionExecution> {
  const executionId = parseExecutionId(input.executionId!);
  const loaded = await readAnyExecutionFile(paths, executionId);
  throwIfLegacyUnbound(loaded, input.manifest.manifestHash);
  const execution = reconcileExecution(normalizeExecution(loaded.execution as SelectionExecution), {
    strict: true
  });
  if (execution.manifestHash !== input.manifest.manifestHash) {
    throw selectionError(
      "SELECTION_EXECUTION_MANIFEST_MISMATCH",
      "That --execution-id is bound to a different immutable manifest. No quote was requested."
    );
  }
  assertSelectionTenantMatch(executionTenant(execution), input.tenant, {
    executionId: execution.executionId,
    recoveryAction: "resume_execution"
  });
  assertShardsMatchManifest(execution, input.manifest);
  if (isTerminalExecutionState(execution.state)) {
    throw selectionError(
      "SELECTION_EXECUTION_TERMINAL",
      `Execution ${execution.executionId} already finished. Omit --execution-id to start a new rerun that does not inherit prior shard results.`,
      {
        details: {
          execution_id: execution.executionId,
          manifest_hash: execution.manifestHash,
          recovery_action: "start_new_execution"
        }
      }
    );
  }
  if (execution.aggregateMaxCredits !== input.aggregateMaxCredits) {
    throw selectionError(
      "SHARD_PROGRESS_BLOCKED",
      "An in-progress multi-shard run already has a consented aggregate budget. Reuse the original --max-credits value. The CLI will not silently raise consent."
    );
  }
  const resumed = await saveSelectionExecution(paths, resumeExecution(execution, input.now), input.now);
  return { execution: resumed, kind: "resumed", lock, paths };
}

async function unresolvedExecutionId(
  paths: SelectionExecutionPaths,
  index: LoadedIndex
): Promise<string | null> {
  if (index.unfinishedExecutionId !== null) {
    const current = await readAnyExecutionFile(paths, index.unfinishedExecutionId);
    if (isUnfinishedExecutionState(current.execution.state)) return current.execution.executionId;
  }
  const unfinished = await listUnfinishedExecutions(paths);
  if (unfinished.length > 1) {
    throw selectionError(
      "SELECTION_EXECUTION_CORRUPT",
      "Multiple unfinished executions exist for this manifest. The CLI will not guess which attempt to resume. No quote was requested.",
      { details: { recovery_action: "inspect_quarantined_state" } }
    );
  }
  return unfinished[0]?.execution.executionId ?? null;
}

async function listUnfinishedExecutions(paths: SelectionExecutionPaths): Promise<AnyExecutionRecord[]> {
  const directory = join(paths.root, "executions");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const unfinished: AnyExecutionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const id = name.slice(0, -".json".length);
    if (!EXECUTION_ID_PATTERN.test(id)) continue;
    const loaded = await readJsonFile(join(directory, name), parseAnyExecution);
    if (loaded.status === "ok" && isUnfinishedExecutionState(loaded.value.execution.state)) {
      unfinished.push(loaded.value);
    }
  }
  return unfinished;
}

async function hasTerminalReceipt(paths: SelectionExecutionPaths, exceptId: string): Promise<boolean> {
  const directory = join(paths.root, "executions");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (id === exceptId) continue;
    const loaded = await readJsonFile(
      join(directory, name),
      parseAnyExecution,
      { quarantine: false, quarantineOnSchemaFailure: false }
    );
    if (
      loaded.status === "ok" &&
      loaded.value !== undefined &&
      isTerminalExecutionState(loaded.value.execution.state)
    ) {
      return true;
    }
  }
  return false;
}

async function migrateV1IfNeeded(
  input: ResolveSelectionExecutionInput | SelectionExecutionPreflightInput,
  paths: SelectionExecutionPaths,
  index: LoadedIndex | undefined
): Promise<void> {
  if (index?.v1Migrated === true) return;
  const loaded = await readV1Progress(paths.v1Progress);
  if (loaded.status === "missing") {
    if (index !== undefined) return;
    return;
  }
  const progress = loaded.value;
  if (progress === "v2-in-v1-path") {
    throw selectionProgressMigrationRequiredError({
      manifestHash: input.manifest.manifestHash,
      reason:
        "A tenant-bound execution document occupies the v1 progress path. The CLI will not interpret it as aw-selection-progress/1 or start a new charge."
    });
  }
  if (progress === "invalid") {
    throw selectionProgressMigrationRequiredError({
      manifestHash: input.manifest.manifestHash,
      reason: "The v1 progress file is present but not an unambiguous aw-selection-progress/1 document."
    });
  }
  const migrated = classifyUnambiguousV1(progress);
  if (migrated === undefined) {
    throw selectionProgressMigrationRequiredError({
      manifestHash: input.manifest.manifestHash,
      reason:
        "The v1 progress file has ambiguous execution identity or spend state and cannot be migrated automatically."
    });
  }
  if (migrated === "unused") {
    await markV1Migrated(paths, index, input);
    return;
  }
  throw selectionLegacyUnboundError({
    manifestHash: input.manifest.manifestHash,
    originalRunIds: originalRunIdsFromShards(progress.shards),
    reason:
      "An aw-selection-progress/1 file records spend or runs without a tenant binding. The file was left unchanged."
  });
}

function classifyUnambiguousV1(progress: SelectionProgress): "unused" | "legacy" | undefined {
  const shardIds = progress.shards.map((shard) => shard.shardId);
  if (new Set(shardIds).size !== shardIds.length) return undefined;
  const inFlight = progress.shards.filter(
    (shard) => shard.status === "running" || shard.status === "interrupted"
  );
  if (inFlight.length > 1) return undefined;
  const completedUnits = progress.shards.reduce((sum, shard) => {
    if (shard.status !== "completed") return sum;
    return sum + (shard.quoteUnits ?? Number.NaN);
  }, 0);
  const allPending = progress.shards.every((shard) => shard.status === "pending");
  if (
    allPending &&
    progress.stoppedReason === null &&
    progress.remainingCredits === progress.aggregateMaxCredits
  ) {
    return "unused";
  }
  const completed = progress.shards.filter((shard) => shard.status === "completed");
  if (completed.some((shard) => shard.quoteUnits === undefined)) return undefined;
  if (!Number.isSafeInteger(completedUnits) || completedUnits < 0) return undefined;
  if (completedUnits > progress.aggregateMaxCredits) return undefined;
  if (progress.remainingCredits !== progress.aggregateMaxCredits - completedUnits) return undefined;
  if (progress.remainingCredits < 0) return undefined;
  return "legacy";
}

async function readV1Progress(
  path: string
): Promise<
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly value: SelectionProgress | "invalid" | "v2-in-v1-path" }
> {
  const loaded = await readJsonFile(
    path,
    (raw) => raw,
    { quarantineOnSchemaFailure: false }
  );
  if (loaded.status === "missing") return loaded;
  if (
    isRecord(loaded.value) &&
    (loaded.value["documentKind"] === SELECTION_EXECUTION_DOCUMENT_KIND ||
      loaded.value["documentKind"] === SELECTION_EXECUTION_DOCUMENT_KIND_V2)
  ) {
    return { status: "ok", value: "v2-in-v1-path" };
  }
  const parsed = SelectionProgressSchema.safeParse(loaded.value);
  if (!parsed.success) return { status: "ok", value: "invalid" };
  return { status: "ok", value: parsed.data };
}

function assertShardsMatchManifest(
  execution: SelectionExecution,
  manifest: SuiteSelectionManifest
): void {
  if (execution.manifestHash !== manifest.manifestHash) {
    throw selectionError(
      "SELECTION_EXECUTION_MANIFEST_MISMATCH",
      "The execution document is bound to a different immutable manifest. No quote was requested."
    );
  }
  if (execution.shards.length !== manifest.shards.length) {
    throw selectionError(
      "SELECTION_EXECUTION_MANIFEST_MISMATCH",
      "The execution shard set does not match this immutable manifest. No quote was requested."
    );
  }
  for (const [index, expected] of manifest.shards.entries()) {
    const actual = execution.shards[index];
    if (
      actual === undefined ||
      actual.shardId !== expected.shardId ||
      actual.shardIdentityHash !== expected.shardIdentityHash
    ) {
      throw selectionError(
        "SELECTION_EXECUTION_MANIFEST_MISMATCH",
        "The execution shard identity does not match this immutable manifest. No quote was requested."
      );
    }
  }
}

function mapShard(
  execution: SelectionExecution,
  shardId: string,
  now: () => Date,
  mapper: (shard: SelectionExecutionShard) => SelectionExecutionShard
): SelectionExecution {
  if (!execution.shards.some((shard) => shard.shardId === shardId)) {
    throw selectionError("SHARD_NOT_FOUND", `Shard ${shardId} is not in this execution.`);
  }
  const shards = execution.shards.map((shard) => (shard.shardId === shardId ? mapper(shard) : shard));
  assertExclusiveShardBindings(shards);
  return reconcileExecution({
    ...execution,
    updatedAt: isoNow(now),
    shards
  });
}

function assertExclusiveShardBindings(shards: readonly SelectionExecutionShard[]): void {
  const duplicate = findCrossShardBindingDuplicate(shards);
  if (duplicate === undefined) return;
  const field = duplicate.field === "quoteId" ? "Quote" : "Run";
  throw selectionError(
    "SHARD_PROGRESS_BLOCKED",
    `${field} identifier is already bound to shard ${duplicate.firstShardId}. Retry idempotency applies only to the same shard. The CLI will not bind shard ${duplicate.secondShardId} or continue quoting.`,
    {
      details: {
        shard_id: duplicate.secondShardId,
        bound_shard_id: duplicate.firstShardId,
        recovery_action: "resume_execution"
      }
    }
  );
}

function reconcileExecution(
  execution: SelectionExecution,
  options: { readonly strict?: boolean } = {}
): SelectionExecution {
  const parsed = SelectionExecutionSchema.safeParse(normalizeExecution(execution));
  if (!parsed.success) {
    throw selectionError(
      "SELECTION_EXECUTION_CORRUPT",
      "The local execution document failed schema validation. No quote was requested.",
      { details: { recovery_action: "inspect_quarantined_state" } }
    );
  }
  const remaining = derivedRemainingCredits(parsed.data);
  if (options.strict === true && parsed.data.remainingCredits !== remaining) {
    throw budgetInvariantError("Persisted remainingCredits does not match the unique credit ledger.");
  }
  return { ...parsed.data, remainingCredits: remaining };
}

function normalizeExecution(execution: SelectionExecution): SelectionExecution {
  return {
    ...execution,
    executionId: execution.executionId.toLowerCase(),
    manifestHash: execution.manifestHash.toLowerCase()
  };
}

function ledgerUnits(execution: SelectionExecution): { reserved: number; charged: number } {
  const reservedKeys = new Set<string>();
  const chargedKeys = new Set<string>();
  let reserved = 0;
  let charged = 0;
  for (const shard of execution.shards) {
    if (IN_FLIGHT_SHARD_STATES.has(shard.state)) {
      if (reservedKeys.has(shard.shardId)) continue;
      reservedKeys.add(shard.shardId);
      reserved += shard.quotedUnits;
      continue;
    }
    if (shard.chargedUnits <= 0) continue;
    if (chargedKeys.has(shard.shardId)) continue;
    chargedKeys.add(shard.shardId);
    charged += shard.chargedUnits;
  }
  return { reserved, charged };
}

async function persistOpened(
  paths: SelectionExecutionPaths,
  execution: SelectionExecution,
  now?: () => Date,
  v1Migrated?: boolean
): Promise<SelectionExecution> {
  const clock = now ?? (() => new Date());
  const settled = finalizeExecution(execution, clock);
  const reconciled = reconcileExecution(settled, { strict: true });
  const previous = await readIndex(paths);
  const migrated = v1Migrated ?? previous?.v1Migrated ?? false;
  const file = executionDocumentPath(paths, reconciled.executionId);
  await writeJsonAtomic(file, reconciled);
  await writeIndex(paths, {
    documentKind: SELECTION_EXECUTION_INDEX_DOCUMENT_KIND,
    manifestHash: reconciled.manifestHash,
    unfinishedExecutionId: isUnfinishedExecutionState(reconciled.state)
      ? reconciled.executionId
      : null,
    v1Migrated: migrated,
    updatedAt: isoNow(now),
    api_origin: reconciled.api_origin,
    tenant: reconciled.tenant
  });
  return reconciled;
}

async function writeIndex(paths: SelectionExecutionPaths, index: SelectionExecutionIndex): Promise<void> {
  const parsed = SelectionExecutionIndexSchema.parse(index);
  await writeJsonAtomic(paths.index, parsed);
}

async function readIndex(paths: SelectionExecutionPaths): Promise<LoadedIndex | undefined> {
  const loaded = await readJsonFile(paths.index, parseAnyIndex);
  return loaded.status === "missing" ? undefined : loaded.value;
}

function emptyIndex(
  manifestHash: string,
  tenant: SelectionExecutionTenant,
  now?: () => Date
): LoadedIndex {
  const binding = parseSelectionTenant(tenant);
  return {
    documentKind: SELECTION_EXECUTION_INDEX_DOCUMENT_KIND,
    manifestHash,
    unfinishedExecutionId: null,
    v1Migrated: false,
    updatedAt: isoNow(now),
    api_origin: binding.api_origin,
    tenant: binding.tenant,
    binding
  };
}

function requireInputTenant(input: ResolveSelectionExecutionInput): SelectionExecutionTenant {
  if (input.tenant === undefined) {
    throw selectionTenantMismatchErrorFromMissing();
  }
  return parseSelectionTenant(input.tenant);
}

function selectionTenantMismatchErrorFromMissing(): never {
  throw selectionError(
    "SELECTION_TENANT_MISMATCH",
    "A hosted multi-shard execution requires a pinned API origin, workspace, and connector before any local mutation. No quote was requested.",
    { category: "auth", details: { recovery_action: "start_new_execution" } }
  );
}

function executionTenant(execution: SelectionExecution): SelectionExecutionTenant {
  return parseSelectionTenant({
    api_origin: execution.api_origin,
    tenant: execution.tenant
  });
}

function parseAnyExecution(raw: unknown): AnyExecutionRecord | undefined {
  const current = SelectionExecutionSchema.safeParse(raw);
  if (current.success) return { version: "current", execution: current.data };
  const legacy = LegacySelectionExecutionSchema.safeParse(raw);
  if (legacy.success) return { version: "legacy", execution: legacy.data };
  return undefined;
}

function parseAnyIndex(raw: unknown): LoadedIndex | undefined {
  const current = SelectionExecutionIndexSchema.safeParse(raw);
  if (current.success) {
    return {
      ...current.data,
      binding: {
        api_origin: current.data.api_origin,
        tenant: current.data.tenant
      }
    };
  }
  const legacy = LegacySelectionExecutionIndexSchema.safeParse(raw);
  if (!legacy.success) return undefined;
  return { ...legacy.data };
}

async function acquireSelectionExecutionLock(
  paths: SelectionExecutionPaths,
  now?: () => Date
): Promise<SecureLockHandle> {
  return acquireSecureLock({
    path: join(paths.root, "lock"),
    label: "selection execution",
    errorCodes: {
      locked: "SELECTION_EXECUTION_LOCKED",
      unsafe: "UNSAFE_SELECTION_EXECUTION",
      unknownOwner: "SELECTION_EXECUTION_LOCK_OWNER_UNKNOWN",
      foreignOwner: "SELECTION_EXECUTION_LOCK_FOREIGN_OWNER",
      changed: "SELECTION_EXECUTION_LOCK_CHANGED"
    },
    ...(now === undefined ? {} : { now })
  });
}

async function prepareSelectionExecutionStore(
  input: ResolveSelectionExecutionInput | SelectionExecutionPreflightInput,
  paths: SelectionExecutionPaths
): Promise<void> {
  const index = await readIndex(paths);
  await migrateV1IfNeeded(input, paths, index);
  if (!Number.isSafeInteger(input.aggregateMaxCredits) || input.aggregateMaxCredits < 0) {
    throw budgetInvariantError("aggregateMaxCredits must be a finite nonnegative integer.");
  }
}

async function inspectRequestedExecution(
  input: SelectionExecutionPreflightInput,
  paths: SelectionExecutionPaths
): Promise<void> {
  const loaded = await readAnyExecutionFile(paths, parseExecutionId(input.executionId!));
  throwIfLegacyUnbound(loaded, input.manifest.manifestHash);
  const execution = loaded.execution as SelectionExecution;
  if (execution.manifestHash !== input.manifest.manifestHash) {
    throw selectionError(
      "SELECTION_EXECUTION_MANIFEST_MISMATCH",
      "That --execution-id is bound to a different immutable manifest. No quote was requested."
    );
  }
  assertShardsMatchManifest(execution, input.manifest);
  if (isTerminalExecutionState(execution.state)) {
    throw selectionError(
      "SELECTION_EXECUTION_TERMINAL",
      `Execution ${execution.executionId} already finished. Omit --execution-id to start a new rerun that does not inherit prior shard results.`,
      {
        details: {
          execution_id: execution.executionId,
          manifest_hash: execution.manifestHash,
          recovery_action: "start_new_execution"
        }
      }
    );
  }
  if (execution.aggregateMaxCredits !== input.aggregateMaxCredits) {
    throw selectionError(
      "SHARD_PROGRESS_BLOCKED",
      "An in-progress multi-shard run already has a consented aggregate budget. Reuse the original --max-credits value. The CLI will not silently raise consent."
    );
  }
}

async function throwIfUnfinishedSelection(
  input: SelectionExecutionPreflightInput,
  paths: SelectionExecutionPaths,
  index: LoadedIndex | undefined
): Promise<void> {
  const latestIndex = index ?? {
    documentKind: SELECTION_EXECUTION_INDEX_DOCUMENT_KIND_V2,
    manifestHash: input.manifest.manifestHash,
    unfinishedExecutionId: null,
    v1Migrated: false,
    updatedAt: isoNow(input.now)
  };
  const unfinishedId = await unresolvedExecutionId(paths, latestIndex);
  if (unfinishedId === null) return;
  const unfinished = await readAnyExecutionFile(paths, unfinishedId);
  throwIfLegacyUnbound(unfinished, input.manifest.manifestHash);
  throw selectionResumeRequiredError({
    executionId: unfinished.execution.executionId,
    manifestHash: input.manifest.manifestHash,
    command: formatSelectionResumeCommand({
      executionId: unfinished.execution.executionId,
      maxCredits: unfinished.execution.aggregateMaxCredits,
      ...(input.manifestPath === undefined ? {} : { manifestPath: input.manifestPath }),
      ...(input.yes === undefined ? {} : { yes: input.yes })
    })
  });
}

function throwIfLegacyUnbound(loaded: AnyExecutionRecord, manifestHash: string): void {
  if (loaded.version !== "legacy") return;
  throw selectionLegacyUnboundError({
    manifestHash,
    executionId: loaded.execution.executionId,
    originalRunIds: originalRunIdsFromShards(loaded.execution.shards),
    reason: "This aw-selection-execution/2 document has no tenant binding."
  });
}

async function readAnyExecutionFile(
  paths: SelectionExecutionPaths,
  executionId: string
): Promise<AnyExecutionRecord> {
  const id = parseExecutionId(executionId);
  const path = executionDocumentPath(paths, id);
  const loaded = await readJsonFile(path, parseAnyExecution);
  if (loaded.status === "missing") {
    throw selectionError(
      "SELECTION_EXECUTION_NOT_FOUND",
      `No local execution ${id} exists for this manifest. Confirm --execution-id before quoting.`
    );
  }
  return loaded.value;
}

async function markV1Migrated(
  paths: SelectionExecutionPaths,
  index: LoadedIndex | undefined,
  input: ResolveSelectionExecutionInput | SelectionExecutionPreflightInput
): Promise<void> {
  const tenant = "tenant" in input ? input.tenant : undefined;
  if (tenant !== undefined) {
    const binding = parseSelectionTenant(tenant);
    await writeIndex(paths, {
      documentKind: SELECTION_EXECUTION_INDEX_DOCUMENT_KIND,
      manifestHash: input.manifest.manifestHash,
      unfinishedExecutionId: index?.unfinishedExecutionId ?? null,
      v1Migrated: true,
      updatedAt: isoNow(input.now),
      api_origin: binding.api_origin,
      tenant: binding.tenant
    });
    return;
  }
  await writeJsonAtomic(paths.index, {
    documentKind: SELECTION_EXECUTION_INDEX_DOCUMENT_KIND_V2,
    manifestHash: input.manifest.manifestHash,
    unfinishedExecutionId: index?.unfinishedExecutionId ?? null,
    v1Migrated: true,
    updatedAt: isoNow(input.now)
  });
}

async function ensureExecutionDirectories(root: string): Promise<void> {
  await assertContainedPath(root, root);
  await mkdir(dirname(root), { recursive: true, mode: 0o700 }).catch(() => undefined);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "executions"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "quarantine"), { recursive: true, mode: 0o700 });
  await assertSafeDirectory(root);
  await assertSafeDirectory(join(root, "executions"));
  await assertSafeDirectory(join(root, "quarantine"));
}

async function assertSafeDirectory(path: string): Promise<void> {
  await rejectSymlinkPath(path, false);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw unsafeExecutionError("A selection execution path must be a regular directory.");
  }
  if (process.platform === "win32") return;
  const getuid = process.getuid;
  if (getuid !== undefined && stat.uid !== getuid()) {
    throw unsafeExecutionError("A selection execution directory must be owned by the current user.");
  }
  await chmod(path, 0o700).catch(() => undefined);
  const after = await lstat(path);
  if ((after.mode & 0o777) !== 0o700) {
    throw unsafeExecutionError("A selection execution directory must be mode 0700.");
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectSymlinkPath(directory, false);
  await rejectSymlinkPath(path, true);
  assertContainedPath(directory, path);
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXECUTION_BYTES) {
    throw selectionError(
      "SELECTION_EXECUTION_TOO_LARGE",
      "The local execution document exceeds the bounded size. No quote was requested."
    );
  }
  const temporary = join(
    directory,
    `.execution-${process.pid}-${randomBytes(12).toString("hex")}.tmp`
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600
    );
    if (process.platform !== "win32") await handle.chmod(0o600);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw unsafeExecutionError("The execution write target must be a regular file.");
    }
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await rejectSymlinkPath(path, false);
    if (process.platform !== "win32") await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof AwError) throw error;
    throw selectionError(
      "SELECTION_EXECUTION_WRITE_FAILED",
      "The local execution document could not be persisted atomically.",
      { cause: error }
    );
  }
}

async function readJsonFile<T>(
  path: string,
  parse: (raw: unknown) => T | undefined,
  options: { readonly quarantine?: boolean; readonly quarantineOnSchemaFailure?: boolean } = {}
): Promise<LoadedDocument<T>> {
  const quarantine = options.quarantine !== false;
  const quarantineOnSchemaFailure = options.quarantineOnSchemaFailure !== false;
  await rejectSymlinkPath(path, true);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
    const stat = await handle.stat();
    assertSafeFileStat(stat);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_EXECUTION_BYTES) {
      throw unsafeExecutionError("The local execution document is too large.");
    }
    const text = bytes.toString("utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (cause) {
      if (quarantine) await quarantineFile(path);
      throw selectionError(
        "SELECTION_EXECUTION_CORRUPT",
        "The local execution document is truncated or not valid JSON. It was quarantined. No quote was requested.",
        { cause, details: { recovery_action: "inspect_quarantined_state" } }
      );
    }
    const parsed = parse(raw);
    if (parsed === undefined) {
      if (quarantine && quarantineOnSchemaFailure) await quarantineFile(path);
      if (!quarantineOnSchemaFailure) return { status: "missing" };
      throw selectionError(
        "SELECTION_EXECUTION_CORRUPT",
        "The local execution document failed schema validation and was quarantined. No quote was requested.",
        { details: { recovery_action: "inspect_quarantined_state" } }
      );
    }
    return { status: "ok", value: parsed };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { status: "missing" };
    if (error instanceof AwError) throw error;
    throw selectionError(
      "UNSAFE_SELECTION_EXECUTION",
      "The local execution document could not be read without following links.",
      { cause: error }
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function quarantineFile(path: string): Promise<void> {
  const parent = dirname(path);
  const destDir = parent.endsWith(`${sep}executions`)
    ? join(dirname(parent), "quarantine")
    : join(parent, "quarantine");
  await mkdir(destDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(destDir, `${stamp}-${randomBytes(4).toString("hex")}-${basenameSafe(path)}`);
  assertContainedPath(destDir, dest);
  try {
    await rename(path, dest);
  } catch {
    return;
  }
}

function basenameSafe(path: string): string {
  const base = path.split(sep).pop() ?? "state.json";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function assertSafeFileStat(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_EXECUTION_BYTES) {
    throw unsafeExecutionError("The local execution document must be a bounded regular file.");
  }
  if (process.platform === "win32") return;
  const getuid = process.getuid;
  if (getuid !== undefined && stat.uid !== getuid()) {
    throw unsafeExecutionError("The local execution document must be owned by the current user.");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw unsafeExecutionError("The local execution document must be mode 0600.");
  }
}

async function rejectSymlinkPath(path: string, allowMissing: boolean): Promise<void> {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (allowMissing && isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    if (!stat.isSymbolicLink()) continue;
    const leafMissing = allowMissing && index === components.length - 1;
    if (leafMissing) {
      throw unsafeExecutionError("Refusing to use a symbolic link for selection execution state.");
    }
    const unsafe = await findUnsafeSymbolicLinkComponent(current);
    if (unsafe !== undefined) {
      throw unsafeExecutionError("Refusing to follow a symbolic link for selection execution state.");
    }
  }
}

function assertContainedPath(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(resolvedRoot, rel) !== resolvedPath) {
    throw unsafeExecutionError("Selection execution paths cannot escape the state directory.");
  }
}

function assertManifestHash(manifestHash: string): void {
  if (!MANIFEST_HASH_PATTERN.test(manifestHash)) {
    throw unsafeExecutionError("Manifest hash is not a 64-character lowercase hex digest.");
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (isExpectedWindowsDirectorySyncError(error, process.platform)) return;
    throw selectionError(
      "SELECTION_EXECUTION_WRITE_FAILED",
      "The execution directory could not be synchronized.",
      { cause: error }
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function noFollowFlag(): number {
  return process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number"
    ? 0
    : constants.O_NOFOLLOW;
}

function isoNow(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function budgetInvariantError(message: string): AwError {
  return selectionError("SELECTION_BUDGET_INVARIANT", `${message} No quote was requested.`, {
    category: "local"
  });
}

function unsafeExecutionError(message: string): AwError {
  return selectionError("UNSAFE_SELECTION_EXECUTION", message, { category: "local" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
