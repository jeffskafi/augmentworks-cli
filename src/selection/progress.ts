import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DeclaredShard, SelectionArtifact, SelectionProgress, SuiteSelectionManifest } from "./schema.js";
import { SelectionArtifactSchema, SelectionProgressSchema } from "./schema.js";
import { selectionError } from "./errors.js";

export function progressPath(stateDirectory: string, manifestHash: string): string {
  return join(stateDirectory, "selections", `${manifestHash}.progress.json`);
}

export async function loadProgress(
  stateDirectory: string,
  manifestHash: string
): Promise<SelectionProgress | undefined> {
  try {
    const raw = JSON.parse(await readFile(progressPath(stateDirectory, manifestHash), "utf8")) as unknown;
    const parsed = SelectionProgressSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function saveProgress(
  stateDirectory: string,
  progress: SelectionProgress
): Promise<string> {
  const path = progressPath(stateDirectory, progress.manifestHash);
  await mkdir(join(stateDirectory, "selections"), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(progress)}\n`, { encoding: "utf8" });
  await rename(temporary, path);
  return path;
}

export function initialProgress(
  manifest: SuiteSelectionManifest,
  aggregateMaxCredits: number
): SelectionProgress {
  return {
    schemaVersion: "aw-selection-progress/1",
    manifestHash: manifest.manifestHash,
    aggregateMaxCredits,
    remainingCredits: aggregateMaxCredits,
    stoppedReason: null,
    shards: manifest.shards.map((shard) => ({
      shardId: shard.shardId,
      shardIdentityHash: shard.shardIdentityHash,
      status: "pending" as const
    }))
  };
}

export function nextRunnableShard(progress: SelectionProgress): SelectionProgress["shards"][number] | undefined {
  const running = progress.shards.find((shard) => shard.status === "running" || shard.status === "interrupted");
  if (running !== undefined) return running;
  if (progress.stoppedReason !== null) return undefined;
  return progress.shards.find((shard) => shard.status === "pending");
}

export function skipRemainingPendingShards(
  progress: SelectionProgress,
  stoppedReason: string
): SelectionProgress {
  let updated = progress;
  for (const shard of progress.shards) {
    if (shard.status === "pending") {
      updated = markShardTerminal(updated, shard.shardId, "skipped", { stoppedReason });
    }
  }
  return { ...updated, stoppedReason };
}

export function assertResumeSameShard(progress: SelectionProgress, shardId: string): void {
  const running = progress.shards.find((shard) => shard.status === "running" || shard.status === "interrupted");
  if (running !== undefined && running.shardId !== shardId) {
    throw selectionError(
      "SHARD_PROGRESS_BLOCKED",
      `Shard ${running.shardId} is ${running.status}. Status and recovery resume that original run. The CLI will not start a different shard after a retry or partial failure.`
    );
  }
}

export function markShardRunning(
  progress: SelectionProgress,
  shardId: string
): SelectionProgress {
  return mapShard(progress, shardId, (shard) => ({ ...shard, status: "running" }));
}

export function markShardTerminal(
  progress: SelectionProgress,
  shardId: string,
  status: "completed" | "failed" | "interrupted" | "skipped",
  extras: { readonly runId?: string; readonly quoteUnits?: number; readonly stoppedReason?: string } = {}
): SelectionProgress {
  const remaining =
    extras.quoteUnits !== undefined && extras.quoteUnits > 0 && status === "completed"
      ? Math.max(0, progress.remainingCredits - extras.quoteUnits)
      : progress.remainingCredits;
  const updated = mapShard(progress, shardId, (shard) => ({
    ...shard,
    status,
    ...(extras.runId === undefined ? {} : { runId: extras.runId }),
    ...(extras.quoteUnits === undefined ? {} : { quoteUnits: extras.quoteUnits }),
    ...(extras.stoppedReason === undefined ? {} : { stoppedReason: extras.stoppedReason })
  }));
  const stop =
    status === "failed" || status === "interrupted" || status === "skipped"
      ? extras.stoppedReason ?? status
      : updated.stoppedReason;
  return {
    ...updated,
    remainingCredits: remaining,
    stoppedReason: stop
  };
}

export function artifactFromProgress(
  manifest: SuiteSelectionManifest,
  progress: SelectionProgress
): SelectionArtifact {
  const declared: DeclaredShard[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const shard of progress.shards) {
    if (shard.runId !== undefined) {
      declared.push({
        shardId: shard.shardId,
        shardIdentityHash: shard.shardIdentityHash,
        runId: shard.runId
      });
    }
    if (shard.status === "pending" || shard.status === "running" || shard.status === "interrupted") {
      if (shard.runId === undefined) missing.push(shard.shardId);
    }
    if (shard.status === "skipped") skipped.push(shard.shardId);
    if (shard.status === "failed") failed.push(shard.shardId);
  }
  for (const expected of manifest.shards) {
    if (!progress.shards.some((shard) => shard.shardId === expected.shardId && shard.runId !== undefined)) {
      if (!missing.includes(expected.shardId) && !skipped.includes(expected.shardId) && !failed.includes(expected.shardId)) {
        missing.push(expected.shardId);
      }
    }
  }
  return {
    schemaVersion: "aw-selection-artifact/1",
    manifestHash: manifest.manifestHash,
    expectedShardIds: manifest.shards.map((shard) => shard.shardId),
    declaredShards: declared,
    missingShardIds: [...new Set(missing)],
    skippedShardIds: skipped,
    failedShardIds: failed,
    createsBillableRun: false
  };
}

export async function writeArtifact(path: string, artifact: SelectionArtifact): Promise<void> {
  const parsed = SelectionArtifactSchema.parse(artifact);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8" });
}

export async function loadDeclaredShardsFile(path: string): Promise<DeclaredShard[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (cause) {
    throw selectionError("DECLARED_SHARDS_INVALID", `Could not read declared-shards file ${path}.`, { cause });
  }
  const artifact = SelectionArtifactSchema.safeParse(raw);
  if (artifact.success) return [...artifact.data.declaredShards];
  if (Array.isArray(raw)) {
    return raw.map((entry, index) => {
      if (entry === null || typeof entry !== "object") {
        throw selectionError("DECLARED_SHARDS_INVALID", `declaredShards[${String(index)}] is invalid.`);
      }
      const record = entry as Record<string, unknown>;
      const shardId = record["shardId"];
      const runId = record["runId"];
      const shardIdentityHash = record["shardIdentityHash"];
      if (typeof shardId !== "string" || typeof runId !== "string") {
        throw selectionError("DECLARED_SHARDS_INVALID", `declaredShards[${String(index)}] needs shardId and runId.`);
      }
      return {
        shardId,
        runId,
        ...(typeof shardIdentityHash === "string" ? { shardIdentityHash } : {})
      };
    });
  }
  throw selectionError(
    "DECLARED_SHARDS_INVALID",
    "Declared shards must be an aw-selection-artifact/1 document or an array of {shardId, shardIdentityHash, runId}."
  );
}

function mapShard(
  progress: SelectionProgress,
  shardId: string,
  mapper: (shard: SelectionProgress["shards"][number]) => SelectionProgress["shards"][number]
): SelectionProgress {
  return {
    ...progress,
    shards: progress.shards.map((shard) => (shard.shardId === shardId ? mapper(shard) : shard))
  };
}
