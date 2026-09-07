import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { parseMaxCreditsFlag } from "../../src/billing/consent.js";
import { billingHttpError } from "../../src/billing/errors.js";
import { runEstimate, runTest } from "../../src/commands/test.js";
import { runUsage } from "../../src/commands/usage.js";
import { createRunCommand } from "../../src/commands/run.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import { RunIntentStore } from "../../src/relay/run-intent.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { EXIT, AwError } from "../../src/errors.js";
import { runSourceCli } from "../util/cli-process.js";

const fixtures = JSON.parse(
  await readFile(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "contracts/aw-billing-v1.fixtures.json"),
    "utf8"
  )
) as { fixtures: Record<string, { response: unknown; status?: number }> };

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function projectDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-quote-"));
  temporaryDirectories.push(directory);
  await mkdir(resolve(directory, "references"));
  await writeFile(
    resolve(directory, "augmentworks.assessment.yaml"),
    `schema_version: aw-assessment-file/1
profile: quick
evaluation_mode: hybrid
packets:
  - key: response-quality
    version: 0.1.0
references:
  local:
    - path: references/faq.md
      id: synthetic-faq
      kind: reference_facts
`,
    "utf8"
  );
  await writeFile(resolve(directory, "references/faq.md"), "# Synthetic FAQ\n", "utf8");
  return directory;
}

const POST_CHAT = { method: "POST" as const, path: "/chat" };

function resolvedConfig() {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "chat",
      connector: "http",
      base_url: "http://127.0.0.1:8000",
      operations: {
        send: {
          method: POST_CHAT.method,
          path: POST_CHAT.path,
          request: { message: "$input.message" },
          response: { content: "$.answer" }
        }
      }
    }
  };
  const inspection = resolveConfig(config, "/tmp/augmentworks.yaml", "/tmp", {});
  if (inspection.resolvedConfig === undefined) throw new Error("test config did not resolve");
  return inspection.resolvedConfig;
};

function identity() {
  return {
    subject: "user-1",
    workspaceId: WORKSPACE,
    workspaceName: "Fixture workspace",
    connectorId: "connector-1",
    scopes: ["connector:identity", "connector:run"]
  };
}

function hostedCloud(fetchMock: typeof fetch) {
  return (options: {
    apiOrigin: URL;
    accessToken: string;
    accessTokenProvider: () => Promise<string>;
  }) =>
    new CloudClient({
      apiUrl: options.apiOrigin,
      accessToken: options.accessToken,
      accessTokenProvider: options.accessTokenProvider,
      fetch: fetchMock
    });
}

function completedCreateResponse(request: Record<string, unknown>, protocol = "aw-relay/0.3") {
  return {
    protocol_version: protocol,
    create_request_id: request["create_request_id"],
    create_request_sha256: sha256(canonicalize(request)),
    create_disposition: "created",
    run_id: "run-quoted",
    session_id: "session-1",
    packet: {
      key: protocol === "aw-relay/0.1" ? "support-refunds" : "response-quality",
      version: "0.1.0",
      sha256: "a".repeat(64)
    },
    config_sha256: request["config_sha256"],
    fencing_epoch: 1,
    status: "completed",
    dashboard_url: "https://augmentworks.ai/portal/runs/run-quoted",
    run_expires_at: "2099-09-06T00:00:00.000Z",
    credit_state: "reserved"
  };
}

function doctorFor() {
  const resolved = resolvedConfig();
  return async () => ({
    ok: true as const,
    configPath: resolved.configPath,
    offline: true as const,
    diagnostics: [],
    resolvedConfig: resolved
  });
}

describe("max-credits parsing", () => {
  it("accepts finite nonnegative integers and rejects ambiguous strings", () => {
    expect(parseMaxCreditsFlag("0")).toBe(0);
    expect(parseMaxCreditsFlag("30")).toBe(30);
    expect(() => parseMaxCreditsFlag("-1")).toThrowError(
      expect.objectContaining({ code: "INVALID_MAX_CREDITS" })
    );
    expect(() => parseMaxCreditsFlag("30.5")).toThrowError(
      expect.objectContaining({ code: "INVALID_MAX_CREDITS" })
    );
    expect(() => parseMaxCreditsFlag("1e2")).toThrowError(
      expect.objectContaining({ code: "INVALID_MAX_CREDITS" })
    );
    expect(() => parseMaxCreditsFlag("NaN")).toThrowError(
      expect.objectContaining({ code: "INVALID_MAX_CREDITS" })
    );
    expect(() => parseMaxCreditsFlag("+30")).toThrowError(
      expect.objectContaining({ code: "INVALID_MAX_CREDITS" })
    );
  });
});

describe("quote and status fixture errors", () => {
  it("maps every Stage 2 stable billing error from typed codes", () => {
    const cases: Array<[string, string, "billing" | "auth"]> = [
      ["error_insufficient_credits", "INSUFFICIENT_CREDITS", "billing"],
      ["error_quote_expired", "QUOTE_EXPIRED", "billing"],
      ["error_quote_mismatch", "QUOTE_MISMATCH", "billing"],
      ["error_budget_exceeded", "BUDGET_EXCEEDED", "billing"],
      ["error_update_required", "UPDATE_REQUIRED", "billing"],
      ["error_workspace_closing", "WORKSPACE_CLOSING", "billing"],
      ["error_membership_revoked", "MEMBERSHIP_REVOKED", "auth"],
      ["error_billing_unavailable", "BILLING_UNAVAILABLE", "billing"]
    ];
    for (const [name, code, category] of cases) {
      const fixture = fixtures.fixtures[name];
      const error = billingHttpError(
        fixture?.status ?? 409,
        fixture?.response,
        "POST",
        "/v1/billing/quote",
        "https://augmentworks.ai/portal"
      );
      expect(error.code).toBe(code);
      expect(error.category).toBe(category);
    }
  });
});

describe("hosted estimate and quoted admission", () => {
  it("estimate causes zero create, reserve, target, or provider calls", async () => {
    const cwd = await projectDir();
    const counts = { quote: 0, create: 0, capabilities: 0, usage: 0, target: 0 };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        counts.capabilities += 1;
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        counts.quote += 1;
        return Response.json(fixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs" || url.pathname === "/v1/billing/usage") {
        counts.create += 1;
        throw new Error(`unexpected ${url.pathname}`);
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const result = await runEstimate(
      {
        cwd,
        assessment: "augmentworks.assessment.yaml",
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        doctor: doctorFor(),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: (options) =>
          new CloudClient({
            apiUrl: options.apiOrigin,
            accessToken: options.accessToken,
            accessTokenProvider: options.accessTokenProvider,
            fetch: fetchMock
          }),
        connector: () => {
          counts.target += 1;
          throw new Error("target must not be constructed");
        }
      }
    );
    expect(result.quote.executionUnits).toBe(30);
    expect(result.quote.estimateOnly).toBe(true);
    expect(result.localPlanHash).not.toBe(result.quote.assessmentPlanHash);
    expect(counts).toEqual({ quote: 1, create: 0, capabilities: 1, usage: 0, target: 0 });
  });

  it("rejects a ceiling below the quote with zero target or create calls", async () => {
    const cwd = await projectDir();
    const counts = { quote: 0, create: 0, target: 0 };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        counts.quote += 1;
        return Response.json(fixtures.fixtures["quote_success_with_balance"]?.response);
      }
      counts.create += 1;
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(
      runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          maxCredits: "10",
          yes: true
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: (options) =>
            new CloudClient({
              apiUrl: options.apiOrigin,
              accessToken: options.accessToken,
              accessTokenProvider: options.accessTokenProvider,
              fetch: fetchMock
            }),
          connector: () => {
            counts.target += 1;
            throw new Error("target must not be constructed");
          }
        }
      )
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", category: "billing" });
    expect(counts).toEqual({ quote: 1, create: 0, target: 0 });
  });

  it("a successful admission creates one reservation and does not requote after a dropped create", async () => {
    const cwd = await projectDir();
    const stateDirectory = await projectDir();
    const counts = { quote: 0, create: 0, target: 0 };
    let dropCreates = true;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        counts.quote += 1;
        return Response.json(fixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs") {
        counts.create += 1;
        const request = body as Record<string, unknown>;
        expect(request["protocol_version"]).toBe("aw-relay/0.3");
        expect(request["quote_id"]).toBe("55555555-5555-4555-8555-555555555555");
        expect(request["max_credits"]).toBe(30);
        if (dropCreates) {
          throw Object.assign(new Error("dropped"), { cause: "network" });
        }
        return Response.json({
          protocol_version: "aw-relay/0.3",
          create_request_id: request["create_request_id"],
          create_request_sha256: sha256(canonicalize(request)),
          create_disposition: "replayed",
          run_id: "run-quoted",
          session_id: "session-1",
          packet: {
            key: "response-quality",
            version: "0.1.0",
            sha256: "a".repeat(64)
          },
          config_sha256: request["config_sha256"],
          fencing_epoch: 1,
          status: "completed",
          dashboard_url: "https://augmentworks.ai/portal/runs/run-quoted",
          run_expires_at: "2099-09-06T00:00:00.000Z",
          credit_state: "reserved"
        });
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const request = body as Record<string, unknown>;
        return Response.json({
          protocol_version: "aw-run-intent-reconcile/0.1",
          outcome: "unknown",
          create_request_id: request["create_request_id"],
          create_request_sha256: request["create_request_sha256"],
          reason: "in_flight"
        });
      }
      if (url.pathname === "/v1/relay/runs/run-quoted") {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: "run-quoted",
          status: "completed",
          credit_state: "reserved",
          outcome: "passed"
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const cloud = (options: {
      apiOrigin: URL;
      accessToken: string;
      accessTokenProvider: () => Promise<string>;
    }) =>
      new CloudClient({
        apiUrl: options.apiOrigin,
        accessToken: options.accessToken,
        accessTokenProvider: options.accessTokenProvider,
        fetch: fetchMock
      });
    const first = runTest(
      {
        cwd,
        assessment: "augmentworks.assessment.yaml",
        maxCredits: "30",
        yes: true,
        stateDirectory
      },
      {
        doctor: doctorFor(),
        isInteractive: () => false,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud,
        connector: () => {
          counts.target += 1;
          throw new Error("target must not be constructed");
        }
      }
    );
    await expect(first).rejects.toMatchObject({ code: "RELAY_UNREACHABLE" });
    expect(counts.quote).toBe(1);
    dropCreates = false;
    const second = await runTest(
      {
        cwd,
        assessment: "augmentworks.assessment.yaml",
        maxCredits: "30",
        yes: true,
        stateDirectory
      },
      {
        doctor: doctorFor(),
        isInteractive: () => false,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud,
        connector: () => {
          counts.target += 1;
          throw new Error("target must not be constructed");
        }
      }
    );
    expect(second.binding.run_id).toBe("run-quoted");
    expect(counts.quote).toBe(1);
    expect(counts.create).toBeGreaterThanOrEqual(1);
    expect(counts.target).toBe(0);
    const createBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes("/v1/relay/runs") && !String(call[0]).includes("run-quoted"))
      .map((call) => JSON.parse(String(call[1]?.body)));
    const quoteIds = new Set(createBodies.map((body: { quote_id?: string }) => body.quote_id));
    expect(quoteIds).toEqual(new Set(["55555555-5555-4555-8555-555555555555"]));
  });

  it("does not fall back to aw-relay/0.2 when quote_v1 is absent", async () => {
    const cwd = await projectDir();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json({
          schemaVersion: "aw-billing/1",
          asOf: "2026-09-06T17:00:00.000Z",
          capabilities: ["usage_v1"]
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(
      runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          maxCredits: "30",
          yes: true
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: (options) =>
            new CloudClient({
              apiUrl: options.apiOrigin,
              accessToken: options.accessToken,
              accessTokenProvider: options.accessTokenProvider,
              fetch: fetchMock
            })
        }
      )
    ).rejects.toMatchObject({ code: "UPDATE_REQUIRED", category: "billing" });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/v1/relay/runs"))).toBe(false);
  });

  it("maps insufficient credits from create without starting the target", async () => {
    const cwd = await projectDir();
    let target = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      let body: Record<string, unknown> = {};
      if (typeof init?.body === "string" && init.body.length > 0) {
        body = JSON.parse(init.body) as Record<string, unknown>;
      }
      if (url.pathname.endsWith("/v1/billing/capabilities")) {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname.endsWith("/v1/billing/quote")) {
        return Response.json(fixtures.fixtures["quote_success_insufficient_balance"]?.response);
      }
      if (url.pathname.endsWith("/v1/relay/runs")) {
        return Response.json(fixtures.fixtures["error_insufficient_credits"]?.response, { status: 409 });
      }
      if (url.pathname.endsWith("/v1/relay/run-intents:reconcile")) {
        return Response.json({
          protocol_version: "aw-run-intent-reconcile/0.1",
          outcome: "rejected_uncreated",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          rejection: { code: "INSUFFICIENT_CREDITS", message: "Not enough credits." }
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    try {
      await runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          maxCredits: "30",
          yes: true
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: (options) =>
            new CloudClient({
              apiUrl: options.apiOrigin,
              accessToken: options.accessToken,
              accessTokenProvider: options.accessTokenProvider,
              fetch: fetchMock
            }),
          connector: () => {
            target += 1;
            throw new Error("target must not be constructed");
          }
        }
      );
      throw new Error("expected INSUFFICIENT_CREDITS");
    } catch (error) {
      expect(error).toMatchObject({ code: "INSUFFICIENT_CREDITS", category: "billing" });
      const awError = error as AwError;
      expect(awError.message).toContain("Required 30 credits, available 5.");
      expect(awError.message).toContain("/portal/billing?workspace=");
      expect(awError.message).toContain("does not wait for a purchase");
      expect(awError.details?.["required_units"]).toBe(30);
      expect(awError.details?.["available_units"]).toBe(5);
      expect(String(awError.details?.["billing_page_url"] ?? "")).not.toContain("token");
    }
    expect(target).toBe(0);
  });

  it("requires an explicit new test after insufficient credits and a fulfilled purchase snapshot", async () => {
    const cwd = await projectDir();
    const stateDirectory = await projectDir();
    let phase: "blocked" | "purchased" = "blocked";
    let target = 0;
    const fulfilledUsage = {
      ...((fixtures.fixtures["eligible_trial"]?.response ?? {}) as Record<string, unknown>),
      availableUnits: 500,
      reservedUnits: 0,
      consumedUnits: 0,
      ledgerRevision: 4,
      grantBalances: [
        {
          lotId: "33333333-3333-4333-8333-333333333333",
          origin: "trial",
          grantedUnits: 200,
          availableUnits: 200,
          reservedUnits: 0,
          consumedUnits: 0,
          expiresAt: null,
          grantedAt: "2026-09-06T16:00:00.000Z",
          policyVersion: "aw-billing/1"
        },
        {
          lotId: "55555555-5555-4555-8555-555555555555",
          origin: "purchased",
          grantedUnits: 300,
          availableUnits: 300,
          reservedUnits: 0,
          consumedUnits: 0,
          expiresAt: null,
          grantedAt: "2026-09-06T18:05:00.000Z",
          policyVersion: "aw-billing/pack-300-v1"
        }
      ]
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      let body: Record<string, unknown> = {};
      if (typeof init?.body === "string" && init.body.length > 0) {
        body = JSON.parse(init.body) as Record<string, unknown>;
      }
      if (url.pathname.endsWith("/v1/billing/capabilities")) {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname.endsWith("/v1/billing/usage")) {
        expect(phase).toBe("purchased");
        return Response.json(fulfilledUsage);
      }
      if (url.pathname.endsWith("/v1/billing/quote")) {
        if (phase === "blocked") {
          return Response.json(fixtures.fixtures["quote_success_insufficient_balance"]?.response);
        }
        return Response.json({
          ...((fixtures.fixtures["quote_success_with_balance"]?.response ?? {}) as object),
          availableUnitsAtQuote: 500,
          remainingUnitsEstimate: 470
        });
      }
      if (url.pathname.endsWith("/v1/relay/runs")) {
        if (phase === "blocked") {
          return Response.json(fixtures.fixtures["error_insufficient_credits"]?.response, { status: 409 });
        }
        expect(body["max_credits"]).toBe(500);
        expect(body["protocol_version"]).toBe("aw-relay/0.3");
        return Response.json(completedCreateResponse(body));
      }
      if (url.pathname.endsWith("/v1/relay/run-intents:reconcile")) {
        return Response.json({
          protocol_version: "aw-run-intent-reconcile/0.1",
          outcome: "rejected_uncreated",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          rejection: { code: "INSUFFICIENT_CREDITS", message: "Not enough credits." }
        });
      }
      if (url.pathname.endsWith("/v1/relay/runs/run-quoted")) {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: "run-quoted",
          status: "completed",
          credit_state: "reserved",
          outcome: "passed"
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const deps = {
      doctor: doctorFor(),
      isInteractive: () => false as const,
      accessToken: async () => "token",
      identity: async () => identity(),
      cloud: hostedCloud(fetchMock),
      connector: () => {
        target += 1;
        throw new Error("target must not be constructed");
      }
    };
    try {
      await runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          maxCredits: "30",
          yes: true,
          stateDirectory
        },
        deps
      );
      throw new Error("expected INSUFFICIENT_CREDITS");
    } catch (error) {
      expect(error).toMatchObject({ code: "INSUFFICIENT_CREDITS", category: "billing" });
      const awError = error as AwError;
      expect(awError.message).toContain("Required 30 credits, available 5.");
      expect(awError.message).toContain("/portal/billing?workspace=");
      expect(awError.message).toContain("does not wait for a purchase");
      expect(awError.details?.["required_units"]).toBe(30);
      expect(awError.details?.["available_units"]).toBe(5);
      expect(String(awError.details?.["billing_page_url"] ?? "")).not.toContain("token");
    }
    expect(target).toBe(0);
    expect(
      fetchMock.mock.calls.filter(
        (call) => String(call[0]).includes("/v1/relay/runs") && !String(call[0]).includes("reconcile")
      ).length
    ).toBe(1);

    phase = "purchased";
    const usage = await runUsage(
      { env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" } },
      {
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock)
      }
    );
    expect(usage.usage.availableUnits).toBe(500);
    expect(usage.usage.pendingCommerce).toBeUndefined();
    expect(usage.usage.grantBalances.some((lot) => lot.origin === "purchased" && lot.availableUnits === 300)).toBe(
      true
    );
    expect(target).toBe(0);

    const admitted = await runTest(
      {
        cwd,
        assessment: "augmentworks.assessment.yaml",
        maxCredits: "500",
        yes: true,
        stateDirectory
      },
      deps
    );
    expect(admitted.binding.run_id).toBe("run-quoted");
    expect(target).toBe(0);
    expect(
      fetchMock.mock.calls.some((call) => /checkout|stripe|customer|refund|subscribe/i.test(String(call[0])))
    ).toBe(false);
  });

  it("requires --max-credits even when the usage snapshot has an active monthly grant", async () => {
    const cwd = await projectDir();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["subscription_active"]?.response);
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(
      runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          yes: true
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock),
          connector: () => {
            throw new Error("target must not be constructed");
          }
        }
      )
    ).rejects.toMatchObject({ code: "MAX_CREDITS_REQUIRED", category: "config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "subscription_past_due_with_purchased",
    "subscription_canceled_retained_results",
    "subscription_expired_monthly_grant",
    "no_subscription"
  ] as const)("requires --max-credits for hosted tests when usage is %s", async (name) => {
    const cwd = await projectDir();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      throw new Error(`unexpected ${url.pathname} for ${name}`);
    });
    await expect(
      runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          yes: true
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock),
          connector: () => {
            throw new Error("target must not be constructed");
          }
        }
      )
    ).rejects.toMatchObject({ code: "MAX_CREDITS_REQUIRED", category: "config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("packet-only hosted tests create without quoting", async () => {
    const cwd = await projectDir();
    const counts = { quote: 0, create: 0 };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (url.pathname === "/v1/billing/quote" || url.pathname === "/v1/billing/capabilities") {
        counts.quote += 1;
        throw new Error("packet-only tests must not quote");
      }
      if (url.pathname === "/v1/relay/runs") {
        counts.create += 1;
        expect(body["protocol_version"]).toBe("aw-relay/0.1");
        expect(body["quote_id"]).toBeUndefined();
        return Response.json(completedCreateResponse(body as Record<string, unknown>, "aw-relay/0.1"));
      }
      if (url.pathname === "/v1/relay/runs/run-quoted") {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: "run-quoted",
          status: "completed",
          credit_state: "reserved",
          outcome: "passed"
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const result = await runTest(
      {
        cwd,
        packet: "support-refunds@0.1.0"
      },
      {
        doctor: doctorFor(),
        isInteractive: () => false,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock),
        connector: () => {
          throw new Error("target must not be constructed for a terminal create");
        }
      }
    );
    expect(result.binding.protocol_version).toBe("aw-relay/0.1");
    expect(counts).toEqual({ quote: 0, create: 1 });
  });

  it("retires a proven-uncreated expired quote and requotes on the next invocation", async () => {
    const cwd = await projectDir();
    const stateDirectory = await projectDir();
    const counts = { quote: 0, create: 0 };
    let createAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        counts.quote += 1;
        return Response.json(
          counts.quote === 1
            ? fixtures.fixtures["quote_success_with_balance"]?.response
            : {
                ...((fixtures.fixtures["quote_success_with_balance"]?.response ?? {}) as object),
                quoteId: "99999999-9999-4999-8999-999999999999",
                executionUnits: 40,
                remainingUnitsEstimate: 150
              }
        );
      }
      if (url.pathname === "/v1/relay/runs") {
        counts.create += 1;
        createAttempts += 1;
        if (createAttempts === 1) {
          return Response.json(fixtures.fixtures["error_quote_expired"]?.response, { status: 409 });
        }
        expect(body["quote_id"]).toBe("99999999-9999-4999-8999-999999999999");
        expect(body["max_credits"]).toBe(40);
        return Response.json(completedCreateResponse(body as Record<string, unknown>));
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        return Response.json({
          protocol_version: "aw-run-intent-reconcile/0.1",
          outcome: "rejected_uncreated",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          rejection: { code: "QUOTE_EXPIRED", message: "Quote expired." }
        });
      }
      if (url.pathname === "/v1/relay/runs/run-quoted") {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: "run-quoted",
          status: "completed",
          credit_state: "reserved",
          outcome: "passed"
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const deps = {
      doctor: doctorFor(),
      isInteractive: () => false as const,
      accessToken: async () => "token",
      identity: async () => identity(),
      cloud: hostedCloud(fetchMock),
      connector: () => {
        throw new Error("target must not be constructed");
      }
    };
    await expect(
      runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          maxCredits: "30",
          yes: true,
          stateDirectory
        },
        deps
      )
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(counts.quote).toBe(1);
    await expect(
      runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          maxCredits: "30",
          yes: true,
          stateDirectory
        },
        deps
      )
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", category: "billing" });
    expect(counts.quote).toBe(2);
    expect(counts.create).toBe(1);
    const admitted = await runTest(
      {
        cwd,
        assessment: "augmentworks.assessment.yaml",
        maxCredits: "40",
        yes: true,
        stateDirectory
      },
      deps
    );
    expect(admitted.binding.run_id).toBe("run-quoted");
    expect(counts.quote).toBe(3);
    expect(counts.create).toBe(2);
  });
});

describe("run status wait and retry-evaluation", () => {
  it("waits on billing status after intent retirement with zero target calls", async () => {
    let target = 0;
    let billingStatus = 0;
    let retry = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/status") {
        billingStatus += 1;
        expect(url.searchParams.get("runId")).toBe("66666666-6666-4666-8666-666666666666");
        return Response.json(fixtures.fixtures["status_pending_grading"]?.response);
      }
      if (url.pathname.endsWith(":retry-evaluation")) {
        retry += 1;
        throw new Error("retry must not be automatic");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const command = createRunCommand({
      stdout: { write: () => true },
      stderr: { write: () => true },
      accessToken: async () => "token",
      identity: async () => identity(),
      apiOrigin: () => new URL("http://127.0.0.1:8787/"),
      cloud: (options) =>
        new CloudClient({
          apiUrl: options.apiOrigin,
          accessToken: options.accessToken,
          accessTokenProvider: options.accessTokenProvider,
          fetch: fetchMock
        })
    }).exitOverride();
    await command.parseAsync(
      ["node", "augmentworks", "status", "66666666-6666-4666-8666-666666666666", "--json"],
      { from: "node" }
    );
    expect(billingStatus).toBe(1);
    expect(retry).toBe(0);
    expect(target).toBe(0);
  });

  it("waits until grading completes without creating a run or constructing a target", async () => {
    let billingStatus = 0;
    const pending = fixtures.fixtures["status_pending_grading"]?.response as Record<string, unknown>;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/status") {
        billingStatus += 1;
        if (billingStatus === 1) return Response.json(pending);
        return Response.json({
          ...pending,
          evaluationStatus: "complete",
          outcome: "failed",
          nextActions: ["inspect", "open_dashboard"]
        });
      }
      if (url.pathname === "/v1/relay/runs") {
        throw new Error("wait must not create a run");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const stdout: string[] = [];
    let exitCode = 0;
    const command = createRunCommand({
      stdout: {
        write: (chunk) => {
          stdout.push(String(chunk));
          return true;
        }
      },
      stderr: { write: () => true },
      sleep: async () => undefined,
      setExitCode: (code) => {
        exitCode = code;
      },
      accessToken: async () => "token",
      identity: async () => identity(),
      apiOrigin: () => new URL("http://127.0.0.1:8787/"),
      cloud: hostedCloud(fetchMock)
    }).exitOverride();
    await command.parseAsync(
      ["node", "augmentworks", "wait", "66666666-6666-4666-8666-666666666666", "--json"],
      { from: "node" }
    );
    expect(billingStatus).toBe(2);
    const payload = JSON.parse(stdout.join("")) as {
      evaluationStatus: string;
      outcome?: string;
      assessment?: string;
      exit_code?: number;
      ok?: boolean;
    };
    expect(payload.evaluationStatus).toBe("complete");
    expect(payload.outcome).toBe("failed");
    expect(payload.ok).toBe(true);
    expect(payload.assessment).toBe("failed");
    expect(payload.exit_code).toBe(EXIT.ASSESSMENT_FAILED);
    expect(exitCode).toBe(EXIT.ASSESSMENT_FAILED);
  });

  it("does not finish wait successfully for running/absent/0-of-10/null-outcome", async () => {
    let nowMs = 0;
    let billingStatus = 0;
    let quote = 0;
    let create = 0;
    const pending = fixtures.fixtures["status_pending_grading"]?.response as Record<string, unknown>;
    const runningAbsent = {
      ...pending,
      executionStatus: "running",
      evaluationStatus: "absent",
      outcome: null,
      nextActions: ["wait", "inspect", "open_dashboard"],
      progress: {
        completedAttempts: 0,
        plannedAttempts: 10,
        completedJudgeJobs: 0,
        plannedJudgeJobs: 0
      }
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/status") {
        billingStatus += 1;
        return Response.json(runningAbsent);
      }
      if (url.pathname === "/v1/billing/quote") {
        quote += 1;
        throw new Error("timeout wait must not quote");
      }
      if (url.pathname === "/v1/relay/runs") {
        create += 1;
        throw new Error("timeout wait must not create a run");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const command = createRunCommand({
      stdout: { write: () => true },
      stderr: { write: () => true },
      now: () => nowMs,
      sleep: async () => {
        nowMs = 10;
      },
      accessToken: async () => "token",
      identity: async () => identity(),
      apiOrigin: () => new URL("http://127.0.0.1:8787/"),
      cloud: hostedCloud(fetchMock)
    }).exitOverride();
    await expect(
      command.parseAsync(
        [
          "node",
          "augmentworks",
          "wait",
          "66666666-6666-4666-8666-666666666666",
          "--timeout-ms",
          "5"
        ],
        { from: "node" }
      )
    ).rejects.toMatchObject({
      code: "EVALUATION_INCOMPLETE",
      message: expect.stringContaining("66666666-6666-4666-8666-666666666666")
    });
    expect(billingStatus).toBeGreaterThanOrEqual(1);
    expect(quote).toBe(0);
    expect(create).toBe(0);
  });

  it("retries evaluation without a new reservation or target call", async () => {
    let create = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname.endsWith(":retry-evaluation")) {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: "66666666-6666-4666-8666-666666666666",
          evaluation_id: "77777777-7777-4777-8777-777777777777",
          reused_target_evidence: true,
          customer_units_debited: 0
        });
      }
      if (url.pathname === "/v1/relay/runs") {
        create += 1;
        throw new Error("create must not happen");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const stdout: string[] = [];
    const command = createRunCommand({
      stdout: {
        write: (chunk) => {
          stdout.push(String(chunk));
          return true;
        }
      },
      stderr: { write: () => true },
      accessToken: async () => "token",
      identity: async () => identity(),
      apiOrigin: () => new URL("http://127.0.0.1:8787/"),
      cloud: (options) =>
        new CloudClient({
          apiUrl: options.apiOrigin,
          accessToken: options.accessToken,
          accessTokenProvider: options.accessTokenProvider,
          fetch: fetchMock
        })
    }).exitOverride();
    await command.parseAsync(
      ["node", "augmentworks", "retry-evaluation", "66666666-6666-4666-8666-666666666666", "--json"],
      { from: "node" }
    );
    const payload = JSON.parse(stdout.join("")) as { customer_units_debited: number };
    expect(payload.customer_units_debited).toBe(0);
    expect(create).toBe(0);
  });
});

describe("help surface", () => {
  it("documents estimate, max-credits, and run subcommands", async () => {
    const testHelp = await runSourceCli(["test", "--help"], { cwd: process.cwd() });
    expect(testHelp.stdout).toContain("--estimate");
    expect(testHelp.stdout).toContain("--max-credits");
    expect(testHelp.stdout).toContain("--yes");
    const runHelp = await runSourceCli(["run", "--help"], { cwd: process.cwd() });
    expect(runHelp.stdout).toContain("status");
    expect(runHelp.stdout).toContain("wait");
    expect(runHelp.stdout).toContain("retry-evaluation");
  });
});

describe("intent fingerprint", () => {
  it("replays a pending quoted create without treating a new quote id as a different run", async () => {
    const stateDirectory = await projectDir();
    const request = {
      protocol_version: "aw-relay/0.3" as const,
      packet: { key: "response-quality", version: "0.1.0" },
      config_sha256: "b".repeat(64),
      target: {
        name: "chat",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: [],
          multi_turn: true
        }
      },
      assessment: {
        plan_hash: "d".repeat(64),
        profile: "quick" as const,
        evaluation_mode: "hybrid" as const,
        disclosure_version: "aw-judge-disclosure/1",
        reference_bundle: {
          bundleId: "bundle",
          entries: [],
          refundPolicy: null,
          knowledgeBoundary: null,
          targetAlreadyConfigured: true
        }
      },
      quote_id: "55555555-5555-4555-8555-555555555555",
      max_credits: 30
    };
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: WORKSPACE, connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"a".repeat(32)}`
    });
    await store.open();
    const first = await store.loadOrCreate(request);
    const second = await store.loadOrCreate({
      ...request,
      quote_id: "44444444-4444-4444-8444-444444444444"
    });
    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);
    expect(second.intent.request.protocol_version).toBe("aw-relay/0.3");
    if (second.intent.request.protocol_version === "aw-relay/0.3") {
      expect(second.intent.request.quote_id).toBe("55555555-5555-4555-8555-555555555555");
    }
    await store.close();
  });
});
