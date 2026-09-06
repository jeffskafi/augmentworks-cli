import { z } from "zod";

import { DEFAULT_API_ORIGIN } from "../auth/api-origin.js";
import { AwError } from "../errors.js";
import {
  billingMalformedError,
  billingUnsupportedStateError,
  usageUnsupportedError,
  workspaceMismatchError
} from "./errors.js";
import {
  BILLING_SCHEMA_VERSION,
  BILLING_UNIT_MAX,
  USAGE_V1,
  capabilityIsAvailable,
  isBillingAccessState,
  type BillingCapabilities,
  type BillingGrantBalance,
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
