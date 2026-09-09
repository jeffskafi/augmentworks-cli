import type { LoadedAssessment } from "../assessment/load.js";
import { inspectConfig, unresolvedConfigError } from "../config/load.js";
import { advertisedTargetCapabilities, CONVERSATION_STRATEGY_EXPLICIT_SESSION } from "../config/conversation.js";
import type { ResolvedConfig } from "../config/types.js";
import type {
  CompileSuiteSelectionCapabilities,
  CompileSuiteSelectionRequest,
  SelectionConversationMode,
  SelectionProfile
} from "./schema.js";
import { CompileSuiteSelectionRequestSchema } from "./schema.js";
import { selectionError } from "./errors.js";

export interface SelectionAdvertisement {
  readonly conversationMode: SelectionConversationMode;
  readonly capabilities: CompileSuiteSelectionCapabilities;
}

export const CAPABILITY_FREE_SELECTION_CAPABILITIES: CompileSuiteSelectionCapabilities = {
  prepare: false,
  observation: false,
  toolEvents: false,
  cleanup: false,
  multiTurn: false,
  observationKeys: []
};

export const CAPABILITY_FREE_SELECTION_ADVERTISEMENT: SelectionAdvertisement = {
  conversationMode: "single_turn",
  capabilities: CAPABILITY_FREE_SELECTION_CAPABILITIES
};

export function conversationModeFromConfig(resolved: ResolvedConfig): SelectionConversationMode {
  return resolved.conversation.strategy === CONVERSATION_STRATEGY_EXPLICIT_SESSION
    ? "explicit_session_v1"
    : "single_turn";
}

export function selectionCapabilitiesFromResolved(
  resolved: ResolvedConfig
): CompileSuiteSelectionCapabilities {
  const advertised = advertisedTargetCapabilities(resolved);
  return {
    prepare: advertised.prepare,
    observation: advertised.observation,
    toolEvents: advertised.tool_events,
    cleanup: advertised.cleanup,
    multiTurn: advertised.multi_turn === true,
    observationKeys: [...advertised.observation_keys]
  };
}

export function selectionAdvertisementFromResolved(resolved: ResolvedConfig): SelectionAdvertisement {
  return {
    conversationMode: conversationModeFromConfig(resolved),
    capabilities: selectionCapabilitiesFromResolved(resolved)
  };
}

export async function resolveSelectionAdvertisement(options: {
  readonly configPath: string;
  readonly cwd: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly allowMissingDefault: boolean;
}): Promise<SelectionAdvertisement> {
  const inspection = await inspectConfig({
    configPath: options.configPath,
    cwd: options.cwd,
    ...(options.processEnv === undefined ? {} : { processEnv: options.processEnv })
  });
  if (inspection.resolvedConfig !== undefined) {
    return selectionAdvertisementFromResolved(inspection.resolvedConfig);
  }
  const missingDefault =
    options.allowMissingDefault &&
    inspection.diagnostics.some((item) => item.level === "error" && item.code === "CONFIG_FILE_NOT_FOUND");
  if (missingDefault) return CAPABILITY_FREE_SELECTION_ADVERTISEMENT;
  throw unresolvedConfigError(inspection);
}

export function compileRequestFromAssessment(
  assessment: LoadedAssessment,
  advertisement: SelectionAdvertisement,
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
    profile: profileOverride ?? selection.profile
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
  return parseCompileRequest(body, advertisement);
}

export function compileRequestFromFlags(options: {
  readonly advertisement: SelectionAdvertisement;
  readonly profile: SelectionProfile;
  readonly includeCatalog?: boolean;
  readonly includeTags?: string[];
  readonly excludeTags?: string[];
}): CompileSuiteSelectionRequest {
  return parseCompileRequest(
    {
      schemaVersion: "aw-suite-selection/1",
      profile: options.profile,
      includeCatalog: options.includeCatalog ?? true,
      ...(options.includeTags === undefined ? {} : { includeTags: options.includeTags }),
      ...(options.excludeTags === undefined ? {} : { excludeTags: options.excludeTags })
    },
    options.advertisement
  );
}

export function parseCompileRequest(
  body: Record<string, unknown> | CompileSuiteSelectionRequest,
  advertisement: SelectionAdvertisement
): CompileSuiteSelectionRequest {
  return CompileSuiteSelectionRequestSchema.parse({
    ...body,
    conversationMode: advertisement.conversationMode,
    capabilities: cloneSelectionCapabilities(advertisement.capabilities)
  });
}

export function cloneSelectionCapabilities(
  capabilities: CompileSuiteSelectionCapabilities
): CompileSuiteSelectionCapabilities {
  return {
    prepare: capabilities.prepare,
    observation: capabilities.observation,
    toolEvents: capabilities.toolEvents,
    cleanup: capabilities.cleanup,
    multiTurn: capabilities.multiTurn,
    observationKeys: [...capabilities.observationKeys]
  };
}
