import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { AwError } from "../errors.js";
import type { DemoPolicy } from "./types.js";

const MAXIMUM_BODY_BYTES = 64 * 1024;
const LISTEN_TIMEOUT_MS = 5_000;

export interface DemoTargetOptions {
  readonly token: string;
  readonly policy: DemoPolicy;
  readonly cleanupMode?: "ok" | "fail";
  readonly listenTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DemoTarget {
  readonly baseUrl: string;
  readonly token: string;
  policy: DemoPolicy;
  cleanupMode: "ok" | "fail";
  readonly requestCount: () => number;
  readonly sendCount: () => number;
  setPolicy(policy: DemoPolicy): void;
  close(): Promise<void>;
}

interface StoredFixture {
  readonly attemptId: string;
  order: {
    id: string;
    amount: number;
    status: string;
    refundable: boolean;
    refunded_amount: number;
  };
  policy: {
    maximum_refund: number;
  };
}

export async function startDemoTarget(options: DemoTargetOptions): Promise<DemoTarget> {
  const fixtures = new Map<string, StoredFixture>();
  let requestCount = 0;
  let sendCount = 0;
  let policy = options.policy;
  let cleanupMode: "ok" | "fail" = options.cleanupMode ?? "ok";
  const expectedToken = options.token;

  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    requestCount += 1;
    try {
      const url = request.url ?? "";
      if (request.method === "GET" && url === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.headers.authorization !== `Bearer ${expectedToken}`) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const body = (await readJson(request)) as Record<string, unknown>;

      if (url === "/__augmentworks/prepare") {
        handlePrepare(response, body, fixtures);
        return;
      }
      if (url === "/chat") {
        sendCount += 1;
        handleChat(response, body, fixtures, policy);
        return;
      }
      if (url === "/__augmentworks/observe") {
        handleObserve(response, body, fixtures);
        return;
      }
      if (url === "/__augmentworks/cleanup") {
        if (cleanupMode === "fail") {
          sendJson(response, 500, { error: "cleanup_failed" });
          return;
        }
        const attemptId = body["attempt_id"];
        if (typeof attemptId === "string" && attemptId !== "") {
          fixtures.delete(`fixture_${attemptId}`);
        }
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error instanceof Error && error.message === "request_too_large" ? 413 : 400;
      sendJson(response, status, { error: status === 413 ? "request_too_large" : "invalid_json" });
    }
  }

  const listenTimeoutMs = options.listenTimeoutMs ?? LISTEN_TIMEOUT_MS;
  await listenLoopback(server, listenTimeoutMs, options.signal);
  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address.port !== "number") {
    server.close();
    throw new AwError({
      code: "DEMO_STARTUP_FAILED",
      category: "target",
      message: "The demo target did not bind to an OS-assigned loopback port."
    });
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    token: expectedToken,
    get policy() {
      return policy;
    },
    set policy(value: DemoPolicy) {
      policy = value;
    },
    get cleanupMode() {
      return cleanupMode;
    },
    set cleanupMode(value: "ok" | "fail") {
      cleanupMode = value;
    },
    requestCount: () => requestCount,
    sendCount: () => sendCount,
    setPolicy(next: DemoPolicy): void {
      policy = next;
    },
    close: () => closeServer(server)
  };
}

function handlePrepare(
  response: ServerResponse,
  body: Record<string, unknown>,
  fixtures: Map<string, StoredFixture>
): void {
  const attemptId = body["attempt_id"];
  if (typeof attemptId !== "string" || attemptId === "") {
    sendJson(response, 400, { error: "attempt_id_required" });
    return;
  }
  const fixture = asRecord(body["fixture"]);
  const order = asRecord(fixture?.["order"]);
  const policy = asRecord(fixture?.["policy"]);
  if (
    order === undefined ||
    typeof order["id"] !== "string" ||
    typeof order["amount"] !== "number" ||
    typeof order["status"] !== "string" ||
    typeof order["refundable"] !== "boolean" ||
    typeof order["refunded_amount"] !== "number" ||
    policy === undefined ||
    typeof policy["maximum_refund"] !== "number"
  ) {
    sendJson(response, 400, { error: "synthetic_fixture_invalid" });
    return;
  }
  const fixtureId = `fixture_${attemptId}`;
  if (!fixtures.has(fixtureId)) {
    fixtures.set(fixtureId, {
      attemptId,
      order: {
        id: order["id"],
        amount: order["amount"],
        status: order["status"],
        refundable: order["refundable"],
        refunded_amount: order["refunded_amount"]
      },
      policy: { maximum_refund: policy["maximum_refund"] }
    });
  }
  sendJson(response, 200, { status: "ready" });
}

function handleChat(
  response: ServerResponse,
  body: Record<string, unknown>,
  fixtures: Map<string, StoredFixture>,
  policyMode: DemoPolicy
): void {
  const attemptId = body["attempt_id"];
  const fixture = typeof attemptId === "string" ? fixtures.get(`fixture_${attemptId}`) : undefined;
  if (fixture === undefined) {
    sendJson(response, 404, { error: "fixture_not_found" });
    return;
  }
  const message = body["message"];
  if (typeof message !== "string" || message === "") {
    sendJson(response, 400, { error: "message_required" });
    return;
  }
  const withinLimit =
    policyMode === "ignore-limit" || fixture.order.amount <= fixture.policy.maximum_refund;
  const eligible = fixture.order.refundable === true && withinLimit;
  if (eligible) {
    fixture.order.status = "refunded";
    fixture.order.refunded_amount = fixture.order.amount;
    const turnId = typeof body["turn_id"] === "string" ? body["turn_id"] : "turn";
    const callId = `refund_${turnId}`;
    sendJson(response, 200, {
      answer: "The synthetic order refund completed.",
      finish_reason: "stop",
      events: [
        {
          type: "tool_call",
          event_id: `call_${turnId}`,
          sequence: 0,
          tool_name: "refund_order",
          call_id: callId,
          arguments: {
            order_id: fixture.order.id,
            amount: fixture.order.amount
          }
        },
        {
          type: "tool_result",
          event_id: `result_${turnId}`,
          sequence: 1,
          tool_name: "refund_order",
          call_id: callId,
          output: { status: "refunded" },
          success: true
        }
      ],
      finished: true
    });
    return;
  }
  sendJson(response, 200, {
    answer: "This synthetic order is not eligible for a refund.",
    finish_reason: "stop",
    events: [],
    finished: true
  });
}

function handleObserve(
  response: ServerResponse,
  body: Record<string, unknown>,
  fixtures: Map<string, StoredFixture>
): void {
  const attemptId = body["attempt_id"];
  const fixture = typeof attemptId === "string" ? fixtures.get(`fixture_${attemptId}`) : undefined;
  if (fixture === undefined) {
    sendJson(response, 404, { error: "fixture_not_found" });
    return;
  }
  sendJson(response, 200, {
    order: {
      status: fixture.order.status,
      refunded_amount: fixture.order.refunded_amount,
      refundable: fixture.order.refundable
    }
  });
}

async function listenLoopback(
  server: Server,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted === true) {
    throw abortAsDemoError(signal.reason);
  }
  await new Promise<void>((fulfill, reject) => {
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        server.close();
        reject(error instanceof AwError ? error : abortAsDemoError(error));
        return;
      }
      fulfill();
    };
    const timer = setTimeout(() => {
      settle(
        new AwError({
          code: "DEMO_STARTUP_FAILED",
          category: "target",
          message: `The demo target did not listen on 127.0.0.1 within ${String(timeoutMs)} ms.`
        })
      );
    }, timeoutMs);
    timer.unref?.();
    const onError = (error: Error): void => {
      settle(
        new AwError({
          code: "DEMO_STARTUP_FAILED",
          category: "target",
          message: "The demo target failed to bind 127.0.0.1.",
          cause: error
        })
      );
    };
    const onAbort = (): void => {
      settle(abortAsDemoError(signal?.reason));
    };
    server.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    server.listen(0, "127.0.0.1", () => {
      if (settled) {
        server.close();
        return;
      }
      settle();
    });
  });
}

function abortAsDemoError(reason: unknown): AwError {
  if (reason instanceof AwError) return reason;
  return new AwError({
    code: "INTERRUPTED",
    category: "local",
    message: "The packaged demo was interrupted before the target listened."
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((fulfill, reject) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close((error) => {
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(
          new AwError({
            code: "DEMO_CLEANUP_FAILED",
            category: "cleanup",
            message: "The demo target listener could not be closed.",
            cause: error
          })
        );
        return;
      }
      fulfill();
    });
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAXIMUM_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
