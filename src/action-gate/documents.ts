import { z } from "zod";

import {
  ActionPolicySchema,
  Sha256Schema,
  UtcZSchema,
  UuidSchema
} from "../real-data/documents.js";

export const ACTION_PERMIT_SCHEMA_VERSION = "aw-action-permit/1" as const;
export const ACTION_PERMIT_REQUEST_SCHEMA_VERSION = "aw-action-permit-request/1" as const;
export const ACTION_RECEIPT_SCHEMA_VERSION = "aw-action-receipt/1" as const;
export const ACTION_INTENT_SCHEMA_VERSION = "aw-action-intent/1" as const;
export const ACTION_PERMITS_PATH = "/v1/action-permits" as const;
export const ACTION_RECEIPTS_PATH = "/v1/action-receipts" as const;

/** Public controlled-action capability stays off until AUG-199. */
export const CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE = false as const;

export const ActionArgumentCommitmentSchema = z
  .object({
    algorithm: z.literal("hmac-sha256"),
    value: Sha256Schema,
    keyId: z.string().min(1).max(120)
  })
  .strict();

export const ActionAmountSchema = z
  .object({
    currency: z.string().min(3).max(8),
    minorUnits: z.number().int().min(0)
  })
  .strict();

export const ActionPermitRequestSchema = z
  .object({
    schemaVersion: z.literal(ACTION_PERMIT_REQUEST_SCHEMA_VERSION),
    runId: UuidSchema,
    attemptId: UuidSchema,
    commandId: z.string().min(1).max(200),
    actionName: z.string().min(1).max(120),
    resourceId: z.string().min(1).max(200),
    argumentRepresentationHash: Sha256Schema,
    argumentCommitment: ActionArgumentCommitmentSchema,
    amount: ActionAmountSchema.nullable(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict();

export const ActionPermitSchema = z
  .object({
    schemaVersion: z.literal(ACTION_PERMIT_SCHEMA_VERSION),
    permitId: UuidSchema,
    runId: UuidSchema,
    attemptId: UuidSchema,
    commandId: z.string().min(1).max(200),
    scopeHash: Sha256Schema,
    policyHash: Sha256Schema,
    actionName: z.string().min(1).max(120),
    resourceId: z.string().min(1).max(200),
    argumentRepresentationHash: Sha256Schema,
    argumentCommitment: ActionArgumentCommitmentSchema,
    amount: ActionAmountSchema.nullable(),
    expiresAt: UtcZSchema,
    nonce: z.string().min(1).max(200),
    keyId: z.string().min(1).max(120),
    residualWindowSeconds: z.number().int().min(1).max(15),
    signature: z.string().min(1).max(8_192)
  })
  .strict();

export const ActionReceiptSchema = z
  .object({
    schemaVersion: z.literal(ACTION_RECEIPT_SCHEMA_VERSION),
    permitId: UuidSchema,
    runId: UuidSchema,
    attemptId: UuidSchema,
    commandId: z.string().min(1).max(200),
    scopeHash: Sha256Schema,
    policyHash: Sha256Schema,
    receiverId: UuidSchema,
    actionName: z.string().min(1).max(120),
    argumentRepresentationHash: Sha256Schema,
    argumentCommitment: ActionArgumentCommitmentSchema,
    amount: ActionAmountSchema.nullable(),
    outcome: z.enum(["denied", "succeeded", "failed", "indeterminate"]),
    startedAt: UtcZSchema,
    finishedAt: UtcZSchema.nullable(),
    providerOperationRef: z.string().min(1).max(300).nullable(),
    observedStateRepresentationHash: Sha256Schema.nullable(),
    issuerKeyId: z.string().min(1).max(120),
    signature: z.string().min(1).max(8_192)
  })
  .strict();

export const INTENT_STATES = [
  "prepared",
  "dispatching",
  "receipt_pending",
  "accepted",
  "denied"
] as const;

export const ActionIntentSchema = z
  .object({
    schemaVersion: z.literal(ACTION_INTENT_SCHEMA_VERSION),
    intentId: Sha256Schema,
    state: z.enum(INTENT_STATES),
    mode: z.enum(["hosted", "local-offline"]),
    workspaceId: UuidSchema,
    receiverId: UuidSchema,
    scopeHash: Sha256Schema,
    policyHash: Sha256Schema,
    runId: UuidSchema,
    attemptId: UuidSchema,
    commandId: z.string().min(1).max(200),
    actionName: z.string().min(1).max(120),
    resourceId: z.string().min(1).max(200),
    argumentRepresentationHash: Sha256Schema,
    argumentCommitment: ActionArgumentCommitmentSchema,
    amount: ActionAmountSchema.nullable(),
    permit: ActionPermitSchema.nullable(),
    receipt: ActionReceiptSchema.nullable(),
    receiptBytes: z.string().min(1).max(100_000).nullable(),
    toolInvocations: z.union([z.literal(0), z.literal(1)]),
    platformSignature: z.literal(false)
  })
  .strict();

export type ActionPolicyDocument = z.infer<typeof ActionPolicySchema>;
export type ActionPermitRequest = z.infer<typeof ActionPermitRequestSchema>;
export type ActionPermit = z.infer<typeof ActionPermitSchema>;
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;
export type ActionIntent = z.infer<typeof ActionIntentSchema>;
export type IntentState = (typeof INTENT_STATES)[number];

export { ActionPolicySchema };
