import { AwError } from "../errors.js";

export function selectionError(
  code: string,
  message: string,
  options: {
    readonly category?: AwError["category"];
    readonly details?: Readonly<Record<string, string | number | boolean>>;
    readonly cause?: unknown;
  } = {}
): AwError {
  return new AwError({
    code,
    category: options.category ?? "config",
    message,
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
