import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { runEstimate, runTest } from "../../src/commands/test.js";
import {
  CONVERSATION_STRATEGY_EXPLICIT_SESSION,
  advertisedTargetCapabilities
} from "../../src/config/conversation.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig, ResolvedConfig } from "../../src/config/types.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { loadCustomerSuiteFile } from "../../src/suite/load.js";

const fixtures = JSON.parse(
  await readFile(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "contracts/aw-billing-v1.fixtures.json"),
    "utf8"
  )
) as { fixtures: Record<string, { response: unknown; status?: number }> };

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function projectDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-suite-admit-"));
  temporaryDirectories.push(directory);
  await mkdir(resolve(directory, "references"));
  const suite = await readFile(
    resolve(projectRoot, "examples/customer-suites/faq-non-commerce.yaml"),
    "utf8"
  );
  const faq = await readFile(resolve(projectRoot, "examples/customer-suites/references/faq.md"), "utf8");
  await writeFile(resolve(directory, "faq-non-commerce.yaml"), suite, "utf8");
  await writeFile(resolve(directory, "references/faq.md"), faq, "utf8");
  const returns = await readFile(
    resolve(projectRoot, "examples/customer-suites/returns-14-day.yaml"),
    "utf8"
  );
  const policy = await readFile(
    resolve(projectRoot, "examples/customer-suites/references/returns-14-day.md"),
    "utf8"
  );
  await writeFile(resolve(directory, "returns-14-day.yaml"), returns, "utf8");
  await writeFile(resolve(directory, "references/returns-14-day.md"), policy, "utf8");
  return directory;
}

function chatConfig(options: { session?: boolean; observe?: boolean } = {}): AugmentWorksConfig {
  const session = options.session === true;
  return {
    version: 1,
    target: {
      name: "chat",
      connector: "http",
      base_url: "http://127.0.0.1:8000",
      ...(session ? { conversation: { strategy: CONVERSATION_STRATEGY_EXPLICIT_SESSION } } : {}),
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          ...(session ? { idempotent: true } : {}),
          request: session
            ? {
                message: "$input.message.content",
                conversation_id: "$input.conversation_id"
              }
            : { message: "$input.message.content" },
          response: { content: "$.answer" }
        },
        ...(options.observe === true
          ? {
              observe: { method: "POST", path: "/observe", idempotent: true }
            }
          : {})
      }
    },
    ...(options.observe === true
      ? { telemetry: { allow_observations: ["policy.window_days", "policy.permitted_refusal"] } }
      : {})
  };
}

function resolvedFor(options: { session?: boolean; observe?: boolean } = {}): ResolvedConfig {
  const inspection = resolveConfig(chatConfig(options), "/tmp/augmentworks.yaml", "/tmp", {});
  if (inspection.resolvedConfig === undefined) throw new Error("test config did not resolve");
  return inspection.resolvedConfig;
}

function doctorFor(options: { session?: boolean; observe?: boolean } = {}) {
  const resolved = resolvedFor(options);
  return async () => ({
    ok: true as const,
    configPath: resolved.configPath,
    offline: true as const,
    diagnostics: [],
    resolvedConfig: resolved
  });
}

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

describe("hosted customer suite admission", () => {
  it("pins the server-accepted revision through estimate and admission", async () => {
    const cwd = await projectDir();
    const loaded = await loadCustomerSuiteFile("faq-non-commerce.yaml", cwd);
    const paths: string[] = [];
    const quoteBodies: Array<Record<string, unknown>> = [];
    const createBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.pathname === "/v1/suites") {
        return Response.json({
          suiteId: "customer.faq.non_commerce",
          revisionId: "rev_pinned_1",
          contentHash: loaded.contentHash,
          schemaVersion: "aw-suite/1"
        });
      }
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        quoteBodies.push(body ?? {});
        return Response.json(fixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs") {
        createBodies.push(body ?? {});
        const request = body ?? {};
        return Response.json({
          protocol_version: "aw-relay/0.3",
          create_request_id: request["create_request_id"],
          create_request_sha256: sha256(canonicalize(request)),
          create_disposition: "created",
          run_id: "run-suite",
          session_id: "session-1",
          packet: { key: "customer-owned-suite", version: "1.0.0", sha256: "a".repeat(64) },
          config_sha256: request["config_sha256"],
          fencing_epoch: 1,
          status: "completed",
          dashboard_url: "http://127.0.0.1:8787/portal/runs/run-suite",
          run_expires_at: "2099-09-06T00:00:00.000Z",
          credit_state: "reserved"
        });
      }
      if (url.pathname === "/v1/relay/runs/run-suite") {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: "run-suite",
          status: "completed",
          credit_state: "reserved",
          outcome: "passed"
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    const estimate = await runEstimate(
      {
        cwd,
        suite: "faq-non-commerce.yaml",
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        doctor: doctorFor(),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock)
      }
    );
    expect(estimate.localPlanHash).toBe(loaded.contentHash);
    expect(estimate.advertisedCapabilities).toEqual(advertisedTargetCapabilities(resolvedFor()));
    expect(estimate.advertisedCapabilities).not.toHaveProperty("multi_turn");
    const estimateAssessment = quoteBodies[0]?.["assessment"] as Record<string, unknown>;
    expect(estimateAssessment["suite_id"]).toBe("customer.faq.non_commerce");
    expect(estimateAssessment["suite_revision_id"]).toBe("rev_pinned_1");
    expect(estimateAssessment["suite_content_hash"]).toBe(loaded.contentHash);

    await runTest(
      {
        cwd,
        suite: "faq-non-commerce.yaml",
        maxCredits: "30",
        yes: true,
        stateDirectory: cwd,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        doctor: doctorFor(),
        isInteractive: () => false,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock)
      }
    );
    const admitted = createBodies[0]?.["assessment"] as Record<string, unknown>;
    expect(admitted["suite_revision_id"]).toBe("rev_pinned_1");
    expect(admitted["suite_content_hash"]).toBe(loaded.contentHash);
    expect(createBodies[0]?.["packet"]).toEqual({ key: "customer-owned-suite", version: "1.0.0" });
    expect(paths.filter((path) => path.includes("/v1/relay/runs") && path.endsWith("/v1/relay/runs")).length).toBe(1);
  });

  it("does not silently admit a file that changed after quote", async () => {
    const cwd = await projectDir();
    const loaded = await loadCustomerSuiteFile("faq-non-commerce.yaml", cwd);
    let quoteCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.pathname === "/v1/suites") {
        return Response.json({
          suiteId: "customer.faq.non_commerce",
          revisionId: "rev_pinned_1",
          contentHash: loaded.contentHash
        });
      }
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        quoteCount += 1;
        const mutated = `${await readFile(resolve(cwd, "faq-non-commerce.yaml"), "utf8")}\n# mutated after quote\n`;
        await writeFile(resolve(cwd, "faq-non-commerce.yaml"), mutated, "utf8");
        return Response.json(fixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs") {
        throw new Error("create must not run after a post-quote file change");
      }
      throw new Error(`unexpected ${url.pathname} ${JSON.stringify(body)}`);
    });

    await expect(
      runTest(
        {
          cwd,
          suite: "faq-non-commerce.yaml",
          maxCredits: "30",
          yes: true,
          stateDirectory: cwd,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "SUITE_CHANGED_AFTER_QUOTE" });
    expect(quoteCount).toBe(1);
  });

  it("refuses a server revision whose content hash differs from the local file", async () => {
    const cwd = await projectDir();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/suites") {
        return Response.json({
          suiteId: "customer.faq.non_commerce",
          revisionId: "rev_other",
          contentHash: "b".repeat(64)
        });
      }
      if (url.pathname === "/v1/relay/runs") {
        throw new Error("create must not run after a hash mismatch");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    await expect(
      runEstimate(
        {
          cwd,
          suite: "faq-non-commerce.yaml",
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "SUITE_REVISION_HASH_MISMATCH" });
  });

  it("requires --max-credits for noninteractive suite admission before suite HTTP", async () => {
    const cwd = await projectDir();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      throw new Error(`unexpected ${String(input)}`);
    });
    await expect(
      runTest(
        {
          cwd,
          suite: "faq-non-commerce.yaml",
          yes: true,
          stateDirectory: cwd,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock),
          openBrowser: async () => {
            throw new Error("browser must not open");
          }
        }
      )
    ).rejects.toMatchObject({ code: "MAX_CREDITS_REQUIRED", category: "config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when a multi-turn suite meets a single-turn connector", async () => {
    const cwd = await projectDir();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      throw new Error(`unexpected ${String(input)}`);
    });
    await expect(
      runTest(
        {
          cwd,
          suite: "returns-14-day.yaml",
          maxCredits: "30",
          yes: true,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor({ observe: true }),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "CONVERSATION_CAPABILITY_INCOMPATIBLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
