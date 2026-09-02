import { createServer } from "node:http";

const baseUrl = new URL(process.env.CHATBOT_BASE_URL ?? "http://127.0.0.1:8000");
const expectedToken = process.env.CHATBOT_API_KEY ?? "demo-local-key";
const fixtures = new Map();
const maximumBodyBytes = 64 * 1024;

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
}

function unauthorized(response) {
  sendJson(response, 401, { error: "unauthorized" });
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBodyBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      unauthorized(response);
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    const body = await readJson(request);

    if (request.url === "/__augmentworks/prepare") {
      if (typeof body.attempt_id !== "string" || body.attempt_id === "") {
        sendJson(response, 400, { error: "attempt_id_required" });
        return;
      }
      const order = body.fixture?.order;
      const policy = body.fixture?.policy;
      if (
        order === null ||
        typeof order !== "object" ||
        typeof order.id !== "string" ||
        typeof order.amount !== "number" ||
        typeof order.status !== "string" ||
        typeof order.refundable !== "boolean" ||
        typeof order.refunded_amount !== "number" ||
        policy === null ||
        typeof policy !== "object" ||
        typeof policy.maximum_refund !== "number"
      ) {
        sendJson(response, 400, { error: "synthetic_fixture_invalid" });
        return;
      }
      const fixtureId = `fixture_${body.attempt_id}`;
      if (!fixtures.has(fixtureId)) {
        fixtures.set(fixtureId, {
          attemptId: body.attempt_id,
          order: structuredClone(order),
          policy: structuredClone(policy)
        });
      }
      sendJson(response, 200, {
        status: "ready"
      });
      return;
    }

    if (request.url === "/chat") {
      const fixture = fixtures.get(`fixture_${body.attempt_id}`);
      if (fixture === undefined) {
        sendJson(response, 404, { error: "fixture_not_found" });
        return;
      }
      if (typeof body.message !== "string" || body.message === "") {
        sendJson(response, 400, { error: "message_required" });
        return;
      }
      const wantsShipping = /shipping/i.test(body.message);
      const eligible =
        fixture.order.refundable === true &&
        fixture.order.amount <= fixture.policy.maximum_refund;
      if (wantsShipping) {
        sendJson(response, 200, {
          answer: "This synthetic example does not record a shipping method.",
          finish_reason: "stop",
          events: [],
          finished: true
        });
        return;
      }
      if (eligible) {
        fixture.order.status = "refunded";
        fixture.order.refunded_amount = fixture.order.amount;
        const callId = `refund_${body.turn_id}`;
        sendJson(response, 200, {
          answer: "The synthetic order refund completed.",
          finish_reason: "stop",
          events: [
            {
              type: "tool_call",
              event_id: `call_${body.turn_id}`,
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
              event_id: `result_${body.turn_id}`,
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
      return;
    }

    if (request.url === "/__augmentworks/observe") {
      const fixture = fixtures.get(`fixture_${body.attempt_id}`);
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
      return;
    }

    if (request.url === "/__augmentworks/cleanup") {
      const fixtureId = `fixture_${body.attempt_id}`;
      fixtures.delete(fixtureId);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    const status = error instanceof Error && error.message === "request_too_large" ? 413 : 400;
    sendJson(response, status, { error: status === 413 ? "request_too_large" : "invalid_json" });
  }
});

server.listen(Number(baseUrl.port || 8000), baseUrl.hostname, () => {
  console.log(`Refund-agent mock listening on ${baseUrl.origin}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
