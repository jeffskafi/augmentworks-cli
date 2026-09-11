import { AwError } from "../errors.js";
import { createsBillableCompileError, savedSuiteBindingInvalidError, savedSuiteBindingUnsupportedError } from "./errors.js";
import { requireSavedSuiteManifest } from "./admit.js";
import {
  SUITE_SELECTION_SCHEMA_VERSION,
  SUITE_SELECTION_SCHEMA_VERSION_V2,
  SuiteSelectionManifestSchema,
  requestsSavedSuiteManifest,
  type CompileSuiteSelectionRequest,
  type SuiteSelectionManifest
} from "./schema.js";

export function parseCompiledSuiteSelectionManifest(
  value: unknown,
  request: CompileSuiteSelectionRequest
): SuiteSelectionManifest {
  const requestedSavedSuite = requestsSavedSuiteManifest(request);
  const parsed = SuiteSelectionManifestSchema.safeParse(value);
  if (!parsed.success) {
    if (requestedSavedSuite && isLegacyCatalogManifest(value)) {
      throw savedSuiteBindingUnsupportedError();
    }
    if (requestedSavedSuite) {
      throw savedSuiteBindingInvalidError(
        "The saved-suite compile response is not a valid aw-suite-selection/2 binding."
      );
    }
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned an invalid suite-selection compile response."
    });
  }
  if (parsed.data.createsBillableRun) throw createsBillableCompileError();
  if (requestedSavedSuite && parsed.data.schemaVersion !== SUITE_SELECTION_SCHEMA_VERSION_V2) {
    throw savedSuiteBindingUnsupportedError();
  }
  if (parsed.data.schemaVersion === SUITE_SELECTION_SCHEMA_VERSION_V2) {
    requireSavedSuiteManifest(parsed.data);
  }
  return parsed.data;
}

export function mapSavedSuiteCompileError(
  error: unknown,
  request: CompileSuiteSelectionRequest
): unknown {
  if (!requestsSavedSuiteManifest(request) || !(error instanceof AwError)) return error;
  if (error.code === "SAVED_SUITE_BINDING_UNSUPPORTED") {
    return savedSuiteBindingUnsupportedError(error);
  }
  if (error.code === "SAVED_SUITE_BINDING_INVALID" || error.code === "SAVED_SUITE_BINDING_STALE") {
    return error;
  }
  const status = error.details?.["http_status"];
  if (status === 400 || error.code === "SAVED_SUITE_BINDING_UNSUPPORTED") {
    return savedSuiteBindingUnsupportedError(error);
  }
  return error;
}

function isLegacyCatalogManifest(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["schemaVersion"] === SUITE_SELECTION_SCHEMA_VERSION
  );
}
