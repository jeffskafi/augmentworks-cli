import { describe, expect, it } from "vitest";

import {
  advertisedTargetCapabilities,
  assertConversationSupportsPacket,
  conversationIdMappedFields,
  resolveConversation,
  SINGLE_TURN_CONVERSATION
} from "../../src/config/conversation.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { validateConfigObject } from "../../src/config/validate.js";
import type { AugmentWorksConfig, ResolvedConfig } from "../../src/config/types.js";

function chat(overrides: Partial<AugmentWorksConfig["target"]> = {}): AugmentWorksConfig {
  return {
    version: 1,
    target: {
      name: "chat",
      connector: "http",
      base_url: "http://127.0.0.1:8000",
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          request: { message: "$input.message.content" },
          response: { content: "$.answer" }
        }
      },
      ...overrides
    }
  };
}

function resolvedFrom(config: AugmentWorksConfig): ResolvedConfig {
  const result = resolveConfig(config, "/tmp/augmentworks.yaml", "/tmp", {});
  if (result.resolvedConfig === undefined) {
    throw new Error(result.diagnostics.map((item) => item.message).join("; "));
  }
  return result.resolvedConfig;
}

describe("conversation configuration", () => {
  it("defaults to single-turn and omits hosted multi_turn", () => {
    const config = chat();
    expect(validateConfigObject(config).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONVERSATION_SINGLE_TURN", level: "ok" })])
    );
    const resolved = resolvedFrom(config);
    expect(resolved.conversation).toMatchObject(SINGLE_TURN_CONVERSATION);
    expect(advertisedTargetCapabilities(resolved)).toEqual({
      prepare: false,
      observation: false,
      cleanup: false,
      tool_events: false,
      observation_keys: []
    });
    expect(advertisedTargetCapabilities(resolved)).not.toHaveProperty("multi_turn");
    expect(advertisedTargetCapabilities(resolved)).not.toHaveProperty("conversation");
  });

  it("advertises only explicit_session_v1 when the identifier is mapped", () => {
    const config = chat({
      conversation: { strategy: "explicit_session_v1" },
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          idempotent: true,
          request: {
            message: "$input.message.content",
            conversation_id: "$input.conversation_id"
          },
          response: { content: "$.answer" }
        }
      }
    });
    expect(validateConfigObject(config).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CONVERSATION_EXPLICIT_SESSION", level: "ok" })
      ])
    );
    expect(conversationIdMappedFields(config.target.operations.send.request)).toEqual(["conversation_id"]);
    const resolved = resolvedFrom(config);
    expect(resolveConversation(config).strategy).toBe("explicit_session_v1");
    expect(advertisedTargetCapabilities(resolved)).toEqual({
      prepare: false,
      observation: false,
      cleanup: false,
      tool_events: false,
      observation_keys: [],
      multi_turn: true,
      conversation: {
        version: "aw-conversation-enforcement/1",
        strategy: "explicit_session_v1"
      }
    });
  });

  it("rejects a reserved or unknown strategy and an unmapped session", () => {
    expect(
      validateConfigObject(chat({ conversation: { strategy: "history_array_v1" } })).diagnostics
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SESSION_STRATEGY_UNSUPPORTED", level: "error" })
      ])
    );
    expect(
      validateConfigObject(chat({ conversation: { strategy: "inferred_memory" } })).diagnostics
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SESSION_STRATEGY_UNSUPPORTED", level: "error" })
      ])
    );
    expect(
      validateConfigObject(
        chat({
          conversation: { strategy: "explicit_session_v1" },
          operations: {
            send: {
              method: "POST",
              path: "/chat",
              request: {
                message: "$input.message.content",
                attempt_id: "$input.attempt_id"
              },
              response: { content: "$.answer" }
            }
          }
        })
      ).diagnostics
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SESSION_CONVERSATION_ID_UNMAPPED", level: "error" })
      ])
    );
  });

  it("does not treat a conversation_id mapping as valid single-turn configuration", () => {
    const mapped = chat({
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          request: {
            message: "$input.message.content",
            conversation_id: "$input.conversation_id"
          },
          response: { content: "$.answer" }
        }
      }
    });
    expect(validateConfigObject(mapped).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SESSION_CONVERSATION_ID_UNEXPECTED", level: "error" })
      ])
    );
    expect(
      validateConfigObject({
        ...mapped,
        target: { ...mapped.target, conversation: { strategy: "single_turn" } }
      }).diagnostics
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SESSION_CONVERSATION_ID_UNEXPECTED", level: "error" })
      ])
    );
    expect(
      validateConfigObject(
        chat({
          operations: {
            send: {
              method: "POST",
              path: "/chat",
              request: "$input",
              response: { content: "$.answer" }
            }
          }
        })
      ).diagnostics
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONVERSATION_SINGLE_TURN", level: "ok" })])
    );
  });

  it("warns when session duplicate suppression is not declared on send", () => {
    const config = chat({
      conversation: { strategy: "explicit_session_v1" },
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          request: {
            message: "$input.message.content",
            conversation_id: "$input.conversation_id"
          },
          response: { content: "$.answer" }
        }
      }
    });
    expect(validateConfigObject(config).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SESSION_IDEMPOTENCY_UNDECLARED", level: "warning" })
      ])
    );
  });

  it("fails closed before a multi-turn packet is admitted to a single-turn connector", () => {
    const resolved = resolvedFrom(chat());
    expect(() =>
      assertConversationSupportsPacket({
        resolved,
        packetRequiresMultiTurn: true,
        packetLabel: "conversation-session@0.1.0"
      })
    ).toThrowError(
      expect.objectContaining({
        code: "CONVERSATION_CAPABILITY_INCOMPATIBLE",
        category: "config"
      })
    );
    expect(() =>
      assertConversationSupportsPacket({
        resolved,
        packetRequiresMultiTurn: false
      })
    ).not.toThrow();
  });
});
