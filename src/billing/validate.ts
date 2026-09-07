import { z } from "zod";

import { DEFAULT_API_ORIGIN } from "../auth/api-origin.js";
import { AwError } from "../errors.js";
import {
  billingMalformedError,
  billingPortalUnsupportedError,
  billingUnsupportedStateError,
  quoteUnsupportedError,
  statusUnsupportedError,
  usageUnsupportedError,
  workspaceMismatchError
} from "./errors.js";
import { isLoopbackUrl } from "../system/browser.js";
import {
  BILLING_PORTAL_LINK_V1,
  BILLING_PRICING_VERSION,
  BILLING_SCHEMA_VERSION,
  BILLING_UNIT_MAX,
  QUOTE_V1,
  STATUS_V1,
  USAGE_V1,
  capabilityIsAvailable,
  isBillingAccessState,
  isBillingEvaluationStatus,
  isBillingExecutionStatus,
  type BillingCapabilities,
  type BillingGrantBalance,
  type BillingPendingCommerce,
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
    forfeitedUnits: unitCount.optional(),
    frozenUnits: unitCount.optional()
  })
  .passthrough();

const pendingCommerceSchema = z
  .object({
    orderId: uuid,
    state: z.string().min(1).max(64),
    skuCode: z.string().min(1).max(64)
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
    releasedUnits: unitCount.optional(),
    cutoverVersion: z.string().max(64).nullable().optional(),
    pendingCommerce: pendingCommerceSchema.nullable().optional()
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
    remainingUnitsEstimate: unitCount.optional(),
    retentionPolicyVersion: z.string().min(1).max(80).optional(),
    retainUntil: utcTimestamp.optional()
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

export { isBillingExecutionStatus };

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
    ...(lot.forfeitedUnits === undefined ? {} : { forfeitedUnits: lot.forfeitedUnits }),
    ...(lot.frozenUnits === undefined ? {} : { frozenUnits: lot.frozenUnits })
  }));
  const pendingCommerce = parsePendingCommerce(parsed.data.pendingCommerce);
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
    ...(parsed.data.releasedUnits === undefined ? {} : { releasedUnits: parsed.data.releasedUnits }),
    ...(parsed.data.cutoverVersion === undefined
      ? {}
      : { cutoverVersion: parsed.data.cutoverVersion }),
    ...(pendingCommerce === undefined ? {} : { pendingCommerce })
  };
}

function parsePendingCommerce(
  value: { orderId: string; state: string; skuCode: string } | null | undefined
): BillingPendingCommerce | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return {
    orderId: value.orderId,
    state: value.state,
    skuCode: value.skuCode
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

export function assertBillingPortalCapability(capabilities: readonly string[]): void {
  if (!capabilityIsAvailable(capabilities, BILLING_PORTAL_LINK_V1)) {
    throw billingPortalUnsupportedError();
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
      : { remainingUnitsEstimate: parsed.data.remainingUnitsEstimate }),
    ...(parsed.data.retentionPolicyVersion === undefined
      ? {}
      : { retentionPolicyVersion: parsed.data.retentionPolicyVersion }),
    ...(parsed.data.retainUntil === undefined ? {} : { retainUntil: parsed.data.retainUntil })
  };
}

export function parseBillingRunStatusResponse(value: unknown): BillingRunStatus {
  const parsed = runStatusConsumerSchema.safeParse(value);
  if (!parsed.success) throw billingMalformedError("billing run status response");
  if (!isBillingEvaluationStatus(parsed.data.evaluationStatus)) {
    throw billingUnsupportedStateError({ evaluation_status: parsed.data.evaluationStatus });
  }
  // executionStatus is an unconstrained string on the main-owned billing
  // schema (unlike evaluationStatus). Known relay values are listed by
  // isBillingExecutionStatus. Unknown values still parse so observation can
  // succeed; classifyBillingRunStatus treats them as assessment unknown, never
  // as a release pass. outcome is similarly unconstrained and only "passed"
  // with terminal applicable evaluation is a pass.
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

const BILLING_PAGE_PATH = "/portal/billing";
const SENSITIVE_BILLING_QUERY =
  /^(access_token|refresh_token|id_token|token|code|session_id|checkout_session_id|checkout|customer_id|customer|client_secret|secret|password|authorization|stripe_session)$/i;

export function firstPartyBillingPageUrl(apiOrigin: URL, workspaceId: string): URL {
  const origin = isLoopbackUrl(apiOrigin) ? apiOrigin : new URL(DEFAULT_API_ORIGIN);
  const url = new URL(BILLING_PAGE_PATH, origin);
  url.search = "";
  url.hash = "";
  url.searchParams.set("workspace", workspaceId);
  return assertSafeBillingPageUrl(url.toString(), apiOrigin, workspaceId);
}

export function assertSafeBillingPageUrl(
  value: string,
  apiOrigin: URL,
  expectedWorkspaceId?: string
): URL {
  const trimmed = value.trim();
  if (trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) === false) {
    throw billingMalformedError("billing page URL scheme");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
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
  if (url.hash !== "") {
    throw billingMalformedError("billing page URL fragment");
  }
  const productionOrigin = new URL(DEFAULT_API_ORIGIN).origin;
  const trustedOrigins = new Set([productionOrigin, apiOrigin.origin]);
  if (!trustedOrigins.has(url.origin)) {
    throw billingMalformedError("billing page URL origin");
  }
  const loopback = isLoopbackUrl(url);
  if (url.origin === productionOrigin) {
    if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
      throw billingMalformedError("billing page URL scheme");
    }
  } else if (!loopback || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw billingMalformedError("billing page URL scheme");
  } else if (url.origin !== apiOrigin.origin) {
    throw billingMalformedError("billing page URL origin");
  }
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (pathname !== BILLING_PAGE_PATH) {
    throw billingMalformedError("billing page URL path");
  }
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "workspace") {
    throw billingMalformedError("billing page URL query");
  }
  const workspace = url.searchParams.get("workspace") ?? "";
  if (!UUID.test(workspace) || /[\r\n]/.test(workspace)) {
    throw billingMalformedError("billing page URL workspace");
  }
  for (const [key, parameter] of url.searchParams) {
    if (SENSITIVE_BILLING_QUERY.test(key) || /[\r\n]/.test(parameter)) {
      throw billingMalformedError("billing page URL credentials");
    }
  }
  if (expectedWorkspaceId !== undefined && workspace !== expectedWorkspaceId) {
    throw workspaceMismatchError({
      authenticated_workspace: expectedWorkspaceId,
      billing_page_workspace: workspace
    });
  }
  url.hash = "";
  url.pathname = BILLING_PAGE_PATH;
  return url;
}
