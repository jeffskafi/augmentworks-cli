import { Buffer } from "node:buffer";

import type { AugmentWorksConfig, Diagnostic, JsonValue } from "../config/types.js";
import { AwError, type OperationKind } from "../errors.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { LIMITS } from "../util/limits.js";
import { redactSecrets, selectResponse } from "./mapping.js";
import {
  normalizeConnectorResult,
  omitMappedResponseFieldReason,
  shouldOmitMappedResponseField
} from "./normalize.js";
import type { ConnectorExecutionContext, ConnectorResult } from "./types.js";

export const MAPPING_PREVIEW_SCHEMA_VERSION = "AW-MAPPING-PREVIEW-1" as const;

export const PREVIEW_DISCLAIMER =
  "This preview is for the supplied fixture only. It does not guarantee that future target responses are secret-free.";

export const PREVIEW_CORRELATION = {
  commandId: "preview-command",
  idempotencyKey: "preview-idempotency",
  runId: "preview-run",
  attemptId: "preview-attempt",
  turnId: "preview-turn",
  requestId: "preview-request"
} as const;

export const HUMAN_DISPLAY_LIMIT_BYTES = 240;
export const HUMAN_EVIDENCE_LISTING_LIMIT_BYTES = 2048;

const OPERATION_KINDS = ["prepare", "send", "observe", "cleanup"] as const;

export type MappingPreviewFieldStatus =
  | "extracted"
  | "missing"
  | "omitted"
  | "invalid_selector"
  | "unsafe_selector";

export interface MappingPreviewField {
  readonly field: string;
  readonly selector: string;
  readonly location: string;
  readonly status: MappingPreviewFieldStatus;
  readonly redacted: boolean;
  readonly omitted_reason?: string;
  readonly selector_offset?: number;
  readonly display?: string;
  readonly value_bytes?: number;
}

export interface MappingPreviewRedaction {
  readonly field: string;
  readonly location: string;
}

export interface MappingPreviewTruncation {
  readonly field: string;
  readonly location: string;
  readonly original_bytes: number;
  readonly display_bytes: number;
  readonly truncated: boolean;
  readonly scope: "human_listing" | "evidence_limit";
  readonly rejected?: boolean;
}

export interface MappingPreviewResult {
  readonly schema_version: typeof MAPPING_PREVIEW_SCHEMA_VERSION;
  readonly ok: boolean;
  readonly offline: true;
  readonly operation: OperationKind;
  readonly fields: readonly MappingPreviewField[];
  readonly redactions: readonly MappingPreviewRedaction[];
  readonly truncations: readonly MappingPreviewTruncation[];
  readonly evidence: ConnectorResult | null;
  readonly evidence_canonical: string | null;
  readonly evidence_sha256: string | null;
  readonly evidence_bytes: number | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly disclaimer: typeof PREVIEW_DISCLAIMER;
}

export interface PreviewMappedEvidenceOptions {
  readonly kind: OperationKind;
  readonly config: AugmentWorksConfig;
  readonly response: JsonValue;
  readonly secrets?: readonly string[];
}

export function isOperationKind(value: string): value is OperationKind {
  return (OPERATION_KINDS as readonly string[]).includes(value);
}

export function previewCorrelationInput(): Record<string, string> {
  return {
    attempt_id: PREVIEW_CORRELATION.attemptId,
    turn_id: PREVIEW_CORRELATION.turnId,
    request_id: PREVIEW_CORRELATION.requestId,
    run_id: PREVIEW_CORRELATION.runId
  };
}

export function previewCorrelationContext(): ConnectorExecutionContext {
  return { ...PREVIEW_CORRELATION };
}

export function previewMappedEvidence(options: PreviewMappedEvidenceOptions): MappingPreviewResult {
  const diagnostics: Diagnostic[] = [
    {
      level: "ok",
      code: "PREVIEW_OFFLINE",
      message: "No target, cloud, model, or billing operation was invoked."
    }
  ];
  const allowToolEvents = options.config.telemetry?.allow_tool_events === true;
  const allowedObservations = new Set(options.config.telemetry?.allow_observations ?? []);
  const secrets = [...new Set((options.secrets ?? []).filter((secret) => secret.length > 0))];
  const operation = options.config.target.operations[options.kind];

  if (operation === undefined) {
    diagnostics.push({
      level: "error",
      code: "OPERATION_NOT_CONFIGURED",
      message: `No ${options.kind} operation is configured.`,
      path: `target.operations.${options.kind}`
    });
    return failedPreview(options.kind, [], [], [], diagnostics);
  }

  const responseMap = operation.response;
  if (responseMap === undefined) {
    diagnostics.push({
      level: "ok",
      code: "RESPONSE_MAP_ABSENT",
      message:
        options.kind === "cleanup"
          ? "Cleanup evidence does not use a response mapping."
          : "No response mapping is configured; the fixture is normalized as the operation result."
    });
  }

  const fields: MappingPreviewField[] = [];
  const redactions: MappingPreviewRedaction[] = [];
  const truncations: MappingPreviewTruncation[] = [];

  for (const [field, selector] of Object.entries(responseMap ?? {})) {
    const location = `target.operations.${options.kind}.response.${field}`;
    const omitReason = omitMappedResponseFieldReason({
      kind: options.kind,
      field,
      allowToolEvents,
      allowedObservations
    });
    if (
      shouldOmitMappedResponseField({
        kind: options.kind,
        field,
        allowToolEvents,
        allowedObservations
      })
    ) {
      fields.push({
        field,
        selector,
        location,
        status: "omitted",
        redacted: false,
        ...(omitReason === undefined ? {} : { omitted_reason: omitReason })
      });
      diagnostics.push({
        level: "ok",
        code: "RESPONSE_FIELD_OMITTED",
        message: omitReason ?? "The mapped field is omitted from evidence.",
        path: location
      });
      continue;
    }

    try {
      const extracted = selectResponse(options.response, selector);
      const redacted = redactSecrets(extracted, secrets);
      const wasRedacted = canonicalize(extracted) !== canonicalize(redacted);
      const display = listingFor(redacted);
      const valueBytes = Buffer.byteLength(canonicalize(redacted), "utf8");
      fields.push({
        field,
        selector,
        location,
        status: "extracted",
        redacted: wasRedacted,
        display: display.text,
        value_bytes: valueBytes
      });
      if (wasRedacted) {
        redactions.push({ field, location });
        diagnostics.push({
          level: "ok",
          code: "RESPONSE_VALUE_REDACTED",
          message: "Extracted values were replaced with [REDACTED] by the production redactor.",
          path: location
        });
      }
      if (display.truncated) {
        truncations.push({
          field,
          location,
          original_bytes: display.original_bytes,
          display_bytes: display.display_bytes,
          truncated: true,
          scope: "human_listing"
        });
      }
      if (typeof extracted === "string" && Buffer.byteLength(extracted, "utf8") > LIMITS.maxMessageBytes) {
        truncations.push({
          field,
          location,
          original_bytes: Buffer.byteLength(extracted, "utf8"),
          display_bytes: 0,
          truncated: false,
          scope: "evidence_limit",
          rejected: true
        });
        diagnostics.push({
          level: "error",
          code: "TARGET_MESSAGE_TOO_LARGE",
          message: "Assistant content exceeds the evidence size limit.",
          path: location
        });
      }
    } catch (error) {
      const mapped = fieldError(error, field, selector, location);
      fields.push(mapped.field);
      diagnostics.push(mapped.diagnostic);
    }
  }

  let evidence: ConnectorResult | null = null;
  let evidenceCanonical: string | null = null;
  let evidenceDigest: string | null = null;
  let evidenceBytes: number | null = null;

  const blocking = diagnostics.some((item) => item.level === "error");
  if (!blocking) {
    try {
      evidence = normalizeConnectorResult({
        kind: options.kind,
        input: previewCorrelationInput(),
        context: previewCorrelationContext(),
        response: options.response,
        responseMap,
        allowToolEvents,
        allowedObservations,
        secrets
      });
      evidenceCanonical = canonicalize(evidence);
      evidenceDigest = sha256(evidenceCanonical);
      evidenceBytes = Buffer.byteLength(evidenceCanonical, "utf8");
      const listing = listingFor(evidence, HUMAN_EVIDENCE_LISTING_LIMIT_BYTES);
      if (listing.truncated) {
        truncations.push({
          field: "evidence",
          location: "evidence",
          original_bytes: listing.original_bytes,
          display_bytes: listing.display_bytes,
          truncated: true,
          scope: "human_listing"
        });
      }
      diagnostics.push({
        level: "ok",
        code: "EVIDENCE_SERIALIZED",
        message: `Canonical relay evidence is ${evidenceBytes} bytes.`
      });
    } catch (error) {
      diagnostics.push(safeDiagnostic(error, `target.operations.${options.kind}`));
    }
  }

  const ok = !diagnostics.some((item) => item.level === "error") && evidence !== null;
  diagnostics.push({
    level: "ok",
    code: "PREVIEW_DISCLAIMER",
    message: PREVIEW_DISCLAIMER
  });
  return {
    schema_version: MAPPING_PREVIEW_SCHEMA_VERSION,
    ok,
    offline: true,
    operation: options.kind,
    fields,
    redactions,
    truncations,
    evidence,
    evidence_canonical: evidenceCanonical,
    evidence_sha256: evidenceDigest,
    evidence_bytes: evidenceBytes,
    diagnostics,
    disclaimer: PREVIEW_DISCLAIMER
  };
}

function failedPreview(
  operation: OperationKind,
  fields: readonly MappingPreviewField[],
  redactions: readonly MappingPreviewRedaction[],
  truncations: readonly MappingPreviewTruncation[],
  diagnostics: readonly Diagnostic[]
): MappingPreviewResult {
  return {
    schema_version: MAPPING_PREVIEW_SCHEMA_VERSION,
    ok: false,
    offline: true,
    operation,
    fields,
    redactions,
    truncations,
    evidence: null,
    evidence_canonical: null,
    evidence_sha256: null,
    evidence_bytes: null,
    diagnostics: [
      ...diagnostics,
      {
        level: "ok",
        code: "PREVIEW_DISCLAIMER",
        message: PREVIEW_DISCLAIMER
      }
    ],
    disclaimer: PREVIEW_DISCLAIMER
  };
}

function fieldError(
  error: unknown,
  field: string,
  selector: string,
  location: string
): { field: MappingPreviewField; diagnostic: Diagnostic } {
  const code = error instanceof AwError ? error.code : "INVALID_SELECTOR";
  const status: MappingPreviewFieldStatus =
    code === "UNSAFE_SELECTOR"
      ? "unsafe_selector"
      : code === "MAPPING_VALUE_MISSING"
        ? "missing"
        : "invalid_selector";
  const offset =
    error instanceof AwError && typeof error.details?.["offset"] === "number"
      ? error.details["offset"]
      : undefined;
  const message =
    error instanceof AwError
      ? error.message
      : "The response selector could not be applied.";
  return {
    field: {
      field,
      selector,
      location,
      status,
      redacted: false,
      ...(offset === undefined ? {} : { selector_offset: offset })
    },
    diagnostic: {
      level: "error",
      code,
      message:
        offset === undefined
          ? message
          : `${message} (selector offset ${offset})`,
      path: location
    }
  };
}

function safeDiagnostic(error: unknown, path: string): Diagnostic {
  if (error instanceof AwError) {
    return {
      level: "error",
      code: error.code,
      message: error.message,
      path
    };
  }
  return {
    level: "error",
    code: "PREVIEW_FAILED",
    message: "The fixture could not be normalized into relay evidence.",
    path
  };
}

function listingFor(
  value: JsonValue | ConnectorResult,
  limit = HUMAN_DISPLAY_LIMIT_BYTES
): { text: string; truncated: boolean; original_bytes: number; display_bytes: number } {
  const text = canonicalize(value);
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= limit) {
    return {
      text,
      truncated: false,
      original_bytes: originalBytes,
      display_bytes: originalBytes
    };
  }
  const truncated = `${truncateUtf8(text, limit)}… [truncated ${originalBytes} bytes]`;
  return {
    text: truncated,
    truncated: true,
    original_bytes: originalBytes,
    display_bytes: Buffer.byteLength(truncated, "utf8")
  };
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes < 1) return "";
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}

export function fieldListing(result: MappingPreviewResult, field: string): string | undefined {
  return result.fields.find((entry) => entry.field === field)?.display;
}
