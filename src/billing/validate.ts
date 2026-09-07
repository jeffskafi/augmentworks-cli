import { z } from "zod";

import { DEFAULT_API_ORIGIN } from "../auth/api-origin.js";
import { AwError } from "../errors.js";
import {
  billingMalformedError,
  billingUnsupportedStateError,
  quoteUnsupportedError,
  statusUnsupportedError,
  usageUnsupportedError,
  workspaceMismatchError
} from "./errors.js";
import {
  BILLING_PRICING_VERSION,
  BILLING_SCHEMA_VERSION,
  BILLING_UNIT_MAX,
  QUOTE_V1,
  STATUS_V1,
  USAGE_V1,
  capabilityIsAvailable,
  isBillingAccessState,
  isBillingAssessmentOutcome,
  isBillingEvaluationStatus,
  type BillingCapabilities,
  type BillingGrantBalance,
  type BillingQuote,
  type BillingRunStatus,
  type BillingUsage
} from "./protocol.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utcTimestamp = z
  .string()
  .min(1)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const uuid = z.string().regex(UUID);
const unitCount = z.number().int().min(0).max(BILLING_UNIT_MAX);
const executionUnits = z.number().int().min(0).max(60);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*_v[0-9]+$/);

const grantBalanceSchema = z
  .object({
    lotId: uuid,
    origin: z.string().min(1).max(64),
    grantedUnits: unitCount,
    availableUnits: unitCount,
    reservedUnits: unitCount,
    consumedUnits: unitCount,
    expiresAt: utcTimestamp.nullable(),
    grantedAt: utcTimestamp,
    policyVersion: z.string().max(64).optional(),
    forfeitedUnits: unitCount.optional()
  })
  .passthrough();

const usageConsumerSchema = z
  .object({
    schemaVersion: z.literal(BILLING_SCHEMA_VERSION),
    workspaceId: uuid,
    billingAccountId: uuid,
    asOf: utcTimestamp,
    ledgerRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    accessState: z.string().min(1).max(64),
    availableUnits: unitCount,
    reservedUnits: unitCount,
    consumedUnits: unitCount,
    grantBalances: z.array(grantBalanceSchema),
    subscription: z.unknown().nullable(),
    billingPageUrl: z.string().min(1).max(2_048),
    capabilities: z.array(capability).min(1),
    grossConsumedUnits: unitCount.optional(),
    compensatedUnits: unitCount.optional(),
    cutoverVersion: z.string().max(64).nullable().optional()
  })
  .passthrough();

const capabilitiesConsumerSchema = z
  .object({
    schemaVersion: z.literal(BILLING_SCHEMA_VERSION),
    asOf: utcTimestamp,
    capabilities: z.array(capability).min(1),
    workspaceId: uuid.optional()
  })
  .passthrough();

const quoteConsumerSchema = z
  .object({
    schemaVersion: z.literal(BILLING_SCHEMA_VERSION),
    quoteId: uuid,
    workspaceId: uuid,
    assessmentPlanHash: sha256Hex,
    pricingVersion: z.string().min(1).max(80),
    executionUnits,
    expiresAt: utcTimestamp,
    availableUnitsAtQuote: unitCount,
    estimateOnly: z.literal(true),
    scenarioCount: z.number().int().min(0).max(20).optional(),
    repetitions: z.number().int().min(1).max(3).optional(),
    remainingUnitsEstimate: unitCount.optional()
  })
  .passthrough();

const runStatusConsumerSchema = z
  .object({
    schemaVersion: z.literal(BILLING_SCHEMA_VERSION),
    runId: uuid,
    workspaceId: uuid,
    originalRunId: uuid,
    executionStatus: z.string().min(1).max(64),
    evaluationStatus: z.string().min(1).max(64),
    credit: z
      .object({
        reservedUnits: unitCount,
        consumedUnits: unitCount,
        releasedUnits: unitCount,
        compensatedUnits: unitCount
      })
      .passthrough(),
    progress: z
      .object({
        completedAttempts: z.number().int().min(0),
        plannedAttempts: z.number().int().min(0),
        completedJudgeJobs: z.number().int().min(0),
        plannedJudgeJobs: z.number().int().min(0)
      })
      .passthrough(),
    savedEvidence: z.boolean(),
    retryEligible: z.boolean(),
    retryReason: z.string().max(300).nullable(),
    nextActions: z.array(z.string().min(1).max(64)).max(8),
    dashboardUrl: z.string().min(1).max(2_048),
    asOf: utcTimestamp,
    outcome: z.string().max(64).nullable().optional()
  })
  .passthrough();

export function parseBillingUsageResponse(value: unknown): BillingUsage {
  const parsed = usageConsumerSchema.safeParse(value);
  if (!parsed.success) throw billingMalformedError("billing usage response");
  if (!isBillingAccessState(parsed.data.accessState)) {
    throw billingUnsupportedStateError({ access_state: parsed.data.accessState });
  }
  if (!capabilityIsAvailable(parsed.data.capabilities, USAGE_V1)) {
    throw usageUnsupportedError();
  }
  const grantBalances: BillingGrantBalance[] = parsed.data.grantBalances.map((lot) => ({
    lotId: lot.lotId,
    origin: lot.origin,
    grantedUnits: lot.grantedUnits,
    availableUnits: lot.availableUnits,
    reservedUnits: lot.reservedUnits,
    consumedUnits: lot.consumedUnits,
    expiresAt: lot.expiresAt,
    grantedAt: lot.grantedAt,
    ...(lot.policyVersion === undefined ? {} : { policyVersion: lot.policyVersion }),
    ...(lot.forfeitedUnits === undefined ? {} : { forfeitedUnits: lot.forfeitedUnits })
  }));
  return {
    schemaVersion: parsed.data.schemaVersion,
    workspaceId: parsed.data.workspaceId,
    billingAccountId: parsed.data.billingAccountId,
    asOf: parsed.data.asOf,
    ledgerRevision: parsed.data.ledgerRevision,
    accessState: parsed.data.accessState,
    availableUnits: parsed.data.availableUnits,
    reservedUnits: parsed.data.reservedUnits,
    consumedUnits: parsed.data.consumedUnits,
    grantBalances,
    subscription: parsed.data.subscription,
    billingPageUrl: parsed.data.billingPageUrl,
    capabilities: parsed.data.capabilities,
    ...(parsed.data.grossConsumedUnits === undefined
      ? {}
      : { grossConsumedUnits: parsed.data.grossConsumedUnits }),
    ...(parsed.data.compensatedUnits === undefined
      ? {}
      : { compensatedUnits: parsed.data.compensatedUnits }),
    ...(parsed.data.cutoverVersion === undefined
      ? {}
      : { cutoverVersion: parsed.data.cutoverVersion })
  };
}

export function parseBillingCapabilitiesResponse(value: unknown): BillingCapabilities {
  const parsed = capabilitiesConsumerSchema.safeParse(value);
  if (!parsed.success) throw billingMalformedError("billing capabilities response");
  if (!capabilityIsAvailable(parsed.data.capabilities, USAGE_V1)) {
    throw usageUnsupportedError();
  }
  return {
    schemaVersion: parsed.data.schemaVersion,
    asOf: parsed.data.asOf,
    capabilities: parsed.data.capabilities,
    ...(parsed.data.workspaceId === undefined ? {} : { workspaceId: parsed.data.workspaceId })
  };
}

export function parseBillingCapabilitiesDocument(value: unknown): BillingCapabilities {
  const parsed = capabilitiesConsumerSchema.safeParse(value);
  if (!parsed.success) throw billingMalformedError("billing capabilities response");
  return {
    schemaVersion: parsed.data.schemaVersion,
    asOf: parsed.data.asOf,
    capabilities: parsed.data.capabilities,
    ...(parsed.data.workspaceId === undefined ? {} : { workspaceId: parsed.data.workspaceId })
  };
}

export function assertQuoteCapability(capabilities: readonly string[]): void {
  if (!capabilityIsAvailable(capabilities, QUOTE_V1)) {
    throw quoteUnsupportedError();
  }
}

export function assertStatusCapability(capabilities: readonly string[]): void {
  if (!capabilityIsAvailable(capabilities, STATUS_V1)) {
    throw statusUnsupportedError();
  }
}

export function parseBillingQuoteResponse(value: unknown): BillingQuote {
  const parsed = quoteConsumerSchema.safeParse(value);
  if (!parsed.success) throw billingMalformedError("billing quote response");
  if (parsed.data.pricingVersion !== BILLING_PRICING_VERSION) {
    throw billingUnsupportedStateError({ pricing_version: parsed.data.pricingVersion });
  }
  return {
    schemaVersion: parsed.data.schemaVersion,
    quoteId: parsed.data.quoteId,
    workspaceId: parsed.data.workspaceId,
    assessmentPlanHash: parsed.data.assessmentPlanHash,
    pricingVersion: parsed.data.pricingVersion,
    executionUnits: parsed.data.executionUnits,
    expiresAt: parsed.data.expiresAt,
    availableUnitsAtQuote: parsed.data.availableUnitsAtQuote,
    estimateOnly: true,
    ...(parsed.data.scenarioCount === undefined ? {} : { scenarioCount: parsed.data.scenarioCount }),
    ...(parsed.data.repetitions === undefined ? {} : { repetitions: parsed.data.repetitions }),
    ...(parsed.data.remainingUnitsEstimate === undefined
      ? {}
      : { remainingUnitsEstimate: parsed.data.remainingUnitsEstimate })
  };
}

export function parseBillingRunStatusResponse(value: unknown): BillingRunStatus {
  const parsed = runStatusConsumerSchema.safeParse(value);
  if (!parsed.success) throw billingMalformedError("billing run status response");
  if (!isBillingEvaluationStatus(parsed.data.evaluationStatus)) {
    throw billingUnsupportedStateError({ evaluation_status: parsed.data.evaluationStatus });
  }
  if (
    parsed.data.outcome !== undefined &&
    parsed.data.outcome !== null &&
    !isBillingAssessmentOutcome(parsed.data.outcome)
  ) {
    throw billingUnsupportedStateError({ outcome: parsed.data.outcome });
  }
  return {
    schemaVersion: parsed.data.schemaVersion,
    runId: parsed.data.runId,
    workspaceId: parsed.data.workspaceId,
    originalRunId: parsed.data.originalRunId,
    executionStatus: parsed.data.executionStatus,
    evaluationStatus: parsed.data.evaluationStatus,
    credit: {
      reservedUnits: parsed.data.credit.reservedUnits,
      consumedUnits: parsed.data.credit.consumedUnits,
      releasedUnits: parsed.data.credit.releasedUnits,
      compensatedUnits: parsed.data.credit.compensatedUnits
    },
    progress: {
      completedAttempts: parsed.data.progress.completedAttempts,
      plannedAttempts: parsed.data.progress.plannedAttempts,
      completedJudgeJobs: parsed.data.progress.completedJudgeJobs,
      plannedJudgeJobs: parsed.data.progress.plannedJudgeJobs
    },
    savedEvidence: parsed.data.savedEvidence,
    retryEligible: parsed.data.retryEligible,
    retryReason: parsed.data.retryReason,
    nextActions: parsed.data.nextActions,
    dashboardUrl: parsed.data.dashboardUrl,
    asOf: parsed.data.asOf,
    ...(parsed.data.outcome === undefined ? {} : { outcome: parsed.data.outcome })
  };
}

export function assertQuoteWorkspace(
  quote: BillingQuote,
  authenticatedWorkspaceId: string
): void {
  if (quote.workspaceId !== authenticatedWorkspaceId) {
    throw workspaceMismatchError({
      authenticated_workspace: authenticatedWorkspaceId,
      quote_workspace: quote.workspaceId
    });
  }
}

export function assertStatusWorkspace(
  status: BillingRunStatus,
  authenticatedWorkspaceId: string
): void {
  if (status.workspaceId !== authenticatedWorkspaceId) {
    throw workspaceMismatchError({
      authenticated_workspace: authenticatedWorkspaceId,
      status_workspace: status.workspaceId
    });
  }
}

export function assertUsageWorkspace(
  usage: BillingUsage,
  authenticatedWorkspaceId: string
): void {
  if (usage.workspaceId !== authenticatedWorkspaceId) {
    throw workspaceMismatchError({
      authenticated_workspace: authenticatedWorkspaceId,
      usage_workspace: usage.workspaceId
    });
  }
}

export function assertSafeBillingPageUrl(value: string, apiOrigin: URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned an invalid billing page URL.",
      cause
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw billingMalformedError("billing page URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const trusted =
    url.origin === new URL(DEFAULT_API_ORIGIN).origin || url.origin === apiOrigin.origin;
  if (!trusted) {
    throw billingMalformedError("billing page URL origin");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw billingMalformedError("billing page URL scheme");
  }
  if (!url.pathname.startsWith("/portal/billing")) {
    throw billingMalformedError("billing page URL path");
  }
  for (const [key, parameter] of url.searchParams) {
    if (/^(access_token|refresh_token|token|code|id_token)$/i.test(key) || /[\r\n]/.test(parameter)) {
      throw billingMalformedError("billing page URL credentials");
    }
  }
  url.hash = "";
  return url;
}
