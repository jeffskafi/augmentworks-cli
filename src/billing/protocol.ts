import { AW_BILLING_CONTRACT } from "./generated/contract.js";

export const BILLING_SCHEMA_VERSION = AW_BILLING_CONTRACT.schemaVersion;
export const BILLING_READ_SCOPE = AW_BILLING_CONTRACT.contract.readScope;
export const BILLING_QUOTE_SCOPE = AW_BILLING_CONTRACT.contract.quoteScope;
export const BILLING_STATUS_SCOPE = AW_BILLING_CONTRACT.contract.statusScope;
export const BILLING_UNIT_MAX = 1_000_000;
export const BILLING_EXECUTION_UNIT_MAX = 60;
export const BILLING_PRICING_VERSION = AW_BILLING_CONTRACT.contract.pricingVersion;
export const QUOTED_CREATE_PROTOCOL = AW_BILLING_CONTRACT.contract.quotedCreateProtocol;
export const USAGE_V1 = "usage_v1" as const;
export const QUOTE_V1 = "quote_v1" as const;
export const STATUS_V1 = "status_v1" as const;
export const BILLING_PORTAL_LINK_V1 = "billing_portal_link_v1" as const;
export const SUBSCRIPTIONS_V1 = "subscriptions_v1" as const;

export const BILLING_PRIMARY_PATHS = AW_BILLING_CONTRACT.contract.primaryPaths;
export const BILLING_ALIAS_PATHS = AW_BILLING_CONTRACT.contract.aliases;
export const BILLING_ADVERTISED_CAPABILITIES = AW_BILLING_CONTRACT.contract.advertisedCapabilities;
export const BILLING_RESERVED_CAPABILITIES = AW_BILLING_CONTRACT.contract.reservedCapabilities;

export const BILLING_ACCESS_STATES = [
  "active",
  "past_due",
  "suspended",
  "closing",
  "closed"
] as const;

export const BILLING_GRANT_ORIGINS = [
  "trial",
  "legacy_imported",
  "purchased",
  "subscription",
  "adjustment",
  "migration"
] as const;

export const BILLING_ERROR_CODES = [
  "unauthenticated",
  "unauthorized",
  "insufficient_scope",
  "invalid_request",
  "workspace_mismatch",
  "billing_unprovisioned",
  "unsupported_state",
  "conflict",
  "service_unavailable",
  "insufficient_credits",
  "quote_expired",
  "quote_mismatch",
  "budget_exceeded",
  "update_required",
  "workspace_closing",
  "membership_revoked"
] as const;

export const STABLE_BILLING_CODES = [
  "BILLING_UNAVAILABLE",
  "INSUFFICIENT_CREDITS",
  "QUOTE_EXPIRED",
  "QUOTE_MISMATCH",
  "BUDGET_EXCEEDED",
  "UPDATE_REQUIRED",
  "WORKSPACE_CLOSING",
  "MEMBERSHIP_REVOKED"
] as const;

export type BillingAccessState = (typeof BILLING_ACCESS_STATES)[number];
export type BillingGrantOrigin = (typeof BILLING_GRANT_ORIGINS)[number];
export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];
export type StableBillingCode = (typeof STABLE_BILLING_CODES)[number];

export type BillingGrantBalance = {
  readonly lotId: string;
  readonly origin: string;
  readonly grantedUnits: number;
  readonly availableUnits: number;
  readonly reservedUnits: number;
  readonly consumedUnits: number;
  readonly expiresAt: string | null;
  readonly grantedAt: string;
  readonly policyVersion?: string;
  readonly forfeitedUnits?: number;
  readonly frozenUnits?: number;
};

export type BillingPendingCommerce = {
  readonly orderId: string;
  readonly state: string;
  readonly skuCode: string;
};

export type BillingUsage = {
  readonly schemaVersion: typeof BILLING_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly billingAccountId: string;
  readonly asOf: string;
  readonly ledgerRevision: number;
  readonly accessState: string;
  readonly availableUnits: number;
  readonly reservedUnits: number;
  readonly consumedUnits: number;
  readonly grantBalances: readonly BillingGrantBalance[];
  readonly subscription: unknown;
  readonly billingPageUrl: string;
  readonly capabilities: readonly string[];
  readonly grossConsumedUnits?: number;
  readonly compensatedUnits?: number;
  readonly releasedUnits?: number;
  readonly cutoverVersion?: string | null;
  readonly pendingCommerce?: BillingPendingCommerce | null;
};

export type BillingCapabilities = {
  readonly schemaVersion: typeof BILLING_SCHEMA_VERSION;
  readonly asOf: string;
  readonly capabilities: readonly string[];
  readonly workspaceId?: string;
};

export type BillingErrorEnvelope = {
  readonly schemaVersion: typeof BILLING_SCHEMA_VERSION;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly billingCode?: string;
  };
};

export type BillingQuote = {
  readonly schemaVersion: typeof BILLING_SCHEMA_VERSION;
  readonly quoteId: string;
  readonly workspaceId: string;
  readonly assessmentPlanHash: string;
  readonly pricingVersion: string;
  readonly executionUnits: number;
  readonly expiresAt: string;
  readonly availableUnitsAtQuote: number;
  readonly estimateOnly: true;
  readonly scenarioCount?: number;
  readonly repetitions?: number;
  readonly remainingUnitsEstimate?: number;
};

export const BILLING_EVALUATION_STATUSES = [
  "absent",
  "pending",
  "complete",
  "partial",
  "error",
  "unsupported"
] as const;

export const BILLING_STATUS_NEXT_ACTIONS = [
  "wait",
  "inspect",
  "retry_evaluation",
  "open_dashboard",
  "none"
] as const;

export type BillingEvaluationStatus = (typeof BILLING_EVALUATION_STATUSES)[number];
export type BillingStatusNextAction = (typeof BILLING_STATUS_NEXT_ACTIONS)[number];

export type BillingRunStatus = {
  readonly schemaVersion: typeof BILLING_SCHEMA_VERSION;
  readonly runId: string;
  readonly workspaceId: string;
  readonly originalRunId: string;
  readonly executionStatus: string;
  readonly evaluationStatus: BillingEvaluationStatus;
  readonly credit: {
    readonly reservedUnits: number;
    readonly consumedUnits: number;
    readonly releasedUnits: number;
    readonly compensatedUnits: number;
  };
  readonly progress: {
    readonly completedAttempts: number;
    readonly plannedAttempts: number;
    readonly completedJudgeJobs: number;
    readonly plannedJudgeJobs: number;
  };
  readonly savedEvidence: boolean;
  readonly retryEligible: boolean;
  readonly retryReason: string | null;
  readonly nextActions: readonly string[];
  readonly dashboardUrl: string;
  readonly asOf: string;
  readonly outcome?: string | null;
};

export type RetryEvaluationResult = {
  readonly protocolVersion: string;
  readonly runId: string;
  readonly evaluationId: string;
  readonly reusedTargetEvidence: true;
  readonly customerUnitsDebited: 0;
};

export function isBillingAccessState(value: string): value is BillingAccessState {
  return (BILLING_ACCESS_STATES as readonly string[]).includes(value);
}

export function isBillingGrantOrigin(value: string): value is BillingGrantOrigin {
  return (BILLING_GRANT_ORIGINS as readonly string[]).includes(value);
}

export function isBillingErrorCode(value: string): value is BillingErrorCode {
  return (BILLING_ERROR_CODES as readonly string[]).includes(value);
}

export function isStableBillingCode(value: string): value is StableBillingCode {
  return (STABLE_BILLING_CODES as readonly string[]).includes(value);
}

export function isBillingEvaluationStatus(value: string): value is BillingEvaluationStatus {
  return (BILLING_EVALUATION_STATUSES as readonly string[]).includes(value);
}

export function capabilityIsAvailable(
  capabilities: readonly string[],
  name: string
): boolean {
  return capabilities.includes(name);
}

export function grantOriginKind(
  origin: string
): "trial_promotional" | "purchased" | "recurring" | "unrecognized" {
  if (origin === "purchased") return "purchased";
  if (origin === "subscription") return "recurring";
  if (
    origin === "trial" ||
    origin === "legacy_imported" ||
    origin === "migration" ||
    origin === "adjustment"
  ) {
    return "trial_promotional";
  }
  return "unrecognized";
}
