import { describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { classifyManifestReleasePolicy } from "../../src/selection/classify.js";
import {
  requireExecutableManifest,
  selectShard,
  assertShardWithinPerRunLimits
} from "../../src/selection/admit.js";
import {
  artifactFromProgress,
  assertResumeSameShard,
  initialProgress,
  markShardTerminal,
  nextRunnableShard,
  skipRemainingPendingShards
} from "../../src/selection/progress.js";
import type { ManifestReleasePolicyResult, SuiteSelectionManifest } from "../../src/selection/schema.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-suite-selection-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };

function manifest(name: string): SuiteSelectionManifest {
  return fixtures.fixtures[name]?.response as SuiteSelectionManifest;
}

function gate(name: string): ManifestReleasePolicyResult {
  return fixtures.fixtures[name]?.response as ManifestReleasePolicyResult;
}

describe("suite selection contracts", () => {
  it("keeps consumer fixture checksums aligned with lock files", async () => {
    const catalogLock = JSON.parse(
      await readFile(resolve(projectRoot, "contracts/aw-coverage-catalog-v1.lock.json"), "utf8")
    ) as { source: { consumerFixturesChecksum: string } };
    const selectionLock = JSON.parse(
      await readFile(resolve(projectRoot, "contracts/aw-suite-selection-v1.lock.json"), "utf8")
    ) as { source: { consumerFixturesChecksum: string } };
    const catalogBytes = await readFile(resolve(projectRoot, "contracts/aw-coverage-catalog-v1.fixtures.json"));
    const selectionBytes = await readFile(resolve(projectRoot, "contracts/aw-suite-selection-v1.fixtures.json"));
    expect(createHash("sha256").update(catalogBytes).digest("hex")).toBe(
      catalogLock.source.consumerFixturesChecksum
    );
    expect(createHash("sha256").update(selectionBytes).digest("hex")).toBe(
      selectionLock.source.consumerFixturesChecksum
    );
  });
});

describe("suite selection admit and gate mapping", () => {
  it("refuses an empty selection before quote", () => {
    expect(() => requireExecutableManifest(manifest("compile_empty"))).toThrow(/SELECTION_EMPTY/);
  });

  it("surfaces incompatible session capability instead of hiding it", () => {
    const compiled = manifest("compile_incompatible_session");
    expect(compiled.incompatible.some((row) => row.reasonCode === "capability_multi_turn")).toBe(true);
    expect(() => requireExecutableManifest(compiled)).toThrow(/SELECTION_UNEXECUTABLE/);
  });

  it("refuses a shard that exceeds frozen per-run limits", () => {
    const compiled = manifest("compile_per_run_expanded_limit");
    const shard = compiled.shards[0];
    expect(shard).toBeDefined();
    expect(() => assertShardWithinPerRunLimits(compiled, shard!)).toThrow(/PER_RUN_EXPANDED_LIMIT/);
  });

  it("selects a single shard and keeps server packet bindings", () => {
    const compiled = manifest("compile_executable");
    const shard = selectShard(compiled, "shard-000");
    expect(shard.packetBindings[0]?.key).toBe("aw-customer-suite");
    expect(shard.caseIds).toHaveLength(2);
  });

  it("does not treat an incomplete shard set as a pass", () => {
    const missing = classifyManifestReleasePolicy(gate("evaluate_missing_shards"));
    expect(missing.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(missing.assessment).toBe("incomplete");
    const incomplete = classifyManifestReleasePolicy(gate("evaluate_incomplete_run"));
    expect(incomplete.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const substituted = classifyManifestReleasePolicy(gate("evaluate_substituted_shard"));
    expect(substituted.exitCode).toBe(EXIT.CONFIG);
    const pass = classifyManifestReleasePolicy(gate("evaluate_complete_pass"));
    expect(pass.exitCode).toBe(EXIT.OK);
  });

  it("resumes the interrupted shard and does not start the next one", () => {
    const compiled = manifest("compile_executable");
    let progress = initialProgress(compiled, 30);
    progress = markShardTerminal(progress, "shard-000", "interrupted", {
      runId: "run-1",
      stoppedReason: "SIGINT"
    });
    expect(nextRunnableShard(progress)?.shardId).toBe("shard-000");
    expect(() => assertResumeSameShard(progress, "shard-001")).toThrow(/SHARD_PROGRESS_BLOCKED/);
    const artifact = artifactFromProgress(compiled, progress);
    expect(artifact.createsBillableRun).toBe(false);
    expect(artifact.declaredShards[0]?.runId).toBe("run-1");
    expect(artifact.missingShardIds.length + artifact.declaredShards.length).toBeGreaterThan(0);
  });

  it("skips remaining pending shards when the aggregate budget is exhausted", () => {
    const compiled = manifest("compile_executable");
    const first = compiled.shards[0];
    expect(first).toBeDefined();
    const two: SuiteSelectionManifest = {
      ...compiled,
      shards: [first!, { ...first!, shardId: "shard-001", shardIndex: 1 }]
    };
    let progress = initialProgress(two, 4);
    progress = markShardTerminal(progress, "shard-000", "completed", {
      runId: "run-1",
      quoteUnits: 4
    });
    expect(progress.remainingCredits).toBe(0);
    progress = skipRemainingPendingShards(progress, "aggregate_budget");
    expect(progress.shards.find((shard) => shard.shardId === "shard-001")?.status).toBe("skipped");
    const artifact = artifactFromProgress(two, progress);
    expect(artifact.createsBillableRun).toBe(false);
    expect(artifact.skippedShardIds).toContain("shard-001");
    expect(artifact.declaredShards[0]?.runId).toBe("run-1");
  });
});
