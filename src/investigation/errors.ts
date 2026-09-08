import { AwError } from "../errors.js";

export function investigationError(
  code: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
  cause?: unknown
): AwError {
  return new AwError({
    code,
    category: "config",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause })
  });
}

export function createsBillableInvestigationError(): AwError {
  return investigationError(
    "CREATES_BILLABLE_RUN",
    "The investigation API advertised createsBillableRun. Observation and inspect must not start, reserve, or charge a run. No reproduction was started."
  );
}

export function crossWorkspaceInvestigationError(): AwError {
  return new AwError({
    code: "CROSS_WORKSPACE_INVESTIGATION",
    category: "auth",
    message:
      "The investigation belongs to a different workspace than the authenticated session. Export and reproduction stay workspace-private. No run was created."
  });
}

export function pinnedRevisionUnavailableError(details?: {
  readonly suiteId?: string;
  readonly revisionId?: string;
}): AwError {
  return investigationError(
    "PINNED_REVISION_UNAVAILABLE",
    "The pinned suite revision in this investigation is unavailable or inaccessible. Reproduction will not silently select the newest suite version.",
    details
  );
}

export function pinnedCaseUnavailableError(caseId: string): AwError {
  return investigationError(
    "PINNED_CASE_UNAVAILABLE",
    `The pinned case ${caseId} is not present on the saved suite revision. Reproduction will not substitute another case.`,
    { caseId }
  );
}

export function missingReproductionPrerequisitesError(messages: readonly string[]): AwError {
  return investigationError(
    "REPRODUCTION_PREREQUISITES_MISSING",
    `Missing local setup, session, or cleanup prerequisites block paid reproduction: ${messages.join(" ")} No quote, reservation, or run was created.`
  );
}
