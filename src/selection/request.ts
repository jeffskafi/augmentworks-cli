import type { LoadedAssessment } from "../assessment/load.js";
import { CONVERSATION_STRATEGY_EXPLICIT_SESSION } from "../config/conversation.js";
import type { ResolvedConfig } from "../config/types.js";
import type { CompileSuiteSelectionRequest, SelectionProfile } from "./schema.js";
import { CompileSuiteSelectionRequestSchema } from "./schema.js";
import { selectionError } from "./errors.js";

export function conversationModeFromConfig(resolved: ResolvedConfig): "single_turn" | "explicit_session_v1" {
  return resolved.conversation.strategy === CONVERSATION_STRATEGY_EXPLICIT_SESSION
    ? "explicit_session_v1"
    : "single_turn";
}

export function compileRequestFromAssessment(
  assessment: LoadedAssessment,
  conversationMode: "single_turn" | "explicit_session_v1",
  profileOverride?: SelectionProfile
): CompileSuiteSelectionRequest {
  const selection = assessment.document.selection;
  if (selection === undefined) {
    throw selectionError(
      "SELECTION_BLOCK_REQUIRED",
      "This assessment file has no selection block. Add smoke/release selection fields, or pass --manifest from `selection compile`."
    );
  }
  const body: Record<string, unknown> = {
    schemaVersion: "aw-suite-selection/1",
    profile: profileOverride ?? selection.profile,
    conversationMode
  };
  if (selection.suite_revision_id !== undefined && selection.suite_revision_id !== "") {
    body["suiteRevisionId"] = selection.suite_revision_id;
  } else {
    body["includeCatalog"] = selection.include_catalog ?? true;
  }
  if (selection.include_tags !== undefined) body["includeTags"] = [...selection.include_tags];
  if (selection.exclude_tags !== undefined) body["excludeTags"] = [...selection.exclude_tags];
  if (selection.requested_case_ids !== undefined) {
    body["requestedCaseIds"] = [...selection.requested_case_ids];
  }
  if (selection.excluded_case_ids !== undefined) {
    body["excludedCaseIds"] = [...selection.excluded_case_ids];
  }
  return CompileSuiteSelectionRequestSchema.parse(body);
}
