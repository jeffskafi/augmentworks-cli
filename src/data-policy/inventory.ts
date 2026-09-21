export const CONTENT_EGRESS_INVENTORY_SCHEMA = "aw-real-data-r06-inventory/1" as const;

export interface ContentEgressCallsite {
  readonly id: string;
  readonly path: string;
  readonly stage: string;
  readonly owner: "R06" | "R05" | "shared";
  readonly hook: string;
  readonly pendingRetry: boolean;
  readonly notes: string;
}

/**
 * Inventory of content exits, including pending/retry paths. R06 owns the
 * transform; R05 owns command/executor wiring that must call these hooks
 * before canonicalization, journal append, or upload.
 */
export const CONTENT_EGRESS_INVENTORY: readonly ContentEgressCallsite[] = [
  {
    id: "mapping-preview",
    path: "src/connector/mapping-preview.ts",
    stage: "pre-upload fixture preview",
    owner: "R06",
    hook: "inspectOutbound",
    pendingRetry: false,
    notes: "Offline fixture-only. No auth, target, suite upload, or credits."
  },
  {
    id: "normalize",
    path: "src/connector/normalize.ts",
    stage: "normalized connector result",
    owner: "R06",
    hook: "inspectOutbound via optional dataPolicy",
    pendingRetry: false,
    notes: "R05 passes policy before canonicalization and upload."
  },
  {
    id: "mapping-redact",
    path: "src/connector/mapping.ts",
    stage: "legacy secret redaction",
    owner: "shared",
    hook: "redactSecrets",
    pendingRetry: false,
    notes: "Credential [REDACTED] remains for paths without a frozen policy."
  },
  {
    id: "system-redact",
    path: "src/system/redact.ts",
    stage: "credential patterns",
    owner: "shared",
    hook: "SecretRedactor",
    pendingRetry: false,
    notes: "Not universal anonymization. Profile transforms live in src/data-policy."
  },
  {
    id: "http-connector",
    path: "src/connector/http.ts",
    stage: "target HTTP request/response",
    owner: "R05",
    hook: "normalizeConnectorResult dataPolicy",
    pendingRetry: true,
    notes: "Pending/retry target calls must not replay to obtain cleaner output."
  },
  {
    id: "journal-success",
    path: "src/relay/journal.ts",
    stage: "durable success/indeterminate result",
    owner: "R06",
    hook: "projectRelayResult",
    pendingRetry: true,
    notes: "Transform before append. Blocked responses persist a sanitized failure only."
  },
  {
    id: "relay-runner",
    path: "src/relay/runner.ts",
    stage: "hosted result ack/upload",
    owner: "R05",
    hook: "journal recordSuccess after inspectOutbound",
    pendingRetry: true,
    notes: "Do not auto-replay a blocked target response."
  },
  {
    id: "cloud-client",
    path: "src/cloud/client.ts",
    stage: "hosted API bodies",
    owner: "R05",
    hook: "inspectOutbound before create/quote/upload",
    pendingRetry: true,
    notes: "Pre-upload block must issue zero hosted content requests."
  },
  {
    id: "local-artifacts",
    path: "src/local/artifacts.ts",
    stage: "HTML/JSON/JUnit reports",
    owner: "R06",
    hook: "inspectOutbound optional dataPolicy",
    pendingRetry: false,
    notes: "Customer-controlled local files. Hosted purge cannot delete them."
  },
  {
    id: "local-scorer",
    path: "src/local/scorer.ts",
    stage: "local evidence text",
    owner: "shared",
    hook: "redactSecrets",
    pendingRetry: false,
    notes: "Structural enums must survive a secret equal to a status string."
  },
  {
    id: "assessment-bundle",
    path: "src/assessment/bundle.ts",
    stage: "reference payload",
    owner: "R06",
    hook: "projectAssessmentReferencePayload",
    pendingRetry: false,
    notes: "Optional second argument. R05 callers stay source-compatible."
  },
  {
    id: "quote-request",
    path: "src/billing/quote-request.ts",
    stage: "reference_bundle on quote/create",
    owner: "R05",
    hook: "buildAssessmentReferencePayload(assessment, context)",
    pendingRetry: false,
    notes: "Block invalid suite/source content before quote."
  },
  {
    id: "suite-load",
    path: "src/suite/load.ts",
    stage: "customer suite upload source",
    owner: "R05",
    hook: "inspectOutbound",
    pendingRetry: false,
    notes: "Credential-like keys already rejected; sensitive prose needs R06 transform."
  },
  {
    id: "suite-native",
    path: "src/suite/native.ts",
    stage: "native suite translation",
    owner: "R05",
    hook: "inspectOutbound",
    pendingRetry: false,
    notes: "Do not edit concurrently with this R06 change."
  },
  {
    id: "commands-test",
    path: "src/commands/test.ts",
    stage: "hosted run create",
    owner: "R05",
    hook: "inspectOutbound",
    pendingRetry: true,
    notes: "Command wiring owned by AUG-188."
  },
  {
    id: "connection-probe",
    path: "src/connector/connection-probe.ts",
    stage: "probe request/response",
    owner: "R05",
    hook: "inspectOutbound",
    pendingRetry: false,
    notes: "Probe must not leak fixture secrets in stdout."
  },
  {
    id: "report-export",
    path: "src/report/",
    stage: "hosted report export",
    owner: "R05",
    hook: "inspectOutbound",
    pendingRetry: false,
    notes: "Exports must hash the retained representation only."
  },
  {
    id: "investigation-export",
    path: "src/investigation/",
    stage: "investigation export",
    owner: "R05",
    hook: "inspectOutbound",
    pendingRetry: false,
    notes: "Local-only reversal maps never become export metadata."
  },
  {
    id: "local-content-cleanup",
    path: "src/data-policy/cleanup.ts",
    stage: "customer-controlled local content delete",
    owner: "R06",
    hook: "planLocalContentCleanup",
    pendingRetry: false,
    notes: "R05 may expose a command. Never delete arbitrary working directories or intent state."
  }
] as const;
