import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { runSourceCli } from "../util/cli-process.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_subscription";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const fixturesUrl = resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json");

type FixtureFile = {
  fixtures: Record<string, { status?: number; response: unknown }>;
};

const fixtures = JSON.parse(await readFile(fixturesUrl, "utf8")) as FixtureFile;

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean> | boolean;

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function emptyCwd(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-subscription-"));
  temporaryDirectories.push(directory);
  return directory;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function identity(): Record<string, unknown> {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspace_id: WORKSPACE,
    workspace_name: "Test Workspace",
    connector_id: "connector_test",
    connector_name: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"]
  };
}

async function startMock(handler: Handler): Promise<{ server: ListeningServer; paths: string[] }> {
  const paths: string[] = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    paths.push(`${request.method ?? "GET"} ${url.pathname}`);
    void Promise.resolve(handler(request, response, url)).then((handled) => {
      if (!handled && !response.writableEnded) {
        send(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
      }
    });
  });
  const server = await listenLoopback(httpServer);
  servers.push(server);
  return { server, paths };
}

function usageEnv(apiOrigin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUGMENTWORKS_API_URL: apiOrigin,
    AUGMENTWORKS_TOKEN: TOKEN,
    CI: "1",
    NO_COLOR: "1"
  };
}

function capabilitiesFrom(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "aw-billing/1",
    asOf: "2026-09-06T17:00:00.000Z",
    capabilities: usage["capabilities"],
    workspaceId: WORKSPACE
  };
}

async function runUsageFixture(
  name: string,
  json: boolean
): Promise<{
  result: Awaited<ReturnType<typeof runSourceCli>>;
  paths: string[];
}> {
  const cwd = await emptyCwd();
  const usage = fixtures.fixtures[name]?.response as Record<string, unknown>;
  const { server, paths } = await startMock((request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
      send(response, 200, identity());
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
      send(response, 200, capabilitiesFrom(usage));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/billing/usage") {
      send(response, 200, usage);
      return true;
    }
    return false;
  });
  const result = await runSourceCli(json ? ["usage", "--json"] : ["usage"], {
    cwd,
    env: usageEnv(server.baseUrl)
  });
  return { result, paths };
}

describe("subscription usage CLI matrix", () => {
  it("prints active recurring and trial lots from the server snapshot", async () => {
    const { result, paths } = await runUsageFixture("subscription_active", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available credits: 1200");
    expect(result.stdout).toContain("Recurring: 1000 available");
    expect(result.stdout).toContain("Trial/promotional: 200 available");
    expect(result.stdout).toContain("pro_monthly_1000_v1");
    expect(result.stdout).not.toContain("149");
    expect(result.stdout).not.toContain(TOKEN);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
    expect(paths).not.toContain("POST /v1/relay/runs");
  });

  it("writes subscription JSON without a Stripe portal URL", async () => {
    const { result } = await runUsageFixture("subscription_active", true);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      availableUnits: number;
      subscription: { status: string; planCode: string };
      subscriptionAdvertised: boolean;
      creditCategories: { recurringAvailable: number };
    };
    expect(parsed.availableUnits).toBe(1200);
    expect(parsed.subscription.status).toBe("active");
    expect(parsed.subscription.planCode).toBe("pro_monthly_1000_v1");
    expect(parsed.subscriptionAdvertised).toBe(true);
    expect(parsed.creditCategories.recurringAvailable).toBe(1000);
    expect(result.stdout).not.toMatch(/billing\.stripe|customer-portal|cs_test|cus_/u);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("shows cancel-at-period-end without erasing the current monthly allowance", async () => {
    const { result } = await runUsageFixture("subscription_canceling", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available credits: 850");
    expect(result.stdout).toContain("Cancellation is scheduled");
    expect(result.stdout).not.toMatch(/subscribe to recover your results/i);
  });

  it("keeps purchased credits after a failed renewal", async () => {
    const { result } = await runUsageFixture("subscription_past_due_with_purchased", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Purchased: 300 available");
    expect(result.stdout).toContain("past_due");
    expect(result.stdout).not.toContain("New hosted tests are rejected");
  });

  it("does not ask a canceled subscriber to subscribe to recover results", async () => {
    const { result } = await runUsageFixture("subscription_canceled_retained_results", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Historical results stay readable");
    expect(result.stdout).not.toMatch(/subscribe to recover your results/i);
  });

  it("treats processing renewal as not yet granted", async () => {
    const { result } = await runUsageFixture("subscription_late_payment_processing", true);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      availableUnits: number;
      subscription: { status: string; monthlyGrant: null };
    };
    expect(parsed.availableUnits).toBe(0);
    expect(parsed.subscription.status).toBe("processing");
    expect(parsed.subscription.monthlyGrant).toBeNull();
  });

  it("omits recurring CTAs when the server does not advertise subscriptions_v1", async () => {
    const { result } = await runUsageFixture("subscription_unavailable", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("does not advertise subscriptions_v1");
    expect(result.stdout).toContain("Available credits: 200");
    expect(result.stdout).not.toContain("149");
    expect(result.stdout).not.toContain("pro_monthly_1000_v1");
  });

  it("billing --json on a pack-only server still omits invented monthly prices", async () => {
    const cwd = await emptyCwd();
    const usage = fixtures.fixtures["subscription_unavailable"]?.response as Record<string, unknown>;
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["billing", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("149");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      subscriptionAdvertised: false,
      subscription: null
    });
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("billing --json for an active subscription still opens only the first-party page", async () => {
    const cwd = await emptyCwd();
    const usage = fixtures.fixtures["subscription_active"]?.response as Record<string, unknown>;
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["billing", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      billingPageUrl: string;
      subscription: { planCode: string };
    };
    expect(parsed.billingPageUrl).toBe(
      `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`
    );
    expect(parsed.subscription.planCode).toBe("pro_monthly_1000_v1");
    expect(result.stdout).not.toContain("149");
    expect(result.stdout).not.toMatch(/customer-portal|cs_live|sk_live/u);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("usage help mentions monthly lots and billing help forbids payment mutations", async () => {
    const usageHelp = await runSourceCli(["usage", "--help"], { cwd: process.cwd() });
    expect(usageHelp.stdout).toContain("monthly");
    const billingHelp = await runSourceCli(["billing", "--help"], { cwd: process.cwd() });
    const billingHelpText = billingHelp.stdout.toLowerCase();
    expect(billingHelpText).toContain("does not create");
    expect(billingHelpText).toContain("subscriptions");
    expect(billingHelp.exitCode).toBe(0);
    expect(usageHelp.exitCode).toBe(0);
  });

  it.each([
    "no_subscription",
    "subscription_active",
    "subscription_canceling",
    "subscription_past_due_with_purchased",
    "subscription_canceled_retained_results",
    "subscription_new_period",
    "subscription_late_payment_processing",
    "subscription_expired_monthly_grant",
    "subscription_unavailable"
  ] as const)("usage --json for %s is read-only and server-authoritative", async (name) => {
    const { result, paths } = await runUsageFixture(name, true);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      availableUnits: number;
      subscriptionAdvertised: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(Number.isSafeInteger(parsed.availableUnits)).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toContain(TOKEN);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
    expect(paths).not.toContain("POST /v1/relay/runs");
    expect(paths).not.toContain("POST /v1/billing/quote");
  });

  it("renders purchased credits with no subscription when subscriptions_v1 is advertised", async () => {
    const cwd = await emptyCwd();
    const usage = {
      ...(fixtures.fixtures["no_subscription"]?.response as Record<string, unknown>),
      availableUnits: 300,
      grantBalances: [
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
          origin: "purchased",
          grantedUnits: 300,
          availableUnits: 300,
          reservedUnits: 0,
          consumedUnits: 0,
          expiresAt: null,
          grantedAt: "2026-08-01T16:00:00.000Z"
        }
      ],
      subscription: null
    };
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage"], { cwd, env: usageEnv(server.baseUrl) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available credits: 300");
    expect(result.stdout).toContain("Purchased: 300 available");
    expect(result.stdout).toContain("Subscription: none");
    expect(result.stdout).not.toContain("149");
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("prints mixed monthly and purchased lots from the server snapshot", async () => {
    const cwd = await emptyCwd();
    const usage = {
      ...(fixtures.fixtures["subscription_active"]?.response as Record<string, unknown>),
      availableUnits: 1150,
      reservedUnits: 0,
      consumedUnits: 50,
      grantBalances: [
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
          origin: "purchased",
          grantedUnits: 300,
          availableUnits: 300,
          reservedUnits: 0,
          consumedUnits: 0,
          expiresAt: null,
          grantedAt: "2026-08-01T16:00:00.000Z"
        },
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
          origin: "subscription",
          grantedUnits: 1000,
          availableUnits: 850,
          reservedUnits: 0,
          consumedUnits: 150,
          expiresAt: "2026-10-01T17:00:00.000Z",
          grantedAt: "2026-09-01T16:00:00.000Z"
        }
      ]
    };
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage"], { cwd, env: usageEnv(server.baseUrl) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available credits: 1150");
    expect(result.stdout).toContain("Purchased: 300 available");
    expect(result.stdout).toContain("Recurring: 850 available");
    expect(result.stdout).toContain("Earliest lot expiry in this snapshot: 2026-10-01T17:00:00.000Z");
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("preserves usage for an uninterpreted future subscription enum at the CLI boundary", async () => {
    const cwd = await emptyCwd();
    const usage = {
      ...(fixtures.fixtures["subscription_past_due_with_purchased"]?.response as Record<string, unknown>),
      subscription: {
        planCode: "pro_monthly_1000_v1",
        status: "quantum_renewing",
        cancelAtPeriodEnd: false,
        nextPaymentAction: "teleport"
      }
    };
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage"], { cwd, env: usageEnv(server.baseUrl) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available credits: 300");
    expect(result.stdout).toContain("Update the CLI");
    expect(result.stdout).not.toContain("quantum_renewing");
    expect(result.stdout).not.toContain("teleport");
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("asks members to contact a workspace owner for payment changes", async () => {
    const cwd = await emptyCwd();
    const usage = fixtures.fixtures["subscription_active"]?.response as Record<string, unknown>;
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const human = await runSourceCli(["billing"], { cwd, env: usageEnv(server.baseUrl) });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("contact a workspace owner");
    expect(human.stdout).not.toMatch(/billing\.stripe|customer-portal/u);
  });

  it("does not locally cancel a reservation that spans monthly expiry", async () => {
    const cwd = await emptyCwd();
    const usage = {
      ...(fixtures.fixtures["subscription_expired_monthly_grant"]?.response as Record<string, unknown>),
      reservedUnits: 10,
      availableUnits: 0,
      grantBalances: [
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
          origin: "subscription",
          grantedUnits: 1000,
          availableUnits: 0,
          reservedUnits: 10,
          consumedUnits: 0,
          expiresAt: "2026-10-06T17:00:00.000Z",
          grantedAt: "2026-09-06T16:00:00.000Z"
        }
      ]
    };
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage"], { cwd, env: usageEnv(server.baseUrl) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Reserved credits: 10");
    expect(result.stdout).toContain("does not cancel target work");
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("does not report a release onto an expired lot as newly available credits", async () => {
    const cwd = await emptyCwd();
    const usage = {
      ...(fixtures.fixtures["subscription_expired_monthly_grant"]?.response as Record<string, unknown>),
      availableUnits: 0,
      reservedUnits: 0,
      releasedUnits: 10,
      grantBalances: [
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
          origin: "subscription",
          grantedUnits: 1000,
          availableUnits: 0,
          reservedUnits: 0,
          consumedUnits: 0,
          expiresAt: "2026-10-06T17:00:00.000Z",
          grantedAt: "2026-09-06T16:00:00.000Z",
          forfeitedUnits: 1000
        }
      ]
    };
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage"], { cwd, env: usageEnv(server.baseUrl) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Released credits in this snapshot: 10");
    expect(result.stdout).toContain("If that lot has expired, they are not spendable again");
    expect(result.stdout).toContain("Available credits: 0");
    expect(result.stdout).not.toContain("Available credits: 10");
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("shows payment authentication required without opening Stripe", async () => {
    const cwd = await emptyCwd();
    const usage = {
      ...(fixtures.fixtures["subscription_late_payment_processing"]?.response as Record<string, unknown>),
      subscription: {
        planCode: "pro_monthly_1000_v1",
        status: "incomplete",
        cancelAtPeriodEnd: false,
        nextPaymentAction: "authenticate",
        monthlyGrant: null
      }
    };
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilitiesFrom(usage));
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, usage);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage"], { cwd, env: usageEnv(server.baseUrl) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Payment authentication is required");
    expect(result.stdout).not.toMatch(/customer-portal|cs_test|sk_live/u);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });
});
