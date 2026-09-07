import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/commands/doctor.js";
import { runInit } from "../../src/commands/init.js";
import { runProbeCommand } from "../../src/commands/probe.js";
import { EXIT } from "../../src/errors.js";
import { probeExitCode } from "../../src/connector/connection-probe.js";
import { listenLoopback, readJsonBody, sendJson, type ListeningServer } from "../util/http-server.js";

const directories: string[] = [];
const servers: ListeningServer[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-probe-cmd-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("probe command", () => {
  it("prints a preflight plan without calling the target", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory, env: false, starter: "response-quality" });
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      return fetch(input, init);
    };
    const { report } = await runProbeCommand({
      cwd: directory,
      processEnv: {
        CHATBOT_BASE_URL: "http://127.0.0.1:65535",
        CHATBOT_API_KEY: "command-probe-secret"
      },
      fetch: fetchImpl
    });
    expect(report.executed).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.preflight.call_count).toBe(1);
    expect(report.pattern).toBe("response-only");
    expect(calls).toBe(0);
    expect(JSON.stringify(report)).not.toContain("command-probe-secret");
  });

  it("does not run during doctor or init", async () => {
    const directory = await temporaryDirectory();
    let calls = 0;
    const http = createServer((_request, response) => {
      calls += 1;
      sendJson(response, 200, { answer: "should-not-run", finished: true });
    });
    const server = await listenLoopback(http);
    servers.push(server);
    await runInit({ cwd: directory, starter: "response-quality" });
    const doctor = await runDoctor({
      cwd: directory,
      processEnv: {
        CHATBOT_BASE_URL: server.baseUrl,
        CHATBOT_API_KEY: "doctor-must-not-call"
      }
    });
    expect(doctor.ok).toBe(true);
    expect(doctor.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["CONNECTION_PROBE_AVAILABLE", "OFFLINE_CHECK_COMPLETE"])
    );
    expect(calls).toBe(0);
  });

  it("executes a response-only probe against a fixture server", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory, starter: "response-quality", env: false });
    const http = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer command-probe-secret") {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      void readJsonBody(request).then((body) => {
        sendJson(response, 200, {
          answer: String((body as { message?: string }).message ?? "").includes("probe-ack")
            ? "probe-ack"
            : "ok",
          finished: true
        });
      });
    });
    const server = await listenLoopback(http);
    servers.push(server);
    const { report, secrets } = await runProbeCommand({
      cwd: directory,
      yes: true,
      processEnv: {
        CHATBOT_BASE_URL: server.baseUrl,
        CHATBOT_API_KEY: "command-probe-secret"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.executed).toBe(true);
    expect(report.hosted_contacted).toBe(false);
    expect(report.credits_consumed).toBe(0);
    expect(report.calls).toHaveLength(1);
    expect(secrets).toContain("command-probe-secret");
    expect(JSON.stringify(report)).not.toContain("command-probe-secret");
    expect(probeExitCode(report)).toBe(EXIT.OK);
  });

  it("executes a stateful probe and always cleans up", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory, starter: "workflow", env: false });
    const fixtures = new Set<string>();
    const events: string[] = [];
    const http = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer command-probe-secret") {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      void readJsonBody(request).then((body) => {
        const url = request.url ?? "";
        if (url === "/__augmentworks/prepare") {
          events.push("prepare");
          fixtures.add(String((body as { attempt_id?: string }).attempt_id));
          sendJson(response, 200, { status: "ready" });
          return;
        }
        if (url === "/chat") {
          events.push("send");
          sendJson(response, 200, { answer: "probe-ack", events: [] });
          return;
        }
        if (url === "/__augmentworks/observe") {
          events.push("observe");
          sendJson(response, 200, {
            order: { status: "paid", refunded_amount: 0, refundable: true }
          });
          return;
        }
        if (url === "/__augmentworks/cleanup") {
          events.push("cleanup");
          fixtures.delete(String((body as { attempt_id?: string }).attempt_id));
          response.writeHead(204);
          response.end();
          return;
        }
        sendJson(response, 404, { error: "not_found" });
      });
    });
    const server = await listenLoopback(http);
    servers.push(server);
    const { report } = await runProbeCommand({
      cwd: directory,
      yes: true,
      processEnv: {
        CHATBOT_BASE_URL: server.baseUrl,
        CHATBOT_API_KEY: "command-probe-secret"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.pattern).toBe("stateful");
    expect(report.preflight.call_count).toBe(4);
    expect(events).toEqual(["prepare", "send", "observe", "cleanup"]);
    expect(fixtures.size).toBe(0);
  });

  it("accepts starter aliases without a second initializer", async () => {
    const directory = await temporaryDirectory();
    const result = await runInit({ cwd: directory, starter: "response-only", env: false });
    expect(result.starter).toBe("response-quality");
    const yaml = await readFile(resolve(directory, "augmentworks.yaml"), "utf8");
    expect(yaml).not.toMatch(/^ {4}prepare:/m);
    expect(yaml).toContain("send:");
    expect(await readFile(resolve(directory, "OWN-TARGET.md"), "utf8")).toContain("probe --yes");
    expect(await readFile(resolve(directory, "own-chatbot.suite.yaml"), "utf8")).toContain("faq.warranty");
  });

  it("rejects unsupported starter names with a boundary explanation", async () => {
    const directory = await temporaryDirectory();
    await expect(runInit({ cwd: directory, starter: "streaming" })).rejects.toMatchObject({
      code: "INIT_STARTER_UNKNOWN"
    });
    try {
      await runInit({ cwd: directory, starter: "streaming" });
    } catch (error) {
      expect(String(error)).toMatch(/Streaming/u);
      expect(String(error)).toMatch(/WebSocket/u);
    }
  });

  it("returns a config failure without executing when YAML is invalid", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, "augmentworks.yaml"), "not: valid: yaml: [\n", "utf8");
    const { report } = await runProbeCommand({ cwd: directory, yes: true });
    expect(report.executed).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.calls).toEqual([]);
  });
});
