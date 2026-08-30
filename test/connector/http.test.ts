import { describe, expect, it, vi } from "vitest";

import type { AugmentWorksConfig, ResolvedConfig } from "../../src/config/types.js";
import { HttpConnector } from "../../src/connector/index.js";
import type { ConnectorExecutionContext } from "../../src/connector/types.js";
import { AwError } from "../../src/errors.js";

const BASE = "https://local.target.test";

function resolved(
  overrides: Partial<AugmentWorksConfig["target"]["operations"]> = {},
  telemetry: AugmentWorksConfig["telemetry"] = {
    allow_tool_events: true,
    allow_observations: ["order.status"]
  },
  limits: AugmentWorksConfig["target"]["limits"] = {}
): ResolvedConfig {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "test",
      connector: "http",
      base_url: BASE,
      operations: {
        prepare: { method: "POST", path: "/prepare" },
        send: {
          method: "POST",
          path: "/chat",
          request: {
            message: "$input.message.content",
            attempt_id: "$input.attempt_id"
          },
          response: {
            content: "$.answer",
            tool_events: "$.events",
            metadata: "$.metadata"
          }
        },
        observe: { method: "POST", path: "/observe" },
        cleanup: { method: "DELETE", path: "/attempt" },
        ...overrides
      },
      limits
    },
    telemetry
  };
  return {
    config,
    configPath: "/project/augmentworks.yaml",
    configDirectory: "/project",
    configDigest: "digest",
    baseUrl: new URL(BASE),
    authHeaders: { Authorization: "Bearer secret-value" },
    secrets: ["secret-value"],
    capabilities: {
      level: "stateful",
      prepare: true,
      observation: true,
      cleanup: true,
      tool_events: telemetry?.allow_tool_events === true
    },
    warnings: []
  };
}

function context(overrides: Partial<ConnectorExecutionContext> = {}): ConnectorExecutionContext {
  return {
    commandId: "command_1",
    idempotencyKey: "idem_1",
    runId: "run_1",
    attemptId: "attempt_1",
    ...overrides
  };
}

describe("HttpConnector", () => {
  it("uses only the configured URL and method, enriches mapping context, and adds fixed headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/chat`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-value");
      expect(headers.get("aw-command-id")).toBe("command_1");
      expect(headers.get("aw-idempotency-key")).toBe("idem_1");
      expect(headers.get("aw-attempt-id")).toBe("attempt_1");
      expect(JSON.parse(String(init?.body))).toEqual({
        message: "Refund it",
        attempt_id: "attempt_1"
      });
      return Response.json({
        answer: "Done with secret-value",
        events: [
          {
            type: "tool_call",
            event_id: "event_1",
            tool_name: "refund",
            call_id: "call_1",
            arguments: { token: "secret-value" }
          }
        ],
        metadata: { internal_trace: "secret-value", debug: true }
      });
    });
    const connector = new HttpConnector(resolved(), { fetch: fetchMock });

    const result = await connector.execute(
      "send",
      { message: { role: "user", content: "Refund it" } },
      context({ turnId: "turn_1" })
    );

    expect("message" in result && result.message.content).toBe("Done with [REDACTED]");
    expect("events" in result && result.events[0]).toMatchObject({
      type: "tool_call",
      arguments: { token: "[REDACTED]" }
    });
    expect("metadata" in result && result.metadata).toEqual({});
  });

  it("removes unconfigured credential shapes before a result can reach the relay", async () => {
    const leakedApiKey = "unconfigured-api-key-value";
    const leakedBearer = "unconfigured-bearer-token-value";
    const connector = new HttpConnector(resolved(), {
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({
          answer: `Bearer ${leakedBearer}`,
          events: [
            {
              type: "tool_call",
              event_id: "event_1",
              tool_name: "refund",
              call_id: "call_1",
              arguments: {
                api_key: leakedApiKey,
                note: `token=${leakedBearer}`
              }
            }
          ]
        })
      )
    });

    const result = await connector.execute(
      "send",
      { message: { role: "user", content: "Refund it" } },
      context({ turnId: "turn_1" })
    );
    const relayBody = JSON.stringify(result);
    expect(relayBody).not.toContain(leakedApiKey);
    expect(relayBody).not.toContain(leakedBearer);
    expect(relayBody).toContain("[REDACTED]");
  });

  it("accepts an empty successful prepare and normalizes it to ready", async () => {
    const connector = new HttpConnector(resolved(), {
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    });
    await expect(connector.execute("prepare", {}, context())).resolves.toEqual({
      protocol_version: "aw-target/0.1",
      status: "ready",
      attempt_id: "attempt_1",
      metadata: {}
    });
  });

  it("drops target-provided prepare metadata from normalized evidence", async () => {
    const connector = new HttpConnector(resolved(), {
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({ status: "ready", metadata: { private_fixture_note: "do not upload" } })
      )
    });
    await expect(connector.execute("prepare", {}, context())).resolves.toEqual({
      protocol_version: "aw-target/0.1",
      status: "ready",
      attempt_id: "attempt_1",
      metadata: {}
    });
  });

  it("emits only returned observations in the local allowlist", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).probe_keys).toEqual(["order.status"]);
      return Response.json({
        request_id: "observation_1",
        observations: [
          { key: "order.status", value: "refunded", source: "db", authoritative: true },
          { key: "customer.email", value: "private", source: "db", authoritative: true }
        ],
        metadata: { raw_database_query: "do not upload" }
      });
    });
    const connector = new HttpConnector(resolved(), { fetch: fetchMock });
    const result = await connector.execute(
      "observe",
      { probe_keys: ["order.status"] },
      context({ requestId: "observation_1" })
    );
    expect("observations" in result && result.observations).toEqual([
      { key: "order.status", value: "refunded", source: "db", authoritative: true }
    ]);
    expect("metadata" in result && result.metadata).toEqual({});
  });

  it("rejects requested observations outside the local allowlist before dispatch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const connector = new HttpConnector(resolved(), { fetch: fetchMock });
    await expect(
      connector.execute(
        "observe",
        { probe_keys: ["customer.email"] },
        context({ requestId: "observation_1" })
      )
    ).rejects.toMatchObject({ code: "OBSERVATION_NOT_ALLOWED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops structured events when telemetry has not opted in", async () => {
    const connector = new HttpConnector(
      resolved({}, { allow_tool_events: false, allow_observations: [] }),
      {
        fetch: vi.fn<typeof fetch>(async () =>
          Response.json({ answer: "Done", events: [{ arbitrary: "private" }] })
        )
      }
    );
    const result = await connector.execute(
      "send",
      { message: { role: "user", content: "Hi" } },
      context({ turnId: "turn_1" })
    );
    expect("events" in result && result.events).toEqual([]);
  });

  it("rejects redirects instead of following them", async () => {
    const connector = new HttpConnector(resolved(), {
      fetch: vi.fn<typeof fetch>(async () =>
        new Response(null, { status: 307, headers: { Location: "https://evil.test" } })
      )
    });
    await expect(
      connector.execute(
        "send",
        { message: { role: "user", content: "Hi" } },
        context({ turnId: "turn_1" })
      )
    ).rejects.toMatchObject({
      code: "TARGET_OUTCOME_INDETERMINATE",
      details: { reason_code: "TARGET_REDIRECT_REJECTED" }
    });
  });

  it("enforces the streaming response cap even without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"answer":"'));
        controller.enqueue(new TextEncoder().encode("too large"));
        controller.close();
      }
    });
    const connector = new HttpConnector(resolved({}, undefined, { response_bytes: 8 }), {
      fetch: vi.fn<typeof fetch>(async () =>
        new Response(stream, { headers: { "Content-Type": "application/json" } })
      )
    });
    await expect(
      connector.execute(
        "send",
        { message: { role: "user", content: "Hi" } },
        context({ turnId: "turn_1" })
      )
    ).rejects.toMatchObject({
      code: "TARGET_OUTCOME_INDETERMINATE",
      details: { reason_code: "TARGET_RESPONSE_TOO_LARGE" }
    });
  });

  it("marks a non-idempotent send timeout as indeterminate", async () => {
    const connector = new HttpConnector(
      resolved({ send: { method: "POST", path: "/chat", timeout_ms: 5 } }),
      {
        fetch: vi.fn<typeof fetch>(
          async (_url, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
            })
        )
      }
    );
    await expect(
      connector.execute(
        "send",
        { message: { role: "user", content: "Hi" } },
        context({ turnId: "turn_1" })
      )
    ).rejects.toMatchObject({ code: "TARGET_OUTCOME_INDETERMINATE", retryable: false });
  });

  it("marks an implicitly non-idempotent lifecycle timeout as indeterminate", async () => {
    const connector = new HttpConnector(
      resolved({ prepare: { method: "POST", path: "/prepare", timeout_ms: 5 } }),
      {
        fetch: vi.fn<typeof fetch>(
          async (_url, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
            })
        )
      }
    );
    await expect(connector.execute("prepare", {}, context())).rejects.toMatchObject({
      code: "TARGET_OUTCOME_INDETERMINATE",
      retryable: false
    });
  });

  it("allows a declared-idempotent lifecycle timeout to be retried", async () => {
    const connector = new HttpConnector(
      resolved({ prepare: { method: "POST", path: "/prepare", timeout_ms: 5, idempotent: true } }),
      {
        fetch: vi.fn<typeof fetch>(
          async (_url, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
            })
        )
      }
    );
    await expect(connector.execute("prepare", {}, context())).rejects.toMatchObject({
      code: "TARGET_TIMEOUT",
      retryable: true
    });
  });

  it("marks every non-idempotent send failure after dispatch as indeterminate", async () => {
    const connector = new HttpConnector(resolved(), {
      fetch: vi.fn<typeof fetch>(async () => Response.json({ answer: 42, events: [] }))
    });
    await expect(
      connector.execute(
        "send",
        { message: { role: "user", content: "Hi" } },
        context({ turnId: "turn_1" })
      )
    ).rejects.toMatchObject({
      code: "TARGET_OUTCOME_INDETERMINATE",
      retryable: false,
      details: { reason_code: "INVALID_TARGET_RESPONSE" }
    });
  });

  it("treats cancellation after a non-idempotent send dispatch as indeterminate", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const abort = new AbortController();
    const connector = new HttpConnector(resolved(), {
      fetch: vi.fn<typeof fetch>(
        async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            markStarted?.();
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          })
      )
    });
    const pending = connector.execute(
      "send",
      { message: { role: "user", content: "Hi" } },
      context({ turnId: "turn_1", signal: abort.signal })
    );
    await started;
    abort.abort();
    await expect(pending).rejects.toMatchObject({
      code: "TARGET_OUTCOME_INDETERMINATE",
      details: { reason_code: "OPERATION_CANCELLED" }
    });
  });

  it("defaults every operation to non-idempotent for crash recovery", () => {
    const connector = new HttpConnector(resolved(), { fetch: vi.fn<typeof fetch>() });
    expect(connector.isIdempotent("prepare")).toBe(false);
    expect(connector.isIdempotent("observe")).toBe(false);
    expect(connector.isIdempotent("cleanup")).toBe(false);
    expect(connector.isIdempotent("send")).toBe(false);
  });

  it("reports idempotency only when the local operation explicitly opts in", () => {
    const connector = new HttpConnector(
      resolved({
        prepare: { method: "POST", path: "/prepare", idempotent: true },
        observe: { method: "POST", path: "/observe", idempotent: true },
        cleanup: { method: "DELETE", path: "/attempt", idempotent: true }
      }),
      { fetch: vi.fn<typeof fetch>() }
    );
    expect(connector.isIdempotent("prepare")).toBe(true);
    expect(connector.isIdempotent("observe")).toBe(true);
    expect(connector.isIdempotent("cleanup")).toBe(true);
    expect(connector.isIdempotent("send")).toBe(false);
  });

  it("rejects unsafe methods, body-bearing GET, and non-relative operation paths", async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(
      new HttpConnector(resolved({ send: { method: "DELETE", path: "/chat" } }), {
        fetch: unused
      }).execute("send", {}, context({ turnId: "turn_1" }))
    ).rejects.toMatchObject({ code: "DELETE_OPERATION_FORBIDDEN" });
    await expect(
      new HttpConnector(
        resolved({ send: { method: "GET", path: "/chat", request: { q: "$input.message" } } }),
        { fetch: unused }
      ).execute("send", {}, context({ turnId: "turn_1" }))
    ).rejects.toMatchObject({ code: "GET_BODY_FORBIDDEN" });
    await expect(
      new HttpConnector(resolved({ send: { method: "POST", path: "https://evil.test/chat" } }), {
        fetch: unused
      }).execute("send", {}, context({ turnId: "turn_1" }))
    ).rejects.toMatchObject({ code: "OPERATION_PATH_INVALID" });
  });

  it("rejects malformed enabled events and correlation mismatches", async () => {
    const connector = new HttpConnector(resolved(), {
      fetch: vi.fn<typeof fetch>(async () => Response.json({ answer: "Done", events: [{ type: "tool_call" }] }))
    });
    await expect(
      connector.execute(
        "send",
        { attempt_id: "different", message: { role: "user", content: "Hi" } },
        context({ turnId: "turn_1" })
      )
    ).rejects.toBeInstanceOf(AwError);

    await expect(
      connector.execute(
        "send",
        { message: { role: "user", content: "Hi" } },
        context({ turnId: "turn_1" })
      )
    ).rejects.toMatchObject({
      code: "TARGET_OUTCOME_INDETERMINATE",
      details: { reason_code: "INVALID_TARGET_EVENTS" }
    });
  });
});
