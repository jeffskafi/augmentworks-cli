import { createServer } from "node:http";

const baseUrl = new URL(process.env.CHATBOT_BASE_URL ?? "http://127.0.0.1:8000");
const expectedToken = process.env.CHATBOT_API_KEY ?? "demo-local-key";
const maximumBodyBytes = 64 * 1024;
const colors = ["red", "blue", "green", "yellow", "purple", "orange"];
const sessions = new Map();

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
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

function colorFrom(text) {
  const match = new RegExp(`\\b(${colors.join("|")})\\b`, "i").exec(text);
  return match?.[1]?.toLowerCase();
}

function daysFrom(text) {
  return /(\d+)\s*days/i.exec(text)?.[1];
}

function answerFor(session, message) {
  if (/what color/i.test(message)) {
    for (let index = session.userMessages.length - 1; index >= 0; index -= 1) {
      const color = colorFrom(session.userMessages[index] ?? "");
      if (color !== undefined) return `You said the color was ${color}.`;
    }
    return "I don't remember a previous color.";
  }
  if (/how long|return window/i.test(message) && daysFrom(message) === undefined) {
    let lastDays;
    for (const previous of session.userMessages) {
      const days = daysFrom(previous);
      if (days !== undefined) lastDays = days;
    }
    if (lastDays !== undefined) return `The return window is ${lastDays} days.`;
    return "I don't remember a return window.";
  }
  return `Noted: ${message}`;
}

function replayKey(conversationId, turnId, idempotencyKey) {
  return `${conversationId}\0${turnId}\0${idempotencyKey}`;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method !== "POST" || request.url !== "/chat") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const body = await readJson(request);
    const conversationId = body.conversation_id;
    if (typeof conversationId !== "string" || conversationId === "") {
      sendJson(response, 400, { error: "session_required" });
      return;
    }
    if (typeof body.message !== "string" || body.message === "") {
      sendJson(response, 400, { error: "message_required" });
      return;
    }

    const turnId = typeof body.turn_id === "string" ? body.turn_id : "turn";
    const idempotencyKey = request.headers["aw-idempotency-key"];
    let session = sessions.get(conversationId);
    if (session === undefined) {
      session = { userMessages: [], accepted: new Map() };
      sessions.set(conversationId, session);
    }

    if (typeof idempotencyKey === "string") {
      const key = replayKey(conversationId, turnId, idempotencyKey);
      const cached = session.accepted.get(key);
      if (cached !== undefined) {
        sendJson(response, 200, cached);
        return;
      }
      session.userMessages.push(body.message);
      const payload = {
        answer: answerFor(session, body.message),
        finished: true,
        user_turn_count: session.userMessages.length
      };
      session.accepted.set(key, payload);
      sendJson(response, 200, payload);
      return;
    }

    session.userMessages.push(body.message);
    sendJson(response, 200, {
      answer: answerFor(session, body.message),
      finished: true,
      user_turn_count: session.userMessages.length
    });
  } catch (error) {
    const status = error instanceof Error && error.message === "request_too_large" ? 413 : 400;
    sendJson(response, status, { error: status === 413 ? "request_too_large" : "invalid_json" });
  }
});

server.listen(Number(baseUrl.port || 8000), baseUrl.hostname, () => {
  console.log(`Session-agent mock listening on ${baseUrl.origin}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
