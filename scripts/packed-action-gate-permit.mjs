#!/usr/bin/env node

/**
 * Packed customer-boundary regression (AUG-211).
 *
 * Imports runCustomerBoundary from the installed package and uses invented
 * refund fixtures only. A permit transport failure before dispatch stays
 * prepared, a later call reuses the same idempotency key, and the tool runs
 * once. A crash after the dispatch claim stays indeterminate.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RECEIVER = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
const RUN = "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b";
const ATTEMPT = "1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c";
const SCOPE = "d4280d922f99bccbe58c4400ad3dc6f1d12435ad070cf17150cd1eed075a1b93";
const NOW = new Date("2026-09-21T12:00:00Z");
const AUDIT = new Set([
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "actorId",
  "actor",
  "audit",
  "serverIssuedAt",
  "correlationId",
  "requestId"
]);

class FixtureFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "FixtureFailure";
  }
}

function assert(condition, message) {
  if (!condition) throw new FixtureFailure(message);
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stripCanonicalMetadata(value, hashField) {
  if (Array.isArray(value)) return value.map((child) => stripCanonicalMetadata(child));
  if (value === null || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (AUDIT.has(key)) continue;
    if (hashField !== undefined && key === hashField) continue;
    output[key] = stripCanonicalMetadata(child);
  }
  return output;
}

function signPermit(document, privateKey, keyId) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "AW-JWS", kid: keyId })).toString("base64url");
  const payload = Buffer.from(canonicalize(document)).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

async function loadBoundary() {
  const configured = process.env.AUGMENTWORKS_PACKED_BIN?.trim();
  const entry = resolve(configured && configured.length > 0 ? configured : join(projectRoot, "dist", "index.js"));
  await access(entry, fsConstants.R_OK);
  const loaded = await import(pathToFileURL(entry).href);
  assert(loaded.CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE === false, "controlled actions must stay unavailable");
  assert(typeof loaded.runCustomerBoundary === "function", "packed runCustomerBoundary export is missing");
  assert(typeof loaded.ActionIntentLedger === "function", "packed ActionIntentLedger export is missing");
  return loaded;
}

async function createContext(ActionIntentLedger, privateKey) {
  const directory = await mkdtemp(join(tmpdir(), "aw-packed-action-gate-"));
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { reason: { type: "string" } }
  };
  const schemaHash = sha256(canonicalize(schema));
  const unsignedPolicy = {
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
        argumentSchemaHash: schemaHash
      }
    ],
    maxTotalActions: 1,
    expiresAt: "2026-12-31T23:59:59Z"
  };
  const policy = {
    ...unsignedPolicy,
    policyHash: sha256(canonicalize(stripCanonicalMetadata(unsignedPolicy, "policyHash")))
  };
  const state = {
    directory,
    ledger: new ActionIntentLedger(directory),
    invocations: 0,
    permits: 0,
    keys: [],
    failOnce: false,
    invalidOnce: false,
    tamper: false,
    crashOnce: false
  };
  state.tool = async () => {
    state.invocations += 1;
    return { providerOperationRef: "fabricated-provider-op", observedState: { status: "refunded" } };
  };
  function service() {
    return {
      async issuePermit(request) {
        state.permits += 1;
        state.keys.push(request.idempotencyKey);
        if (state.failOnce) {
          state.failOnce = false;
          throw new Error("fabricated network failure before permit issuance");
        }
        if (state.invalidOnce) {
          state.invalidOnce = false;
          return { schemaVersion: "not-a-permit" };
        }
        const unsigned = {
          schemaVersion: "aw-action-permit/1",
          permitId: "1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d",
          runId: request.runId,
          attemptId: request.attemptId,
          commandId: request.commandId,
          scopeHash: SCOPE,
          policyHash: policy.policyHash,
          actionName: request.actionName,
          resourceId: state.tamper ? "order_other" : request.resourceId,
          argumentRepresentationHash: request.argumentRepresentationHash,
          argumentCommitment: request.argumentCommitment,
          amount: request.amount,
          expiresAt: "2026-09-21T12:00:15Z",
          nonce: "nonce-fabricated-not-telemetry",
          keyId: "aw-test-eddsa-1",
          residualWindowSeconds: 15
        };
        return { ...unsigned, signature: signPermit(unsigned, privateKey, unsigned.keyId) };
      },
      async acceptReceipt() {
        return { ok: true, accepted: true };
      }
    };
  }
  function input(commandId, signingKey, permitPublicKey) {
    const body = {
      mode: "hosted",
      workspaceId: WORKSPACE,
      receiverId: RECEIVER,
      scopeHash: SCOPE,
      runId: RUN,
      attemptId: ATTEMPT,
      commandId,
      policy,
      actionName: "issue_refund",
      resourceId: "order_fabricated_001",
      rawArguments: { reason: "fabricated refund" },
      amount: { currency: "USD", minorUnits: 2500 },
      commitmentKey: "receiver-local-hmac-test",
      commitmentKeyId: "receiver-local-hmac-1",
      signingKey,
      issuerKeyId: "receiver-local-eddsa-1",
      permitPublicKey,
      service: service(),
      ledger: state.ledger,
      now: NOW,
      argumentSchema: schema,
      tool: () => state.tool()
    };
    if (state.crashOnce) {
      body.onCommittedDispatch = async () => {
        state.crashOnce = false;
        throw new Error("crash");
      };
    }
    return body;
  }
  return { state, input };
}

async function main() {
  const loaded = await loadBoundary();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const receiverKeys = generateKeyPairSync("ed25519");
  const directories = [];

  async function openContext() {
    const context = await createContext(loaded.ActionIntentLedger, privateKey);
    directories.push(context.state.directory);
    return context;
  }

  try {
    const thrown = await openContext();
    thrown.state.failOnce = true;
    let transportError = null;
    try {
      await loaded.runCustomerBoundary(thrown.input("cmd_fabricated_throw", receiverKeys.privateKey, publicKey));
    } catch (error) {
      transportError = error;
    }
    assert(transportError instanceof Error, "permit transport failure did not throw");
    assert(
      transportError.message === "fabricated network failure before permit issuance",
      `unexpected permit error: ${transportError.message}`
    );
    assert(thrown.state.invocations === 0, "tool ran before a permit existed");
    assert(thrown.state.permits === 1, "permit service was not contacted");
    const stranded = await thrown.state.ledger.list();
    assert(stranded.length === 1, "expected one prepared intent");
    assert(stranded[0].state === "prepared", `intent state was ${stranded[0].state}`);
    assert(stranded[0].permit === null, "a failed permit request stored a permit");
    assert(stranded[0].toolInvocations === 0, "tool invocation was recorded before dispatch");
    const intentId = stranded[0].intentId;
    assert(thrown.state.keys[0] === intentId, "permit idempotency key was not the intent id");

    const recovered = await loaded.runCustomerBoundary(
      thrown.input("cmd_fabricated_throw", receiverKeys.privateKey, publicKey)
    );
    assert(recovered.ok === true, "permit retry did not succeed");
    assert(recovered.evidenceStatus === "verified_receipts", "recovered receipt was not verified");
    assert(recovered.intent.intentId === intentId, "retry used a different intent");
    assert(thrown.state.keys[1] === intentId, "retry used a different idempotency key");
    assert(thrown.state.invocations === 1, `tool ran ${String(thrown.state.invocations)} times after recovery`);
    assert(thrown.state.permits === 2, "recovery did not request the permit again");
    const stored = await thrown.state.ledger.read(intentId);
    assert(stored?.state === "accepted", "recovered intent was not accepted");
    assert(stored?.permit?.permitId === "1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d", "recovered intent stored no permit");
    assert(stored?.toolInvocations === 1, "recovered intent invocation count was not one");

    const invalid = await openContext();
    invalid.state.invalidOnce = true;
    let invalidError = null;
    try {
      await loaded.runCustomerBoundary(invalid.input("cmd_fabricated_invalid", receiverKeys.privateKey, publicKey));
    } catch (error) {
      invalidError = error;
    }
    assert(invalidError instanceof Error, "an invalid permit document did not throw");
    const invalidRows = await invalid.state.ledger.list();
    assert(invalidRows.length === 1 && invalidRows[0].state === "prepared", "invalid permit document claimed dispatch");
    assert(invalidRows[0].permit === null && invalidRows[0].toolInvocations === 0, "invalid document left dispatch evidence");
    const invalidRecovered = await loaded.runCustomerBoundary(
      invalid.input("cmd_fabricated_invalid", receiverKeys.privateKey, publicKey)
    );
    assert(invalidRecovered.ok === true, "retry after an invalid permit document failed");
    assert(invalid.state.invocations === 1, "invalid-document recovery invoked the tool more than once");
    assert(invalid.state.keys[0] === invalid.state.keys[1], "invalid-document retry changed the idempotency key");

    const crashed = await openContext();
    crashed.state.crashOnce = true;
    let crashError = null;
    try {
      await loaded.runCustomerBoundary(crashed.input("cmd_fabricated_crash", receiverKeys.privateKey, publicKey));
    } catch (error) {
      crashError = error;
    }
    assert(crashError instanceof Error && crashError.message === "crash", "committed-dispatch crash did not surface");
    assert(crashed.state.invocations === 0, "tool ran during the committed-dispatch crash");
    const committed = await crashed.state.ledger.list();
    assert(committed.length === 1 && committed[0].state === "dispatching", "crash did not leave a dispatch claim");
    assert(committed[0].permit !== null && committed[0].toolInvocations === 0, "crash record was not a committed dispatch");
    const restarted = await loaded.runCustomerBoundary(
      crashed.input("cmd_fabricated_crash", receiverKeys.privateKey, publicKey)
    );
    assert(restarted.ok === false && restarted.evidenceStatus === "indeterminate", "restart after dispatch was retryable");
    assert(restarted.code === "ACTION_OUTCOME_INDETERMINATE", "restart code was not indeterminate");
    assert(crashed.state.invocations === 0, "restart reran the tool");
    assert(crashed.state.permits === 1, "restart requested another permit after dispatch");

    const tampered = await openContext();
    tampered.state.tamper = true;
    const denied = await loaded.runCustomerBoundary(
      tampered.input("cmd_fabricated_tamper", receiverKeys.privateKey, publicKey)
    );
    assert(denied.outcome === "denied", "tampered permit was not denied");
    assert(denied.intent.state === "denied" && denied.intent.toolInvocations === 0, "tampered permit claimed dispatch");
    assert(tampered.state.invocations === 0, "tampered permit invoked the tool");

    const race = await openContext();
    let release = () => undefined;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    race.state.tool = async () => {
      await gate;
      race.state.invocations += 1;
      return { providerOperationRef: "fabricated-provider-op", observedState: { status: "refunded" } };
    };
    const first = loaded.runCustomerBoundary(race.input("cmd_fabricated_race", receiverKeys.privateKey, publicKey));
    const second = loaded.runCustomerBoundary(race.input("cmd_fabricated_race", receiverKeys.privateKey, publicKey));
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const results = await Promise.all([first, second]);
    assert(race.state.invocations === 1, `concurrent callers invoked the tool ${String(race.state.invocations)} times`);
    assert(results.filter((result) => result.receiptAccepted).length === 1, "concurrent callers accepted more than one receipt");
  } finally {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }

  process.stdout.write("[packed action-gate] permit retry before dispatch passed\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
