import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConversation } from "../../src/config/conversation.js";
import type { AugmentWorksConfig, ResolvedConfig } from "../../src/config/types.js";
import {
  CONNECTION_PROBE_SCHEMA_VERSION,
  planConnectionProbe,
  runConnectionProbe
} from "../../src/connector/connection-probe.js";
import { EXIT } from "../../src/errors.js";
import { probeExitCode } from "../../src/connector/connection-probe.js";
import { listenLoopback, readJsonBody, sendJson, type ListeningServer } from "../util/http-server.js";

function chatConfig(baseUrl: string, session = false): ResolvedConfig {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "probe-chat",
      connector: "http",
      base_url: baseUrl,
      ...(session ? { conversation: { strategy: "explicit_session_v1" } } : {}),
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          idempotent: session,
          request: {
            message: "$input.message.content",
            turn_id: "$input.turn_id",
            ...(session ? { conversation_id: "$input.conversation_id" } : {})
          },
          response: { content: "$.answer", finished: "$.finished" }
        }
      }
    },
    telemetry: { allow_tool_events: false, allow_observations: [] }
  };
  return {
    config,
    configPath: "/tmp/augmentworks.yaml",
    configDirectory: "/tmp",
    configDigest: "digest",
    baseUrl: new URL(baseUrl),
    authHeaders: { Authorization: "Bearer secret-probe-token" },
    secrets: ["secret-probe-token"],
    capabilities: {
      level: "chat-only",
      prepare: false,
      observation: false,
      cleanup: false,
      tool_events: false
    },
    conversation: resolveConversation(config),
    warnings: []
  };
}

function statefulConfig(baseUrl: string): ResolvedConfig {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "probe-stateful",
      connector: "http",
      base_url: baseUrl,
      operations: {
        prepare: { method: "POST", path: "/__augmentworks/prepare", idempotent: true },
        send: {
          method: "POST",
          path: "/chat",
          idempotent: false,
          request: {
            message: "$input.message.content",
            attempt_id: "$input.attempt_id",
            turn_id: "$input.turn_id"
          },
          response: { content: "$.answer", tool_events: "$.events" }
        },
        observe: {
          method: "POST",
          path: "/__augmentworks/observe",
          idempotent: true,
          request: { attempt_id: "$input.attempt_id", probe_keys: "$input.probe_keys" },
          response: {
            "order.status": "$.order.status",
            "order.refunded_amount": "$.order.refunded_amount"
          }
        },
        cleanup: {
          method: "POST",
          path: "/__augmentworks/cleanup",
          idempotent: true,
          request: { attempt_id: "$input.attempt_id" }
        }
      }
    },
    telemetry: { allow_tool_events: true, allow_observations: ["order.status", "order.refunded_amount"] }
  };
  return {
    config,
    configPath: "/tmp/augmentworks.yaml",
    configDirectory: "/tmp",
    configDigest: "digest",
    baseUrl: new URL(baseUrl),
    authHeaders: { Authorization: "Bearer secret-probe-token" },
    secrets: ["secret-probe-token"],
    capabilities: {
      level: "stateful",
      prepare: true,
      observation: true,
      cleanup: true,
      tool_events: true
    },
    conversation: resolveConversation(config),
    warnings: []
  };
}

const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("connection probe", () => {
  it("plans a single send for response-only configs and does not execute without the flag", async () => {
    const resolved = chatConfig("http://127.0.0.1:9");
    const preflight = planConnectionProbe(resolved);
    expect(preflight.pattern).toBe("response-only");
    expect(preflight.call_count).toBe(1);
    expect(preflight.hosted_work).toBe("none");
    expect(preflight.cleanup).toBe("none");
    const report = await runConnectionProbe({ resolved, execute: false });
    expect(report.schema_version).toBe(CONNECTION_PROBE_SCHEMA_VERSION);
    expect(report.executed).toBe(false);
    expect(report.credits_consumed).toBe(0);
    expect(report.hosted_contacted).toBe(false);
    expect(report.calls).toEqual([]);
    expect(probeExitCode(report)).toBe(EXIT.OK);
  });

  it("plans prepare/send/observe/cleanup for stateful configs", () => {
    const preflight = planConnectionProbe(statefulConfig("http://127.0.0.1:9"));
    expect(preflight.pattern).toBe("stateful");
    expect(preflight.call_count).toBe(4);
    expect(preflight.operations.map((item) => item.phase)).toEqual(["prepare", "send", "observe", "cleanup"]);
    expect(preflight.cleanup).toBe("always");
  });

  it("plans a follow-up send when explicit session mode is configured", () => {
    const preflight = planConnectionProbe(chatConfig("http://127.0.0.1:9", true));
    expect(preflight.call_count).toBe(2);
    expect(preflight.operations.map((item) => item.phase)).toEqual(["send", "send_followup"]);
    expect(preflight.conversation_strategy).toBe("explicit_session_v1");
  });

  it("probes a chat endpoint and redacts the target secret", async () => {
    let calls = 0;
    const http = createServer((request, response) => {
      calls += 1;
      if (request.headers.authorization !== "Bearer secret-probe-token") {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      void readJsonBody(request).then((body) => {
        const message = (body as { message?: string }).message ?? "";
        sendJson(response, 200, { answer: message.includes("probe-ack") ? "probe-ack" : "ok", finished: true });
      });
    });
    const server = await listenLoopback(http);
    servers.push(server);
    const report = await runConnectionProbe({
      resolved: chatConfig(server.baseUrl),
      execute: true,
      randomId: () => "probe_fixedid01"
    });
    expect(report.ok).toBe(true);
    expect(report.executed).toBe(true);
    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]?.mapping_ok).toBe(true);
    expect(calls).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret-probe-token");
  });

  it("classifies connection refusal without calling it a chatbot miss", async () => {
    const report = await runConnectionProbe({
      resolved: chatConfig("http://127.0.0.1:65535"),
      execute: true
    });
    expect(report.ok).toBe(false);
    expect(report.failure_class).toBe("connection_refusal");
    expect(report.failed_phase).toBe("send");
    expect(report.diagnostics.some((item) => item.code === "PROBE_CONNECTION_REFUSED")).toBe(true);
    expect(report.corrective_action).toMatch(/CHATBOT_BASE_URL/u);
    expect(report.diagnostics.map((item) => item.message).join(" ")).not.toMatch(/failed a (?:test|case|rubric)/iu);
    expect(probeExitCode(report)).toBe(EXIT.TARGET);
  });

  it("classifies 401 as authentication", async () => {
    const http = createServer((_request, response) => {
      sendJson(response, 401, { error: "unauthorized" });
    });
    const server = await listenLoopback(http);
    servers.push(server);
    const report = await runConnectionProbe({
      resolved: chatConfig(server.baseUrl),
      execute: true
    });
    expect(report.failure_class).toBe("authentication");
    expect(report.calls[0]?.http_status).toBe(401);
    expect(JSON.stringify(report)).not.toContain("secret-probe-token");
  });

  it("classifies a missing mapped field as a selector problem", async () => {
    const http = createServer((_request, response) => {
      void readJsonBody(_request).then(() => sendJson(response, 200, { text: "no answer field", finished: true }));
    });
    const server = await listenLoopback(http);
    servers.push(server);
    const report = await runConnectionProbe({
      resolved: chatConfig(server.baseUrl),
      execute: true
    });
    expect(report.ok).toBe(false);
    expect(report.failure_class).toBe("response_selector");
    expect(report.diagnostics.some((item) => item.code === "PROBE_RESPONSE_SELECTOR" || item.code === "MAPPING_VALUE_MISSING")).toBe(
      true
    );
  });

  it("classifies a missing session identifier as a session integration failure", async () => {
    const http = createServer((_request, response) => {
      void readJsonBody(_request).then((body) => {
        const conversationId = (body as { conversation_id?: string }).conversation_id;
        if (typeof conversationId !== "string" || conversationId === "") {
          sendJson(response, 400, { error: "session_required" });
          return;
        }
        sendJson(response, 200, { answer: "ok", finished: true });
      });
    });
    const server = await listenLoopback(http);
    servers.push(server);
    const report = await runConnectionProbe({
      resolved: chatConfig(server.baseUrl),
      execute: true
    });
    expect(report.failure_class).toBe("conversation_session");
    expect(report.corrective_action).toMatch(/conversation_id/u);
  });

  it("cleans up a stateful fixture even after send fails and reports cleanup success separately", async () => {
    const events: string[] = [];
    const fixtures = new Set<string>();
    const http = createServer((request, response) => {
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
          sendJson(response, 200, { text: "missing answer" });
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
    const report = await runConnectionProbe({
      resolved: statefulConfig(server.baseUrl),
      execute: true
    });
    expect(events).toEqual(["prepare", "send", "cleanup"]);
    expect(fixtures.size).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.failure_class).toBe("response_selector");
    expect(report.calls.some((call) => call.phase === "cleanup" && call.ok)).toBe(true);
  });

  it("reports cleanup failure with exit 6", async () => {
    const http = createServer((request, response) => {
      void readJsonBody(request).then((body) => {
        const url = request.url ?? "";
        if (url === "/__augmentworks/prepare") {
          sendJson(response, 200, { status: "ready" });
          return;
        }
        if (url === "/chat") {
          sendJson(response, 200, { answer: "probe-ack", events: [] });
          return;
        }
        if (url === "/__augmentworks/observe") {
          sendJson(response, 200, { order: { status: "paid", refunded_amount: 0 } });
          return;
        }
        if (url === "/__augmentworks/cleanup") {
          void body;
          sendJson(response, 500, { error: "cleanup_failed" });
          return;
        }
        sendJson(response, 404, { error: "not_found" });
      });
    });
    const server = await listenLoopback(http);
    servers.push(server);
    const report = await runConnectionProbe({
      resolved: statefulConfig(server.baseUrl),
      execute: true
    });
    expect(report.failure_class).toBe("cleanup");
    expect(report.failed_phase).toBe("cleanup");
    expect(probeExitCode(report)).toBe(EXIT.CLEANUP);
  });
});
