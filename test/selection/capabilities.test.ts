import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import type { CompileSuiteSelectionCapabilities } from "../../src/selection/schema.js";
import { runPackedCli, runSourceCli } from "../util/cli-process.js";
import { listenLoopback, readJsonBody, type ListeningServer } from "../util/http-server.js";
import {
  ACTION_CONNECTOR_CAPABILITIES,
  ACTION_QUICK_CASE_IDS,
  actionConnectorYaml,
  actionQuickAssessmentYaml,
  CAPABILITY_FREE_SNAPSHOT,
  chatConnectorYaml,
  compileResponseForCapabilities
} from "./connectors.js";

const TOKEN = "aw_connector_test_access_token_selection";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

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

async function startMock(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) => Promise<boolean> | boolean
): Promise<{ server: ListeningServer; paths: string[] }> {
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

function runEnv(apiOrigin: string, stateDirectory?: string): NodeJS.ProcessEnv {
  return {
    AUGMENTWORKS_API_URL: apiOrigin,
    AUGMENTWORKS_TOKEN: TOKEN,
    AUGMENTWORKS_API_KEY: "",
    AUGMENTWORKS_REFRESH_TOKEN: "",
    CI: "1",
    NO_COLOR: "1",
    ...(stateDirectory === undefined ? {} : { AUGMENTWORKS_STATE_DIR: stateDirectory })
  };
}

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "aw-selection-caps-"));
  temporaryDirectories.push(cwd);
  return cwd;
}

async function writeActionProject(
  cwd: string,
  yaml: string,
  withAssessment = false
): Promise<void> {
  await writeFile(join(cwd, "augmentworks.yaml"), yaml, "utf8");
  if (!withAssessment) return;
  await mkdir(join(cwd, "references"));
  await writeFile(join(cwd, "references/refund-policy.md"), "# Synthetic refund policy\n", "utf8");
  await writeFile(join(cwd, "augmentworks.assessment.yaml"), actionQuickAssessmentYaml(), "utf8");
}

async function compileAgainstCapabilities(
  args: readonly string[],
  cwd: string,
  runner: typeof runSourceCli = runSourceCli
): Promise<{
  result: Awaited<ReturnType<typeof runSourceCli>>;
  paths: string[];
  body: Record<string, unknown> | undefined;
}> {
  let body: Record<string, unknown> | undefined;
  const { server, paths } = await startMock(async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
      send(response, 200, identity());
      return true;
    }
    if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
      body = (await readJsonBody(request)) as Record<string, unknown>;
      const capabilities = body["capabilities"] as CompileSuiteSelectionCapabilities;
      const compiled = compileResponseForCapabilities(capabilities);
      send(response, compiled.status, compiled.response);
      return true;
    }
    return false;
  });
  const result = await runner(args, { cwd, env: runEnv(server.baseUrl) });
  return { result, paths, body };
}

describe("selection compile capability advertisement", () => {
  it("sends the exact action-connector snapshot and includes action-quick cases", async () => {
    const cwd = await workspace();
    await writeActionProject(cwd, actionConnectorYaml());
    const { result, paths, body } = await compileAgainstCapabilities(
      ["selection", "compile", "--profile", "smoke", "--include-catalog", "--json"],
      cwd
    );
    expect(body).toMatchObject({
      schemaVersion: "aw-suite-selection/1",
      profile: "smoke",
      conversationMode: "single_turn",
      includeCatalog: true,
      capabilities: ACTION_CONNECTOR_CAPABILITIES
    });
    expect(body).not.toHaveProperty("acceptedManifestVersions");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      includedCaseCount: number;
      included: { caseId: string }[];
      createsBillableRun: boolean;
    };
    expect(payload.includedCaseCount).toBe(5);
    expect(payload.included.map((row) => row.caseId)).toEqual([...ACTION_QUICK_CASE_IDS]);
    expect(payload.createsBillableRun).toBe(false);
    expect(paths).toContain("POST /v1/suite-selections/compile");
    expect(paths).not.toContain("POST /v1/billing/quote");
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
  });

  it("uses the same snapshot for assessment-driven compile", async () => {
    const cwd = await workspace();
    await writeActionProject(cwd, actionConnectorYaml(), true);
    const { result, body } = await compileAgainstCapabilities(
      ["selection", "compile", "--assessment", "augmentworks.assessment.yaml", "--json"],
      cwd
    );
    expect(body?.["capabilities"]).toEqual(ACTION_CONNECTOR_CAPABILITIES);
    expect(body?.["requestedCaseIds"]).toEqual([...ACTION_QUICK_CASE_IDS]);
    expect(body).not.toHaveProperty("acceptedManifestVersions");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { includedCaseCount: number };
    expect(payload.includedCaseCount).toBe(5);
  });

  it("keeps explicit-session multiTurn truthful", async () => {
    const cwd = await workspace();
    await writeActionProject(cwd, actionConnectorYaml({ session: true }));
    const { result, body } = await compileAgainstCapabilities(
      ["selection", "compile", "--profile", "smoke", "--include-catalog", "--json"],
      cwd
    );
    expect(body?.["conversationMode"]).toBe("explicit_session_v1");
    expect(body?.["capabilities"]).toEqual({
      ...ACTION_CONNECTOR_CAPABILITIES,
      multiTurn: true
    });
    expect(result.exitCode).toBe(0);
  });

  it("keeps response-only and missing-default paths capability-free", async () => {
    const withChat = await workspace();
    await writeActionProject(withChat, chatConnectorYaml());
    const chat = await compileAgainstCapabilities(
      ["selection", "compile", "--profile", "smoke", "--include-catalog", "--json"],
      withChat
    );
    expect(chat.body?.["capabilities"]).toEqual(CAPABILITY_FREE_SNAPSHOT);
    expect(chat.body?.["conversationMode"]).toBe("single_turn");
    expect(chat.result.exitCode).toBe(EXIT.CONFIG);
    expect(chat.result.stderr).toContain("SELECTION_UNEXECUTABLE");
    const chatPayload = JSON.parse(chat.result.stdout) as { incompatible: { reasonCode: string }[] };
    expect(chatPayload.incompatible.some((row) => row.reasonCode === "capability_prepare")).toBe(true);

    const missing = await workspace();
    const none = await compileAgainstCapabilities(
      ["selection", "compile", "--profile", "smoke", "--include-catalog", "--json"],
      missing
    );
    expect(none.body?.["capabilities"]).toEqual(CAPABILITY_FREE_SNAPSHOT);
    expect(none.result.exitCode).toBe(EXIT.CONFIG);
  });

  it("does not overstate support when a required hook or observation key is removed", async () => {
    const cases: Array<{
      yaml: string;
      expected: Partial<CompileSuiteSelectionCapabilities>;
      reason: string;
    }> = [
      {
        yaml: actionConnectorYaml({ allowToolEvents: false }),
        expected: { toolEvents: false },
        reason: "capability_tool_events"
      },
      {
        yaml: actionConnectorYaml({
          observationKeys: ["order.refunded_amount", "order.refundable"]
        }),
        expected: { observationKeys: ["order.refundable", "order.refunded_amount"] },
        reason: "capability_observation_key"
      }
    ];
    for (const entry of cases) {
      const cwd = await workspace();
      await writeActionProject(cwd, entry.yaml);
      const { result, body, paths } = await compileAgainstCapabilities(
        ["selection", "compile", "--profile", "smoke", "--include-catalog", "--json"],
        cwd
      );
      expect(body?.["capabilities"]).toMatchObject(entry.expected);
      expect(result.exitCode).toBe(EXIT.CONFIG);
      expect(result.stderr).toContain("SELECTION_UNEXECUTABLE");
      const payload = JSON.parse(result.stdout) as { incompatible: { reasonCode: string }[] };
      expect(payload.incompatible.some((row) => row.reasonCode === entry.reason)).toBe(true);
      expect(paths).not.toContain("POST /v1/billing/quote");
    }
  });

  it("exits with the config diagnostic before authentication when the selected file is invalid", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "broken.yaml"), "version: [\n", "utf8");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      return false;
    });
    const malformed = await runSourceCli(
      ["selection", "compile", "--config", "broken.yaml", "--profile", "smoke", "--include-catalog"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(malformed.exitCode).toBe(EXIT.CONFIG);
    expect(malformed.stderr).toMatch(/Error \[[A-Z0-9_]+\]:/);
    expect(paths).toEqual([]);

    const missing = await runSourceCli(
      ["selection", "compile", "--config", "nope.yaml", "--profile", "smoke", "--include-catalog"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(missing.exitCode).toBe(EXIT.CONFIG);
    expect(missing.stderr).toContain("CONFIG_FILE_NOT_FOUND");
    expect(paths).toEqual([]);

    await writeFile(join(cwd, "incomplete.yaml"), actionConnectorYaml({ omitPrepare: true }), "utf8");
    const incomplete = await runSourceCli(
      ["selection", "compile", "--config", "incomplete.yaml", "--profile", "smoke", "--include-catalog"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(incomplete.exitCode).toBe(EXIT.CONFIG);
    expect(incomplete.stderr).toContain("LIFECYCLE_INCOMPLETE");
    expect(paths).toEqual([]);
  });

  it("sends the same packed-package compile body for an action connector", async () => {
    const cwd = await workspace();
    await writeActionProject(cwd, actionConnectorYaml());
    const { result, body, paths } = await compileAgainstCapabilities(
      ["selection", "compile", "--profile", "smoke", "--include-catalog", "--json"],
      cwd,
      runPackedCli
    );
    expect(body?.["capabilities"]).toEqual(ACTION_CONNECTOR_CAPABILITIES);
    expect(result.exitCode).toBe(0);
    expect(paths).not.toContain("POST /v1/billing/quote");
  });
});
