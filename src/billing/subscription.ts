import {
  SUBSCRIPTIONS_V1,
  capabilityIsAvailable,
  grantOriginKind,
  type BillingGrantBalance,
  type BillingUsage
} from "./protocol.js";

export const BILLING_SUBSCRIPTION_STATUSES = [
  "active",
  "canceling",
  "past_due",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "canceled",
  "processing",
  "unsupported",
  "unknown"
] as const;

export const BILLING_NEXT_PAYMENT_ACTIONS = [
  "none",
  "authenticate",
  "update_payment_method",
  "processing"
] as const;

export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];
export type BillingNextPaymentAction = (typeof BILLING_NEXT_PAYMENT_ACTIONS)[number];

export type BillingMonthlyGrant = {
  readonly grantedUnits: number;
  readonly availableUnits: number;
  readonly reservedUnits: number;
  readonly consumedUnits: number;
  readonly expiresAt: string | null;
};

export type BillingSubscription = {
  readonly planCode: string;
  readonly status: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly nextPaymentAction: string;
  readonly currentPeriodStart?: string | null;
  readonly currentPeriodEnd?: string | null;
  readonly monthlyGrant?: BillingMonthlyGrant | null;
};

export type GrantCategoryTotals = {
  readonly recurringAvailable: number;
  readonly purchasedAvailable: number;
  readonly trialPromotionalAvailable: number;
  readonly unrecognizedAvailable: number;
  readonly recurringReserved: number;
  readonly purchasedReserved: number;
  readonly trialPromotionalReserved: number;
};

export type SubscriptionInterpretation = {
  readonly advertised: boolean;
  readonly interpretable: boolean;
  readonly reason:
    | "capability_absent"
    | "none"
    | "known"
    | "malformed_optional"
    | "uninterpreted_enum";
  readonly projection: BillingSubscription | null;
};

export function isBillingSubscriptionStatus(value: string): value is BillingSubscriptionStatus {
  return (BILLING_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

export function isBillingNextPaymentAction(value: string): value is BillingNextPaymentAction {
  return (BILLING_NEXT_PAYMENT_ACTIONS as readonly string[]).includes(value);
}

export function summarizeGrantCategories(
  lots: readonly BillingGrantBalance[]
): GrantCategoryTotals {
  const totals = {
    recurringAvailable: 0,
    purchasedAvailable: 0,
    trialPromotionalAvailable: 0,
    unrecognizedAvailable: 0,
    recurringReserved: 0,
    purchasedReserved: 0,
    trialPromotionalReserved: 0
  };
  for (const lot of lots) {
    const kind = grantOriginKind(lot.origin);
    if (kind === "recurring") {
      totals.recurringAvailable += lot.availableUnits;
      totals.recurringReserved += lot.reservedUnits;
    } else if (kind === "purchased") {
      totals.purchasedAvailable += lot.availableUnits;
      totals.purchasedReserved += lot.reservedUnits;
    } else if (kind === "trial_promotional") {
      totals.trialPromotionalAvailable += lot.availableUnits;
      totals.trialPromotionalReserved += lot.reservedUnits;
    } else {
      totals.unrecognizedAvailable += lot.availableUnits;
    }
  }
  return totals;
}

export function earliestExpiringLot(
  lots: readonly BillingGrantBalance[]
): BillingGrantBalance | undefined {
  let earliest: BillingGrantBalance | undefined;
  for (const lot of lots) {
    if (lot.expiresAt === null) continue;
    if (earliest === undefined || lot.expiresAt < earliest.expiresAt!) {
      earliest = lot;
    }
  }
  return earliest;
}

export function interpretUsageSubscription(usage: BillingUsage): SubscriptionInterpretation {
  const advertised = capabilityIsAvailable(usage.capabilities, SUBSCRIPTIONS_V1);
  if (!advertised) {
    return {
      advertised: false,
      interpretable: true,
      reason: "capability_absent",
      projection: null
    };
  }
  if (usage.subscription === null) {
    return {
      advertised: true,
      interpretable: true,
      reason: "none",
      projection: null
    };
  }
  const projection = parseSubscriptionObject(usage.subscription);
  if (projection === undefined) {
    return {
      advertised: true,
      interpretable: false,
      reason: "malformed_optional",
      projection: null
    };
  }
  if (
    !isBillingSubscriptionStatus(projection.status) ||
    !isBillingNextPaymentAction(projection.nextPaymentAction)
  ) {
    return {
      advertised: true,
      interpretable: false,
      reason: "uninterpreted_enum",
      projection
    };
  }
  return {
    advertised: true,
    interpretable: true,
    reason: "known",
    projection
  };
}

export function parseSubscriptionObject(value: unknown): BillingSubscription | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const planCode = record["planCode"];
  const status = record["status"];
  const cancelAtPeriodEnd = record["cancelAtPeriodEnd"];
  const nextPaymentAction = record["nextPaymentAction"];
  if (typeof planCode !== "string" || planCode.length < 1 || planCode.length > 80) return undefined;
  if (typeof status !== "string" || status.length < 1 || status.length > 64) return undefined;
  if (typeof cancelAtPeriodEnd !== "boolean") return undefined;
  if (
    typeof nextPaymentAction !== "string" ||
    nextPaymentAction.length < 1 ||
    nextPaymentAction.length > 64
  ) {
    return undefined;
  }
  const monthlyGrant = parseMonthlyGrant(record["monthlyGrant"]);
  if (record["monthlyGrant"] !== undefined && monthlyGrant === undefined) return undefined;
  const currentPeriodStart =
    record["currentPeriodStart"] === undefined
      ? undefined
      : optionalTimestamp(record["currentPeriodStart"]);
  if (record["currentPeriodStart"] !== undefined && currentPeriodStart === undefined) return undefined;
  const currentPeriodEnd =
    record["currentPeriodEnd"] === undefined
      ? undefined
      : optionalTimestamp(record["currentPeriodEnd"]);
  if (record["currentPeriodEnd"] !== undefined && currentPeriodEnd === undefined) return undefined;
  return {
    planCode,
    status,
    cancelAtPeriodEnd,
    nextPaymentAction,
    ...(currentPeriodStart === undefined ? {} : { currentPeriodStart }),
    ...(currentPeriodEnd === undefined ? {} : { currentPeriodEnd }),
    ...(monthlyGrant === undefined ? {} : { monthlyGrant })
  };
}

function parseMonthlyGrant(value: unknown): BillingMonthlyGrant | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const grantedUnits = optionalUnit(record["grantedUnits"]);
  const availableUnits = optionalUnit(record["availableUnits"]);
  const reservedUnits = optionalUnit(record["reservedUnits"]);
  const consumedUnits = optionalUnit(record["consumedUnits"]);
  const expiresAt = optionalTimestamp(record["expiresAt"]);
  if (
    grantedUnits === undefined ||
    availableUnits === undefined ||
    reservedUnits === undefined ||
    consumedUnits === undefined ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return { grantedUnits, availableUnits, reservedUnits, consumedUnits, expiresAt };
}

function optionalUnit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    return undefined;
  }
  return value;
}

function optionalTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    return undefined;
  }
  return value;
}
