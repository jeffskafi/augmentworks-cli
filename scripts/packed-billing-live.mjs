#!/usr/bin/env node

/**
 * Release integration gate: packed CLI against an actual main API and a
 * disposable migrated database.
 *
 * A mock that returns the expected balance cannot prove atomic credit
 * accounting or tenant RLS. Missing credentials are not_run / BLOCKED
 * (exit 2), never a fake pass. Production databases are refused.
 */

const PRODUCTION_API_HOSTS = new Set(["augmentworks.ai", "www.augmentworks.ai"]);

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

function main() {
  const apiUrl = env("AW_BILLING_LIVE_API_URL") ?? env("AUGMENTWORKS_LIVE_API_URL");
  const token = env("AW_BILLING_LIVE_TOKEN") ?? env("AUGMENTWORKS_LIVE_TOKEN");
  const databaseUrl = env("AW_BILLING_LIVE_DATABASE_URL") ?? env("SUPABASE_DB_URL");

  if (apiUrl === undefined || token === undefined) {
    blocked(
      "Set AW_BILLING_LIVE_API_URL and AW_BILLING_LIVE_TOKEN to a disposable staging/main API. This gate does not pack a mock balance as proof of ledger/RLS behavior.",
      {
        required_env: ["AW_BILLING_LIVE_API_URL", "AW_BILLING_LIVE_TOKEN"],
        optional_env: ["AW_BILLING_LIVE_DATABASE_URL", "AW_BILLING_LIVE_DISPOSABLE_DB", "AUGMENTWORKS_PACKED_BIN"]
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
  if (!loopback && env("AW_BILLING_LIVE_ALLOW_NON_LOOPBACK") !== "1") {
    blocked(
      `Non-loopback API host ${apiHost} requires AW_BILLING_LIVE_ALLOW_NON_LOOPBACK=1 plus an explicitly designated staging instance.`,
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

  blocked(
    "Live packed CLI ↔ disposable migrated main database credentials were supplied, but this environment still lacks an authorized disposable database plus Stripe-free reservation observer. Do not treat a mock usage payload as this gate.",
    {
      api_host: apiHost,
      database_url_present: databaseUrl !== undefined,
      packed_bin_present: env("AUGMENTWORKS_PACKED_BIN") !== undefined
    }
  );
}

main();
