#!/usr/bin/env node

/**
 * Packed-binary HTTP fixture for AUG-54 report export and API-key mode,
 * extended by AUG-64 to serve producer-shaped criterion index/detail bodies.
 *
 * Invokes the installed CLI in an isolated HOME/state directory against a
 * loopback report API. This is not proof that the hosted report endpoint is
 * deployed; it proves the packed binary's command registration, JSON-only
 * stdout, API-key mode without a keychain, and read-only GET export against
 * the actual producer criterion wire (items/nextCursor/document/inspection).
 */

import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = "aw_api_packed_report_fixture_key_value";
const CANONICAL_ORIGIN = "https://augmentworks.ai";

class FixtureFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "FixtureFailure";
  }
}

function assert(condition, message) {
  if (!condition) throw new FixtureFailure(message);
}

function rewriteOrigin(value, origin) {
  if (typeof value === "string") return value.split(CANONICAL_ORIGIN).join(origin);
  if (Array.isArray(value)) return value.map((item) => rewriteOrigin(item, origin));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteOrigin(child, origin)])
    );
  }
  return value;
}

async function loadFixtures() {
  return JSON.parse(
    await readFile(resolve(projectRoot, "contracts/aw-run-report-v1.fixtures.json"), "utf8")
  );
}

async function loadProducerFixtures() {
  return JSON.parse(
    await readFile(
      resolve(projectRoot, "contracts/aw-criterion-detail-read-v1.producer.fixtures.json"),
      "utf8"
    )
  );
}

function fixtureNamed(fixtures, name, origin) {
  const entry = fixtures.fixtures[name];
  if (entry === undefined) throw new FixtureFailure(`missing fixture ${name}`);
  return {
    status: entry.status,
    body: rewriteOrigin(entry.response, origin)
  };
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function startFixtureServer(fixtures, producer) {
  const requests = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    requests.push(`${request.method ?? "GET"} ${url.pathname}`);
    if (request.method !== "GET") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "report fixture is GET-only" } });
      return;
    }
    if (url.pathname === "/api/v1/cli/auth/me") {
      send(response, 200, fixtures.identities.machine_report_only);
      return;
    }
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    if (url.pathname === `/v1/relay/runs/${runId}/report`) {
      const fixture = fixtureNamed(fixtures, "report_required_fail", origin);
      send(response, fixture.status, fixture.body);
      return;
    }
    if (/\/criteria\/[^/]+$/u.test(url.pathname)) {
      const fixture = fixtureNamed(producer, "producer_detail_fail", origin);
      send(response, fixture.status, fixture.body);
      return;
    }
    if (url.pathname.includes("/criteria")) {
      const fixture = fixtureNamed(producer, "producer_index_one_page_fail", origin);
      send(response, fixture.status, fixture.body);
      return;
    }
    send(response, 404, { error: { code: "NOT_FOUND", message: "missing packed report fixture route" } });
  });
  return { httpServer, requests };
}

function startPacked(packedBin, args, env, cwd) {
  const child = spawn(process.execPath, [packedBin, ...args], {
    cwd,
    env,
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

function runPacked(packedBin, args, env, cwd, expectStatus, requests) {
  return new Promise((resolveRun, reject) => {
    const started = startPacked(packedBin, args, env, cwd);
    const timeout = setTimeout(() => {
      started.kill();
    }, 60_000);
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
                requests === undefined ? "" : `requests=${requests.join(" | ")}`
              ]
                .filter(Boolean)
                .join("\n")
            )
          );
          return;
        }
        resolveRun(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
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

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aw-packed-report-"));
    const fixtures = await loadFixtures();
    const producer = await loadProducerFixtures();
  let httpServer;
  try {
    const packedBin = process.env.AUGMENTWORKS_PACKED_BIN;
    assert(
      typeof packedBin === "string" && packedBin.length > 0 && existsSync(packedBin),
      "AUGMENTWORKS_PACKED_BIN must point at the installed dist/index.js"
    );
    await access(packedBin, fsConstants.R_OK);

    const fixture = startFixtureServer(fixtures, producer);
    httpServer = fixture.httpServer;
    await new Promise((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
    const port = httpServer.address().port;
    const origin = `http://127.0.0.1:${port}/`;
    const isolatedHome = join(temporaryRoot, "home");
    const isolatedState = join(temporaryRoot, "state");
    const cwd = join(temporaryRoot, "cwd");
    await Promise.all([
      mkdir(isolatedHome, { recursive: true }),
      mkdir(isolatedState, { recursive: true }),
      mkdir(cwd, { recursive: true })
    ]);

    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
      APPDATA: join(isolatedHome, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      XDG_STATE_HOME: join(isolatedState, "xdg"),
      AUGMENTWORKS_STATE_DIR: isolatedState,
      DBUS_SESSION_BUS_ADDRESS: "",
      AUGMENTWORKS_API_URL: origin,
      AUGMENTWORKS_API_KEY: API_KEY,
      AUGMENTWORKS_TOKEN: "",
      AUGMENTWORKS_REFRESH_TOKEN: "",
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

    const help = await runPacked(packedBin, ["run", "report", "--help"], env, cwd, 0);
    assert(help.stdout.includes("--json"), "packed run report help omitted --json");
    assert(help.stdout.includes("aw-run-report-export/1") || help.stdout.includes("report"), "packed run report help omitted report export");

    const conflict = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      { ...env, AUGMENTWORKS_TOKEN: "aw_connector_conflicting_token_value" },
      cwd,
      3
    );
    const conflictPayload = parseJsonStdout(conflict.stdout, "env conflict");
    assert(conflictPayload.schemaVersion === "aw-run-report-export/1", "conflict export schema is wrong");
    assert(conflictPayload.retrieved === false, "env conflict retrieved true");
    assert(conflictPayload.complete === false, "env conflict complete true");
    assert(conflictPayload.error?.code === "AUTH_ENV_CONFLICT", `conflict code was ${String(conflictPayload.error?.code)}`);
    assert(!conflict.stdout.includes(API_KEY), "API key leaked into conflict stdout");
    assert(
      fixture.requests.every((item) => !item.startsWith("POST ")),
      "env conflict issued a mutating request"
    );

    const failed = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      10
    );
    const payload = parseJsonStdout(failed.stdout, "failed report");
    assert(payload.schemaVersion === "aw-run-report-export/1", "failed export schema is wrong");
    assert(payload.retrieved === true, "failed report was not retrieved");
    assert(payload.complete === true, "failed report was incomplete");
    assert(payload.report?.outcome === "failed", "negative-control outcome was not failed");
    assert(payload.criteria?.[0]?.verdict === "fail", "producer criterion verdict was not fail");
    assert(
      payload.criteria?.[0]?.evidence?.availability === "available",
      "producer criterion evidence was not retained"
    );
    assert(payload.criteria?.[0]?.evidence?.text?.includes("365 days"), "producer fail evidence text was dropped");
    assert(failed.stdout.trim().startsWith("{"), "report stdout was not JSON-only object");
    assert(!failed.stdout.includes(API_KEY), "API key leaked into report stdout");
    assert(
      fixture.requests.includes("GET /api/v1/cli/auth/me"),
      "packed report did not call /me"
    );
    assert(
      fixture.requests.includes("GET /v1/relay/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/report"),
      "packed report did not GET the hosted report"
    );
    assert(
      fixture.requests.includes(
        "GET /v1/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/evaluations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/attempts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/criteria"
      ),
      "packed report did not GET the producer criterion index"
    );
    assert(
      fixture.requests.includes(
        "GET /v1/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/evaluations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/attempts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/criteria/dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      ),
      "packed report did not GET the nested producer criterion detail"
    );
    assert(
      fixture.requests.every((item) => item.startsWith("GET ")),
      `packed report issued a non-GET: ${fixture.requests.join(" | ")}`
    );
    assert(!fixture.requests.some((item) => item.includes("quote")), "packed report quoted billing");
    assert(!fixture.requests.some((item) => item.includes("retry-evaluation")), "packed report retried grading");

    process.stdout.write(
      `[packed report fixture] passed (requests=${fixture.requests.length}, source=producer aw-criterion-detail-read/1 @ 8068a90 + AW-QA-1 report)\n`
    );
  } finally {
    if (httpServer !== undefined) {
      await new Promise((resolveClose) => httpServer.close(() => resolveClose()));
    }
    if (process.env.AUGMENTWORKS_KEEP_SMOKE_TMP === "1") {
      process.stdout.write(`[packed report fixture] retained ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[packed report fixture] ${message}\n`);
  process.exitCode = 1;
});
