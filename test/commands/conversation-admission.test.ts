import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as assessment from "../../src/assessment/index.js";
import { CloudClient } from "../../src/cloud/client.js";
import { runEstimate, runTest } from "../../src/commands/test.js";
import {
  CONVERSATION_STRATEGY_EXPLICIT_SESSION,
  advertisedTargetCapabilities
} from "../../src/config/conversation.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig, ResolvedConfig } from "../../src/config/types.js";
import { EXIT } from "../../src/errors.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";

const fixtures = JSON.parse(
  await readFile(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "contracts/aw-billing-v1.fixtures.json"),
    "utf8"
  )
) as { fixtures: Record<string, { response: unknown; status?: number }> };

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function projectDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-session-admit-"));
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

function chatConfig(session = false): AugmentWorksConfig {
  return {
    version: 1,
    target: {
      name: "chat",
      connector: "http",
      base_url: "http://127.0.0.1:8000",
      ...(session
        ? { conversation: { strategy: CONVERSATION_STRATEGY_EXPLICIT_SESSION } }
        : {}),
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
        }
      }
    }
  };
}

function resolvedFor(session = false): ResolvedConfig {
  const inspection = resolveConfig(chatConfig(session), "/tmp/augmentworks.yaml", "/tmp", {});
  if (inspection.resolvedConfig === undefined) throw new Error("test config did not resolve");
  return inspection.resolvedConfig;
}

function doctorFor(session = false) {
  const resolved = resolvedFor(session);
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

describe("hosted conversation admission", () => {
  it("sends identical capability objects on estimate and execute", async () => {
    const cwd = await projectDir();
    const quoteBodies: Array<Record<string, unknown>> = [];
    const createBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
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
          run_id: "run-quoted",
          session_id: "session-1",
          packet: { key: "response-quality", version: "0.1.0", sha256: "a".repeat(64) },
          config_sha256: request["config_sha256"],
          fencing_epoch: 1,
          status: "completed",
          dashboard_url: "http://127.0.0.1:8787/portal/runs/run-quoted",
          run_expires_at: "2099-09-06T00:00:00.000Z",
          credit_state: "reserved"
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
    const estimate = await runEstimate(
      { cwd, assessment: "augmentworks.assessment.yaml", env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" } },
      {
        doctor: doctorFor(false),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud
      }
    );
    expect(estimate.quote.scenarioCount).toBe(10);
    expect(estimate.advertisedCapabilities).toEqual(advertisedTargetCapabilities(resolvedFor(false)));
    expect(estimate.advertisedCapabilities).not.toHaveProperty("multi_turn");

    await runTest(
      {
        cwd,
        assessment: "augmentworks.assessment.yaml",
        maxCredits: "30",
        yes: true,
        stateDirectory: cwd,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        doctor: doctorFor(false),
        isInteractive: () => false,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud,
        connector: () => {
          throw new Error("target must not be constructed for a completed create");
        }
      }
    );

    const quoteCapabilities = (quoteBodies[0]?.["target"] as { capabilities: unknown }).capabilities;
    const createCapabilities = (createBodies[0]?.["target"] as { capabilities: unknown }).capabilities;
    expect(quoteCapabilities).toEqual(createCapabilities);
    expect(quoteCapabilities).toEqual(estimate.advertisedCapabilities);
  });

  it("advertises explicit_session_v1 on estimate and execute when configured", async () => {
    const cwd = await projectDir();
    const quoteBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(fixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        quoteBodies.push(body ?? {});
        return Response.json(fixtures.fixtures["quote_success_with_balance"]?.response);
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const estimate = await runEstimate(
      { cwd, assessment: "augmentworks.assessment.yaml", env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" } },
      {
        doctor: doctorFor(true),
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
    );
    expect(estimate.advertisedCapabilities).toMatchObject({
      multi_turn: true,
      conversation: {
        version: "aw-conversation-enforcement/1",
        strategy: "explicit_session_v1"
      }
    });
    expect((quoteBodies[0]?.["target"] as { capabilities: unknown }).capabilities).toEqual(
      estimate.advertisedCapabilities
    );
  });

  it("rejects an unsupported multi-turn plan before quote or reservation", async () => {
    vi.spyOn(assessment, "packetRequiresMultiTurn").mockResolvedValue(true);
    const cwd = await projectDir();
    const counts = { quote: 0, create: 0, capabilities: 0 };
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
      if (url.pathname === "/v1/relay/runs") {
        counts.create += 1;
        throw new Error("create must not be called");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const deps = {
      doctor: doctorFor(false),
      accessToken: async () => "token",
      identity: async () => identity(),
      cloud: (options: {
        apiOrigin: URL;
        accessToken: string;
        accessTokenProvider: () => Promise<string>;
      }) =>
        new CloudClient({
          apiUrl: options.apiOrigin,
          accessToken: options.accessToken,
          accessTokenProvider: options.accessTokenProvider,
          fetch: fetchMock
        }),
      connector: () => {
        throw new Error("target must not be constructed");
      }
    };

    await expect(
      runEstimate(
        { cwd, assessment: "augmentworks.assessment.yaml", env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" } },
        deps
      )
    ).rejects.toMatchObject({
      code: "CONVERSATION_CAPABILITY_INCOMPATIBLE",
      category: "config"
    });
    await expect(
      runTest(
        {
          cwd,
          assessment: "augmentworks.assessment.yaml",
          maxCredits: "30",
          yes: true,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        { ...deps, isInteractive: () => false }
      )
    ).rejects.toMatchObject({
      code: "CONVERSATION_CAPABILITY_INCOMPATIBLE",
      category: "config"
    });
    expect(counts).toEqual({ quote: 0, create: 0, capabilities: 0 });
    expect(EXIT.CONFIG).toBe(2);
  });
});
