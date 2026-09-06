import { AW_BILLING_CONTRACT } from "./generated/contract.js";

export const BILLING_SCHEMA_VERSION = AW_BILLING_CONTRACT.schemaVersion;
export const BILLING_READ_SCOPE = AW_BILLING_CONTRACT.contract.readScope;
export const BILLING_UNIT_MAX = 1_000_000;
export const USAGE_V1 = "usage_v1" as const;

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
  "service_unavailable"
] as const;

export type BillingAccessState = (typeof BILLING_ACCESS_STATES)[number];
export type BillingGrantOrigin = (typeof BILLING_GRANT_ORIGINS)[number];
export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

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
  readonly cutoverVersion?: string | null;
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
  };
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
