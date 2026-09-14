import { describe, expect, it } from "vitest";

import { AwError } from "../../src/errors.js";
import { parseManifestGateResponse } from "../../src/selection/gate-v2.js";
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

function expectCode(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AwError);
    expect((error as AwError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
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
    expectCode(() => requireExecutableManifest(manifest("compile_empty")), "SELECTION_EMPTY");
  });

  it("surfaces incompatible session capability instead of hiding it", () => {
    const compiled = manifest("compile_incompatible_session");
    expect(compiled.incompatible.some((row) => row.reasonCode === "capability_multi_turn")).toBe(true);
    expectCode(() => requireExecutableManifest(compiled), "SELECTION_UNEXECUTABLE");
  });

  it("refuses a shard that exceeds frozen per-run limits", () => {
    const compiled = manifest("compile_per_run_expanded_limit");
    const shard = compiled.shards[0];
    expect(shard).toBeDefined();
    expectCode(
      () => assertShardWithinPerRunLimits(compiled, shard!),
      "PER_RUN_EXPANDED_LIMIT"
    );
  });

  it("selects a single shard and keeps server packet bindings", () => {
    const compiled = manifest("compile_executable");
    const shard = selectShard(compiled, "shard-000");
    expect(shard.packetBindings[0]?.key).toBe("aw-customer-suite");
    expect(shard.caseIds).toHaveLength(2);
  });

  it("does not treat a v1 or incomplete caller-authoritative receipt as a pass", () => {
    const request = {
      schemaVersion: "aw-manifest-release-gate-request/2" as const,
      manifestHash: "d408b0ed41c7eddc8fbdfbd4e0737f264f257c43d13794aa88a720b0d82c219f",
      declaredShards: [
        {
          shardId: "shard-000",
          shardIdentityHash: "2a3f15188a38cfc4982a924a0d38dfa5ef58a0ff921d8e050ee588e95cd83b3d",
          runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        }
      ]
    };
    expectCode(
      () => parseManifestGateResponse(gate("evaluate_missing_shards"), request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(gate("evaluate_incomplete_run"), request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(gate("evaluate_substituted_shard"), request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(gate("evaluate_complete_pass"), request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
  });

  it("resumes the interrupted shard and does not start the next one", () => {
    const compiled = manifest("compile_executable");
    let progress = initialProgress(compiled, 30);
    progress = markShardTerminal(progress, "shard-000", "interrupted", {
      runId: "run-1",
      stoppedReason: "SIGINT"
    });
    expect(nextRunnableShard(progress)?.shardId).toBe("shard-000");
    expectCode(() => assertResumeSameShard(progress, "shard-001"), "SHARD_PROGRESS_BLOCKED");
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
