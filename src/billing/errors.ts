import { AwError, sanitizeTerminal, type ErrorCategory } from "../errors.js";
import { AW_BILLING_CONTRACT } from "./generated/contract.js";
import {
  BILLING_SCHEMA_VERSION,
  isBillingErrorCode,
  isStableBillingCode,
  type BillingErrorCode,
  type StableBillingCode
} from "./protocol.js";

export type BillingHttpDetails = Readonly<Record<string, string | number | boolean>>;

const STABLE_TO_WIRE = AW_BILLING_CONTRACT.contract.stableErrorCodes;

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

export function quoteUnsupportedError(details?: BillingHttpDetails): AwError {
  return billingError({
    code: "UPDATE_REQUIRED",
    category: "billing",
    message:
      "This AugmentWorks server does not advertise quote_v1. Hosted assessment tests require a quoted aw-relay/0.3 create. Update the CLI and server together. No run was created, reserved, or started.",
    ...(details === undefined ? {} : { details })
  });
}

export function statusUnsupportedError(details?: BillingHttpDetails): AwError {
  return billingError({
    code: "UPDATE_REQUIRED",
    category: "billing",
    message:
      "This AugmentWorks server does not advertise status_v1. Use a server that implements GET /v1/billing/status. This read did not start a run, reserve credits, or retry grading.",
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

export function parseBillingErrorEnvelope(value: unknown):
  | { code: string; message: string; retryable: boolean; billingCode?: string }
  | undefined {
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
  const billingCode = body["billingCode"];
  return {
    code,
    message: sanitizeTerminal(message).replace(/[\r\n]+/g, " ").trim(),
    retryable,
    ...(typeof billingCode === "string" && billingCode.length > 0 ? { billingCode } : {})
  };
}

export function resolveStableBillingCode(
  code: string | undefined,
  billingCode: string | undefined
): StableBillingCode | undefined {
  if (billingCode !== undefined && isStableBillingCode(billingCode)) return billingCode;
  if (code === undefined) return undefined;
  if (isStableBillingCode(code)) return code;
  for (const [stable, wire] of Object.entries(STABLE_TO_WIRE)) {
    if (wire === code && isStableBillingCode(stable)) return stable;
  }
  return undefined;
}

function mapKnownBillingCode(
  code: BillingErrorCode,
  message: string,
  retryable: boolean,
  status: number,
  recoveryUrl: string,
  details: BillingHttpDetails
): AwError {
  const stable = resolveStableBillingCode(code, undefined);
  if (stable !== undefined) {
    return stableBillingError(stable, message, retryable || status >= 500, details);
  }
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
        message: "The AugmentWorks credential does not have the required connector scope.",
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
      return stableBillingError("BILLING_UNAVAILABLE", message, true, details);
    default:
      return billingUnsupportedStateError({ ...details, server_error_code: code });
  }
}

export function stableBillingError(
  code: StableBillingCode,
  message: string,
  retryable: boolean,
  details?: BillingHttpDetails
): AwError {
  switch (code) {
    case "MEMBERSHIP_REVOKED":
      return billingError({
        code: "MEMBERSHIP_REVOKED",
        category: "auth",
        message:
          message ||
          "This connector membership is no longer authorized. This is not a zero-credit balance.",
        ...(details === undefined ? {} : { details })
      });
    case "BILLING_UNAVAILABLE":
      return billingError({
        code: "BILLING_UNAVAILABLE",
        category: "billing",
        message:
          message ||
          "Billing is temporarily unavailable. Retry the request. No credits were changed by this CLI.",
        retryable: true,
        ...(details === undefined ? {} : { details })
      });
    case "INSUFFICIENT_CREDITS":
      return billingError({
        code: "INSUFFICIENT_CREDITS",
        category: "billing",
        message:
          message ||
          "This workspace does not have enough execution credits for the quoted assessment. No target work started. Buy or wait in the browser billing page, then run the test again with an explicit --max-credits ceiling.",
        ...(details === undefined ? {} : { details })
      });
    case "QUOTE_EXPIRED":
      return billingError({
        code: "QUOTE_EXPIRED",
        category: "billing",
        message:
          message ||
          "This quote has expired. Request a new estimate, then start the assessment with the same create identity only if the original create was proved uncreated. Do not get a fresh quote while create is still ambiguous.",
        ...(details === undefined ? {} : { details })
      });
    case "QUOTE_MISMATCH":
      return billingError({
        code: "QUOTE_MISMATCH",
        category: "billing",
        message:
          message ||
          "This quote does not match the compiled assessment, or it was already used. Request a new estimate for the current files. No additional run was created.",
        ...(details === undefined ? {} : { details })
      });
    case "BUDGET_EXCEEDED":
      return billingError({
        code: "BUDGET_EXCEEDED",
        category: "billing",
        message:
          message ||
          "The requested run exceeds the explicit credit ceiling or an operator cost budget. --yes is not an unlimited budget. No target work started.",
        ...(details === undefined ? {} : { details })
      });
    case "UPDATE_REQUIRED":
      return billingError({
        code: "UPDATE_REQUIRED",
        category: "billing",
        message:
          message ||
          "This CLI cannot start billed hosted work on this server. Upgrade to quoted aw-relay/0.3 create. No reservation or execution was started.",
        ...(details === undefined ? {} : { details })
      });
    case "WORKSPACE_CLOSING":
      return billingError({
        code: "WORKSPACE_CLOSING",
        category: "billing",
        message:
          message || "This workspace is closing. New assessments are not admitted. Existing results remain readable.",
        ...(details === undefined ? {} : { details })
      });
  }
}

export function mapBillingAdmissionError(
  status: number,
  value: unknown,
  method: string,
  path: string,
  recoveryUrl: string
): AwError | undefined {
  const details: Record<string, string | number | boolean> = {
    http_status: status,
    http_method: method,
    http_path: path
  };
  const envelope = parseBillingErrorEnvelope(value);
  const record =
    value !== null && typeof value === "object"
      ? ((value as Record<string, unknown>)["error"] as Record<string, unknown> | undefined)
      : undefined;
  const screaming =
    record !== undefined && typeof record["code"] === "string" ? String(record["code"]) : undefined;
  const stable = resolveStableBillingCode(
    envelope?.code ?? screaming,
    envelope?.billingCode ?? (typeof record?.["billingCode"] === "string" ? String(record["billingCode"]) : undefined)
  );
  if (stable !== undefined) {
    const message = envelope?.message ?? (typeof record?.["message"] === "string" ? record["message"] : "");
    return stableBillingError(stable, sanitizeTerminal(message).replace(/[\r\n]+/g, " ").trim(), envelope?.retryable === true || status >= 500, details);
  }
  if (envelope !== undefined && isBillingErrorCode(envelope.code)) {
    return mapKnownBillingCode(
      envelope.code,
      envelope.message,
      envelope.retryable,
      status,
      recoveryUrl,
      details
    );
  }
  return undefined;
}

function unsupportedForPath(path: string, details: BillingHttpDetails): AwError {
  if (path.includes("/v1/billing/quote")) return quoteUnsupportedError(details);
  if (path.includes("/v1/billing/status")) return statusUnsupportedError(details);
  return usageUnsupportedError(details);
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
    return unsupportedForPath(path, details);
  }
  const admission = mapBillingAdmissionError(status, value, method, path, recoveryUrl);
  if (admission !== undefined) return admission;
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
      message: "Billing is temporarily unavailable. Retry the request. No credits were changed by this CLI.",
      retryable: true,
      details
    });
  }
  return billingMalformedError("billing error response", details);
}

export function profileRecoveryUrl(apiOrigin: URL): string {
  return new URL("/portal", apiOrigin).toString();
}
