import { HOSTED_REAL_DATA_RELEASE, R06_HANDOFF_SCHEMA_VERSION } from "./types.js";

export const R01_SCHEMA_SHA256 = "6a53d04f297eb4db275bb7074bf7705a08137d932be823a3f4087d84cfdf7121";
export const R01_FIXTURES_SHA256 = "26033843d55dcb9b49ccf68fa96f7de9ec34aa6c299e8ab28b605cad37572230";

/**
 * Exact R06 hook signatures for AUG-188. This is the integration contract,
 * not an informal TODO. R05 vendors R01 schema/fixtures and wires commands.
 */
export const R06_HANDOFF = {
  schemaVersion: R06_HANDOFF_SCHEMA_VERSION,
  initiative: "AW-REAL-DATA-1",
  scope: "R06",
  consumer: "AUG-188",
  hostedRealDataRelease: HOSTED_REAL_DATA_RELEASE,
  r01SchemaSha256: R01_SCHEMA_SHA256,
  r01FixturesSha256: R01_FIXTURES_SHA256,
  notes: [
    "Do not vendor R01 JSON from this module; AUG-188 owns shared contract vending.",
    "Receipts and errors never include raw detected values, reversal maps, or raw-content hashes.",
    "Credential masking is not universal anonymization.",
    "Hosted real-data remains unavailable until the combined R05+R06 path is verified."
  ],
  hooks: {
    inspectOutbound: {
      signature:
        "inspectOutbound(document, policy, profile, localSecrets) => { representation, receipt, blockedPaths }",
      blockedPaths: "metadata-only; path, action, and ruleId. Never include raw detected values."
    },
    applyRedactionProfile: {
      signature:
        "applyRedactionProfile(input, profile, policy, secrets) => { representation, counts, blockedPaths, maskedPaths, droppedPaths }"
    },
    sealDataHandlingReceipt: {
      signature:
        "sealDataHandlingReceipt({ policy, profile, representation, counts, processor, processorVersion, outcome? }) => DataHandlingReceipt"
    },
    evaluateRetainedEvidence: {
      signature: "evaluateRetainedEvidence(representation, expectedFacts) => { ok, outcome, missingFacts }",
      unicodeSpans: "Evidence offsets use Unicode code points via [...text]."
    },
    projectRelayResult: {
      signature:
        "projectRelayResult(kind, result, context, expectedFacts?) => { disposition, result?, failure?, receipt, evidence }"
    },
    projectAssessmentReferencePayload: {
      signature: "projectAssessmentReferencePayload(payload, context) => AssessmentReferencePayload"
    },
    planLocalContentCleanup: {
      signature: "planLocalContentCleanup({ stateDirectory, candidates }) => LocalContentCleanupPlan",
      neverDeletes: [
        "arbitrary working directories",
        "run-intent recovery state",
        "journal locks"
      ]
    }
  }
} as const;
