import {
  AUTHORIZED_PACKET_SCHEMA_VERSION,
  AUTHORIZED_REPORT_SCOPE,
  CAPABILITIES_PATH,
  DATA_POLICY_SCHEMA_VERSION,
  EXECUTION_SCOPE_SCHEMA_VERSION,
  SUITE_SCHEMA_VERSION_V3
} from "./constants.js";
import { parseCapabilities, type RealDataCapabilities } from "./documents.js";
import { realDataError } from "./errors.js";

export const DISABLED_REAL_DATA_CAPABILITIES: RealDataCapabilities = {
  schemaVersion: "aw-capabilities/1",
  executionScopes: [],
  suiteSchemas: ["aw-suite/1", "aw-suite/2"],
  packetSchemas: ["aw-packet/0.1", "aw-packet/live-informational-1"],
  reportScopes: [],
  dataPolicies: [],
  enabledEffects: [],
  runtimeEnforced: false,
  releaseEnabled: false
};

export function capabilitiesReleaseEnabled(capabilities: RealDataCapabilities): boolean {
  return capabilities.releaseEnabled === true && capabilities.runtimeEnforced === true;
}

export function capabilitiesAdvertiseAuthorized(capabilities: RealDataCapabilities): boolean {
  return (
    capabilities.executionScopes.includes(EXECUTION_SCOPE_SCHEMA_VERSION) &&
    capabilities.suiteSchemas.includes(SUITE_SCHEMA_VERSION_V3) &&
    capabilities.packetSchemas.includes(AUTHORIZED_PACKET_SCHEMA_VERSION) &&
    capabilities.dataPolicies.includes(DATA_POLICY_SCHEMA_VERSION)
  );
}

export function assertAuthorizedCapabilities(capabilities: RealDataCapabilities): void {
  if (!capabilitiesAdvertiseAuthorized(capabilities)) {
    throw realDataError(
      "UNSUPPORTED_EXECUTION_SCOPE",
      "This server does not advertise aw-execution-scope/1, aw-suite/3, and aw-packet/authorized-1."
    );
  }
}

export function assertHostedRealDataRelease(capabilities: RealDataCapabilities): void {
  assertAuthorizedCapabilities(capabilities);
  if (!capabilitiesReleaseEnabled(capabilities)) {
    throw realDataError(
      "EXECUTION_RELEASE_UNAVAILABLE",
      "Hosted real-data quote and admission remain release-disabled until backend and privacy integration are verified."
    );
  }
}

export function assertAuthorizedReportScope(capabilities: RealDataCapabilities): void {
  if (!capabilities.reportScopes.includes(AUTHORIZED_REPORT_SCOPE)) {
    throw realDataError(
      "UNSUPPORTED_EXECUTION_SCOPE",
      "This server does not advertise the authorized-1 report overlay."
    );
  }
}

export function parseOrDisabledCapabilities(value: unknown): RealDataCapabilities {
  try {
    return parseCapabilities(value);
  } catch {
    return DISABLED_REAL_DATA_CAPABILITIES;
  }
}

export { CAPABILITIES_PATH };
