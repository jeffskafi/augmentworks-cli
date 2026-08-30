import type { RelayCommand } from "../../src/cloud/protocol.js";

export const packet = {
  key: "support-refunds",
  version: "0.1.0",
  sha256: "a".repeat(64)
} as const;

export function relayCommand(
  kind: RelayCommand["kind"] = "send",
  overrides: Partial<RelayCommand> = {}
): RelayCommand {
  const now = Date.now();
  const common = {
    protocol_version: "aw-relay/0.1" as const,
    command_id: `command-${kind}-1`,
    session_id: "session-1",
    run_id: "run-1",
    attempt_id: "attempt-1",
    packet,
    config_sha256: "b".repeat(64),
    sequence: 1,
    fencing_epoch: 2,
    idempotency_key: `idempotency-${kind}-1`,
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString()
  };
  const command: RelayCommand =
    kind === "prepare"
      ? {
          ...common,
          kind,
          input: {
            protocol_version: "aw-target/0.1",
            run_id: common.run_id,
            attempt_id: common.attempt_id,
            scenario_key: "support-refunds.eligible",
            repetition_index: 0,
            idempotency_key: common.idempotency_key,
            mode: "evaluation",
            fixture: { order_id: "order-1" },
            metadata: {}
          }
        }
      : kind === "send"
        ? {
            ...common,
            kind,
            input: {
              protocol_version: "aw-target/0.1",
              turn_id: "turn-1",
              idempotency_key: common.idempotency_key,
              message: { role: "user", content: "Refund the order" },
              metadata: {}
            }
          }
        : kind === "observe"
          ? {
              ...common,
              kind,
              input: {
                protocol_version: "aw-target/0.1",
                request_id: "request-1",
                probe_keys: ["order.status"],
                metadata: {}
              }
            }
          : {
              ...common,
              kind,
              input: {
                protocol_version: "aw-target/0.1",
                attempt_id: common.attempt_id
              }
            };
  return { ...command, ...overrides } as RelayCommand;
}

export function resultFor(command: RelayCommand) {
  switch (command.kind) {
    case "prepare":
      return {
        protocol_version: "aw-target/0.1" as const,
        status: "ready" as const,
        attempt_id: command.attempt_id,
        metadata: {}
      };
    case "send":
      return {
        protocol_version: "aw-target/0.1" as const,
        turn_id: command.input.turn_id,
        message: { role: "assistant" as const, content: "Done" },
        events: [],
        finished: true,
        metadata: {}
      };
    case "observe":
      return {
        protocol_version: "aw-target/0.1" as const,
        request_id: command.input.request_id,
        observations: [
          { key: "order.status", value: "refunded", source: "db", authoritative: true }
        ],
        metadata: {}
      };
    case "cleanup":
      return {
        protocol_version: "aw-target/0.1" as const,
        status: "cleaned" as const,
        attempt_id: command.attempt_id
      };
  }
}
