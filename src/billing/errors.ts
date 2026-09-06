import { AwError, sanitizeTerminal, type ErrorCategory } from "../errors.js";
import {
  BILLING_SCHEMA_VERSION,
  isBillingErrorCode,
  type BillingErrorCode
} from "./protocol.js";

export type BillingHttpDetails = Readonly<Record<string, string | number | boolean>>;

function billingError(options: {
  code: string;
  category: ErrorCategory;
  message: string;
  retryable?: boolean;
  details?: BillingHttpDetails;
}): AwError {
  return new AwError({
    code: options.code,
    category: options.category,
    message: options.message,
    retryable: options.retryable ?? false,
    ...(options.details === undefined ? {} : { details: options.details })
  });
}

export function usageUnsupportedError(details?: BillingHttpDetails): AwError {
  return billingError({
    code: "USAGE_UNSUPPORTED",
    category: "billing",
    message:
      "This AugmentWorks server does not advertise usage_v1. Update the CLI or wait for workspace billing APIs. No credits were granted, reserved, or displayed as zero from a missing capability.",
    ...(details === undefined ? {} : { details })
  });
}

export function billingMalformedError(label: string, details?: BillingHttpDetails): AwError {
  return billingError({
    code: "INVALID_CLOUD_RESPONSE",
    category: "protocol",
    message: `AugmentWorks returned an invalid ${label}.`,
    ...(details === undefined ? {} : { details })
  });
}

export function billingUnsupportedStateError(details?: BillingHttpDetails): AwError {
  return billingError({
    code: "BILLING_UNSUPPORTED_STATE",
    category: "billing",
    message:
      "This billing or access state cannot be interpreted. Update the CLI. The CLI did not guess an active or spendable balance.",
    ...(details === undefined ? {} : { details })
  });
}

export function workspaceMismatchError(details?: BillingHttpDetails): AwError {
  return billingError({
    code: "WORKSPACE_MISMATCH",
    category: "auth",
    message: "The usage snapshot does not match the authenticated workspace. No other wallet was selected.",
    ...(details === undefined ? {} : { details })
  });
}

export function profileRecoveryError(recoveryUrl: string, details?: BillingHttpDetails): AwError {
  return billingError({
    code: "PROFILE_RECOVERY_REQUIRED",
    category: "billing",
    message: `This identity is missing a recoverable AugmentWorks application or billing profile. Sign in at ${recoveryUrl} to repair it. The CLI did not create a replacement account or grant credits.`,
    details: { recovery_url: recoveryUrl, ...(details ?? {}) }
  });
}

export function billingUnprovisionedError(recoveryUrl: string, details?: BillingHttpDetails): AwError {
  return billingError({
    code: "BILLING_UNPROVISIONED",
    category: "billing",
    message: `This workspace has no billing account. That is a provisioning failure, not unlimited access. Sign in at ${recoveryUrl} to recover the first-party profile. The CLI did not grant credits.`,
    details: { recovery_url: recoveryUrl, ...(details ?? {}) }
  });
}

export function parseBillingErrorEnvelope(
  value: unknown
): { code: string; message: string; retryable: boolean } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== BILLING_SCHEMA_VERSION) return undefined;
  const error = record["error"];
  if (error === null || typeof error !== "object") return undefined;
  const body = error as Record<string, unknown>;
  const code = body["code"];
  const message = body["message"];
  const retryable = body["retryable"];
  if (typeof code !== "string" || code.length < 1 || code.length > 64) return undefined;
  if (typeof message !== "string" || message.length < 1 || message.length > 300) return undefined;
  if (typeof retryable !== "boolean") return undefined;
  return {
    code,
    message: sanitizeTerminal(message).replace(/[\r\n]+/g, " ").trim(),
    retryable
  };
}

function mapKnownBillingCode(
  code: BillingErrorCode,
  message: string,
  retryable: boolean,
  status: number,
  recoveryUrl: string,
  details: BillingHttpDetails
): AwError {
  switch (code) {
    case "unauthenticated":
      return billingError({
        code: "TOKEN_REVOKED",
        category: "auth",
        message: "The AugmentWorks credential is expired or revoked. Run login again.",
        details
      });
    case "unauthorized":
      return billingError({
        code: "CLOUD_AUTH_REJECTED",
        category: "auth",
        message: "AugmentWorks rejected this connector credential for billing usage.",
        details
      });
    case "insufficient_scope":
      return billingError({
        code: "SCOPE_DENIED",
        category: "auth",
        message: "The AugmentWorks credential does not have connector:identity billing read scope.",
        details
      });
    case "workspace_mismatch":
      return workspaceMismatchError(details);
    case "invalid_request":
      return billingError({
        code: "BILLING_INVALID_REQUEST",
        category: "billing",
        message,
        details
      });
    case "billing_unprovisioned":
      return billingUnprovisionedError(recoveryUrl, details);
    case "unsupported_state":
      return billingUnsupportedStateError(details);
    case "conflict":
      return billingError({
        code: "BILLING_CONFLICT",
        category: "billing",
        message,
        details
      });
    case "service_unavailable":
      return billingError({
        code: "BILLING_UNAVAILABLE",
        category: "billing",
        message: "Billing usage is temporarily unavailable. Retry the read. No credits were changed.",
        retryable: retryable || status >= 500,
        details
      });
  }
}

export function billingHttpError(
  status: number,
  value: unknown,
  method: string,
  path: string,
  recoveryUrl: string
): AwError {
  const details: Record<string, string | number | boolean> = {
    http_status: status,
    http_method: method,
    http_path: path
  };
  if (status === 404 || status === 405 || status === 501) {
    return usageUnsupportedError(details);
  }
  const envelope = parseBillingErrorEnvelope(value);
  if (envelope !== undefined) {
    if (isBillingErrorCode(envelope.code)) {
      return mapKnownBillingCode(
        envelope.code,
        envelope.message,
        envelope.retryable,
        status,
        recoveryUrl,
        details
      );
    }
    return billingUnsupportedStateError({ ...details, server_error_code: envelope.code });
  }
  if (status === 401) {
    return billingError({
      code: "TOKEN_REVOKED",
      category: "auth",
      message: "The AugmentWorks credential is expired or revoked. Run login again.",
      details
    });
  }
  if (status === 403) {
    return billingError({
      code: "CLOUD_AUTH_REJECTED",
      category: "auth",
      message: "AugmentWorks rejected the connector credential.",
      details
    });
  }
  if (status === 408 || status === 429 || status >= 500) {
    return billingError({
      code: "BILLING_UNAVAILABLE",
      category: "billing",
      message: "Billing usage is temporarily unavailable. Retry the read. No credits were changed.",
      retryable: true,
      details
    });
  }
  return billingMalformedError("billing error response", details);
}

export function profileRecoveryUrl(apiOrigin: URL): string {
  return new URL("/portal", apiOrigin).toString();
}
