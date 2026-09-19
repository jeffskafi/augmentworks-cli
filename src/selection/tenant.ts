import type { RunIntentTenantBinding } from "../relay/run-intent.js";
import {
  SelectionExecutionTenantSchema,
  type SelectionExecutionTenant,
  type SuiteSelectionManifest
} from "./schema.js";
import { selectionLegacyUnboundError, selectionTenantMismatchError } from "./errors.js";

export type { SelectionExecutionTenant };

/** Align with `normalizedApiBase` in `src/relay/run-intent.ts`. */
export function normalizeSelectionApiOrigin(value: URL): string {
  const normalized = new URL(value);
  normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
  normalized.search = "";
  normalized.hash = "";
  return normalized.toString();
}

export function selectionTenantFromSession(session: {
  readonly apiOrigin: URL;
  readonly tenant: RunIntentTenantBinding;
}): SelectionExecutionTenant {
  return parseSelectionTenant({
    api_origin: normalizeSelectionApiOrigin(session.apiOrigin),
    tenant: session.tenant
  });
}

export function parseSelectionTenant(value: SelectionExecutionTenant): SelectionExecutionTenant {
  const parsed = SelectionExecutionTenantSchema.safeParse(value);
  if (!parsed.success) {
    throw selectionTenantMismatchError({
      message:
        "The authenticated AugmentWorks origin, workspace, or connector cannot be bound to this selection execution. No quote was requested.",
      expectedWorkspaceId: value.tenant.workspace_id,
      actualWorkspaceId: value.tenant.workspace_id
    });
  }
  return parsed.data;
}

export function selectionTenantsEqual(
  expected: SelectionExecutionTenant,
  actual: SelectionExecutionTenant
): boolean {
  return (
    expected.api_origin === actual.api_origin &&
    expected.tenant.workspace_id === actual.tenant.workspace_id &&
    expected.tenant.connector_id === actual.tenant.connector_id
  );
}

export function assertSelectionTenantMatch(
  expected: SelectionExecutionTenant,
  actual: SelectionExecutionTenant,
  extras: {
    readonly executionId?: string;
    readonly recoveryAction?: "resume_execution" | "start_new_execution" | "inspect_legacy_unbound";
  } = {}
): void {
  if (selectionTenantsEqual(expected, actual)) return;
  throw selectionTenantMismatchError({
    message:
      "This selection execution is pinned to a different AugmentWorks API origin, workspace, or connector. The CLI will not quote, admit, or target another tenant. Resume with the original workspace or start a new execution after this attempt is terminal.",
    expectedWorkspaceId: expected.tenant.workspace_id,
    actualWorkspaceId: actual.tenant.workspace_id,
    ...(extras.executionId === undefined ? {} : { executionId: extras.executionId }),
    ...(extras.recoveryAction === undefined ? {} : { recoveryAction: extras.recoveryAction })
  });
}

export function assertSessionMatchesSelectionTenant(
  expected: SelectionExecutionTenant,
  session: {
    readonly apiOrigin: URL;
    readonly tenant: RunIntentTenantBinding;
  },
  extras: {
    readonly executionId?: string;
    readonly recoveryAction?: "resume_execution" | "start_new_execution" | "inspect_legacy_unbound";
  } = {}
): void {
  assertSelectionTenantMatch(expected, selectionTenantFromSession(session), extras);
}

export function assertManifestWorkspace(
  manifest: SuiteSelectionManifest,
  tenant: RunIntentTenantBinding | SelectionExecutionTenant
): void {
  const workspaceId = "workspace_id" in tenant ? tenant.workspace_id : tenant.tenant.workspace_id;
  const declared = manifest.workspaceId;
  if (declared === undefined || declared === null || declared === "") return;
  if (declared === workspaceId) return;
  throw selectionTenantMismatchError({
    message:
      "This compiled manifest belongs to a different workspace than the authenticated session. The CLI will not quote, admit, or send target calls for a foreign workspace, including catalog shards.",
    expectedWorkspaceId: declared,
    actualWorkspaceId: workspaceId,
    recoveryAction: "start_new_execution"
  });
}

export function originalRunIdsFromShards(
  shards: readonly { readonly runId?: string | null | undefined }[]
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const shard of shards) {
    if (shard.runId === undefined || shard.runId === null || shard.runId === "") continue;
    if (seen.has(shard.runId)) continue;
    seen.add(shard.runId);
    ids.push(shard.runId);
  }
  return ids;
}

export function throwLegacyUnboundSelectionError(details: {
  readonly manifestHash: string;
  readonly executionId?: string;
  readonly originalRunIds?: readonly string[];
  readonly reason?: string;
}): never {
  throw selectionLegacyUnboundError(details);
}
