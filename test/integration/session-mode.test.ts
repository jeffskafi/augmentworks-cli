import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { CONVERSATION_STRATEGY_EXPLICIT_SESSION, resolveConversation } from "../../src/config/conversation.js";
import type { AugmentWorksConfig, ResolvedConfig } from "../../src/config/types.js";
import { HttpConnector } from "../../src/connector/http.js";
import { listenLoopback, readJsonBody, sendJson, type ListeningServer } from "../util/http-server.js";

interface SessionState {
  userMessages: string[];
  accepted: Map<string, Record<string, unknown>>;
}

const COLORS = ["red", "blue", "green", "yellow", "purple", "orange"] as const;

function colorFrom(text: string): string | undefined {
  const match = new RegExp(`\\b(${COLORS.join("|")})\\b`, "iu").exec(text);
  return match?.[1]?.toLowerCase();
}

function daysFrom(text: string): string | undefined {
  return /(\d+)\s*days/iu.exec(text)?.[1];
}

function answerFor(session: SessionState, message: string): string {
  if (/what color/iu.test(message)) {
    for (let index = session.userMessages.length - 1; index >= 0; index -= 1) {
      const color = colorFrom(session.userMessages[index] ?? "");
      if (color !== undefined) return `You said the color was ${color}.`;
    }
    return "I don't remember a previous color.";
  }
  if (/how long|return window/iu.test(message) && daysFrom(message) === undefined) {
    let lastDays: string | undefined;
    for (const previous of session.userMessages) {
      const days = daysFrom(previous);
      if (days !== undefined) lastDays = days;
    }
    if (lastDays !== undefined) return `The return window is ${lastDays} days.`;
    return "I don't remember a return window.";
  }
  return `Noted: ${message}`;
}

function replayKey(conversationId: string, turnId: string, idempotencyKey: string): string {
  return `${conversationId}\u0000${turnId}\u0000${idempotencyKey}`;
}

async function startSessionTarget(): Promise<{
  server: ListeningServer;
  sessions: Map<string, SessionState>;
}> {
  const sessions = new Map<string, SessionState>();
  const http = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST" || request.url !== "/chat") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const conversationId = body["conversation_id"];
      if (typeof conversationId !== "string" || conversationId === "") {
        sendJson(response, 400, { error: "session_required" });
        return;
      }
      const message = body["message"];
      if (typeof message !== "string" || message === "") {
        sendJson(response, 400, { error: "message_required" });
        return;
      }
      const turnId = typeof body["turn_id"] === "string" ? body["turn_id"] : "turn";
      const idempotencyKey = request.headers["aw-idempotency-key"];
      const key =
        typeof idempotencyKey === "string" ? replayKey(conversationId, turnId, idempotencyKey) : undefined;
      let session = sessions.get(conversationId);
      if (session === undefined) {
        session = { userMessages: [], accepted: new Map() };
        sessions.set(conversationId, session);
      }
      if (key !== undefined) {
        const cached = session.accepted.get(key);
        if (cached !== undefined) {
          sendJson(response, 200, cached);
          return;
        }
      }
      session.userMessages.push(message);
      const payload = {
        answer: answerFor(session, message),
        finished: true,
        user_turn_count: session.userMessages.length
      };
      if (key !== undefined) session.accepted.set(key, payload);
      sendJson(response, 200, payload);
    } catch {
      sendJson(response, 400, { error: "invalid_json" });
    }
  });
  return { server: await listenLoopback(http), sessions };
}

function sessionConfig(baseUrl: string): ResolvedConfig {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "synthetic-session-agent",
      connector: "http",
      base_url: baseUrl,
      conversation: { strategy: CONVERSATION_STRATEGY_EXPLICIT_SESSION },
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          idempotent: true,
          request: {
            message: "$input.message.content",
            conversation_id: "$input.conversation_id",
            turn_id: "$input.turn_id"
          },
          response: { content: "$.answer", finished: "$.finished" }
        }
      }
    }
  };
  return {
    config,
    configPath: "/tmp/augmentworks.session.yaml",
    configDirectory: "/tmp",
    configDigest: "digest",
    baseUrl: new URL(baseUrl),
    authHeaders: {},
    secrets: [],
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

const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("explicit_session_v1 fixture target", () => {
  it("recalls prior context in one attempt and isolates a second attempt", async () => {
    const started = await startSessionTarget();
    servers.push(started.server);
    const connector = new HttpConnector(sessionConfig(started.server.baseUrl));

    const first = await connector.execute(
      "send",
      { message: { role: "user", content: "The color is blue." }, turn_id: "turn_1" },
      { commandId: "c1", idempotencyKey: "idem_1", attemptId: "attempt_a", turnId: "turn_1" }
    );
    expect("message" in first && first.message.content).toContain("Noted");

    const followUp = await connector.execute(
      "send",
      { message: { role: "user", content: "What color did I just say?" }, turn_id: "turn_2" },
      { commandId: "c2", idempotencyKey: "idem_2", attemptId: "attempt_a", turnId: "turn_2" }
    );
    expect("message" in followUp && followUp.message.content).toBe("You said the color was blue.");

    const otherAttempt = await connector.execute(
      "send",
      { message: { role: "user", content: "What color did I just say?" }, turn_id: "turn_1" },
      { commandId: "c3", idempotencyKey: "idem_3", attemptId: "attempt_b", turnId: "turn_1" }
    );
    expect("message" in otherAttempt && otherAttempt.message.content).toBe(
      "I don't remember a previous color."
    );
    expect(started.sessions.get("attempt_a")?.userMessages).toEqual([
      "The color is blue.",
      "What color did I just say?"
    ]);
    expect(started.sessions.get("attempt_b")?.userMessages).toEqual(["What color did I just say?"]);
  });

  it("keeps two simultaneous attempts isolated and uses a fresh identifier for a repetition", async () => {
    const started = await startSessionTarget();
    servers.push(started.server);
    const connector = new HttpConnector(sessionConfig(started.server.baseUrl));

    await Promise.all([
      connector.execute(
        "send",
        { message: { role: "user", content: "The color is green." }, turn_id: "turn_1" },
        { commandId: "left_1", idempotencyKey: "left_1", attemptId: "attempt_left", turnId: "turn_1" }
      ),
      connector.execute(
        "send",
        { message: { role: "user", content: "The color is red." }, turn_id: "turn_1" },
        { commandId: "right_1", idempotencyKey: "right_1", attemptId: "attempt_right", turnId: "turn_1" }
      )
    ]);

    const [leftFollowUp, rightFollowUp] = await Promise.all([
      connector.execute(
        "send",
        { message: { role: "user", content: "What color did I just say?" }, turn_id: "turn_2" },
        { commandId: "left_2", idempotencyKey: "left_2", attemptId: "attempt_left", turnId: "turn_2" }
      ),
      connector.execute(
        "send",
        { message: { role: "user", content: "What color did I just say?" }, turn_id: "turn_2" },
        { commandId: "right_2", idempotencyKey: "right_2", attemptId: "attempt_right", turnId: "turn_2" }
      )
    ]);
    expect("message" in leftFollowUp && leftFollowUp.message.content).toBe("You said the color was green.");
    expect("message" in rightFollowUp && rightFollowUp.message.content).toBe("You said the color was red.");

    const repetition = await connector.execute(
      "send",
      { message: { role: "user", content: "What color did I just say?" }, turn_id: "turn_1" },
      { commandId: "rep_1", idempotencyKey: "rep_1", attemptId: "attempt_repeat", turnId: "turn_1" }
    );
    expect("message" in repetition && repetition.message.content).toBe("I don't remember a previous color.");
  });

  it("applies a corrected fact in the same attempt", async () => {
    const started = await startSessionTarget();
    servers.push(started.server);
    const connector = new HttpConnector(sessionConfig(started.server.baseUrl));
    const context = { commandId: "fx", attemptId: "attempt_fact" };

    await connector.execute(
      "send",
      { message: { role: "user", content: "The return window is 14 days." }, turn_id: "t1" },
      { ...context, commandId: "fx1", idempotencyKey: "fx1", turnId: "t1" }
    );
    await connector.execute(
      "send",
      { message: { role: "user", content: "Correction: the return window is 30 days." }, turn_id: "t2" },
      { ...context, commandId: "fx2", idempotencyKey: "fx2", turnId: "t2" }
    );
    const asked = await connector.execute(
      "send",
      { message: { role: "user", content: "How long is the return window?" }, turn_id: "t3" },
      { ...context, commandId: "fx3", idempotencyKey: "fx3", turnId: "t3" }
    );
    expect("message" in asked && asked.message.content).toBe("The return window is 30 days.");
  });

  it("does not append a second user message when an accepted turn is replayed", async () => {
    const started = await startSessionTarget();
    servers.push(started.server);
    const connector = new HttpConnector(sessionConfig(started.server.baseUrl));
    const input = { message: { role: "user" as const, content: "The color is yellow." }, turn_id: "turn_1" };
    const context = {
      commandId: "replay_1",
      idempotencyKey: "same-key",
      attemptId: "attempt_replay",
      turnId: "turn_1"
    };
    const first = await connector.execute("send", input, context);
    const second = await connector.execute("send", input, context);
    expect(first).toEqual(second);
    expect(started.sessions.get("attempt_replay")?.userMessages).toEqual(["The color is yellow."]);
  });

  it("keeps a missing session as a connector failure, distinct from a chatbot miss", async () => {
    const started = await startSessionTarget();
    servers.push(started.server);
    const connector = new HttpConnector(sessionConfig(started.server.baseUrl));

    await expect(
      connector.execute(
        "send",
        { message: { role: "user", content: "What color did I just say?" }, turn_id: "turn_1" },
        { commandId: "missing", idempotencyKey: "missing", turnId: "turn_1" }
      )
    ).rejects.toMatchObject({
      code: "SESSION_CONVERSATION_ID_MISSING",
      category: "config"
    });

    const missingSession = await fetch(`${started.server.baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "aw-idempotency-key": "raw" },
      body: JSON.stringify({ message: "What color did I just say?", turn_id: "turn_1" })
    });
    expect(missingSession.status).toBe(400);
    expect(await missingSession.json()).toEqual({ error: "session_required" });

    const miss = await connector.execute(
      "send",
      { message: { role: "user", content: "What color did I just say?" }, turn_id: "turn_1" },
      { commandId: "miss", idempotencyKey: "miss", attemptId: "attempt_miss", turnId: "turn_1" }
    );
    expect("message" in miss && miss.message.content).toBe("I don't remember a previous color.");
  });
});
