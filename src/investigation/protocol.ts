import { AwError } from "../errors.js";
import {
  InvestigationExportSchema,
  investigationSchemaVersion,
  rewriteInvestigationKeys,
  INVESTIGATION_SCHEMA_VERSION,
  type InvestigationExport
} from "./schema.js";
import { createsBillableInvestigationError, investigationError } from "./errors.js";

export function normalizeInvestigationDocument(value: unknown): unknown {
  return rewriteInvestigationKeys(value);
}

export function parseInvestigationExport(value: unknown, label = "investigation"): InvestigationExport {
  const rewritten = normalizeInvestigationDocument(value);
  const version = investigationSchemaVersion(rewritten);
  if (typeof version === "string" && version !== INVESTIGATION_SCHEMA_VERSION) {
    throw investigationError(
      "INVESTIGATION_UNSUPPORTED_SCHEMA",
      `Unsupported investigation schema "${version}". This CLI validates ${INVESTIGATION_SCHEMA_VERSION} only.`,
      { schemaVersion: version }
    );
  }
  const parsed = InvestigationExportSchema.safeParse(rewritten);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const loc = issue === undefined || issue.path.length === 0 ? "root" : issue.path.join(".");
    throw investigationError(
      version === undefined ? "INVESTIGATION_UNSUPPORTED_SCHEMA" : "INVESTIGATION_INVALID",
      `Invalid ${label} (${loc}: ${issue?.message ?? "invalid document"}). Validate the artifact before using its selectors.`,
      { field: loc }
    );
  }
  if (parsed.data.createsBillableRun !== false) {
    throw createsBillableInvestigationError();
  }
  return parsed.data;
}

export function assertInvestigationObservation(document: InvestigationExport): void {
  if (document.createsBillableRun !== false) {
    throw createsBillableInvestigationError();
  }
  if (document.links?.audience === "share_link") {
    throw investigationError(
      "INVESTIGATION_PUBLICATION_FORBIDDEN",
      "This investigation is marked as a share link. CLI inspect and reproduce stay workspace-private and will not treat a private diagnostic as published."
    );
  }
}

export function mapInvestigationHttpError(error: unknown): unknown {
  if (!(error instanceof AwError)) return error;
  const status = error.details?.["http_status"];
  if (typeof status !== "number") return error;
  if (status === 401 || status === 403) {
    return new AwError({
      code: error.code === "API_KEY_REVOKED" ? error.code : "CLOUD_AUTH_REJECTED",
      category: "auth",
      message: error.message,
      details: error.details,
      cause: error
    });
  }
  if (status === 404) {
    return investigationError(
      "INVESTIGATION_NOT_FOUND",
      "The investigation for this exact run, evaluation, attempt, and criterion was not found. This read did not start a run or consume credits.",
      error.details
    );
  }
  if (status === 409 || status === 422 || status === 400) {
    return investigationError(
      error.code === "CLOUD_REQUEST_FAILED" ? "INVESTIGATION_INVALID" : error.code,
      error.message,
      error.details
    );
  }
  return error;
}
