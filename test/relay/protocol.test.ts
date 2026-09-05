import { describe, expect, it } from "vitest";

import {
  CreateRunRequestSchema,
  RunStatusResponseSchema,
  parseRelayCommand,
  parseRelayResult
} from "../../src/cloud/protocol.js";
import { LIMITS } from "../../src/util/limits.js";
import { relayCommand, resultFor } from "./helpers.js";

describe("aw-relay/0.1 protocol", () => {
  it("accepts only the four typed semantic operations", () => {
    for (const kind of ["prepare", "send", "observe", "cleanup"] as const) {
      const command = relayCommand(kind);
      expect(parseRelayCommand(command)).toEqual(command);
      expect(parseRelayResult(kind, resultFor(command))).toEqual(resultFor(command));
    }
  });

  it("rejects executable cloud instructions and unknown fields", () => {
    const command = relayCommand("send") as unknown as Record<string, unknown>;
    command["url"] = "https://attacker.test";
    expect(() => parseRelayCommand(command)).toThrowError(
      expect.objectContaining({ code: "INVALID_RELAY_PAYLOAD" })
    );
  });

  it("rejects duplicate observation probes", () => {
    const command = relayCommand("observe");
    if (command.kind !== "observe") throw new Error("expected observe command");
    command.input.probe_keys.push("order.status");
    expect(() => parseRelayCommand(command)).toThrowError(
      expect.objectContaining({ code: "INVALID_RELAY_PAYLOAD" })
    );
  });

  it("rejects results for the wrong operation shape", () => {
    const command = relayCommand("send");
    expect(() => parseRelayResult("send", resultFor(relayCommand("prepare")))).toThrowError(
      expect.objectContaining({ code: "INVALID_RELAY_PAYLOAD" })
    );
    expect(parseRelayResult("send", resultFor(command))).toMatchObject({ turn_id: "turn-1" });
  });

  it("accepts bounded target-defined identifiers without relay-identifier syntax restrictions", () => {
    const command = relayCommand("send");
    const result = resultFor(command);
    if (!("events" in result)) throw new Error("expected send result");
    const parsed = parseRelayResult("send", {
      ...result,
      turn_id: "target turn / ✓",
      events: [
        {
          type: "tool_call",
          event_id: "event with spaces / ✓",
          tool_name: "Refund Order (v2)",
          call_id: "call chosen by target",
          arguments: {}
        }
      ]
    });
    expect(parsed).toMatchObject({
      turn_id: "target turn / ✓",
      events: [{ event_id: "event with spaces / ✓", tool_name: "Refund Order (v2)" }]
    });
  });

  it.each([
    ["prepare attempt_id", "prepare", { attempt_id: "x".repeat(201) }],
    ["prepare target_session_id", "prepare", { target_session_id: "x".repeat(301) }],
    ["send turn_id", "send", { turn_id: "x".repeat(301) }],
    ["observe request_id", "observe", { request_id: "x".repeat(301) }],
    ["cleanup attempt_id", "cleanup", { attempt_id: "x".repeat(201) }]
  ] as const)("rejects an oversized target-defined %s", (_label, kind, override) => {
    const result = { ...resultFor(relayCommand(kind)), ...override };
    expect(() => parseRelayResult(kind, result)).toThrowError(
      expect.objectContaining({ code: "INVALID_RELAY_PAYLOAD" })
    );
  });

  it("enforces bounded event text fields through the shared result schema", () => {
    const command = relayCommand("send");
    const result = resultFor(command);
    if (!("events" in result)) throw new Error("expected send result");
    for (const event of [
      {
        type: "tool_call",
        event_id: "event-1",
        tool_name: "x".repeat(301),
        call_id: "call-1",
        arguments: {}
      },
      {
        type: "handoff",
        event_id: "event-2",
        destination: "human",
        reason: "x".repeat(2_001)
      },
      {
        type: "error",
        event_id: "event-3",
        code: "target-error",
        message: "x".repeat(2_001)
      }
    ]) {
      expect(() => parseRelayResult("send", { ...result, events: [event] })).toThrowError(
        expect.objectContaining({ code: "INVALID_RELAY_PAYLOAD" })
      );
    }
  });

  it("enforces assistant content by UTF-8 bytes for inputs and results", () => {
    const oversizedContent = "😀".repeat(Math.floor(LIMITS.maxMessageBytes / 4) + 1);
    const command = relayCommand("send");
    if (command.kind !== "send") throw new Error("expected send command");
    command.input.message.content = oversizedContent;
    expect(() => parseRelayCommand(command)).toThrowError(
      expect.objectContaining({ code: "RELAY_MESSAGE_TOO_LARGE" })
    );

    const result = resultFor(relayCommand("send"));
    if (!("message" in result)) throw new Error("expected send result");
    expect(() =>
      parseRelayResult("send", {
        ...result,
        message: { ...result.message, content: oversizedContent }
      })
    ).toThrowError(expect.objectContaining({ code: "EVIDENCE_LIMIT_EXCEEDED" }));
  });

  it("allows command sequence 512 only on aw-relay/0.2", () => {
    const command = relayCommand("send");
    expect(() => parseRelayCommand({ ...command, sequence: 101 })).toThrowError(
      expect.objectContaining({ code: "INVALID_RELAY_PAYLOAD" })
    );
    expect(
      parseRelayCommand({
        ...command,
        protocol_version: "aw-relay/0.2",
        sequence: 512
      }).sequence
    ).toBe(512);
    expect(() =>
      parseRelayCommand({
        ...command,
        protocol_version: "aw-relay/0.2",
        sequence: 513
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELAY_PAYLOAD" }));
  });

  it("recognizes optional evaluation_status on run status without requiring it", () => {
    expect(
      RunStatusResponseSchema.safeParse({
        protocol_version: "aw-relay/0.1",
        run_id: "run-1",
        status: "completed",
        credit_state: "consumed",
        outcome: "passed"
      }).success
    ).toBe(true);
    expect(
      RunStatusResponseSchema.safeParse({
        protocol_version: "aw-relay/0.2",
        run_id: "run-1",
        status: "completed",
        credit_state: "consumed",
        outcome: "passed",
        evaluation_status: "pending"
      }).success
    ).toBe(true);
  });

  it("accepts a v2 create-run assessment envelope", () => {
    expect(
      CreateRunRequestSchema.safeParse({
        protocol_version: "aw-relay/0.2",
        create_request_id: `crq_${"a".repeat(32)}`,
        packet: { key: "response-quality", version: "0.1.0" },
        config_sha256: "b".repeat(64),
        target: {
          name: "chat",
          boundary_sha256: "c".repeat(64),
          capabilities: {
            prepare: false,
            observation: false,
            cleanup: false,
            tool_events: false,
            multi_turn: true,
            observation_keys: []
          }
        },
        assessment: {
          plan_hash: "d".repeat(64),
          profile: "full",
          evaluation_mode: "hybrid",
          disclosure_version: "aw-judge-disclosure/1"
        }
      }).success
    ).toBe(true);
  });
});
