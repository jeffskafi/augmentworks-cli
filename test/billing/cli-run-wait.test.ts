import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { runPackedCli, runSourceCli } from "../util/cli-process.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";
import {
  billingRunStatusDocument,
  deterministicCompletedDocument,
  RUN_STATUS_RUN_ID,
  RUN_STATUS_WORKSPACE,
  unfinishedRunningAbsentDocument
} from "./run-status-fixtures.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_run_wait";
const fixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean> | boolean;

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];

beforeAll(() => {
  const packed = spawnSync("npm", ["run", "build"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (packed.status !== 0) {
    throw new Error(`packed CLI build failed:\n${packed.stdout}\n${packed.stderr}`);
  }
}, 60_000);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function emptyCwd(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-run-wait-"));
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
    workspace_id: RUN_STATUS_WORKSPACE,
    workspace_name: "Fixture workspace",
    connector_id: "connector_test",
    connector_name: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"]
  };
}

async function startMock(
  handler: Handler
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

function hostedEnv(apiOrigin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUGMENTWORKS_API_URL: apiOrigin,
    AUGMENTWORKS_TOKEN: TOKEN,
    CI: "1",
    NO_COLOR: "1"
  };
}

function capabilitiesAndIdentity(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
    send(response, 200, identity());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
    send(response, 200, fixtures.fixtures["absent_capability"]?.response);
    return true;
  }
  return false;
}

function assertReadOnlyObservation(paths: readonly string[]): void {
  expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  expect(paths).not.toContain("POST /v1/billing/quote");
  expect(paths).not.toContain("POST /v1/relay/runs");
  expect(paths).not.toContain("POST /v1/relay/run-intents:reconcile");
  expect(paths.every((path) => !path.endsWith(":retry-evaluation"))).toBe(true);
}

describe("packed run wait classification", () => {
  it("does not exit 0 for the running/absent/0-of-10/null-outcome reproduction", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (capabilitiesAndIdentity(request, response, url)) return true;
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        expect(url.searchParams.get("runId")).toBe(RUN_STATUS_RUN_ID);
        send(response, 200, unfinishedRunningAbsentDocument());
        return true;
      }
      return false;
    });

    const result = await runPackedCli(
      ["run", "wait", RUN_STATUS_RUN_ID, "--json", "--timeout-ms", "50"],
      { cwd, env: hostedEnv(server.baseUrl), timeoutMs: 15_000 }
    );

    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      code: string;
      exit_code: number;
      details?: { original_run_id?: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("EVALUATION_INCOMPLETE");
    expect(payload.exit_code).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(payload.details?.original_run_id).toBe(RUN_STATUS_RUN_ID);
    expect(`${result.stdout}${result.stderr}`).toContain(RUN_STATUS_RUN_ID);
    expect(`${result.stdout}${result.stderr}`).toContain("run wait");
    assertReadOnlyObservation(paths);
    expect(paths.filter((path) => path === "GET /v1/billing/status").length).toBeGreaterThanOrEqual(1);
  });

  it("a timed-out wait stays read-only and names the original run", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (capabilitiesAndIdentity(request, response, url)) return true;
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        send(response, 200, unfinishedRunningAbsentDocument());
        return true;
      }
      return false;
    });

    const result = await runPackedCli(
      ["run", "wait", RUN_STATUS_RUN_ID, "--timeout-ms", "40"],
      { cwd, env: hostedEnv(server.baseUrl), timeoutMs: 15_000 }
    );

    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(result.stderr).toContain(`Original run ${RUN_STATUS_RUN_ID}`);
    expect(result.stderr).toContain("did not create a quote, reservation, target execution, or new run");
    expect(result.stderr).toContain(`augmentworks run wait ${RUN_STATUS_RUN_ID}`);
    assertReadOnlyObservation(paths);
  });

  it("waits from running/absent into terminal deterministic success and exits 0", async () => {
    const cwd = await emptyCwd();
    let statusReads = 0;
    const { server, paths } = await startMock((request, response, url) => {
      if (capabilitiesAndIdentity(request, response, url)) return true;
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        statusReads += 1;
        send(
          response,
          200,
          statusReads === 1 ? unfinishedRunningAbsentDocument() : deterministicCompletedDocument("passed")
        );
        return true;
      }
      return false;
    });

    const result = await runPackedCli(
      ["run", "wait", RUN_STATUS_RUN_ID, "--json", "--timeout-ms", "8000"],
      { cwd, env: hostedEnv(server.baseUrl), timeoutMs: 15_000 }
    );

    expect(result.exitCode).toBe(EXIT.OK);
    expect(statusReads).toBeGreaterThanOrEqual(2);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      observation: string;
      work: string;
      assessment: string;
      wait_terminal: boolean;
      release_success: boolean;
      exit_code: number;
      executionStatus: string;
      evaluationStatus: string;
      originalRunId: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.observation).toBe("success");
    expect(payload.work).toBe("terminal");
    expect(payload.assessment).toBe("passed");
    expect(payload.wait_terminal).toBe(true);
    expect(payload.release_success).toBe(true);
    expect(payload.exit_code).toBe(EXIT.OK);
    expect(payload.executionStatus).toBe("completed");
    expect(payload.evaluationStatus).toBe("absent");
    expect(payload.originalRunId).toBe(RUN_STATUS_RUN_ID);
    assertReadOnlyObservation(paths);
  });

  it("run status of the unfinished reproduction exits 11 with release_success false", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (capabilitiesAndIdentity(request, response, url)) return true;
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        send(response, 200, unfinishedRunningAbsentDocument());
        return true;
      }
      return false;
    });

    const result = await runPackedCli(["run", "status", RUN_STATUS_RUN_ID, "--json"], {
      cwd,
      env: hostedEnv(server.baseUrl)
    });

    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      observation: string;
      release_success: boolean;
      wait_terminal: boolean;
      exit_code: number;
      originalRunId: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.observation).toBe("success");
    expect(payload.release_success).toBe(false);
    expect(payload.wait_terminal).toBe(false);
    expect(payload.exit_code).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(payload.originalRunId).toBe(RUN_STATUS_RUN_ID);
    assertReadOnlyObservation(paths);
  });
});

describe("source run wait and status exits", () => {
  it("maps cancelled, failed, pending, unsupported, and unknown through the packed-equivalent source CLI", async () => {
    const rows: Array<{
      document: Record<string, unknown>;
      exit: number;
      assessment?: string;
    }> = [
      {
        document: billingRunStatusDocument({
          executionStatus: "cancelled",
          evaluationStatus: "absent",
          plannedJudgeJobs: 0
        }),
        exit: EXIT.INTERRUPTED,
        assessment: "interrupted"
      },
      {
        document: billingRunStatusDocument({
          executionStatus: "failed",
          evaluationStatus: "absent",
          plannedJudgeJobs: 0
        }),
        exit: EXIT.ASSESSMENT_FAILED,
        assessment: "failed"
      },
      {
        document: billingRunStatusDocument({
          executionStatus: "completed",
          evaluationStatus: "pending",
          plannedJudgeJobs: 4
        }),
        exit: EXIT.EVALUATION_INCOMPLETE,
        assessment: "incomplete"
      },
      {
        document: billingRunStatusDocument({
          executionStatus: "completed",
          evaluationStatus: "unsupported"
        }),
        exit: EXIT.EVALUATION_ERROR,
        assessment: "unsupported"
      },
      {
        document: billingRunStatusDocument({
          executionStatus: "bogus",
          evaluationStatus: "absent",
          plannedJudgeJobs: 0
        }),
        exit: EXIT.EVALUATION_INCOMPLETE,
        assessment: "unknown"
      }
    ];

    for (const row of rows) {
      const cwd = await emptyCwd();
      const { server, paths } = await startMock((request, response, url) => {
        if (capabilitiesAndIdentity(request, response, url)) return true;
        if (request.method === "GET" && url.pathname === "/v1/billing/status") {
          send(response, 200, row.document);
          return true;
        }
        return false;
      });
      const result = await runSourceCli(["run", "status", RUN_STATUS_RUN_ID, "--json"], {
        cwd,
        env: hostedEnv(server.baseUrl)
      });
      expect(result.exitCode, JSON.stringify(row.document)).toBe(row.exit);
      const payload = JSON.parse(result.stdout) as {
        assessment: string;
        release_success: boolean;
        exit_code: number;
      };
      expect(payload.release_success).toBe(false);
      expect(payload.exit_code).toBe(row.exit);
      if (row.assessment !== undefined) expect(payload.assessment).toBe(row.assessment);
      assertReadOnlyObservation(paths);
    }
  });
});
