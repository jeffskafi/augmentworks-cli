#!/usr/bin/env node

/**
 * Packed-binary HTTP fixture for Stage 4B.
 *
 * Exercises the installed CLI over loopback HTTP for auth, capabilities,
 * usage, quote, quoted create, status, and billing navigation.
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
const BILLING_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const QUOTE_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "sess_packed_fixture_1";
const PACKET_SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "packed-billing-fixture-token";
const EXECUTION_UNITS = 30;

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
    relayStatus: 0,
    billingStatus: 0,
    retryEvaluation: 0,
    target: 0,
    unauthorized: 0,
    other: 0
  };
  /** @type {string[]} */
  const requests = [];
  let exhausted = false;
  /** @type {Map<string, { sha256: string, body: unknown }>} */
  const creates = new Map();
  let lastQuoteId = QUOTE_ID;

  const usageBase = structuredClone(fixtures.fixtures.partially_consumed_trial.response);
  const exhaustedBase = structuredClone(fixtures.fixtures.exhausted_allowance.response);
  const insufficient = fixtures.fixtures.error_insufficient_credits;

  function usagePayload() {
    const source = exhausted ? exhaustedBase : usageBase;
    return {
      ...source,
      asOf: new Date().toISOString(),
      billingPageUrl: `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`
    };
  }

  function quotePayload() {
    return {
      schemaVersion: "aw-billing/1",
      quoteId: lastQuoteId,
      workspaceId: WORKSPACE,
      assessmentPlanHash: PACKET_SHA256,
      pricingVersion: "aw-pricing/execution-unit/1",
      executionUnits: EXECUTION_UNITS,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      availableUnitsAtQuote: exhausted ? 0 : 190,
      estimateOnly: true,
      scenarioCount: 10,
      repetitions: 3,
      remainingUnitsEstimate: exhausted ? 0 : 160,
      retentionPolicyVersion: "aw-retention/pack-90d-v1",
      retainUntil: "2026-12-05T17:00:00.000Z"
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
      packet: {
        key: request.packet?.key ?? "response-quality",
        version: request.packet?.version ?? "0.1.0",
        sha256: PACKET_SHA256
      },
      config_sha256: request.config_sha256,
      fencing_epoch: 1,
      status: "completed",
      dashboard_url: `${origin}/portal/runs/${RUN_ID}`,
      run_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      credit_state: "consumed",
      poll_after_ms: 0
    };
  }

  function relayStatus(origin) {
    return {
      protocol_version: "aw-relay/0.2",
      run_id: RUN_ID,
      status: "completed",
      dashboard_url: `${origin}/portal/runs/${RUN_ID}`,
      credit_state: "consumed",
      outcome: "failed",
      evaluation_status: "complete"
    };
  }

  function billingStatus(origin) {
    const fixture = structuredClone(fixtures.fixtures.status_pending_grading.response);
    return {
      ...fixture,
      runId: RUN_ID,
      originalRunId: RUN_ID,
      workspaceId: WORKSPACE,
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: "failed",
      dashboardUrl: `${origin}/portal/runs/${RUN_ID}`,
      asOf: new Date().toISOString(),
      credit: {
        reservedUnits: 0,
        consumedUnits: EXECUTION_UNITS,
        releasedUnits: 0,
        compensatedUnits: 0
      },
      nextActions: ["inspect", "open_dashboard"]
    };
  }

  const server = createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url ?? "/", origin);
      const path = url.pathname.replace(/\/+$/u, "") || "/";
      requests.push(`${request.method ?? "GET"} ${path}`);
      const authorization = request.headers.authorization ?? "";
      if (!authorization.startsWith("Bearer ") || authorization.slice(7) !== TOKEN) {
        counts.unauthorized += 1;
        json(response, 401, {
          schemaVersion: "aw-billing/1",
          error: { code: "unauthenticated", message: "Missing or invalid connector credential.", retryable: false }
        });
        return;
      }

      if (path === "/chat" || path.includes("prepare") || path.includes("observe") || path.includes("cleanup")) {
        counts.target += 1;
        json(response, 500, { error: "target must not be contacted by this fixture" });
        return;
      }

      if (request.method === "GET" && path === "/api/v1/cli/auth/me") {
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

      if (request.method === "GET" && (path === "/v1/billing/capabilities" || path === "/api/v1/billing/capabilities")) {
        counts.capabilities += 1;
        json(response, 200, {
          schemaVersion: "aw-billing/1",
          asOf: new Date().toISOString(),
          workspaceId: WORKSPACE,
          capabilities: ["usage_v1", "quote_v1", "status_v1", "billing_portal_link_v1"]
        });
        return;
      }

      if (request.method === "GET" && (path === "/v1/billing/usage" || path === "/api/v1/billing/usage")) {
        counts.usage += 1;
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
        if (exhausted) {
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

/**
 * Run the packed CLI without spawnSync. spawnSync blocks this process's event
 * loop, so the in-process fixture HTTP server cannot accept the child's requests.
 */
function runPacked(packedBin, args, env, cwd, expectStatus, fixture) {
  return new Promise((resolve, reject) => {
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
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 120_000);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new FixtureFailure(`Could not run packed CLI ${args.join(" ")}: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      if (status !== expectStatus) {
        reject(
          new FixtureFailure(
            [
              `packed CLI ${args.join(" ")} exited ${String(status)}${signal ? ` signal=${signal}` : ""}, expected ${String(expectStatus)}`,
              stdout.trim(),
              stderr.trim(),
              fixture === undefined ? "" : `fixture counts=${JSON.stringify(fixture.counts)}`,
              fixture === undefined ? "" : `fixture requests=${fixture.requests.join(" | ")}`
            ]
              .filter(Boolean)
              .join("\n")
          )
        );
        return;
      }
      resolve({ status, stdout, stderr, signal });
    });
  });
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
      AUGMENTWORKS_LIVE_TOKEN: "",
      AW_BILLING_LIVE_TOKEN: "",
      CHATBOT_BASE_URL: "http://127.0.0.1:1",
      CHATBOT_API_KEY: "fixture-placeholder",
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

    process.stdout.write("[packed billing fixture] usage, estimate, ceiling, admit, status, billing\n");
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

    const admitted = parseJsonStdout(
      (
        await runPacked(
          packedBin,
          [
            "test",
            "--assessment",
            "./augmentworks.assessment.yaml",
            "--max-credits",
            "30",
            "--yes",
            "--json"
          ],
          env,
          consumerDir,
          10,
          fixture
        )
      ).stdout,
      "admit"
    );
    assert(admitted.run_id === RUN_ID, "admitted run id mismatch");
    assert(admitted.status === "completed", "admitted run was not completed");
    assert(admitted.outcome === "failed", "fixture should return a valid FAIL");
    assert(fixture.counts.createAccepted === 1, `expected one accepted create, got ${String(fixture.counts.createAccepted)}`);
    assert(fixture.counts.target === 0, "admission contacted a target");

    const usageAfter = parseJsonStdout(
      (await runPacked(packedBin, ["usage", "--json"], env, consumerDir, 0, fixture)).stdout,
      "usage after"
    );
    assert(usageAfter.availableUnits === 160, `post-admit availableUnits ${String(usageAfter.availableUnits)}`);

    const status = parseJsonStdout(
      (await runPacked(packedBin, ["run", "status", RUN_ID, "--json"], env, consumerDir, 10, fixture)).stdout,
      "run status"
    );
    assert(status.runId === RUN_ID, "run status runId mismatch");
    assert(status.evaluationStatus === "complete", "run status evaluation was not complete");
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
    assert(fixture.counts.retryEvaluation === 0, "status/wait retried evaluation");
    assert(fixture.counts.target === 0, "status/wait contacted a target");

    fixture.exhaust();
    const exhaustedUsage = parseJsonStdout(
      (await runPacked(packedBin, ["usage", "--json"], env, consumerDir, 0, fixture)).stdout,
      "exhausted usage"
    );
    assert(exhaustedUsage.availableUnits === 0, "exhausted usage must show 0 available");

    const insufficient = parseJsonStdout(
      (
        await runPacked(
          packedBin,
          [
            "test",
            "--assessment",
            "./augmentworks.assessment.yaml",
            "--max-credits",
            "30",
            "--yes",
            "--json"
          ],
          env,
          consumerDir,
          13,
          fixture
        )
      ).stdout,
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
    assert(!printed.stdout.includes(TOKEN) && !printed.stderr.includes(TOKEN), "billing printed a token");
    assertNoSecrets(`${printed.stdout}\n${printed.stderr}\n${insufficient.stdout}`, "packed billing outputs");

    const transcript = JSON.stringify(fixture.counts);
    assert(!transcript.includes(TOKEN), "fixture counters leaked the token");

    process.stdout.write(
      `[packed billing fixture] passed creates=${String(fixture.counts.createAccepted)} quotes=${String(fixture.counts.quote)} targets=${String(fixture.counts.target)}${tarballDigest ? ` tarball_sha256=${tarballDigest}` : ""}\n`
    );
  } finally {
    if (fixture !== undefined) {
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
