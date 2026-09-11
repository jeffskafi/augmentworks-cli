import { sanitizeTerminal } from "../errors.js";
import type { ManifestReleasePolicyResult, ShardManifest, SuiteSelectionManifest } from "./schema.js";

export function formatSelectionHuman(manifest: SuiteSelectionManifest): string {
  const lines = [
    `Selection ${sanitizeTerminal(manifest.normalizedSelection.profile)} / ${sanitizeTerminal(manifest.normalizedSelection.conversationMode)}`,
    `Manifest ${sanitizeTerminal(manifest.manifestHash)}`,
    `Catalog checksum ${manifest.catalogChecksum === null ? "none" : sanitizeTerminal(manifest.catalogChecksum)}`,
    `Included ${String(manifest.includedCaseCount)} of ${String(manifest.requestedCaseCount)} requested cases`,
    `Planned executions ${String(manifest.plannedExecutions)}; planned commands ${String(manifest.plannedCommands)}`,
    `Per-run limits ${String(manifest.perRunLimits.maxCases)} cases / ${String(manifest.perRunLimits.maxExecutions)} executions / ${String(manifest.perRunLimits.maxCommands)} commands`,
    `Executable: ${manifest.executable ? "yes" : "no"}`,
    `Creates billable run: ${manifest.createsBillableRun ? "yes" : "no"}`,
    `Quote is authoritative: ${manifest.quoteIsAuthoritative ? "yes" : "no"}`
  ];
  if (manifest.unexecutableReason) {
    lines.push(`Unexecutable: ${sanitizeTerminal(manifest.unexecutableReason)}`);
  }
  lines.push("", "Included:");
  if (manifest.included.length === 0) lines.push("- none");
  for (const row of manifest.included) {
    lines.push(`- ${sanitizeTerminal(row.caseId)} (${sanitizeTerminal(row.reasonCode)})`);
  }
  lines.push("", "Excluded:");
  if (manifest.excluded.length === 0) lines.push("- none");
  for (const row of manifest.excluded) {
    lines.push(`- ${sanitizeTerminal(row.caseId)} (${sanitizeTerminal(row.reasonCode)}) ${sanitizeTerminal(row.message)}`);
  }
  lines.push("", "Incompatible:");
  if (manifest.incompatible.length === 0) lines.push("- none");
  for (const row of manifest.incompatible) {
    lines.push(`- ${sanitizeTerminal(row.caseId)} (${sanitizeTerminal(row.reasonCode)}) ${sanitizeTerminal(row.message)}`);
  }
  lines.push("", "Shards:");
  if (manifest.shards.length === 0) lines.push("- none");
  for (const shard of manifest.shards) {
    lines.push(formatShardLine(shard));
  }
  lines.push(
    "",
    "This is the server compiler result. The CLI does not recompute counts or prices."
  );
  return `${lines.join("\n")}\n`;
}

export function selectionCompileJson(manifest: SuiteSelectionManifest): Record<string, unknown> {
  return {
    ok: true,
    action: "compile",
    createsBillableRun: manifest.createsBillableRun,
    quoteIsAuthoritative: manifest.quoteIsAuthoritative,
    executable: manifest.executable,
    unexecutableReason: manifest.unexecutableReason ?? null,
    schemaVersion: manifest.schemaVersion,
    selectionVersion: manifest.selectionVersion,
    manifestHash: manifest.manifestHash,
    catalogChecksum: manifest.catalogChecksum,
    inventoryHash: manifest.inventoryHash,
    suiteBinding: manifest.suiteBinding ?? null,
    normalizedSelection: manifest.normalizedSelection,
    requestedCaseCount: manifest.requestedCaseCount,
    includedCaseCount: manifest.includedCaseCount,
    plannedExecutions: manifest.plannedExecutions,
    plannedCommands: manifest.plannedCommands,
    perRunLimits: manifest.perRunLimits,
    included: manifest.included,
    excluded: manifest.excluded,
    incompatible: manifest.incompatible,
    shards: manifest.shards.map((shard) => ({
      shardId: shard.shardId,
      shardIndex: shard.shardIndex,
      shardIdentityHash: shard.shardIdentityHash,
      caseIds: shard.caseIds,
      plannedExecutions: shard.plannedExecutions,
      plannedCommands: shard.plannedCommands,
      planHash: shard.planHash,
      packetBindings: shard.packetBindings,
      compileOk: shard.compileOk
    }))
  };
}

export function formatManifestGateHuman(result: ManifestReleasePolicyResult): string {
  const lines = [
    "Command: gate --manifest-file",
    `Decision: ${sanitizeTerminal(result.decision)}`,
    `Coverage complete: ${result.coverageComplete ? "yes" : "no"}`,
    `Policy: ${sanitizeTerminal(result.policyVersion)}`,
    `Manifest ${sanitizeTerminal(result.manifestHash)}`,
    `Expected shards: ${result.expectedShardIds.join(", ") || "none"}`,
    `Declared runs: ${result.declaredRunIds.join(", ") || "none"}`
  ];
  for (const reason of result.reasons) {
    const shard = reason.shardId ? ` (${sanitizeTerminal(reason.shardId)})` : "";
    lines.push(`Reason ${sanitizeTerminal(reason.code)}${shard}: ${sanitizeTerminal(reason.message)}`);
  }
  if (result.note) lines.push(sanitizeTerminal(result.note));
  return `${lines.join("\n")}\n`;
}

export function manifestGateJson(
  result: ManifestReleasePolicyResult,
  extras: {
    readonly exitCode: number;
    readonly assessment: string;
  }
): Record<string, unknown> {
  return {
    ok: extras.exitCode === 0,
    observation: "succeeded",
    assessment: extras.assessment,
    exit_code: extras.exitCode,
    schemaVersion: result.schemaVersion,
    documentKind: result.documentKind,
    policyVersion: result.policyVersion,
    createsBillableRun: result.createsBillableRun,
    command: "gate",
    manifestHash: result.manifestHash,
    decision: result.decision,
    coverageComplete: result.coverageComplete,
    expectedShardIds: result.expectedShardIds,
    declaredRunIds: result.declaredRunIds,
    reasons: result.reasons,
    shards: result.shards,
    note: result.note ?? null
  };
}

function formatShardLine(shard: ShardManifest): string {
  return `- ${sanitizeTerminal(shard.shardId)} cases=${String(shard.caseIds.length)} executions=${String(shard.plannedExecutions)} commands=${String(shard.plannedCommands)} compileOk=${shard.compileOk ? "yes" : "no"} packet=${shard.packetBindings.map((binding) => `${binding.key}@${binding.version}`).join(",") || "none"}`;
}
