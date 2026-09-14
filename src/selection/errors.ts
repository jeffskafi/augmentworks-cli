import { AwError } from "../errors.js";

export function selectionError(
  code: string,
  message: string,
  options: {
    readonly category?: AwError["category"];
    readonly details?: Readonly<Record<string, string | number | boolean>>;
    readonly cause?: unknown;
    readonly retryable?: boolean;
  } = {}
): AwError {
  return new AwError({
    code,
    category: options.category ?? "config",
    message,
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.cause === undefined ? {} : { cause: options.cause })
  });
}

export function emptySelectionError(): AwError {
  return selectionError(
    "SELECTION_EMPTY",
    "No compatible cases remain after filters and capability checks. The CLI will not quote or start a run for an empty selection."
  );
}

export function unexecutableSelectionError(reason: string): AwError {
  return selectionError(
    "SELECTION_UNEXECUTABLE",
    `${reason} The CLI will not hide incompatible cases or raise per-run limits.`
  );
}

export function perRunExpandedLimitError(details: {
  readonly cases: number;
  readonly executions: number;
  readonly commands: number;
  readonly maxCases: number;
  readonly maxExecutions: number;
  readonly maxCommands: number;
}): AwError {
  return selectionError(
    "PER_RUN_EXPANDED_LIMIT",
    `This shard exceeds the frozen per-run limits (${String(details.maxCases)} cases / ${String(details.maxExecutions)} executions / ${String(details.maxCommands)} commands). The CLI will not raise those caps. Split the selection or exclude cases before consent.`,
    { details }
  );
}

export function savedSuiteBindingUnsupportedError(cause?: unknown): AwError {
  return selectionError(
    "SAVED_SUITE_BINDING_UNSUPPORTED",
    "This CLI requested aw-suite-selection/2 for a saved policy suite, but the server did not return a bound immutable suite. Upgrade the CLI and server so saved-suite compile uses aw-suite-selection/2. No quote, reservation, or run was created.",
    { category: "protocol", ...(cause === undefined ? {} : { cause }) }
  );
}

export function savedSuiteBindingInvalidError(
  reason: string,
  details?: Readonly<Record<string, string | number | boolean>>
): AwError {
  return selectionError(
    "SAVED_SUITE_BINDING_INVALID",
    `${reason} The CLI will not quote, reserve, or start a run from a malformed, tampered, mixed, or over-limit saved-suite binding.`,
    { category: "protocol", ...(details === undefined ? {} : { details }) }
  );
}

export function savedSuiteBindingStaleError(details: {
  readonly requested_revision: string;
  readonly bound_revision: string;
}): AwError {
  return selectionError(
    "SAVED_SUITE_BINDING_STALE",
    `The compiled suiteBinding revision ${details.bound_revision} does not match the assessment suite_revision_id ${details.requested_revision}. Replace the pin before consent. Do not quote from a stale binding.`,
    { category: "protocol", details }
  );
}

export function hostedSelectionUnsupportedLocalError(): AwError {
  return selectionError(
    "HOSTED_SELECTION_UNSUPPORTED_LOCAL",
    "Catalog metadata, compiled shard manifests, and smoke/release selection fields are hosted compiler features and cannot be used with --local. Local mode still uses deterministic packets only."
  );
}

export function createsBillableCompileError(): AwError {
  return new AwError({
    code: "CREATES_BILLABLE_RUN",
    category: "protocol",
    message:
      "The suite-selection API advertised createsBillableRun. Compile and manifest gating must not start, reserve, or charge a run."
  });
}

export function manifestNotExecutableError(reason?: string): AwError {
  const detail = reason !== undefined && reason.trim() !== "" ? ` ${reason}` : "";
  return selectionError(
    "MANIFEST_NOT_EXECUTABLE",
    `This compiled suite is not executable.${detail} Recompile after fixing incompatible cases. The CLI will not evaluate a release gate for a non-executable manifest.`
  );
}

export function manifestEmptyError(): AwError {
  return selectionError(
    "MANIFEST_EMPTY",
    "This compiled suite has no included cases or expected shards. An empty suite cannot authorize a release. The CLI will not send a release-gate request."
  );
}

export function manifestIntegrityMismatchError(): AwError {
  return selectionError(
    "MANIFEST_INTEGRITY_MISMATCH",
    "The compiled manifestHash does not match the canonical unsigned document. Replace the tampered or stale manifest. The CLI will not send a release-gate request."
  );
}

export function manifestDeclarationIncompleteError(reason?: string): AwError {
  const detail = reason !== undefined && reason.trim() !== "" ? ` ${reason}` : "";
  return selectionError(
    "MANIFEST_DECLARATION_INCOMPLETE",
    `Declared shards must cover every expected shard exactly once with matching identity hashes and run UUIDs.${detail} Supply --declared-shards from test --artifact-out. The CLI will not send a partial or extra declaration.`
  );
}

export function manifestDeclarationDuplicateError(): AwError {
  return selectionError(
    "MANIFEST_DECLARATION_DUPLICATE",
    "Declared shards contain duplicate shard IDs, identity hashes, or run IDs. The CLI will not send a duplicate declaration."
  );
}

export function manifestGateContractUnsupportedError(reason?: string): AwError {
  const detail = reason !== undefined && reason.trim() !== "" ? ` ${reason}` : "";
  return selectionError(
    "MANIFEST_GATE_CONTRACT_UNSUPPORTED",
    `The server did not return an aw-manifest-release-policy/2 server-authoritative receipt.${detail} This CLI will not treat a legacy or malformed body as a pass.`,
    { category: "protocol" }
  );
}

export function manifestGateResponseMismatchError(reason?: string): AwError {
  const detail = reason !== undefined && reason.trim() !== "" ? ` ${reason}` : "";
  return selectionError(
    "MANIFEST_GATE_RESPONSE_MISMATCH",
    `The v2 receipt is internally inconsistent with an authorized pass.${detail} The CLI will not authorize a release.`,
    { category: "protocol" }
  );
}
