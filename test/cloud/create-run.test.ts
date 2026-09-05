import { describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import {
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  type CreateRunRequest
} from "../../src/cloud/protocol.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";

const createRequest: CreateRunRequest = {
  protocol_version: "aw-relay/0.1",
  create_request_id: `crq_${"a".repeat(32)}`,
  packet: { key: "support-refunds", version: "0.1.0" },
  config_sha256: "b".repeat(64),
  target: {
    name: "refunds",
    boundary_sha256: "c".repeat(64),
    capabilities: {
      prepare: true,
      observation: true,
      cleanup: true,
      tool_events: true,
      observation_keys: ["order.refunded_amount", "order.status"]
    }
  }
};

function replayedResponse(requestSha256 = sha256(canonicalize(createRequest))) {
  return {
    protocol_version: "aw-relay/0.1",
    create_request_id: createRequest.create_request_id,
    create_request_sha256: requestSha256,
    create_disposition: "replayed",
    run_id: "run-1",
    session_id: "session-1",
    packet: {
      ...createRequest.packet,
      sha256: "d".repeat(64)
    },
    config_sha256: createRequest.config_sha256,
    fencing_epoch: 1,
    status: "connected",
    dashboard_url: "http://127.0.0.1:8787/dashboard/run-1",
    run_expires_at: "2099-08-30T12:00:00.000Z",
    credit_state: "reserved"
  };
}

describe("idempotent run creation", () => {
  it("requires sorted unique observation aliases and strict create bindings", () => {
    const capabilities = createRequest.target.capabilities;
    expect(
      CreateRunRequestSchema.safeParse({
        ...createRequest,
        target: {
          ...createRequest.target,
          capabilities: {
            ...capabilities,
            observation_keys: ["order.status", "order.refunded_amount"]
          }
        }
      }).success
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        ...createRequest,
        target: {
          ...createRequest.target,
          capabilities: {
            ...capabilities,
            observation_keys: ["order.status", "order.status"]
          }
        }
      }).success
    ).toBe(false);
    expect(
      CreateRunResponseSchema.safeParse({
        ...replayedResponse(),
        credit_state: "unknown"
      }).success
    ).toBe(false);
  });

  it("accepts aw-relay/0.2 create requests with assessment metadata", () => {
    expect(
      CreateRunRequestSchema.safeParse({
        ...createRequest,
        protocol_version: "aw-relay/0.2",
        assessment: {
          plan_hash: "e".repeat(64),
          profile: "quick",
          evaluation_mode: "hybrid",
          disclosure_version: "aw-judge-disclosure/1"
        },
        target: {
          ...createRequest.target,
          capabilities: {
            ...createRequest.target.capabilities,
            multi_turn: true
          }
        }
      }).success
    ).toBe(true);
    expect(
      CreateRunRequestSchema.safeParse({
        ...createRequest,
        assessment: {
          plan_hash: "e".repeat(64),
          profile: "quick",
          evaluation_mode: "hybrid",
          disclosure_version: "aw-judge-disclosure/1"
        }
      }).success
    ).toBe(false);
  });

  it("retries a lost committed response with a byte-identical body and key", async () => {
    const bodies: string[] = [];
    const keys: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(String(init?.body));
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (bodies.length === 1) {
        // The server may have committed before the transport failure surfaced locally.
        throw new TypeError("socket closed after commit");
      }
      return Response.json(replayedResponse());
    });
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "project-token",
      fetch: fetchMock,
      requestTimeoutMs: 100
    });

    const created = await client.createRun(createRequest);
    expect(created.create_disposition).toBe("replayed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toBe(canonicalize(createRequest));
    expect(new Set(bodies)).toEqual(new Set([canonicalize(createRequest)]));
    expect(new Set(keys)).toEqual(new Set([createRequest.create_request_id]));
  });

  it("rejects a create response whose echoed request digest drifted", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(replayedResponse("e".repeat(64)))
    );
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "project-token",
      fetch: fetchMock
    });

    await expect(client.createRun(createRequest)).rejects.toMatchObject({
      code: "RUN_BINDING_MISMATCH"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
