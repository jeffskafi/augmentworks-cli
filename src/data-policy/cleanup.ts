import { lstat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { dataPolicyError } from "./errors.js";

export const LOCAL_CONTENT_CLEANUP_SCHEMA = "aw-local-content-cleanup/1" as const;

export type LocalContentKind = "journal_content" | "preview_cache" | "local_report_content";

export interface LocalContentCandidate {
  readonly path: string;
  readonly kind: LocalContentKind;
}

export interface LocalContentCleanupPlan {
  readonly schemaVersion: typeof LOCAL_CONTENT_CLEANUP_SCHEMA;
  readonly eligible: readonly LocalContentCandidate[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly preservesRecoveryState: true;
  readonly neverDeletesWorkingDirectories: true;
}

const RECOVERY_NAME = /(?:intent|lock|\.lock)$/iu;

export function planLocalContentCleanup(options: {
  readonly stateDirectory: string;
  readonly candidates: readonly LocalContentCandidate[];
}): LocalContentCleanupPlan {
  const root = resolve(options.stateDirectory);
  const eligible: LocalContentCandidate[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const candidate of options.candidates) {
    const path = resolve(candidate.path);
    if (!containedBy(root, path)) {
      skipped.push({ path, reason: "outside_state_directory" });
      continue;
    }
    if (RECOVERY_NAME.test(path)) {
      skipped.push({ path, reason: "recovery_identifier" });
      continue;
    }
    eligible.push({ path, kind: candidate.kind });
  }
  return {
    schemaVersion: LOCAL_CONTENT_CLEANUP_SCHEMA,
    eligible,
    skipped,
    preservesRecoveryState: true,
    neverDeletesWorkingDirectories: true
  };
}

export async function executeLocalContentCleanup(
  plan: LocalContentCleanupPlan
): Promise<{ readonly deleted: number; readonly skipped: number }> {
  if (plan.schemaVersion !== LOCAL_CONTENT_CLEANUP_SCHEMA) {
    throw dataPolicyError("INVALID_DATA_POLICY", "The local content cleanup plan is not recognized.");
  }
  let deleted = 0;
  let skipped = plan.skipped.length;
  for (const candidate of plan.eligible) {
    const metadata = await lstat(candidate.path).catch(() => undefined);
    if (metadata === undefined) {
      skipped += 1;
      continue;
    }
    if (metadata.isSymbolicLink() || metadata.isDirectory() || !metadata.isFile()) {
      skipped += 1;
      continue;
    }
    await unlink(candidate.path);
    deleted += 1;
  }
  return { deleted, skipped };
}

function containedBy(parent: string, child: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false;
  const suffix = relative(parent, child);
  return suffix !== "" && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
