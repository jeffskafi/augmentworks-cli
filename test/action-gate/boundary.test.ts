import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readFile } from "node:fs/promises";
import { ActionIntentLedger } from "../../src/action-gate/ledger.js";
import { runCustomerBoundary, type ActionPermitService } from "../../src/action-gate/boundary.js";
import { ActionPermitSchema, ActionReceiptSchema, CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE } from "../../src/action-gate/documents.js";
import { sealDocumentHash } from "../../src/real-data/canonical.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import type { ActionPolicyDocument, ActionReceipt } from "../../src/action-gate/documents.js";

const NOW = new Date("2026-09-21T12:00:00Z");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RECEIVER = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
const RUN = "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b";
const ATTEMPT = "1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c";
const SCOPE = "d4280d922f99bccbe58c4400ad3dc6f1d12435ad070cf17150cd1eed075a1b93";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("controlled-action customer boundary", () => {
  it("invokes a fake refund once and persists the accepted receipt", async () => {
    const harness = await createHarness();
    const result = await harness.run();
    expect(result.ok).toBe(true);
    expect(result.evidenceStatus).toBe("verified_receipts");
    expect(result.receiptAccepted).toBe(true);
    expect(result.platformSignature).toBe(false);
    expect(harness.invocations).toBe(1);
    expect(harness.receipts).toHaveLength(1);
    const stored = await harness.ledger.read(result.intent.intentId);
    expect(stored?.state).toBe("accepted");
    expect(stored?.receiptBytes).toBe(harness.receipts[0]);
    const again = await harness.run();
    expect(again.receiptAccepted).toBe(true);
    expect(harness.invocations).toBe(1);
    expect(harness.permits).toBe(1);
  });

  it("keeps a rejected receipt pending and retries the same bytes", async () => {
    const harness = await createHarness();
    harness.accept = () => ({
      ok: false,
      code: "LEDGER_UNAVAILABLE",
      message: "receipt ledger rejected the receipt",
      unknown: false
    });
    const failed = await harness.run();
    expect(failed.ok).toBe(false);
    expect(failed.evidenceStatus).toBe("indeterminate");
    expect(failed.receiptAccepted).toBe(false);
    expect(failed.invoked).toBe(true);
    expect(harness.invocations).toBe(1);
    const firstBytes = harness.receipts[0];
    harness.accept = () => ({ ok: true, accepted: true });
    const retried = await harness.run();
    expect(retried.receiptAccepted).toBe(true);
    expect(retried.evidenceStatus).toBe("verified_receipts");
    expect(harness.invocations).toBe(1);
    expect(harness.permits).toBe(1);
    expect(harness.receipts[1]).toBe(firstBytes);
  });

  it("treats a lost acknowledgement as pending and converges on duplicate delivery", async () => {
    const harness = await createHarness();
    let seen = false;
    harness.accept = () => {
      if (!seen) {
        seen = true;
        throw new Error("socket closed");
      }
      return { ok: true, accepted: true };
    };
    const lost = await harness.run();
    expect(lost.evidenceStatus).toBe("indeterminate");
    expect(lost.receiptAccepted).toBe(false);
    const stored = await harness.ledger.read(lost.intent.intentId);
    expect(stored?.state).toBe("receipt_pending");
    const recovered = await harness.run();
    expect(recovered.receiptAccepted).toBe(true);
    expect(harness.invocations).toBe(1);
    expect(harness.receipts[0]).toBe(harness.receipts[1]);
  });

  it("does not rerun the tool after a crash before send or a process restart", async () => {
    const harness = await createHarness();
    harness.onCommittedDispatch = async () => {
      throw new Error("crash");
    };
    await expect(harness.run()).rejects.toThrow("crash");
    expect(harness.invocations).toBe(0);
    const committed = await harness.ledger.list();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.state).toBe("dispatching");
    expect(committed[0]?.permit).not.toBeNull();
    expect(committed[0]?.toolInvocations).toBe(0);
    delete harness.onCommittedDispatch;
    const restarted = await runCustomerBoundary({ ...harness.input(), ledger: new ActionIntentLedger(harness.directory) });
    expect(restarted.evidenceStatus).toBe("indeterminate");
    expect(restarted.code).toBe("ACTION_OUTCOME_INDETERMINATE");
    expect(restarted.invoked).toBe(false);
    expect(harness.invocations).toBe(0);
    expect(harness.permits).toBe(1);
  });

  it("retries permit issuance when the hosted request fails before dispatch", async () => {
    const harness = await createHarness();
    harness.failPermitOnce = true;
    await expect(harness.run()).rejects.toThrow("fabricated network failure before permit issuance");
    expect(harness.invocations).toBe(0);
    expect(harness.permits).toBe(1);
    const stranded = await harness.ledger.list();
    expect(stranded).toHaveLength(1);
    const intent = stranded[0];
    expect(intent?.state).toBe("prepared");
    expect(intent?.permit).toBeNull();
    expect(intent?.toolInvocations).toBe(0);
    const intentId = intent?.intentId ?? "";
    expect(harness.permitKeys).toEqual([intentId]);

    const recovered = await harness.run();
    expect(recovered.ok).toBe(true);
    expect(recovered.evidenceStatus).toBe("verified_receipts");
    expect(recovered.intent.intentId).toBe(intentId);
    expect(harness.permitKeys).toEqual([intentId, intentId]);
    expect(harness.invocations).toBe(1);
    expect(harness.permits).toBe(2);
    const stored = await harness.ledger.read(intentId);
    expect(stored?.state).toBe("accepted");
    expect(stored?.permit?.permitId).toBe("1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d");
    expect(stored?.toolInvocations).toBe(1);

    const replay = await harness.run();
    expect(replay.receiptAccepted).toBe(true);
    expect(harness.invocations).toBe(1);
    expect(harness.permits).toBe(2);
  });

  it("retries when the permit response is not a permit document", async () => {
    const harness = await createHarness();
    harness.invalidPermitOnce = true;
    await expect(harness.run()).rejects.toThrow();
    expect(harness.invocations).toBe(0);
    const stranded = await harness.ledger.list();
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.state).toBe("prepared");
    expect(stranded[0]?.permit).toBeNull();
    expect(stranded[0]?.toolInvocations).toBe(0);

    const recovered = await harness.run();
    expect(recovered.ok).toBe(true);
    expect(harness.invocations).toBe(1);
    expect(harness.permits).toBe(2);
    expect(recovered.intent.intentId).toBe(stranded[0]?.intentId);
    expect(harness.permitKeys[0]).toBe(recovered.intent.intentId);
    expect(harness.permitKeys[1]).toBe(recovered.intent.intentId);
  });

  it("stays local-offline without a hosted call or a platform signature", async () => {
    const harness = await createHarness();
    const result = await runCustomerBoundary({
      ...harness.input(),
      mode: "local-offline",
      service: undefined,
      permitPublicKey: undefined
    });
    expect(result.ok).toBe(true);
    expect(result.evidenceStatus).toBe("reported");
    expect(result.platformSignature).toBe(false);
    expect(result.receiptAccepted).toBe(false);
    expect(harness.permits).toBe(0);
    expect(harness.receipts).toHaveLength(0);
    expect(harness.invocations).toBe(1);
    expect(result.intent.receipt?.issuerKeyId.startsWith("aw-")).toBe(false);
  });

  it("fails closed for policy, permit, secret, and revocation faults", async () => {
    const harness = await createHarness();
    const wrongResource = await harness.run({ resourceId: "order_other" });
    expect(wrongResource.outcome).toBe("denied");
    expect(harness.invocations).toBe(0);

    const amount = await harness.run({
      commandId: "cmd_amount",
      amount: { currency: "USD", minorUnits: 9_000 }
    });
    expect(amount.outcome).toBe("denied");

    const currency = await harness.run({
      commandId: "cmd_currency",
      amount: { currency: "EUR", minorUnits: 100 }
    });
    expect(currency.outcome).toBe("denied");

    const secret = await harness.run({
      commandId: "cmd_secret",
      rawArguments: { reason: "sk_live_fabricated" }
    });
    expect(secret.code).toBe("DATA_POLICY_BLOCKED");

    harness.tamper = true;
    const tampered = await harness.run({ commandId: "cmd_tamper" });
    expect(tampered.outcome).toBe("denied");
    expect(tampered.intent.state).toBe("denied");
    expect(tampered.intent.toolInvocations).toBe(0);
    expect(tampered.intent.permit).not.toBeNull();
    const permitsAfterTamper = harness.permits;
    const tamperedAgain = await harness.run({ commandId: "cmd_tamper" });
    expect(tamperedAgain.outcome).toBe("denied");
    expect(harness.permits).toBe(permitsAfterTamper);
    expect(harness.invocations).toBe(0);
    harness.tamper = false;

    harness.expire = true;
    const expired = await harness.run({ commandId: "cmd_expired" });
    expect(expired.outcome).toBe("denied");
    harness.expire = false;

    const workspace = await harness.run({
      commandId: "cmd_workspace",
      authorityWorkspaceId: "22222222-2222-4222-8222-222222222222"
    });
    expect(workspace.outcome).toBe("denied");
    const receiver = await harness.run({
      commandId: "cmd_receiver",
      receiverId: "33333333-3333-4333-8333-333333333333"
    });
    expect(receiver.outcome).toBe("denied");

    const revoked = await harness.run({ commandId: "cmd_revoked", revoked: true });
    expect(revoked.code).toBe("TARGET_AUTHORITY_REVOKED");
    expect(harness.invocations).toBe(0);
  });

  it("allows only one tool invocation when two callers race", async () => {
    const harness = await createHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    harness.tool = async () => {
      entered += 1;
      await gate;
      harness.invocations += 1;
      return { providerOperationRef: "fabricated-provider-op", observedState: { status: "refunded" } };
    };
    const first = harness.run({ commandId: "cmd_race" });
    const second = harness.run({ commandId: "cmd_race" });
    // The loser returns while the winner is still inside the tool. A fixed
    // delay is not enough on a slow runner: the second caller can arrive
    // after the first has already accepted, which is a replay, not a race.
    const early = await Promise.race([
      first.then((result) => ({ pending: second, result })),
      second.then((result) => ({ pending: first, result }))
    ]);
    const deadline = Date.now() + 5_000;
    while (entered !== 1) {
      if (Date.now() > deadline) {
        throw new Error("the winning caller did not stay inside the tool while the other returned");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(early.result.receiptAccepted).toBe(false);
    expect(early.result.evidenceStatus).toBe("indeterminate");
    release();
    const winner = await early.pending;
    expect(entered).toBe(1);
    expect(harness.invocations).toBe(1);
    expect(winner.receiptAccepted).toBe(true);
  });

  it("parses the frozen permit and receipt fixtures", async () => {
    const raw = JSON.parse(await readFile(new URL("../../contracts/aw-real-data-1.fixtures.json", import.meta.url), "utf8")) as {
      fixtures: { action_permit: { document: unknown }; action_receipt: { document: unknown } };
    };
    expect(ActionPermitSchema.parse(raw.fixtures.action_permit.document).schemaVersion).toBe("aw-action-permit/1");
    expect(ActionReceiptSchema.parse(raw.fixtures.action_receipt.document).outcome).toBe("succeeded");
    expect(CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE).toBe(false);
  });
});

interface Harness {
  readonly directory: string;
  readonly ledger: ActionIntentLedger;
  invocations: number;
  permits: number;
  permitKeys: string[];
  receipts: string[];
  tamper: boolean;
  expire: boolean;
  failPermitOnce: boolean;
  invalidPermitOnce: boolean;
  accept: () => { ok: true; accepted: true } | { ok: false; code: string; message: string; unknown: boolean };
  onCommittedDispatch?: () => Promise<void>;
  tool: () => Promise<{ providerOperationRef: string; observedState: unknown }>;
  input: () => Parameters<typeof runCustomerBoundary>[0];
  run: (overrides?: Partial<Parameters<typeof runCustomerBoundary>[0]>) => ReturnType<typeof runCustomerBoundary>;
}

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "aw-action-gate-"));
  directories.push(directory);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const receiverKeys = generateKeyPairSync("ed25519");
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { reason: { type: "string" } }
  };
  const policy = sealDocumentHash(
    {
      schemaVersion: "aw-action-policy/1",
      policyId: "19191919-1919-4191-8191-191919191919",
      revision: 1,
      policyHash: "0".repeat(64),
      receiverId: RECEIVER,
      allowedActions: [
        {
          name: "issue_refund",
          resourceIds: ["order_fabricated_001"],
          maxCalls: 1,
          amountLimit: { currency: "USD", maxMinorUnits: 5000 },
          argumentSchemaHash: sha256(canonicalize(schema))
        }
      ],
      maxTotalActions: 1,
      expiresAt: "2026-12-31T23:59:59Z"
    },
    "policyHash"
  ) as ActionPolicyDocument;
  const harness: Harness = {
    directory,
    ledger: new ActionIntentLedger(directory),
    invocations: 0,
    permits: 0,
    permitKeys: [],
    receipts: [],
    tamper: false,
    expire: false,
    failPermitOnce: false,
    invalidPermitOnce: false,
    accept: () => ({ ok: true, accepted: true }),
    tool: async () => {
      harness.invocations += 1;
      return { providerOperationRef: "fabricated-provider-op", observedState: { status: "refunded" } };
    },
    input() {
      const service: ActionPermitService = {
        async issuePermit(request) {
          harness.permits += 1;
          harness.permitKeys.push(request.idempotencyKey);
          if (harness.failPermitOnce) {
            harness.failPermitOnce = false;
            throw new Error("fabricated network failure before permit issuance");
          }
          if (harness.invalidPermitOnce) {
            harness.invalidPermitOnce = false;
            return { schemaVersion: "not-a-permit" } as unknown as Awaited<ReturnType<ActionPermitService["issuePermit"]>>;
          }
          const unsigned = {
            schemaVersion: "aw-action-permit/1" as const,
            permitId: "1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d",
            runId: request.runId,
            attemptId: request.attemptId,
            commandId: request.commandId,
            scopeHash: SCOPE,
            policyHash: policy.policyHash,
            actionName: request.actionName,
            resourceId: harness.tamper ? "order_other" : request.resourceId,
            argumentRepresentationHash: request.argumentRepresentationHash,
            argumentCommitment: request.argumentCommitment,
            amount: request.amount,
            expiresAt: harness.expire ? "2026-09-21T11:00:00Z" : "2026-09-21T12:00:15Z",
            nonce: "nonce-fabricated-not-telemetry",
            keyId: "aw-test-eddsa-1",
            residualWindowSeconds: 15 as const
          };
          return ActionPermitSchema.parse({
            ...unsigned,
            signature: signPermit(unsigned, privateKey, unsigned.keyId)
          });
        },
        async acceptReceipt(receipt: ActionReceipt, raw: string) {
          harness.receipts.push(raw);
          expect(JSON.parse(raw)).toEqual(receipt);
          return harness.accept();
        }
      };
      return {
        mode: "hosted" as const,
        workspaceId: WORKSPACE,
        receiverId: RECEIVER,
        scopeHash: SCOPE,
        runId: RUN,
        attemptId: ATTEMPT,
        commandId: "cmd_fabricated_1",
        policy,
        actionName: "issue_refund",
        resourceId: "order_fabricated_001",
        rawArguments: { reason: "fabricated refund" },
        amount: { currency: "USD", minorUnits: 2500 },
        commitmentKey: "receiver-local-hmac-test",
        commitmentKeyId: "receiver-local-hmac-1",
        signingKey: receiverKeys.privateKey,
        issuerKeyId: "receiver-local-eddsa-1",
        permitPublicKey: publicKey,
        service,
        ledger: harness.ledger,
        now: NOW,
        argumentSchema: schema,
        tool: () => harness.tool(),
        ...(harness.onCommittedDispatch === undefined ? {} : { onCommittedDispatch: harness.onCommittedDispatch })
      };
    },
    run(overrides = {}) {
      return runCustomerBoundary({ ...this.input(), ...overrides });
    }
  };
  return harness;
}

function signPermit(document: Record<string, unknown>, privateKey: KeyObject, keyId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "AW-JWS", kid: keyId })).toString("base64url");
  const payload = Buffer.from(canonicalize(document)).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}
