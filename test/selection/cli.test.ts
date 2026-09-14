import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createTestCommand } from "../../src/commands/test.js";
import { EXIT } from "../../src/errors.js";
import { computeManifestIntegrityHash } from "../../src/selection/admit.js";
import type { SuiteSelectionManifest } from "../../src/selection/schema.js";
import { runSourceCli } from "../util/cli-process.js";
import { listenLoopback, readJsonBody, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_selection";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const fixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-suite-selection-v1.fixtures.json"), "utf8")
) as {
  fixtures: Record<string, { status?: number; response: unknown }>;
};

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

function fixture(name: string): { status: number; response: unknown } {
  const entry = fixtures.fixtures[name];
  if (entry === undefined) throw new Error(`missing fixture ${name}`);
  return { status: entry.status ?? 200, response: entry.response };
}

describe("selection and manifest-gate CLI", () => {
  it("documents catalog, selection, test shard, and gate manifest flags", async () => {
    const catalog = await runSourceCli(["catalog", "--help"], { cwd: projectRoot });
    expect(catalog.exitCode).toBe(0);
    expect(catalog.stdout).toContain("list");
    expect(catalog.stdout).toContain("show");

    const selection = await runSourceCli(["selection", "--help"], { cwd: projectRoot });
    expect(selection.exitCode).toBe(0);
    expect(selection.stdout).toContain("compile");

    const compile = await runSourceCli(["selection", "compile", "--help"], { cwd: projectRoot });
    expect(compile.exitCode).toBe(0);
    expect(compile.stdout).toContain("--json");
    expect(compile.stdout).toContain("--include-catalog");
    expect(compile.stdout).toContain("Not a quote");

    const testHelp = await runSourceCli(["test", "--help"], { cwd: projectRoot });
    expect(testHelp.stdout).toContain("--manifest");
    expect(testHelp.stdout).toContain("--shard");
    expect(testHelp.stdout).toContain("--all-shards");
    expect(testHelp.stdout).toContain("--artifact-out");

    const gateHelp = await runSourceCli(["gate", "--help"], { cwd: projectRoot });
    expect(gateHelp.stdout).toContain("--manifest-file");
    expect(gateHelp.stdout).toContain("--declared-shards");
    expect(gateHelp.stdout).toContain("aw-manifest-release-policy/2");
  });

  it("rejects hosted selection flags with --local", async () => {
    const compile = await runSourceCli(
      ["selection", "compile", "--local", "--profile", "smoke"],
      { cwd: projectRoot }
    );
    expect(compile.exitCode).toBe(EXIT.CONFIG);
    expect(compile.stderr).toContain("HOSTED_SELECTION_UNSUPPORTED_LOCAL");

    const test = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();
    await expect(
      test.parseAsync(
        ["node", "augmentworks", "--local", "--packet", "x@1.0.0", "--manifest", "manifest.json"],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "HOSTED_SELECTION_UNSUPPORTED_LOCAL" });
  });

  it("prints an empty compile and refuses quote", async () => {
    const empty = fixture("compile_empty");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        expect(body["schemaVersion"]).toBe("aw-suite-selection/1");
        expect(body["profile"]).toBe("smoke");
        expect(body["includeCatalog"]).toBe(true);
        expect(body).not.toHaveProperty("acceptedManifestVersions");
        expect(body["conversationMode"]).toBe("single_turn");
        expect(body["capabilities"]).toEqual({
          prepare: false,
          observation: false,
          toolEvents: false,
          cleanup: false,
          multiTurn: false,
          observationKeys: []
        });
        send(response, empty.status, empty.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(
      ["selection", "compile", "--profile", "smoke", "--include-catalog", "--include-tags", "no-such-tag", "--json"],
      { cwd: projectRoot, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain("SELECTION_EMPTY");
    const payload = JSON.parse(result.stdout) as {
      includedCaseCount: number;
      executable: boolean;
      createsBillableRun: boolean;
    };
    expect(payload.includedCaseCount).toBe(0);
    expect(payload.executable).toBe(false);
    expect(payload.createsBillableRun).toBe(false);
    expect(paths).not.toContain("POST /v1/billing/quote");
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
  });

  it("surfaces incompatible session capability instead of hiding cases", async () => {
    const compiled = fixture("compile_incompatible_session");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
        send(response, compiled.status, compiled.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(
      ["selection", "compile", "--profile", "release", "--include-catalog", "--json"],
      { cwd: projectRoot, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain("SELECTION_UNEXECUTABLE");
    const payload = JSON.parse(result.stdout) as {
      incompatible: { reasonCode: string }[];
    };
    expect(payload.incompatible.some((row) => row.reasonCode === "capability_multi_turn")).toBe(true);
    expect(paths).not.toContain("POST /v1/billing/quote");
  });

  it("refuses a compiled shard that exceeds frozen per-run limits", async () => {
    const compiled = fixture("compile_per_run_expanded_limit");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
        send(response, compiled.status, compiled.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(
      ["selection", "compile", "--profile", "release", "--include-catalog", "--json"],
      { cwd: projectRoot, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain("PER_RUN_EXPANDED_LIMIT");
    expect(paths).not.toContain("POST /v1/billing/quote");
  });

  it("writes an immutable executable compile without quoting", async () => {
    const compiled = fixture("compile_executable");
    const cwd = await mkdtemp(join(tmpdir(), "aw-selection-"));
    temporaryDirectories.push(cwd);
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
        send(response, compiled.status, compiled.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(
      [
        "selection",
        "compile",
        "--profile",
        "release",
        "--include-catalog",
        "--json",
        "--out",
        "suite-selection.manifest.json"
      ],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      includedCaseCount: number;
      shards: { packetBindings: { key: string }[] }[];
      createsBillableRun: boolean;
    };
    expect(payload.includedCaseCount).toBe(2);
    expect(payload.shards[0]?.packetBindings[0]?.key).toBe("aw-customer-suite");
    expect(payload.createsBillableRun).toBe(false);
    expect(paths).not.toContain("POST /v1/billing/quote");
  });

  it("rejects an incomplete declared shard set before any network call", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aw-gate-manifest-"));
    temporaryDirectories.push(cwd);
    const compiled = fixture("compile_executable");
    const hashed = {
      ...(compiled.response as Record<string, unknown>),
      manifestHash: computeManifestIntegrityHash(compiled.response as SuiteSelectionManifest)
    };
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(hashed, null, 2)}\n`, "utf8");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      return false;
    });
    const result = await runSourceCli(
      ["gate", "--manifest-file", "suite-selection.manifest.json", "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain("MANIFEST_DECLARATION_INCOMPLETE");
    expect(paths).not.toContain("POST /v1/release-gates/evaluate-manifest");
    expect(paths).not.toContain("GET /api/v1/cli/auth/me");
    expect(paths).not.toContain("POST /v1/billing/quote");
  });

  it("maps a complete server-authoritative v2 pass without starting another run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aw-gate-pass-"));
    temporaryDirectories.push(cwd);
    const compiled = fixture("compile_executable").response as SuiteSelectionManifest;
    const hashed = { ...compiled, manifestHash: computeManifestIntegrityHash(compiled) };
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(hashed, null, 2)}\n`, "utf8");
    await writeFile(
      join(cwd, "declared-shards.json"),
      `${JSON.stringify({
        schemaVersion: "aw-selection-artifact/1",
        manifestHash: hashed.manifestHash,
        expectedShardIds: ["shard-000"],
        declaredShards: [
          {
            shardId: "shard-000",
            shardIdentityHash: hashed.shards[0]?.shardIdentityHash,
            runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          }
        ],
        missingShardIds: [],
        skippedShardIds: [],
        failedShardIds: [],
        createsBillableRun: false
      })}\n`,
      "utf8"
    );
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate-manifest") {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        expect(body["schemaVersion"]).toBe("aw-manifest-release-gate-request/2");
        expect(body).not.toHaveProperty("manifest");
        send(response, 200, {
          documentKind: "aw-manifest-release-policy/2",
          manifestHash: hashed.manifestHash,
          decision: "pass",
          coverageComplete: true,
          evidenceSource: "server",
          reasonCodes: [],
          resolvedShards: [
            {
              shardId: "shard-000",
              shardIdentityHash: hashed.shards[0]?.shardIdentityHash,
              runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              executionState: "completed",
              evaluationStatus: "completed",
              decision: "pass"
            }
          ],
          createsBillableRun: false
        });
        return true;
      }
      return false;
    });
    const result = await runSourceCli(
      [
        "gate",
        "--manifest-file",
        "suite-selection.manifest.json",
        "--declared-shards",
        "declared-shards.json",
        "--json"
      ],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { assessment: string; decision: string; documentKind: string };
    expect(payload.assessment).toBe("passed");
    expect(payload.decision).toBe("pass");
    expect(payload.documentKind).toBe("aw-manifest-release-policy/2");
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
  });
});
