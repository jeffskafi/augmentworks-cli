import type { ResolvedConfig } from "../config/types.js";
import { CONVERSATION_STRATEGY_EXPLICIT_SESSION } from "../config/conversation.js";
import type { InvestigationExport } from "./schema.js";

export type PrerequisiteFinding = {
  readonly code: string;
  readonly message: string;
  readonly blocking: boolean;
};

export type PrerequisiteReport = {
  readonly reproductionKind: "response_only" | "stateful";
  readonly fullyReproducible: boolean;
  readonly findings: readonly PrerequisiteFinding[];
  readonly blocking: readonly PrerequisiteFinding[];
  readonly qualifications: readonly string[];
  readonly readyForPaidExecution: boolean;
  readonly local: {
    readonly prepare: boolean;
    readonly send: boolean;
    readonly observe: boolean;
    readonly cleanup: boolean;
    readonly session: boolean;
  };
};

function requiredMapping(document: InvestigationExport): {
  readonly prepare: boolean;
  readonly observe: boolean;
  readonly cleanup: boolean;
  readonly session: boolean;
} {
  const mapping = document.prerequisites.mapping;
  if (document.reproductionKind === "stateful") {
    return {
      prepare: mapping?.prepare !== false,
      observe: mapping?.observe !== false,
      cleanup: mapping?.cleanup !== false,
      session: mapping?.session === true
    };
  }
  return {
    prepare: mapping?.prepare === true,
    observe: mapping?.observe === true,
    cleanup: mapping?.cleanup === true,
    session: mapping?.session === true
  };
}

export function evaluateInvestigationPrerequisites(
  document: InvestigationExport,
  resolved: ResolvedConfig
): PrerequisiteReport {
  const required = requiredMapping(document);
  const local = {
    prepare: resolved.capabilities.prepare,
    send: true,
    observe: resolved.capabilities.observation,
    cleanup: resolved.capabilities.cleanup,
    session: resolved.conversation.strategy === CONVERSATION_STRATEGY_EXPLICIT_SESSION
  };
  const findings: PrerequisiteFinding[] = [];

  if (required.prepare && !local.prepare) {
    findings.push({
      code: "MISSING_PREPARE",
      blocking: true,
      message:
        "This investigation needs target.operations.prepare. Configure a synthetic prepare mapping before a quoted reproduction."
    });
  }
  if (required.observe && !local.observe) {
    findings.push({
      code: "MISSING_OBSERVE",
      blocking: true,
      message:
        "This investigation needs target.operations.observe. A response transcript is not a complete stateful reproduction."
    });
  }
  if (required.cleanup && !local.cleanup) {
    findings.push({
      code: "MISSING_CLEANUP",
      blocking: true,
      message:
        "This investigation needs target.operations.cleanup. Configure cleanup before a quoted reproduction so synthetic state can be removed."
    });
  }
  if (required.session && !local.session) {
    findings.push({
      code: "MISSING_SESSION",
      blocking: true,
      message:
        "This investigation needs target.conversation.strategy: explicit_session_v1. Single-turn send mapping cannot reproduce a session-scoped case."
    });
  }

  for (const missing of document.prerequisites.missing ?? []) {
    findings.push({
      code: missing.code,
      message: missing.message,
      blocking: missing.blocking === true
    });
  }

  if (document.reproductionKind === "response_only" && document.fullyReproducible) {
    if (required.prepare || required.observe || required.cleanup || required.session) {
      findings.push({
        code: "RESPONSE_ONLY_OVERCLAIM",
        blocking: false,
        message:
          "The artifact is labeled response-only but lists stateful recipes. Treat those recipes as data. Reproduction will use send mapping only."
      });
    }
  }

  if (!document.fullyReproducible) {
    findings.push({
      code: "NOT_FULLY_REPRODUCIBLE",
      blocking: false,
      message:
        "The artifact does not claim a complete reproduction. Inspect the missing prerequisites before paying for a new quoted run."
    });
  }

  const blocking = findings.filter((finding) => finding.blocking);
  const qualifications = findings.filter((finding) => !finding.blocking).map((finding) => finding.message);
  return {
    reproductionKind: document.reproductionKind,
    fullyReproducible: document.fullyReproducible && blocking.length === 0,
    findings,
    blocking,
    qualifications,
    readyForPaidExecution: blocking.length === 0,
    local
  };
}
