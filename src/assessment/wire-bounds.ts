import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ASSESSMENT_FILE_SCHEMA,
  MAX_ASSESSMENT_FILE_BYTES,
  MAX_REFERENCE_BYTES_TOTAL,
  MAX_REFERENCE_ENTRIES
} from "./schema.js";
import type { LoadedAssessment } from "./load.js";
import type { Diagnostic, ResolvedConfig } from "../config/types.js";
import { LIMITS } from "../util/limits.js";
import { resolveInstalledPackageRoot } from "../system/package-root.js";

export async function assessmentWireBoundDiagnostics(
  assessment: LoadedAssessment,
  resolvedConfig?: ResolvedConfig
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [
    {
      level: "ok",
      code: "ASSESSMENT_WIRE_BOUNDS",
      message: `Wire bounds: assessment ≤ ${String(MAX_ASSESSMENT_FILE_BYTES)} bytes, references ≤ ${String(MAX_REFERENCE_BYTES_TOTAL)} bytes total and ${String(MAX_REFERENCE_ENTRIES)} files, parameters ≤ 20 scenarios × 32 keys, target response ≤ ${String(LIMITS.targetResponseBytes)} bytes.`
    },
    {
      level: "ok",
      code: "ASSESSMENT_PROFILE",
      message: `Profile ${assessment.profile} (file schema ${ASSESSMENT_FILE_SCHEMA}).`
    },
    {
      level: "ok",
      code: "ASSESSMENT_REQUIRED_FILES",
      message:
        assessment.localReferences.length > 0
          ? `Required local references present: ${assessment.localReferences.map((entry) => entry.relativePath).join(", ")}.`
          : "No local reference files; hosted reference ids only."
    }
  ];
  const packet = assessment.document.packets[0];
  if (packet !== undefined && resolvedConfig !== undefined) {
    const required = await readPacketRequiredCapabilities(packet.key, packet.version);
    if (required !== undefined) {
      const missing: string[] = [];
      if (required.prepare === true && !resolvedConfig.capabilities.prepare) missing.push("prepare");
      if (required.observation === true && !resolvedConfig.capabilities.observation) missing.push("observation");
      if (required.cleanup === true && !resolvedConfig.capabilities.cleanup) missing.push("cleanup");
      if (required.tool_events === true && !resolvedConfig.capabilities.tool_events) missing.push("tool_events");
      if (required.multi_turn === true && !resolvedConfig.conversation.multiTurn) missing.push("multi_turn");
      if (missing.length > 0) {
        diagnostics.push({
          level: "error",
          code: "ASSESSMENT_CAPABILITY_MISMATCH",
          message: missing.includes("multi_turn")
            ? `Assessment packet ${packet.key}@${packet.version} requires multi-turn conversation, which this connector does not advertise. Configure target.conversation.strategy: explicit_session_v1 and map $input.conversation_id into the send request.`
            : `Assessment packet ${packet.key}@${packet.version} requires ${missing.join(", ")}, which augmentworks.yaml does not provide.`
        });
      } else {
        diagnostics.push({
          level: "ok",
          code: "ASSESSMENT_CAPABILITY_MATCH",
          message: `Connector capabilities match packet ${packet.key}@${packet.version}.`
        });
      }
    }
  }
  return diagnostics;
}

export async function packetRequiresMultiTurn(key: string, version: string): Promise<boolean> {
  const required = await readPacketRequiredCapabilities(key, version);
  return required?.multi_turn === true;
}

async function readPacketRequiredCapabilities(
  key: string,
  version: string
): Promise<
  | {
      readonly prepare?: boolean;
      readonly observation?: boolean;
      readonly cleanup?: boolean;
      readonly tool_events?: boolean;
      readonly multi_turn?: boolean;
    }
  | undefined
> {
  try {
    const root = await resolveInstalledPackageRoot();
    const raw = JSON.parse(await readFile(join(root, "packets", key, version, "packet.json"), "utf8")) as {
      required_capabilities?: Record<string, unknown>;
    };
    const required = raw.required_capabilities;
    if (required === undefined || typeof required !== "object") return undefined;
    return {
      prepare: required["prepare"] === true,
      observation: required["observation"] === true,
      cleanup: required["cleanup"] === true,
      tool_events: required["tool_events"] === true,
      multi_turn: required["multi_turn"] === true
    };
  } catch {
    return undefined;
  }
}
