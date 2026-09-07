#!/usr/bin/env node

/**
 * Packed-binary HTTP fixture for Stage 4B.
 *
 * Exercises the installed CLI over loopback HTTP for auth refresh, capabilities,
 * usage, quote, quoted create recovery, one synthetic target send, status, wait,
 * and billing navigation.
 *
 * This is not proof of atomic PostgreSQL/RLS credit accounting. The live
 * disposable-database gate is scripts/packed-billing-live.mjs.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePackReport } from "./npm-pack-report.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const QUOTE_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "sess_packed_fixture_1";
const PACKET_SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "packed-billing-fixture-token";
const FRESH_TOKEN = "packed-billing-fixture-token-refreshed";
const REFRESH_TOKEN = "packed-billing-fixture-refresh-token";
const TARGET_KEY = "fixture-placeholder";
const EXECUTION_UNITS = 30;
const COMMAND_ID = "cmd-send-1";
const ATTEMPT_ID = "attempt-packed-1";
const TURN_ID = "turn-packed-1";

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

function resolveNpmJsCli(binName) {
  const fileName = `${binName}-cli.js`;
  const fromLifecycle =
    typeof process.env.npm_execpath === "string" && process.env.npm_execpath.length > 0
      ? process.env.npm_execpath
      : undefined;
  const candidates = [];
  if (fromLifecycle !== undefined) {
    if (binName === "npm") candidates.push(fromLifecycle);
    candidates.push(join(dirname(fromLifecycle), fileName));
  }
  const prefix = dirname(process.execPath);
  candidates.push(
    join(prefix, "node_modules", "npm", "bin", fileName),
    join(prefix, "..", "lib", "node_modules", "npm", "bin", fileName)
  );
  return candidates.find((path) => existsSync(path));
}

function runJsCli(binName, args, options = {}) {
  const cli = resolveNpmJsCli(binName);
  const executable = cli === undefined ? (process.platform === "win32" ? `${binName}.cmd` : binName) : process.execPath;
  const argv = cli === undefined ? args : [cli, ...args];
  return spawnSync(executable, argv, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    ...(cli === undefined && process.platform === "win32" ? { shell: true } : {})
  });
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response, status, body) {
  if (response.writableEnded || response.destroyed) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store"
  });
  response.end(payload);
}

async function loadFixtures() {
  return JSON.parse(await readFile(join(projectRoot, "contracts", "aw-billing-v1.fixtures.json"), "utf8"));
}

async function ensurePackedBin(temporaryRoot) {
  const provided = process.env.AUGMENTWORKS_PACKED_BIN?.trim();
  if (provided) {
    await access(provided, fsConstants.R_OK);
    return { packedBin: provided, tarballDigest: process.env.AUGMENTWORKS_TARBALL_SHA256 ?? null };
  }

  process.stdout.write("[packed billing fixture] packing tarball because AUGMENTWORKS_PACKED_BIN is unset\n");
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "install");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const built = runJsCli("npm", ["run", "build"]);
  if (built.status !== 0) {
    throw new FixtureFailure(`npm run build failed\n${built.stderr}`);
  }
  const packed = runJsCli("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory]);
  if (packed.status !== 0) {
    throw new FixtureFailure(`npm pack failed\n${packed.stderr}`);
  }
  const report = parsePackReport(packed.stdout);
  const tarballPath = join(packDirectory, report.filename);
  const digest = sha256(await readFile(tarballPath));
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "augmentworks-cli-packed-billing-fixture", private: true, version: "0.0.0" }, null, 2) + "\n",
    "utf8"
  );
  const installed = runJsCli(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
    { cwd: consumerDirectory }
  );
  if (installed.status !== 0) {
    throw new FixtureFailure(`npm install tarball failed\n${installed.stderr}`);
  }
  return {
    packedBin: join(consumerDirectory, "node_modules", "@augmentworks", "cli", "dist", "index.js"),
    tarballDigest: digest
  };
}

function createFixtureServer(fixtures) {
  const counts = {
    me: 0,
    capabilities: 0,
    usage: 0,
    quote: 0,
    create: 0,
    createAccepted: 0,
    createRejected: 0,
    createDropped: 0,
    relayStatus: 0,
    billingStatus: 0,
    retryEvaluation: 0,
    target: 0,
    poll: 0,
    pollHeld: 0,
    complete: 0,
    token: 0,
    unauthorized: 0,
    other: 0
  };
  /** @type {string[]} */
  const requests = [];
  let exhausted = false;
  let holdPoll = false;
  let dropNextCreate = false;
  let evaluationComplete = false;
  let sendCompleted = false;
  let requireFresh = false;
  let usageUnavailable = false;
  let omitQuoteCapability = false;
  let lastUnitsRace = false;
  let pendingCommerce = false;
  let pendingFulfilled = false;
  /** @type {Set<() => void>} */
  const pollWaiters = new Set();
  /** @type {Map<string, { sha256: string, body: unknown }>} */
  const creates = new Map();
  /** @type {{ packet?: { key?: string, version?: string }, config_sha256?: string }} */
  let lastCreate = {};
  let lastQuoteId = QUOTE_ID;

  const usageBase = structuredClone(fixtures.fixtures.partially_consumed_trial.response);
  const exhaustedBase = structuredClone(fixtures.fixtures.exhausted_allowance.response);
  const pendingBase = structuredClone(fixtures.fixtures.pending_pack_purchase.response);
  const insufficient = fixtures.fixtures.error_insufficient_credits;
  const unavailable = fixtures.fixtures.error_service_unavailable;

  function capabilitiesList() {
    return omitQuoteCapability
      ? ["usage_v1", "status_v1", "billing_portal_link_v1"]
      : ["usage_v1", "quote_v1", "status_v1", "billing_portal_link_v1"];
  }

  function usagePayload() {
    if (pendingCommerce && !pendingFulfilled) {
      return {
        ...pendingBase,
        asOf: new Date().toISOString(),
        availableUnits: exhausted ? 0 : usageBase.availableUnits,
        reservedUnits: exhausted ? 0 : usageBase.reservedUnits,
        consumedUnits: exhausted ? exhaustedBase.consumedUnits : usageBase.consumedUnits,
        ledgerRevision: usageBase.ledgerRevision,
        grantBalances: exhausted ? exhaustedBase.grantBalances : usageBase.grantBalances,
        billingPageUrl: `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`,
        capabilities: capabilitiesList()
      };
    }
    const source = exhausted ? exhaustedBase : usageBase;
    const extra = pendingFulfilled ? 300 : 0;
    return {
      ...source,
      asOf: new Date().toISOString(),
      availableUnits: (exhausted ? 0 : source.availableUnits) + extra,
      billingPageUrl: `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`,
      capabilities: capabilitiesList()
    };
  }

  function quotePayload() {
    const available = lastUnitsRace ? 5 : exhausted ? 0 : usageBase.availableUnits;
    return {
      schemaVersion: "aw-billing/1",
      quoteId: lastQuoteId,
      workspaceId: WORKSPACE,
      assessmentPlanHash: PACKET_SHA256,
      pricingVersion: "aw-pricing/execution-unit/1",
      executionUnits: EXECUTION_UNITS,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      availableUnitsAtQuote: available,
      estimateOnly: true,
      scenarioCount: 10,
      repetitions: 3,
      remainingUnitsEstimate: lastUnitsRace || exhausted ? 0 : Math.max(0, available - EXECUTION_UNITS),
      retentionPolicyVersion: "aw-retention/pack-90d-v1",
      retainUntil: "2026-12-05T17:00:00.000Z"
    };
  }

  function packetBinding(request) {
    return {
      key: request.packet?.key ?? lastCreate.packet?.key ?? "response-quality",
      version: request.packet?.version ?? lastCreate.packet?.version ?? "0.1.0",
      sha256: PACKET_SHA256
    };
  }

  function createResponse(request, requestSha256, origin, disposition) {
    return {
      protocol_version: "aw-relay/0.3",
      create_request_id: request.create_request_id,
      create_request_sha256: requestSha256,
      create_disposition: disposition,
      run_id: RUN_ID,
      session_id: SESSION_ID,
      packet: packetBinding(request),
      config_sha256: request.config_sha256,
      fencing_epoch: 1,
      status: "running",
      dashboard_url: `${origin}/portal/runs/${RUN_ID}`,
      run_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      credit_state: sendCompleted ? "consumed" : "reserved",
      poll_after_ms: 0
    };
  }

  function sendCommand(origin) {
    const issuedAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const packet = packetBinding(lastCreate);
    return {
      protocol_version: "aw-relay/0.2",
      command_id: COMMAND_ID,
      session_id: SESSION_ID,
      run_id: RUN_ID,
      attempt_id: ATTEMPT_ID,
      packet,
      config_sha256: lastCreate.config_sha256,
      sequence: 1,
      fencing_epoch: 1,
      idempotency_key: "idempotency-send-packed-1",
      issued_at: issuedAt,
      expires_at: expiresAt,
      kind: "send",
      input: {
        protocol_version: "aw-target/0.1",
        turn_id: TURN_ID,
        idempotency_key: "idempotency-send-packed-1",
        message: {
          role: "user",
          content: "What is the return window for unused items in the synthetic catalog?"
        },
        metadata: {}
      }
    };
  }

  function relayStatus(origin) {
    if (!sendCompleted) {
      return {
        protocol_version: "aw-relay/0.2",
        run_id: RUN_ID,
        status: "running",
        dashboard_url: `${origin}/portal/runs/${RUN_ID}`,
        credit_state: "reserved",
        outcome: null,
        evaluation_status: "pending"
      };
    }
    return {
      protocol_version: "aw-relay/0.2",
      run_id: RUN_ID,
      status: "completed",
      dashboard_url: `${origin}/portal/runs/${RUN_ID}`,
      credit_state: "consumed",
      outcome: evaluationComplete ? "failed" : null,
      evaluation_status: evaluationComplete ? "complete" : "pending"
    };
  }

  function billingStatus(origin) {
    const fixture = structuredClone(fixtures.fixtures.status_pending_grading.response);
    return {
      ...fixture,
      runId: RUN_ID,
      originalRunId: RUN_ID,
      workspaceId: WORKSPACE,
      executionStatus: sendCompleted ? "completed" : "running",
      evaluationStatus: evaluationComplete ? "complete" : "pending",
      outcome: evaluationComplete ? "failed" : null,
      dashboardUrl: `${origin}/portal/runs/${RUN_ID}`,
      asOf: new Date().toISOString(),
      credit: {
        reservedUnits: sendCompleted ? 0 : EXECUTION_UNITS,
        consumedUnits: sendCompleted ? EXECUTION_UNITS : 0,
        releasedUnits: 0,
        compensatedUnits: 0
      },
      nextActions: evaluationComplete ? ["inspect", "open_dashboard"] : ["wait", "inspect", "open_dashboard"]
    };
  }

  function waitForPollRelease(request) {
    return new Promise((resolveWait) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        request.off("close", finish);
        pollWaiters.delete(finish);
        resolveWait();
      };
      request.on("close", finish);
      pollWaiters.add(finish);
    });
  }

  function releasePollHold() {
    holdPoll = false;
    for (const waiter of pollWaiters) waiter();
    pollWaiters.clear();
  }

  const server = createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url ?? "/", origin);
      const path = url.pathname.replace(/\/+$/u, "") || "/";
      requests.push(`${request.method ?? "GET"} ${path}`);
      const authorization = request.headers.authorization ?? "";
      const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";

      if (request.method === "POST" && path === "/api/v1/cli/auth/token") {
        counts.token += 1;
        const raw = await readBody(request);
        const params = new URLSearchParams(raw.toString("utf8"));
        if (params.get("grant_type") !== "refresh_token" || params.get("refresh_token") !== REFRESH_TOKEN) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        json(response, 200, {
          access_token: FRESH_TOKEN,
          token_type: "Bearer",
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
          scope: "connector:identity connector:run",
          workspace_id: WORKSPACE,
          connector_id: "conn_packed_fixture"
        });
        return;
      }

      if (path === "/chat") {
        counts.target += 1;
        if (request.method !== "POST" || bearer !== TARGET_KEY) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        await readBody(request);
        json(response, 200, {
          answer: "Unused items in the synthetic catalog can be returned within 30 days.",
          finished: true
        });
        return;
      }

      if (path.includes("prepare") || path.includes("observe") || path.includes("cleanup")) {
        counts.target += 1;
        json(response, 500, { error: "target must not be contacted for prepare/observe/cleanup in this fixture" });
        return;
      }

      if (request.method === "GET" && path === "/api/v1/cli/auth/me") {
        if (bearer !== TOKEN && bearer !== FRESH_TOKEN) {
          counts.unauthorized += 1;
          json(response, 401, {
            schemaVersion: "aw-billing/1",
            error: { code: "unauthenticated", message: "Missing or invalid connector credential.", retryable: false }
          });
          return;
        }
        counts.me += 1;
        json(response, 200, {
          subject: "user_packed_fixture",
          workspace_id: WORKSPACE,
          workspace_name: "Packed fixture workspace",
          connector_id: "conn_packed_fixture",
          scopes: ["connector:identity", "connector:run"]
        });
        return;
      }

      const isPoll = request.method === "POST" && path === `/v1/relay/sessions/${SESSION_ID}/commands:poll`;
      if (isPoll && bearer === TOKEN && !requireFresh) {
        requireFresh = true;
        counts.unauthorized += 1;
        json(response, 401, {
          schemaVersion: "aw-billing/1",
          error: { code: "unauthenticated", message: "Access token expired.", retryable: false }
        });
        return;
      }
      if (bearer !== TOKEN && bearer !== FRESH_TOKEN) {
        counts.unauthorized += 1;
        json(response, 401, {
          schemaVersion: "aw-billing/1",
          error: { code: "unauthenticated", message: "Missing or invalid connector credential.", retryable: false }
        });
        return;
      }

      if (request.method === "GET" && (path === "/v1/billing/capabilities" || path === "/api/v1/billing/capabilities")) {
        counts.capabilities += 1;
        json(response, 200, {
          schemaVersion: "aw-billing/1",
          asOf: new Date().toISOString(),
          workspaceId: WORKSPACE,
          capabilities: capabilitiesList()
        });
        return;
      }

      if (request.method === "GET" && (path === "/v1/billing/usage" || path === "/api/v1/billing/usage")) {
        counts.usage += 1;
        if (usageUnavailable) {
          json(response, unavailable.status, unavailable.response);
          return;
        }
        json(response, 200, usagePayload());
        return;
      }

      if (request.method === "POST" && (path === "/v1/billing/quote" || path === "/api/v1/billing/quote")) {
        counts.quote += 1;
        const raw = await readBody(request);
        let planHash = PACKET_SHA256;
        try {
          const parsed = JSON.parse(raw.toString("utf8"));
          const fromAssessment = parsed?.assessment?.plan_hash;
          if (typeof fromAssessment === "string" && /^[a-f0-9]{64}$/u.test(fromAssessment)) {
            planHash = fromAssessment;
          }
        } catch {
          // Keep the fixture hash when the body is not the documented quote shape.
        }
        json(response, 200, { ...quotePayload(), assessmentPlanHash: planHash });
        return;
      }

      if (request.method === "GET" && (path === "/v1/billing/status" || path === "/api/v1/billing/status")) {
        counts.billingStatus += 1;
        json(response, 200, billingStatus(origin));
        return;
      }

      if (request.method === "POST" && path.endsWith(":retry-evaluation")) {
        counts.retryEvaluation += 1;
        json(response, 404, { error: { code: "not_found", message: "retry not used in this fixture" } });
        return;
      }

      if (request.method === "POST" && path === `/v1/relay/commands/${COMMAND_ID}:complete`) {
        counts.complete += 1;
        await readBody(request);
        sendCompleted = true;
        json(response, 200, {
          protocol_version: "aw-relay/0.2",
          command_id: COMMAND_ID,
          accepted: true
        });
        return;
      }

      if (request.method === "POST" && path === `/v1/relay/sessions/${SESSION_ID}/commands:poll`) {
        counts.poll += 1;
        await readBody(request);
        if (holdPoll) {
          counts.pollHeld += 1;
          await waitForPollRelease(request);
          if (request.destroyed || response.writableEnded) return;
        }
        if (sendCompleted) {
          json(response, 200, {
            protocol_version: "aw-relay/0.2",
            run_id: RUN_ID,
            session_id: SESSION_ID,
            status: "completed",
            command: null,
            retry_after_ms: 0
          });
          return;
        }
        json(response, 200, {
          protocol_version: "aw-relay/0.2",
          run_id: RUN_ID,
          session_id: SESSION_ID,
          status: "running",
          command: sendCommand(origin),
          retry_after_ms: 0
        });
        return;
      }

      if (request.method === "GET" && path.startsWith("/v1/relay/runs/")) {
        counts.relayStatus += 1;
        json(response, 200, relayStatus(origin));
        return;
      }

      if (request.method === "POST" && path === "/v1/relay/runs") {
        counts.create += 1;
        const raw = await readBody(request);
        const parsed = JSON.parse(raw.toString("utf8"));
        const requestSha256 = sha256(canonicalize(parsed));
        if (dropNextCreate) {
          dropNextCreate = false;
          counts.createDropped += 1;
          response.destroy();
          return;
        }
        if (exhausted || lastUnitsRace) {
          counts.createRejected += 1;
          json(response, insufficient.status, insufficient.response);
          return;
        }
        const existing = creates.get(parsed.create_request_id);
        const disposition = existing === undefined ? "created" : "replayed";
        if (existing === undefined) {
          creates.set(parsed.create_request_id, { sha256: requestSha256, body: parsed });
          counts.createAccepted += 1;
          usageBase.availableUnits = 160;
          usageBase.consumedUnits = 40;
          usageBase.reservedUnits = 0;
          usageBase.ledgerRevision = 6;
        }
        lastCreate = parsed;
        json(response, 200, createResponse(parsed, requestSha256, origin, disposition));
        return;
      }

      counts.other += 1;
      json(response, 404, { error: { code: "not_found", message: `unhandled ${request.method} ${path}` } });
    } catch (error) {
      json(response, 500, {
        error: { code: "fixture_crash", message: error instanceof Error ? error.message : String(error) }
      });
    }
  });

  return {
    server,
    counts,
    requests,
    exhaust() {
      exhausted = true;
    },
    holdNextPoll() {
      holdPoll = true;
    },
    releasePoll() {
      releasePollHold();
    },
    dropNextCreate() {
      dropNextCreate = true;
    },
    completeEvaluation() {
      evaluationComplete = true;
    },
    failUsage() {
      usageUnavailable = true;
    },
    omitQuoteCapability() {
      omitQuoteCapability = true;
    },
    enableLastUnitsRace() {
      lastUnitsRace = true;
    },
    enablePendingCommerce() {
      pendingCommerce = true;
      pendingFulfilled = false;
    },
    fulfillPendingCommerce() {
      pendingFulfilled = true;
      pendingCommerce = false;
    }
  };
}

function spawnEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const isolated = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    isolated[key] = value;
  }
  return isolated;
}

function startPacked(packedBin, args, env, cwd) {
  const child = spawn(process.execPath, [packedBin, ...args], {
    cwd,
    env: spawnEnv(env),
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolveClose, reject) => {
    child.once("error", (error) => {
      reject(new FixtureFailure(`Could not run packed CLI ${args.join(" ")}: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      resolveClose({ status, stdout, stderr, signal });
    });
  });
  return {
    child,
    closed,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }
  };
}

/**
 * Run the packed CLI without spawnSync. spawnSync blocks this process's event
 * loop, so the in-process fixture HTTP server cannot accept the child's requests.
 */
function runPacked(packedBin, args, env, cwd, expectStatus, fixture) {
  return new Promise((resolve, reject) => {
    const started = startPacked(packedBin, args, env, cwd);
    const timeout = setTimeout(() => {
      started.kill();
    }, 120_000);
    timeout.unref();
    started.closed.then(
      (result) => {
        clearTimeout(timeout);
        if (result.status !== expectStatus) {
          reject(
            new FixtureFailure(
              [
                `packed CLI ${args.join(" ")} exited ${String(result.status)}${result.signal ? ` signal=${result.signal}` : ""}, expected ${String(expectStatus)}`,
                result.stdout.trim(),
                result.stderr.trim(),
                fixture === undefined ? "" : `fixture counts=${JSON.stringify(fixture.counts)}`,
                fixture === undefined ? "" : `fixture requests=${fixture.requests.join(" | ")}`
              ]
                .filter(Boolean)
                .join("\n")
            )
          );
          return;
        }
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function waitUntil(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new FixtureFailure(`${label} timed out`);
}

function parseJsonStdout(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new FixtureFailure(
      `${label} stdout was not JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}`
    );
  }
}

function assertNoSecrets(text, label) {
  assert(!text.includes(TOKEN), `${label} leaked the fixture token`);
  assert(!text.includes(FRESH_TOKEN), `${label} leaked the refreshed fixture token`);
  assert(!text.includes(REFRESH_TOKEN), `${label} leaked the refresh token`);
  assert(!/sk_live|sk_test|whsec_|rk_live/u.test(text), `${label} looks like a Stripe secret`);
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aw-packed-billing-"));
  const fixtures = await loadFixtures();
  let fixture;
  try {
    const { packedBin, tarballDigest } = await ensurePackedBin(temporaryRoot);
    await access(packedBin, fsConstants.R_OK);

    fixture = createFixtureServer(fixtures);
    await new Promise((resolveListen) => fixture.server.listen(0, "127.0.0.1", resolveListen));
    const port = fixture.server.address().port;
    const origin = `http://127.0.0.1:${port}/`;
    const chatbotOrigin = `http://127.0.0.1:${port}`;
    const consumerDir = join(temporaryRoot, "empty-project");
    const isolatedHome = join(temporaryRoot, "home");
    await mkdir(consumerDir, { recursive: true });
    await mkdir(isolatedHome, { recursive: true });

    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
      APPDATA: join(isolatedHome, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      XDG_STATE_HOME: join(isolatedHome, ".local", "state"),
      AUGMENTWORKS_STATE_DIR: join(isolatedHome, "aw-state"),
      AUGMENTWORKS_API_URL: origin,
      AUGMENTWORKS_TOKEN: TOKEN,
      AUGMENTWORKS_REFRESH_TOKEN: REFRESH_TOKEN,
      AUGMENTWORKS_LIVE_TOKEN: "",
      AW_BILLING_LIVE_TOKEN: "",
      CHATBOT_BASE_URL: chatbotOrigin,
      CHATBOT_API_KEY: TARGET_KEY,
      CI: "1",
      NO_COLOR: "1",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      ALL_PROXY: "",
      all_proxy: "",
      NO_PROXY: "*",
      no_proxy: "*"
    };

    const probe = await fetch(new URL("/api/v1/cli/auth/me", origin), {
      headers: { authorization: `Bearer ${TOKEN}` },
      redirect: "error"
    });
    if (!probe.ok) {
      throw new FixtureFailure(`fixture auth probe failed: ${String(probe.status)} ${await probe.text()}`);
    }

    process.stdout.write("[packed billing fixture] empty-directory init and offline doctor\n");
    await runPacked(packedBin, ["init"], env, consumerDir, 0, fixture);
    await Promise.all([
      access(join(consumerDir, "augmentworks.yaml"), fsConstants.R_OK),
      access(join(consumerDir, "augmentworks.assessment.yaml"), fsConstants.R_OK),
      access(join(consumerDir, "references", "faq.md"), fsConstants.R_OK),
      access(join(consumerDir, ".env.example"), fsConstants.R_OK),
      access(join(consumerDir, ".env"), fsConstants.R_OK)
    ]);
    const generatedEnv = await readFile(join(consumerDir, ".env"), "utf8");
    assert(/^CHATBOT_API_KEY=\s*$/m.test(generatedEnv), "packed init must leave CHATBOT_API_KEY empty");
    const assessment = await readFile(join(consumerDir, "augmentworks.assessment.yaml"), "utf8");
    assert(assessment.includes("response-quality"), "default packed init must generate the response-quality starter");

    const doctor = await runPacked(packedBin, ["doctor", "--offline", "--json"], env, consumerDir, 0, fixture);
    const doctorJson = parseJsonStdout(doctor.stdout, "doctor");
    assert(doctorJson.ok === true, "packed doctor did not pass");
    const doctorCodes = (doctorJson.diagnostics ?? []).map((item) => item.code);
    assert(doctorCodes.includes("ASSESSMENT_WIRE_BOUNDS"), "packed doctor skipped assessment wire bounds");
    assert(doctorCodes.includes("ASSESSMENT_CAPABILITY_MATCH"), "packed doctor skipped capability match");
    assert(doctorCodes.includes("OFFLINE_CHECK_COMPLETE"), "packed doctor skipped offline marker");

    const overwrite = await runPacked(packedBin, ["init"], env, consumerDir, 2, fixture);
    assert(overwrite.stderr.includes("INIT_FILE_EXISTS") || overwrite.stdout.includes("INIT_FILE_EXISTS"), "second init must refuse overwrite");

    process.stdout.write("[packed billing fixture] usage, estimate, ceiling, recover, target, wait, billing\n");
    const usageBefore = parseJsonStdout(
      (await runPacked(packedBin, ["usage", "--json"], env, consumerDir, 0, fixture)).stdout,
      "usage"
    );
    assert(usageBefore.availableUnits === 190, `usage availableUnits ${String(usageBefore.availableUnits)} !== 190`);
    assert(usageBefore.reservedUnits === 0, "usage reservedUnits should be 0 in the 190 fixture");
    assert(usageBefore.consumedUnits === 10, "usage consumedUnits should be 10 in the 190 fixture");
    const quotesBeforeEstimate = fixture.counts.quote;
    const createsBeforeEstimate = fixture.counts.create;

    const estimate = parseJsonStdout(
      (
        await runPacked(
          packedBin,
          ["test", "--assessment", "./augmentworks.assessment.yaml", "--estimate", "--json"],
          env,
          consumerDir,
          0,
          fixture
        )
      ).stdout,
      "estimate"
    );
    assert(estimate.executionUnits === EXECUTION_UNITS, "estimate did not use server executionUnits");
    assert(estimate.estimateOnly === true, "estimate must be estimateOnly");
    assert(fixture.counts.quote === quotesBeforeEstimate + 1, "estimate must create exactly one quote");
    assert(fixture.counts.create === createsBeforeEstimate, "estimate must not create a run");
    assert(fixture.counts.target === 0, "estimate contacted a target");

    const lowCeiling = parseJsonStdout(
      (
        await runPacked(
          packedBin,
          [
            "test",
            "--assessment",
            "./augmentworks.assessment.yaml",
            "--max-credits",
            "0",
            "--yes",
            "--json"
          ],
          env,
          consumerDir,
          13,
          fixture
        )
      ).stdout,
      "low ceiling"
    );
    assert(lowCeiling.code === "BUDGET_EXCEEDED", `low ceiling code ${String(lowCeiling.code)}`);
    assert(fixture.counts.create === createsBeforeEstimate, "rejected ceiling created a run");
    assert(fixture.counts.target === 0, "rejected ceiling contacted a target");

    const hostedArgs = [
      "test",
      "--assessment",
      "./augmentworks.assessment.yaml",
      "--max-credits",
      "30",
      "--yes",
      "--json"
    ];
    fixture.dropNextCreate();
    fixture.holdNextPoll();
    const interrupted = startPacked(packedBin, hostedArgs, env, consumerDir);
    await waitUntil(() => fixture.counts.pollHeld >= 1, 20_000, "create+poll hold after dropped create");
    assert(fixture.counts.createDropped >= 1, "packed create was not dropped once before replay");
    assert(fixture.counts.createAccepted === 1, "dropped create did not replay into one accepted admission");
    interrupted.kill();
    await interrupted.closed;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    fixture.releasePoll();

    const admitted = parseJsonStdout(
      (await runPacked(packedBin, hostedArgs, env, consumerDir, 11, fixture)).stdout,
      "admit"
    );
    assert(admitted.run_id === RUN_ID, "admitted run id mismatch");
    assert(admitted.status === "completed", "admitted run was not completed after target execution");
    assert(admitted.evaluation_status === "pending", "admitted run must leave grading pending for run wait");
    assert(fixture.counts.createAccepted === 1, `expected one accepted create, got ${String(fixture.counts.createAccepted)}`);
    assert(fixture.counts.target >= 1, "admission did not execute the synthetic /chat target");
    assert(fixture.counts.complete >= 1, "admission did not complete the relay send command");
    assert(fixture.counts.token >= 1, "packed journey did not refresh the connector token");

    const usageAfter = parseJsonStdout(
      (await runPacked(packedBin, ["usage", "--json"], env, consumerDir, 0, fixture)).stdout,
      "usage after"
    );
    assert(usageAfter.availableUnits === 160, `post-admit availableUnits ${String(usageAfter.availableUnits)}`);

    const pendingStatus = parseJsonStdout(
      (await runPacked(packedBin, ["run", "status", RUN_ID, "--json"], env, consumerDir, 11, fixture)).stdout,
      "run status pending"
    );
    assert(pendingStatus.runId === RUN_ID, "run status runId mismatch");
    assert(pendingStatus.evaluationStatus === "pending", "run status evaluation was not pending");

    const timedOutWait = parseJsonStdout(
      (
        await runPacked(
          packedBin,
          ["run", "wait", RUN_ID, "--json", "--timeout-ms", "200"],
          env,
          consumerDir,
          11,
          fixture
        )
      ).stdout,
      "run wait timeout"
    );
    assert(timedOutWait.code === "EVALUATION_INCOMPLETE", `wait timeout code ${String(timedOutWait.code)}`);
    assert(timedOutWait.ok === false, "timed-out wait must be a structured failure");

    fixture.completeEvaluation();
    const wait = parseJsonStdout(
      (
        await runPacked(
          packedBin,
          ["run", "wait", RUN_ID, "--json", "--timeout-ms", "5000"],
          env,
          consumerDir,
          10,
          fixture
        )
      ).stdout,
      "run wait"
    );
    assert(wait.originalRunId === RUN_ID, "run wait did not keep the original run");
    assert(wait.evaluationStatus === "complete", "run wait evaluation was not complete");
    assert(wait.outcome === "failed", "fixture should return a valid FAIL after grading");
    assert(fixture.counts.retryEvaluation === 0, "status/wait retried evaluation");

    fixture.enableLastUnitsRace();
    const lastUnits = parseJsonStdout(
      (await runPacked(packedBin, hostedArgs, env, consumerDir, 13, fixture)).stdout,
      "last units"
    );
    assert(lastUnits.code === "INSUFFICIENT_CREDITS", `last-units code ${String(lastUnits.code)}`);
    assert(fixture.counts.createAccepted === 1, "last-units race created another run");

    fixture.exhaust();
    const exhaustedUsage = parseJsonStdout(
      (await runPacked(packedBin, ["usage", "--json"], env, consumerDir, 0, fixture)).stdout,
      "exhausted usage"
    );
    assert(exhaustedUsage.availableUnits === 0, "exhausted usage must show 0 available");

    const insufficient = parseJsonStdout(
      (await runPacked(packedBin, hostedArgs, env, consumerDir, 13, fixture)).stdout,
      "insufficient"
    );
    assert(insufficient.code === "INSUFFICIENT_CREDITS", `insufficient code ${String(insufficient.code)}`);
    assert(fixture.counts.createAccepted === 1, "insufficient credits created another run");
    const billingUrl = String(insufficient.details?.billing_page_url ?? "");
    assert(billingUrl.includes("/portal/billing?workspace="), "insufficient credits must point at the billing page");
    assert(!/[?&](access_token|refresh_token|token|checkout)=/u.test(billingUrl), "billing URL contained a secret query");

    const printed = await runPacked(packedBin, ["billing", "--print"], env, consumerDir, 0, fixture);
    const printedUrl = printed.stdout.trim();
    assert(
      printedUrl === `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`,
      `billing --print was ${printedUrl}`
    );
    assertNoSecrets(`${printed.stdout}\n${printed.stderr}\n${insufficient.stdout}`, "packed billing outputs");

    fixture.enablePendingCommerce();
    const pendingUsage = parseJsonStdout(
      (await runPacked(packedBin, ["usage", "--json"], env, consumerDir, 0, fixture)).stdout,
      "pending commerce usage"
    );
    assert(pendingUsage.availableUnits === 0, "pending pack must not become spendable credit");
    assert(pendingUsage.pendingCommerce?.state === "paid_unfulfilled", "pendingCommerce.state missing");
    fixture.fulfillPendingCommerce();
    const fulfilledUsage = parseJsonStdout(
      (await runPacked(packedBin, ["usage", "--json"], env, consumerDir, 0, fixture)).stdout,
      "fulfilled pack usage"
    );
    assert(fulfilledUsage.availableUnits === 300, `fulfilled pack availableUnits ${String(fulfilledUsage.availableUnits)}`);
    assert(fulfilledUsage.pendingCommerce == null, "fulfilled usage still has pendingCommerce");

    fixture.failUsage();
    const usage503 = parseJsonStdout(
      (await runPacked(packedBin, ["usage", "--json"], env, consumerDir, 13, fixture)).stdout,
      "usage unavailable"
    );
    assert(usage503.code === "BILLING_UNAVAILABLE", `usage 503 code ${String(usage503.code)}`);

    fixture.omitQuoteCapability();
    const updateRequired = parseJsonStdout(
      (
        await runPacked(
          packedBin,
          [
            "test",
            "--assessment",
            "./augmentworks.assessment.yaml",
            "--max-credits",
            "31",
            "--yes",
            "--json"
          ],
          env,
          consumerDir,
          13,
          fixture
        )
      ).stdout,
      "update required"
    );
    assert(updateRequired.code === "UPDATE_REQUIRED", `old-server code ${String(updateRequired.code)}`);
    assert(fixture.counts.createAccepted === 1, "UPDATE_REQUIRED created another run");

    const transcript = JSON.stringify(fixture.counts);
    assert(!transcript.includes(TOKEN) && !transcript.includes(FRESH_TOKEN), "fixture counters leaked a token");

    process.stdout.write(
      `[packed billing fixture] passed creates=${String(fixture.counts.createAccepted)} quotes=${String(fixture.counts.quote)} targets=${String(fixture.counts.target)} polls=${String(fixture.counts.poll)} refreshes=${String(fixture.counts.token)}${tarballDigest ? ` tarball_sha256=${tarballDigest}` : ""}\n`
    );
  } finally {
    if (fixture !== undefined) {
      fixture.releasePoll();
      await new Promise((resolveClose) => fixture.server.close(resolveClose));
    }
    if (process.env.AUGMENTWORKS_KEEP_SMOKE_TMP === "1") {
      process.stdout.write(`[packed billing fixture] retained ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[packed billing fixture] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
