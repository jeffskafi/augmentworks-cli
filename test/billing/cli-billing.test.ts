import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import {
  createBillingCommand,
  runBilling,
  shouldOpenBillingBrowser
} from "../../src/commands/billing.js";
import { EXIT, AwError } from "../../src/errors.js";
import { runSourceCli } from "../util/cli-process.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_billing";
const REFRESHED = "aw_connector_test_access_token_billing_refresh";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
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
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-billing-"));
  temporaryDirectories.push(directory);
  return directory;
}

function send(response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extra
  });
  response.end(body);
}

function identity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspace_id: WORKSPACE,
    workspace_name: "Test Workspace",
    connector_id: "connector_test",
    connector_name: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"],
    ...overrides
  };
}

function hostedIdentity(overrides: Record<string, unknown> = {}) {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspaceId: WORKSPACE,
    workspaceName: "Test Workspace",
    connectorId: "connector_test",
    connectorName: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"],
    ...overrides
  };
}

function fixtureFetch(response: unknown = fixtures.fixtures["eligible_trial"]?.response) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/billing/capabilities") {
      return Response.json(fixtures.fixtures["absent_capability"]?.response);
    }
    if (url.pathname === "/v1/billing/usage") {
      return Response.json(response);
    }
    throw new Error(`unexpected ${url.pathname}`);
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

function usageEnv(apiOrigin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUGMENTWORKS_API_URL: apiOrigin,
    AUGMENTWORKS_TOKEN: TOKEN,
    CI: "1",
    NO_COLOR: "1",
    ...extra
  };
}

function fixtureResponse(name: string): Record<string, unknown> {
  return { ...(fixtures.fixtures[name]?.response as Record<string, unknown>) };
}

const MUTATION_RE = /checkout|stripe|refund|subscribe|customer|reserve|grant|runs/i;

describe("augmentworks billing CLI", () => {
  it("prints the same first-party billing URL for owner-like and member-like identities", async () => {
    const cwd = await emptyCwd();
    const expectedUrl = `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`;
    let role: "owner" | "member" = "owner";
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(
          response,
          200,
          role === "owner"
            ? identity({ email: "owner@example.com", subject: "user_owner" })
            : identity({ email: "member@example.com", subject: "user_member" })
        );
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["eligible_trial"]?.response);
        return true;
      }
      return false;
    });

    const owner = await runSourceCli(["billing", "--print"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    role = "member";
    const member = await runSourceCli(["billing", "--print"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(owner.exitCode).toBe(0);
    expect(member.exitCode).toBe(0);
    expect(owner.stdout.trim()).toBe(expectedUrl);
    expect(member.stdout.trim()).toBe(expectedUrl);
    expect(owner.stderr).toContain("does not authorize payment");
    expect(member.stderr).toContain("does not authorize payment");
    expect(`${owner.stdout}${owner.stderr}${member.stdout}${member.stderr}`).not.toContain(TOKEN);
    expect(paths.some((path) => MUTATION_RE.test(path) && path.startsWith("POST "))).toBe(false);
    expect(paths).not.toContain("POST /v1/relay/runs");
  });

  it("prints human billing output without opening a browser when CI=1 and flags are omitted", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["eligible_trial"]?.response);
        return true;
      }
      return false;
    });

    const result = await runSourceCli(["billing"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available credits: 200");
    expect(result.stdout).toContain(
      `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`
    );
    expect(result.stdout).toContain("Printed the billing URL without opening a browser.");
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(TOKEN);
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
  });

  it("writes one JSON object and never opens a browser", async () => {
    const cwd = await emptyCwd();
    const opened: string[] = [];
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["eligible_trial"]?.response);
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
      ok: boolean;
      billingPageUrl: string;
      openedBrowser: boolean;
      availableUnits: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.openedBrowser).toBe(false);
    expect(parsed.availableUnits).toBe(200);
    expect(parsed.billingPageUrl).toBe(
      `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`
    );
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(opened).toEqual([]);
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
  });

  it("isolates the billing URL to the authenticated workspace", async () => {
    const cwd = await emptyCwd();
    const mismatched = {
      ...fixtureResponse("eligible_trial"),
      billingPageUrl: `https://augmentworks.ai/portal/billing?workspace=${OTHER_WORKSPACE}`
    };
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, mismatched);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["billing", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.AUTH);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "WORKSPACE_MISMATCH" });
  });

  it("rejects a usage snapshot whose workspace changed before the billing link is used", async () => {
    const cwd = await emptyCwd();
    const mismatched = {
      ...fixtureResponse("eligible_trial"),
      workspaceId: OTHER_WORKSPACE
    };
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, mismatched);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["billing", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.AUTH);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "WORKSPACE_MISMATCH" });
  });

  it("rejects when the authenticated workspace changes after usage is retrieved", async () => {
    const cwd = await emptyCwd();
    let meCount = 0;
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        meCount += 1;
        send(
          response,
          200,
          meCount === 1 ? identity() : identity({ workspace_id: OTHER_WORKSPACE })
        );
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["eligible_trial"]?.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["billing", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.AUTH);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "WORKSPACE_MISMATCH" });
    expect(meCount).toBeGreaterThanOrEqual(2);
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
  });

  it("rejects malicious billing URLs without opening them", async () => {
    const cwd = await emptyCwd();
    const poisoned = {
      ...fixtureResponse("eligible_trial"),
      billingPageUrl: `https://evil.example/steal?workspace=${WORKSPACE}&access_token=${TOKEN}`
    };
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, poisoned);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["billing", "--open"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(TOKEN);
    expect(paths.some((path) => path.includes("evil"))).toBe(false);
  });

  it("prints the safe URL when the GUI opener fails and does not mutate billing", async () => {
    const opened: URL[] = [];
    const fetchMock = fixtureFetch();
    const stderr: string[] = [];
    const stdout: string[] = [];
    const command = createBillingCommand({
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      apiOrigin: () => new URL("http://127.0.0.1:8787"),
      accessToken: async () => TOKEN,
      identity: async () => hostedIdentity(),
      cloud: (options) =>
        new CloudClient({
          apiUrl: options.apiOrigin,
          accessToken: options.accessToken,
          accessTokenProvider: options.accessTokenProvider,
          fetch: fetchMock
        }),
      openBrowser: async (url) => {
        opened.push(url);
        throw new AwError({
          code: "BROWSER_OPEN_FAILED",
          category: "auth",
          message: "Could not open the browser. Open the displayed URL manually."
        });
      }
    });
    command.exitOverride();
    await command.parseAsync(["--open"], { from: "user" });
    const expectedUrl = `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`;
    expect(opened).toHaveLength(1);
    expect(opened[0]?.toString()).toBe(expectedUrl);
    expect([...opened[0]!.searchParams.keys()]).toEqual(["workspace"]);
    expect(opened[0]?.toString()).not.toMatch(/token|secret|checkout|customer/i);
    expect(stdout.join("\n")).toContain(expectedUrl);
    expect(stdout.join("\n")).toContain("Available credits: 200");
    expect(stderr.join("\n")).toContain("could not be opened");
    expect(`${stdout.join("\n")}\n${stderr.join("\n")}`).not.toContain(TOKEN);
  });

  it("does not open a browser from createBillingCommand when stderr is not a TTY", async () => {
    const opened: URL[] = [];
    const stdout: string[] = [];
    const previousCi = process.env["CI"];
    delete process.env["CI"];
    try {
      const command = createBillingCommand({
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
        isTty: () => false,
        apiOrigin: () => new URL("http://127.0.0.1:8787"),
        accessToken: async () => TOKEN,
        identity: async () => hostedIdentity(),
        cloud: (options) =>
          new CloudClient({
            apiUrl: options.apiOrigin,
            accessToken: options.accessToken,
            accessTokenProvider: options.accessTokenProvider,
            fetch: fixtureFetch()
          }),
        openBrowser: async (url) => {
          opened.push(url);
        }
      });
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    } finally {
      if (previousCi === undefined) delete process.env["CI"];
      else process.env["CI"] = previousCi;
    }
    expect(opened).toEqual([]);
    expect(stdout.join("\n")).toContain("Available credits: 200");
    expect(stdout.join("\n")).toContain(
      `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`
    );
    expect(stdout.join("\n")).not.toContain(TOKEN);
  });

  it("never opens a browser for --json or --print even when a TTY is present", () => {
    expect(shouldOpenBillingBrowser({ json: true }, { isTty: () => true })).toBe(false);
    expect(shouldOpenBillingBrowser({ print: true }, { isTty: () => true })).toBe(false);
    expect(shouldOpenBillingBrowser({ open: true, env: { CI: "1" } })).toBe(true);
    expect(shouldOpenBillingBrowser({}, { isTty: () => false })).toBe(false);
    expect(shouldOpenBillingBrowser({ env: { CI: "1" } }, { isTty: () => true })).toBe(false);
  });

  it("treats a missing billing_portal_link_v1 as disabled purchasing, not a catalog price", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, {
          schemaVersion: "aw-billing/1",
          asOf: "2026-09-06T17:00:00.000Z",
          capabilities: ["usage_v1", "quote_v1", "status_v1"]
        });
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, {
          ...fixtureResponse("eligible_trial"),
          capabilities: ["usage_v1", "quote_v1", "status_v1"]
        });
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["billing", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.BILLING);
    const parsed = JSON.parse(result.stdout) as { code: string; safe_message: string };
    expect(parsed.code).toBe("UPDATE_REQUIRED");
    expect(parsed.safe_message.toLowerCase()).toContain("billing_portal_link_v1");
    expect(result.stdout).not.toContain("49");
    expect(result.stdout).not.toContain("149");
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("shows pending fulfillment without treating it as available credits", async () => {
    const cwd = await emptyCwd();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["pending_pack_purchase"]?.response);
        return true;
      }
      return false;
    });
    const json = await runSourceCli(["billing", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      availableUnits: number;
      pendingCommerce: { state: string; skuCode: string };
    };
    expect(parsed.availableUnits).toBe(200);
    expect(parsed.pendingCommerce.state).toBe("paid_unfulfilled");
    expect(parsed.pendingCommerce.skuCode).toBe("test_pack_300_v1");

    const human = await runSourceCli(["usage"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("Available credits: 200");
    expect(human.stdout).toContain("paid_unfulfilled");
    expect(human.stdout).toContain("not spendable");
    expect(human.stdout).not.toContain("500");
  });

  it("after fulfillment shows purchased credits without starting a new test", async () => {
    const cwd = await emptyCwd();
    let phase: "pending" | "fulfilled" = "pending";
    const fulfilled = {
      ...fixtureResponse("eligible_trial"),
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
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(
          response,
          200,
          phase === "pending" ? fixtures.fixtures["pending_pack_purchase"]?.response : fulfilled
        );
        return true;
      }
      return false;
    });
    const pending = await runSourceCli(["usage", "--json"], { cwd, env: usageEnv(server.baseUrl) });
    expect(pending.exitCode).toBe(0);
    expect(JSON.parse(pending.stdout).availableUnits).toBe(200);
    phase = "fulfilled";
    const after = await runSourceCli(["usage", "--json"], { cwd, env: usageEnv(server.baseUrl) });
    expect(after.exitCode).toBe(0);
    const parsed = JSON.parse(after.stdout) as {
      availableUnits: number;
      grantBalances: Array<{ origin: string; availableUnits: number }>;
    };
    expect(parsed.availableUnits).toBe(500);
    expect(parsed.grantBalances.some((lot) => lot.origin === "purchased" && lot.availableUnits === 300)).toBe(
      true
    );
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
    expect(paths).not.toContain("POST /v1/relay/runs");
  });

  it("repeat billing reads do not create checkout, runs, or reservations", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["pending_pack_purchase"]?.response);
        return true;
      }
      return false;
    });
    const first = await runSourceCli(["billing", "--json"], { cwd, env: usageEnv(server.baseUrl) });
    const second = await runSourceCli(["billing", "--print"], { cwd, env: usageEnv(server.baseUrl) });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).billingPageUrl).toBe(second.stdout.trim());
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
    expect(paths.every((path) => path.startsWith("GET "))).toBe(true);
  });

  it("refreshes a 401 without changing workspace or billing account", async () => {
    let token = TOKEN;
    const bearers: string[] = [];
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["absent_capability"]?.response);
      }
      if (url.pathname === "/v1/billing/usage") {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === `Bearer ${TOKEN}`) {
          return Response.json(
            {
              schemaVersion: "aw-billing/1",
              error: {
                code: "unauthenticated",
                message: "A valid CLI connector credential is required.",
                retryable: false
              }
            },
            { status: 401 }
          );
        }
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      throw new Error(`unexpected ${url.pathname}`);
    };
    const result = await runBilling(
      { print: true, json: true, env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787", AUGMENTWORKS_TOKEN: TOKEN } },
      {
        accessToken: async (request) => {
          if (request.forceRefresh === true) token = REFRESHED;
          return token;
        },
        identity: async () => ({
          subject: "user_test",
          email: "developer@example.com",
          workspaceId: WORKSPACE,
          workspaceName: "Fixture workspace",
          connectorId: "connector_test",
          connectorName: "Refunds Staging",
          scopes: ["connector:identity", "connector:run"]
        }),
        cloud: (options) =>
          new CloudClient({
            apiUrl: options.apiOrigin,
            accessToken: options.accessToken,
            accessTokenProvider: options.accessTokenProvider,
            fetch: fetchMock
          })
      }
    );
    expect(result.usage.workspaceId).toBe(WORKSPACE);
    expect(result.usage.billingAccountId).toBe(ACCOUNT);
    expect(result.billingPageUrl.searchParams.get("workspace")).toBe(WORKSPACE);
    expect(bearers).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${REFRESHED}`]);
  });

  it("does not invent an order-status mutation or foreign order lookup", async () => {
    const cwd = await emptyCwd();
    const result = await runSourceCli(["billing", "status", "not-an-order"], { cwd });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown command|too many arguments|error/i);
  });
});
