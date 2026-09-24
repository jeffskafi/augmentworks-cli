import type { KeyObject } from "node:crypto";

import { realDataError } from "../real-data/errors.js";
import { canonicalDocumentHash } from "../real-data/canonical.js";
import { sha256 } from "../util/canonical.js";
import { canonicalize } from "../util/canonical.js";
import {
  ActionPermitRequestSchema,
  ActionPermitSchema,
  ActionReceiptSchema,
  type ActionIntent,
  type ActionPermit,
  type ActionPermitRequest,
  type ActionPolicyDocument,
  type ActionReceipt
} from "./documents.js";
import { ActionIntentLedger } from "./ledger.js";
import {
  argumentCommitment,
  argumentRepresentationHash,
  commitmentsMatch,
  isPlatformKeyId,
  signDocument,
  verifyDocumentSignature
} from "./sign.js";

export interface ActionReceiptAcceptance {
  readonly ok: true;
  readonly accepted: true;
}

export interface ActionReceiptRejection {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly unknown: boolean;
}

export type ActionReceiptResult = ActionReceiptAcceptance | ActionReceiptRejection;

export interface ActionPermitService {
  issuePermit(request: ActionPermitRequest): Promise<ActionPermit>;
  acceptReceipt(receipt: ActionReceipt, raw: string): Promise<ActionReceiptResult>;
}

export interface CustomerToolResult {
  readonly providerOperationRef: string;
  readonly observedState: unknown;
}

export interface CustomerBoundaryInput {
  readonly mode: "hosted" | "local-offline";
  readonly workspaceId: string;
  readonly authorityWorkspaceId?: string;
  readonly receiverId: string;
  readonly scopeHash: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly policy: ActionPolicyDocument;
  readonly actionName: string;
  readonly resourceId: string;
  readonly rawArguments: unknown;
  readonly amount: { readonly currency: string; readonly minorUnits: number } | null;
  readonly commitmentKey: Uint8Array | string;
  readonly commitmentKeyId: string;
  readonly signingKey: KeyObject;
  readonly issuerKeyId: string;
  readonly permitPublicKey?: KeyObject | undefined;
  readonly service?: ActionPermitService | undefined;
  readonly ledger: ActionIntentLedger;
  readonly now?: Date;
  readonly revoked?: boolean;
  readonly argumentSchema?: unknown;
  readonly tool: () => Promise<CustomerToolResult>;
  readonly onCommittedDispatch?: (() => Promise<void>) | undefined;
}

export interface CustomerBoundaryResult {
  readonly ok: boolean;
  readonly evidenceStatus: "verified_receipts" | "indeterminate" | "reported";
  readonly invoked: boolean;
  readonly receiptAccepted: boolean;
  readonly outcome: "denied" | "succeeded" | "failed" | "indeterminate";
  readonly platformSignature: false;
  readonly intent: ActionIntent;
  readonly code?: string;
}

const SECRET_PATTERN =
  /(?:sk_live_|sk_test_|api[_-]?key|secret|password|bearer\s+[A-Za-z0-9._~+/-]{8,})/i;

export async function runCustomerBoundary(input: CustomerBoundaryInput): Promise<CustomerBoundaryResult> {
  const now = input.now ?? new Date();
  assertReceiverSignature(input.issuerKeyId);
  if (input.mode === "local-offline" && input.service !== undefined) {
    throw realDataError(
      "HOSTED_AUTHORITY_INTERCHANGE_FORBIDDEN",
      "Local-offline controlled actions cannot attach a hosted permit client."
    );
  }
  if (input.mode === "hosted" && input.service === undefined) {
    throw realDataError("ACTION_BOUNDARY_REQUIRED", "A hosted controlled action requires a permit client.");
  }
  if (input.mode === "hosted" && input.permitPublicKey === undefined) {
    throw realDataError("ACTION_BOUNDARY_REQUIRED", "A hosted controlled action requires the permit verification key.");
  }

  const representation = argumentRepresentationHash(input.rawArguments);
  const commitment = argumentCommitment({
    rawArguments: input.rawArguments,
    key: input.commitmentKey,
    keyId: input.commitmentKeyId
  });
  const intentId = sha256(
    canonicalize({
      runId: input.runId,
      attemptId: input.attemptId,
      commandId: input.commandId,
      actionName: input.actionName,
      resourceId: input.resourceId,
      argumentCommitment: commitment
    })
  );

  const prepared: ActionIntent = {
    schemaVersion: "aw-action-intent/1",
    intentId,
    state: "prepared",
    mode: input.mode,
    workspaceId: input.workspaceId,
    receiverId: input.receiverId,
    scopeHash: input.scopeHash,
    policyHash: input.policy.policyHash,
    runId: input.runId,
    attemptId: input.attemptId,
    commandId: input.commandId,
    actionName: input.actionName,
    resourceId: input.resourceId,
    argumentRepresentationHash: representation,
    argumentCommitment: commitment,
    amount: input.amount,
    permit: null,
    receipt: null,
    receiptBytes: null,
    toolInvocations: 0,
    platformSignature: false
  };

  const existing = await input.ledger.createPrepared(prepared);
  if (existing.state === "accepted" && existing.receipt !== null) {
    return acceptedResult(existing);
  }
  if (existing.state === "receipt_pending" && existing.receipt !== null && existing.receiptBytes !== null) {
    return deliverReceipt(input, existing);
  }
  if (existing.state === "dispatching" || existing.toolInvocations > 0) {
    return indeterminate(existing, "ACTION_OUTCOME_INDETERMINATE");
  }
  if (existing.state === "denied") {
    return denied(existing, "ACTION_NOT_ALLOWED");
  }
  if (
    existing.argumentRepresentationHash !== representation ||
    !commitmentsMatch(existing.argumentCommitment, commitment)
  ) {
    return denied(existing, "ACTION_NOT_ALLOWED");
  }

  const denial = policyDenial(input, now);
  if (denial !== null) {
    const stored = await input.ledger.transition(intentId, ["prepared"], { ...existing, state: "denied" });
    return denied(stored, denial);
  }

  const claim = await input.ledger.claimDispatch(intentId, null);
  const dispatching = claim.intent;
  if (!claim.won) {
    return indeterminate(dispatching, "ACTION_OUTCOME_INDETERMINATE");
  }

  let permit: ActionPermit;
  if (input.mode === "local-offline") {
    permit = localPermit(input, representation, commitment, now);
  } else {
    const request = ActionPermitRequestSchema.parse({
      schemaVersion: "aw-action-permit-request/1",
      runId: input.runId,
      attemptId: input.attemptId,
      commandId: input.commandId,
      actionName: input.actionName,
      resourceId: input.resourceId,
      argumentRepresentationHash: representation,
      argumentCommitment: commitment,
      amount: input.amount,
      idempotencyKey: intentId
    });
    permit = ActionPermitSchema.parse(await input.service!.issuePermit(request));
    const permitError = permitDenial(input, permit, representation, commitment, now);
    if (permitError !== null) {
      const stored = await input.ledger.transition(intentId, ["dispatching"], {
        ...dispatching,
        state: "denied",
        permit
      });
      return denied(stored, permitError);
    }
  }
  if (input.onCommittedDispatch !== undefined) {
    await input.onCommittedDispatch();
  }

  const startedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  let toolResult: CustomerToolResult;
  try {
    toolResult = await input.tool();
  } catch {
    const failed = sealReceipt(input, permit, {
      outcome: "failed",
      startedAt,
      finishedAt: startedAt,
      providerOperationRef: null,
      observedStateRepresentationHash: null
    });
    const pending = await input.ledger.transition(intentId, ["dispatching"], {
      ...dispatching,
      state: "receipt_pending",
      permit,
      receipt: failed.receipt,
      receiptBytes: failed.bytes,
      toolInvocations: 1
    });
    return indeterminate(pending, "ACTION_OUTCOME_INDETERMINATE");
  }

  const succeeded = sealReceipt(input, permit, {
    outcome: "succeeded",
    startedAt,
    finishedAt: startedAt,
    providerOperationRef: toolResult.providerOperationRef,
    observedStateRepresentationHash: argumentRepresentationHash(toolResult.observedState)
  });
  const pending = await input.ledger.transition(intentId, ["dispatching"], {
    ...dispatching,
    state: "receipt_pending",
    permit,
    receipt: succeeded.receipt,
    receiptBytes: succeeded.bytes,
    toolInvocations: 1
  });
  if (pending.receiptBytes !== succeeded.bytes || pending.toolInvocations !== 1) {
    return indeterminate(pending, "ACTION_OUTCOME_INDETERMINATE");
  }
  return deliverReceipt(input, pending);
}

export async function retryReceiptDelivery(
  input: Pick<CustomerBoundaryInput, "mode" | "service" | "ledger">,
  intent: ActionIntent
): Promise<CustomerBoundaryResult> {
  return deliverReceipt(input, intent);
}

async function deliverReceipt(
  input: Pick<CustomerBoundaryInput, "mode" | "service" | "ledger">,
  intent: ActionIntent
): Promise<CustomerBoundaryResult> {
  if (intent.receipt === null || intent.receiptBytes === null) {
    return indeterminate(intent, "ACTION_OUTCOME_INDETERMINATE");
  }
  if (intent.platformSignature !== false || isPlatformKeyId(intent.receipt.issuerKeyId)) {
    return indeterminate(intent, "ACTION_NOT_ALLOWED");
  }
  if (input.mode === "local-offline" || intent.mode === "local-offline") {
    return {
      ok: true,
      evidenceStatus: "reported",
      invoked: intent.toolInvocations === 1,
      receiptAccepted: false,
      outcome: intent.receipt.outcome === "failed" ? "failed" : "succeeded",
      platformSignature: false,
      intent
    };
  }
  let acceptance: ActionReceiptResult;
  try {
    acceptance = await input.service!.acceptReceipt(intent.receipt, intent.receiptBytes);
  } catch {
    return indeterminate(intent, "ACTION_OUTCOME_INDETERMINATE");
  }
  if (!acceptance.ok) {
    return indeterminate(intent, acceptance.unknown ? "ACTION_OUTCOME_INDETERMINATE" : acceptance.code);
  }
  const accepted = await input.ledger.transition(intent.intentId, ["receipt_pending"], {
    ...intent,
    state: "accepted"
  });
  return acceptedResult(accepted.state === "accepted" ? accepted : { ...intent, state: "accepted" });
}

function sealReceipt(
  input: CustomerBoundaryInput,
  permit: ActionPermit,
  fields: {
    readonly outcome: ActionReceipt["outcome"];
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly providerOperationRef: string | null;
    readonly observedStateRepresentationHash: string | null;
  }
): { readonly receipt: ActionReceipt; readonly bytes: string } {
  const unsigned = {
    schemaVersion: "aw-action-receipt/1" as const,
    permitId: permit.permitId,
    runId: input.runId,
    attemptId: input.attemptId,
    commandId: input.commandId,
    scopeHash: input.scopeHash,
    policyHash: input.policy.policyHash,
    receiverId: input.receiverId,
    actionName: input.actionName,
    argumentRepresentationHash: argumentRepresentationHash(input.rawArguments),
    argumentCommitment: argumentCommitment({
      rawArguments: input.rawArguments,
      key: input.commitmentKey,
      keyId: input.commitmentKeyId
    }),
    amount: input.amount,
    outcome: fields.outcome,
    startedAt: fields.startedAt,
    finishedAt: fields.finishedAt,
    providerOperationRef: fields.providerOperationRef,
    observedStateRepresentationHash: fields.observedStateRepresentationHash,
    issuerKeyId: input.issuerKeyId
  };
  const signature = signDocument(unsigned, input.signingKey, input.issuerKeyId);
  const receipt = ActionReceiptSchema.parse({ ...unsigned, signature });
  return { receipt, bytes: `${JSON.stringify(receipt)}` };
}

function localPermit(
  input: CustomerBoundaryInput,
  representation: string,
  commitment: ActionIntent["argumentCommitment"],
  now: Date
): ActionPermit {
  const expires = new Date(now.getTime() + 15_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return ActionPermitSchema.parse({
    schemaVersion: "aw-action-permit/1",
    permitId: stableUuid(sha256(canonicalize({ local: input.commandId, representation }))),
    runId: input.runId,
    attemptId: input.attemptId,
    commandId: input.commandId,
    scopeHash: input.scopeHash,
    policyHash: input.policy.policyHash,
    actionName: input.actionName,
    resourceId: input.resourceId,
    argumentRepresentationHash: representation,
    argumentCommitment: commitment,
    amount: input.amount,
    expiresAt: expires,
    nonce: `local-${sha256(input.commandId).slice(0, 16)}`,
    keyId: input.issuerKeyId,
    residualWindowSeconds: 15,
    signature: "receiver-local-no-platform-signature"
  });
}

function permitDenial(
  input: CustomerBoundaryInput,
  permit: ActionPermit,
  representation: string,
  commitment: ActionIntent["argumentCommitment"],
  now: Date
): string | null {
  if (input.permitPublicKey === undefined) return "ACTION_BOUNDARY_REQUIRED";
  const { signature, ...unsigned } = permit;
  if (!verifyDocumentSignature(unsigned, signature, input.permitPublicKey)) return "ACTION_NOT_ALLOWED";
  if (permit.runId !== input.runId || permit.attemptId !== input.attemptId || permit.commandId !== input.commandId) {
    return "ACTION_NOT_ALLOWED";
  }
  if (permit.scopeHash !== input.scopeHash || permit.policyHash !== input.policy.policyHash) return "ACTION_NOT_ALLOWED";
  if (permit.actionName !== input.actionName || permit.resourceId !== input.resourceId) return "ACTION_NOT_ALLOWED";
  if (permit.argumentRepresentationHash !== representation) return "ACTION_NOT_ALLOWED";
  if (!commitmentsMatch(permit.argumentCommitment, commitment)) return "ACTION_NOT_ALLOWED";
  if (!amountsEqual(permit.amount, input.amount)) return "ACTION_NOT_ALLOWED";
  if (Date.parse(permit.expiresAt) <= now.getTime()) return "ACTION_NOT_ALLOWED";
  if (permit.residualWindowSeconds > 15) return "ACTION_NOT_ALLOWED";
  return null;
}

function policyDenial(input: CustomerBoundaryInput, now: Date): string | null {
  if (input.revoked === true) return "TARGET_AUTHORITY_REVOKED";
  if (input.authorityWorkspaceId !== undefined && input.authorityWorkspaceId !== input.workspaceId) {
    return "ACTION_NOT_ALLOWED";
  }
  if (input.policy.receiverId !== input.receiverId) return "ACTION_NOT_ALLOWED";
  if (input.policy.policyHash !== canonicalDocumentHash(input.policy, "policyHash")) return "ACTION_BOUNDARY_REQUIRED";
  if (Date.parse(input.policy.expiresAt) <= now.getTime()) return "ACTION_NOT_ALLOWED";
  if (containsSecret(input.rawArguments)) return "DATA_POLICY_BLOCKED";
  if (input.argumentSchema !== undefined && !argumentSchemaAllowed(input)) return "ACTION_NOT_ALLOWED";
  const allowed = input.policy.allowedActions.find((action) => action.name === input.actionName);
  if (allowed === undefined) return "ACTION_NOT_ALLOWED";
  if (!allowed.resourceIds.includes(input.resourceId)) return "ACTION_NOT_ALLOWED";
  if (input.policy.maxTotalActions < 1 || allowed.maxCalls < 1) return "ACTION_NOT_ALLOWED";
  if (allowed.amountLimit === null) {
    if (input.amount !== null) return "ACTION_NOT_ALLOWED";
  } else if (
    input.amount === null ||
    input.amount.currency !== allowed.amountLimit.currency ||
    input.amount.minorUnits > allowed.amountLimit.maxMinorUnits
  ) {
    return "ACTION_NOT_ALLOWED";
  }
  return null;
}

function argumentSchemaAllowed(input: CustomerBoundaryInput): boolean {
  const schema = input.argumentSchema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return false;
  const record = schema as Record<string, unknown>;
  if ("$ref" in record || "$schema" in record) return false;
  const allowed = input.policy.allowedActions.find((action) => action.name === input.actionName);
  if (allowed === undefined) return false;
  if (sha256(canonicalize(schema)) !== allowed.argumentSchemaHash) return false;
  if (record["type"] !== "object" || record["additionalProperties"] !== false) return false;
  const properties = record["properties"];
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return false;
  if (input.rawArguments === null || typeof input.rawArguments !== "object" || Array.isArray(input.rawArguments)) {
    return false;
  }
  const args = input.rawArguments as Record<string, unknown>;
  const propertyRecord = properties as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!(key in propertyRecord)) return false;
  }
  return true;
}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return SECRET_PATTERN.test(value);
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) => SECRET_PATTERN.test(key) || containsSecret(child)
    );
  }
  return false;
}

function amountsEqual(
  left: { readonly currency: string; readonly minorUnits: number } | null,
  right: { readonly currency: string; readonly minorUnits: number } | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.currency === right.currency && left.minorUnits === right.minorUnits;
}

function assertReceiverSignature(issuerKeyId: string): void {
  if (isPlatformKeyId(issuerKeyId)) {
    throw realDataError(
      "ACTION_NOT_ALLOWED",
      "The customer wrapper cannot claim a platform signature. Receipts are receiver-local evidence."
    );
  }
}

function acceptedResult(intent: ActionIntent): CustomerBoundaryResult {
  return {
    ok: true,
    evidenceStatus: "verified_receipts",
    invoked: intent.toolInvocations === 1,
    receiptAccepted: true,
    outcome: intent.receipt?.outcome === "succeeded" ? "succeeded" : "indeterminate",
    platformSignature: false,
    intent
  };
}

function indeterminate(intent: ActionIntent, code: string): CustomerBoundaryResult {
  return {
    ok: false,
    evidenceStatus: "indeterminate",
    invoked: intent.toolInvocations === 1,
    receiptAccepted: false,
    outcome: "indeterminate",
    platformSignature: false,
    intent,
    code
  };
}

function denied(intent: ActionIntent, code: string): CustomerBoundaryResult {
  return {
    ok: false,
    evidenceStatus: "indeterminate",
    invoked: false,
    receiptAccepted: false,
    outcome: "denied",
    platformSignature: false,
    intent,
    code
  };
}

function stableUuid(digest: string): string {
  const hex = digest.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function markAccepted(ledger: ActionIntentLedger, intent: ActionIntent): Promise<ActionIntent> {
  if (intent.receipt === null) return intent;
  return ledger.transition(intent.intentId, ["receipt_pending"], { ...intent, state: "accepted" });
}
