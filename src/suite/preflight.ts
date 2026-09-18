import type { ResolvedConfig } from "../config/types.js";
import { inspectConfig } from "../config/load.js";
import { liveExecutionPolicyFromSuite } from "./live-policy.js";
import { assertExactApprovedOrigin, assertSendOnlyOperations } from "./live-policy.js";
import type { LoadedCustomerSuite } from "./load.js";
import { previewCustomerSuite, type SuitePreview } from "./preview.js";
import { isLiveCustomerSuite, projectedAttemptCount } from "./schema.js";
import { LIVE_PACKET_SCHEMA_VERSION, liveError } from "./live-target.js";

export type SuitePreflight = SuitePreview & {
  readonly action: "preflight";
  readonly ok: true;
  readonly workspaceId: string | null;
  readonly permittedOperations: readonly ["send"] | readonly [];
  readonly permittedMessages: number | null;
  readonly finiteCreditCeiling: number;
  readonly buysCredits: false;
  readonly overlay: string | null;
};

export async function preflightCustomerSuite(
  loaded: LoadedCustomerSuite,
  options: {
    readonly cwd?: string;
    readonly configPath?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: number;
    readonly resolved?: ResolvedConfig;
  } = {}
): Promise<SuitePreflight> {
  const preview = previewCustomerSuite(loaded);
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const workspaceId = offlineWorkspaceId(env);
  let resolved = options.resolved;
  if (resolved === undefined && options.configPath !== undefined) {
    const inspection = await inspectConfig({
      configPath: options.configPath,
      cwd: options.cwd ?? process.cwd(),
      processEnv: env
    });
    if (inspection.resolvedConfig !== undefined) {
      resolved = inspection.resolvedConfig;
    }
  }
  if (isLiveCustomerSuite(loaded.document)) {
    const policy = liveExecutionPolicyFromSuite(loaded.document, now);
    if (options.configPath !== undefined && resolved === undefined) {
      throw liveError(
        "LIVE_TARGET_SCOPE_MISMATCH",
        "Could not resolve connector config to match the approved live origin before quote."
      );
    }
    if (policy !== undefined && resolved !== undefined) {
      assertExactApprovedOrigin(resolved, policy.origin);
      assertSendOnlyOperations(resolved);
    }
  }
  const live = isLiveCustomerSuite(loaded.document);
  return {
    ...preview,
    action: "preflight",
    ok: true,
    workspaceId,
    permittedOperations: live ? (["send"] as const) : [],
    permittedMessages: live ? loaded.document.liveTarget.maxMessages : null,
    finiteCreditCeiling: projectedAttemptCount(loaded.document),
    buysCredits: false,
    overlay: live ? LIVE_PACKET_SCHEMA_VERSION : null
  };
}

export function formatSuitePreflight(preflight: SuitePreflight): string {
  const lines = [
    "Customer suite preflight (offline — zero target messages, zero credits)",
    `  schema: ${preflight.schemaVersion}`,
    `  suite_id: ${preflight.suiteId}`,
    `  workspace: ${preflight.workspaceId ?? "(offline; selected at hosted admission)"}`,
    `  packet: ${preflight.packet.key}@${preflight.packet.version}`,
    ...(preflight.overlay === null ? [] : [`  overlay: ${preflight.overlay}`]),
    `  synthetic_only: ${preflight.syntheticOnly ? "yes" : "no"}`
  ];
  if (preflight.liveTarget !== null) {
    lines.push(
      `  approved_origin: ${preflight.liveTarget.origin}`,
      `  authorization_ref: ${preflight.liveTarget.authorizationRef}`,
      `  expires_at: ${preflight.liveTarget.expiresAt}`,
      `  permitted_operations: ${preflight.permittedOperations.join(", ") || "(none)"}`,
      `  permitted_messages: ${String(preflight.permittedMessages ?? 0)}`
    );
  }
  lines.push(
    `  finite_credit_ceiling: ${String(preflight.finiteCreditCeiling)} (local bound; not a quote and not a purchase)`,
    "  authoritative_price: no",
    "  executes_target: no",
    "  buys_credits: no",
    "  calls_llm: no"
  );
  return lines.join("\n");
}

function offlineWorkspaceId(env: NodeJS.ProcessEnv): string | null {
  const value = env["AUGMENTWORKS_QA_WORKSPACE_ID"]?.trim();
  return value === undefined || value === "" ? null : value;
}
