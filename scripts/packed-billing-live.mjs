#!/usr/bin/env node

/**
 * Release integration gate: packed CLI against an actual main API and a
 * disposable migrated database.
 *
 * A mock that returns the expected balance cannot prove atomic credit
 * accounting or tenant RLS. Missing credentials are not_run / BLOCKED
 * (exit 2), never a fake pass. Production databases are refused.
 *
 * When a loopback disposable API and connector token are supplied, this
 * script runs the packed binary for usage, estimate, and a zero ceiling.
 * Quoted create against that API is opt-in (`AW_BILLING_LIVE_ALLOW_CREATE=1`)
 * because it starts a real reservation. Ledger/RLS inspection remains
 * not_run without a disposable migrated database observer.
 */

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePackReport } from "./npm-pack-report.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_API_HOSTS = new Set(["augmentworks.ai", "www.augmentworks.ai"]);

class LiveFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveFailure";
  }
}

function env(name) {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function blocked(reason, extra = {}) {
  const report = {
    status: "not_run",
    gate: "packed-billing-live",
    reason,
    ...extra
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`[packed billing live] BLOCKED: ${reason}\n`);
  process.exit(2);
}

function failed(reason) {
  process.stderr.write(`[packed billing live] ${reason}\n`);
  process.exit(1);
}

function hostnameOf(value, label) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
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

async function ensurePackedBin(temporaryRoot) {
  const provided = env("AUGMENTWORKS_PACKED_BIN");
  if (provided) {
    await access(provided, fsConstants.R_OK);
    return provided;
  }
  process.stderr.write("[packed billing live] packing tarball because AUGMENTWORKS_PACKED_BIN is unset\n");
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "install");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const built = runJsCli("npm", ["run", "build"]);
  if (built.status !== 0) throw new LiveFailure(`npm run build failed\n${built.stderr}`);
  const packed = runJsCli("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory]);
  if (packed.status !== 0) throw new LiveFailure(`npm pack failed\n${packed.stderr}`);
  const report = parsePackReport(packed.stdout);
  const tarballPath = join(packDirectory, report.filename);
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "augmentworks-cli-packed-billing-live", private: true, version: "0.0.0" }, null, 2) + "\n",
    "utf8"
  );
  const installed = runJsCli(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
    { cwd: consumerDirectory }
  );
  if (installed.status !== 0) throw new LiveFailure(`npm install tarball failed\n${installed.stderr}`);
  return join(consumerDirectory, "node_modules", "@augmentworks", "cli", "dist", "index.js");
}

function spawnEnv(values) {
  /** @type {NodeJS.ProcessEnv} */
  const isolated = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    isolated[key] = value;
  }
  return isolated;
}

function runPacked(packedBin, args, childEnv, cwd, expectStatus) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packedBin, ...args], {
      cwd,
      env: spawnEnv(childEnv),
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
      reject(new LiveFailure(`Could not run packed CLI ${args.join(" ")}: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      if (expectStatus !== undefined && status !== expectStatus) {
        reject(
          new LiveFailure(
            [
              `packed CLI ${args.join(" ")} exited ${String(status)}${signal ? ` signal=${signal}` : ""}, expected ${String(expectStatus)}`,
              stdout.trim(),
              stderr.trim()
            ]
              .filter(Boolean)
              .join("\n")
          )
        );
        return;
      }
      resolve({ status, stdout, stderr });
    });
  });
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new LiveFailure(
      `${label} stdout was not JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}`
    );
  }
}

function startChatbot() {
  /** @type {{ path: string, body: unknown }[]} */
  const hits = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }
    hits.push({ path: url.pathname, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        answer: "Unused items in the synthetic catalog can be returned within 30 days.",
        finished: true
      })
    );
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      resolveListen({
        server,
        hits,
        origin: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

async function runLiveJourney(options) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aw-packed-billing-live-"));
  let chatbot;
  try {
    const packedBin = await ensurePackedBin(temporaryRoot);
    await access(packedBin, fsConstants.R_OK);
    const consumerDir = join(temporaryRoot, "empty-project");
    const isolatedHome = join(temporaryRoot, "home");
    await mkdir(consumerDir, { recursive: true });
    await mkdir(isolatedHome, { recursive: true });

    const apiOrigin = new URL(options.apiUrl);
    const apiUrl = `${apiOrigin.origin}/`;
    chatbot = await startChatbot();
    const childEnv = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
      APPDATA: join(isolatedHome, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      XDG_STATE_HOME: join(isolatedHome, ".local", "state"),
      AUGMENTWORKS_STATE_DIR: join(isolatedHome, "aw-state"),
      AUGMENTWORKS_API_URL: apiUrl,
      AUGMENTWORKS_TOKEN: options.token,
      AUGMENTWORKS_LIVE_TOKEN: "",
      AW_BILLING_LIVE_TOKEN: "",
      CHATBOT_BASE_URL: chatbot.origin,
      CHATBOT_API_KEY: "live-gate-placeholder",
      CI: "1",
      NO_COLOR: "1"
    };

    const probe = await fetch(new URL("/api/v1/cli/auth/me", apiUrl), {
      headers: { authorization: `Bearer ${options.token}` },
      redirect: "error"
    });
    if (!probe.ok) {
      throw new LiveFailure(`live auth/me failed: ${String(probe.status)} ${await probe.text()}`);
    }

    await runPacked(packedBin, ["init"], childEnv, consumerDir, 0);
    const usage = parseJson((await runPacked(packedBin, ["usage", "--json"], childEnv, consumerDir, 0)).stdout, "usage");
    const estimate = parseJson(
      (
        await runPacked(
          packedBin,
          ["test", "--assessment", "./augmentworks.assessment.yaml", "--estimate", "--json"],
          childEnv,
          consumerDir,
          0
        )
      ).stdout,
      "estimate"
    );
    const ceiling = parseJson(
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
          childEnv,
          consumerDir,
          13
        )
      ).stdout,
      "max-credits 0"
    );
    if (ceiling.code !== "BUDGET_EXCEEDED") {
      throw new LiveFailure(`live --max-credits 0 returned ${String(ceiling.code)}, expected BUDGET_EXCEEDED`);
    }

    let created = null;
    if (env("AW_BILLING_LIVE_ALLOW_CREATE") === "1") {
      const result = await runPacked(
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
        childEnv,
        consumerDir
      );
      created = parseJson(result.stdout, "live create");
    }

    const report = {
      status: "passed",
      gate: "packed-billing-live",
      api_host: options.apiHost,
      api_journey: "passed",
      packed_bin: packedBin,
      usage_available_units: usage.availableUnits,
      estimate_execution_units: estimate.executionUnits,
      zero_ceiling: ceiling.code,
      create: env("AW_BILLING_LIVE_ALLOW_CREATE") === "1" ? created : "skipped",
      target_hits: chatbot.hits.length,
      ledger_rls: "not_run",
      database_url_present: options.databaseUrl !== undefined,
      reason:
        "Packed CLI spoke to the supplied API. This is not PostgreSQL/RLS proof. Ledger inspection stays not_run without a disposable migrated database observer."
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (chatbot !== undefined) {
      await new Promise((resolveClose) => chatbot.server.close(resolveClose));
    }
    if (process.env.AUGMENTWORKS_KEEP_SMOKE_TMP === "1") {
      process.stdout.write(`[packed billing live] retained ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function main() {
  const apiUrl = env("AW_BILLING_LIVE_API_URL") ?? env("AUGMENTWORKS_LIVE_API_URL");
  const token = env("AW_BILLING_LIVE_TOKEN") ?? env("AUGMENTWORKS_LIVE_TOKEN");
  const databaseUrl = env("AW_BILLING_LIVE_DATABASE_URL") ?? env("SUPABASE_DB_URL");

  if (apiUrl === undefined || token === undefined) {
    blocked(
      "Set AW_BILLING_LIVE_API_URL and AW_BILLING_LIVE_TOKEN to a disposable staging/main API. This gate does not pack a mock balance as proof of ledger/RLS behavior.",
      {
        required_env: ["AW_BILLING_LIVE_API_URL", "AW_BILLING_LIVE_TOKEN"],
        optional_env: [
          "AW_BILLING_LIVE_DATABASE_URL",
          "AW_BILLING_LIVE_DISPOSABLE_DB",
          "AUGMENTWORKS_PACKED_BIN",
          "AW_BILLING_LIVE_ALLOW_CREATE"
        ]
      }
    );
    return;
  }

  let apiHost;
  try {
    apiHost = hostnameOf(apiUrl, "AW_BILLING_LIVE_API_URL");
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error));
    return;
  }

  const loopback = apiHost === "127.0.0.1" || apiHost === "localhost" || apiHost === "::1";
  if (PRODUCTION_API_HOSTS.has(apiHost)) {
    failed("Refusing production API origin augmentworks.ai. Point this gate at a disposable staging or loopback main API.");
    return;
  }
  if (!loopback) {
    blocked(
      `CLI API origin allowlist only permits https://augmentworks.ai or loopback. Host ${apiHost} cannot be used by the packed binary even with AW_BILLING_LIVE_ALLOW_NON_LOOPBACK=1.`,
      { api_host: apiHost }
    );
    return;
  }

  if (databaseUrl !== undefined) {
    let dbHost;
    try {
      dbHost = hostnameOf(databaseUrl, "AW_BILLING_LIVE_DATABASE_URL");
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));
      return;
    }
    if (dbHost.endsWith(".supabase.co") && env("AW_BILLING_LIVE_DISPOSABLE_DB") !== "1") {
      failed(
        "Refusing a Supabase-hosted database URL without AW_BILLING_LIVE_DISPOSABLE_DB=1. Production destinations cannot be reset, seeded, or purged by this gate."
      );
      return;
    }
  }

  runLiveJourney({ apiUrl, token, apiHost, databaseUrl }).catch((error) => {
    failed(error instanceof Error ? error.message : String(error));
  });
}

main();
