import { describe, expect, it, vi } from "vitest";

import { CloudClient, normalizeApiUrl } from "../../src/cloud/client.js";
import { RELAY_PROTOCOL_VERSION } from "../../src/cloud/protocol.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { packet, relayCommand, resultFor } from "./helpers.js";

describe("CloudClient", () => {
  it("binds create, poll, complete, fail, cancel, and status requests to the relay API", async () => {
    const command = relayCommand("send");
    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method} ${url.pathname}`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer project-token");
      if (url.pathname === "/v1/relay/runs" && init?.method === "POST") {
        const createRequest = JSON.parse(String(init.body)) as { create_request_id: string };
        expect(new Headers(init.headers).get("idempotency-key")).toBe(
          createRequest.create_request_id
        );
        return Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          create_request_id: createRequest.create_request_id,
          create_request_sha256: sha256(canonicalize(createRequest)),
          create_disposition: "created",
          run_id: command.run_id,
          session_id: command.session_id,
          packet,
          config_sha256: command.config_sha256,
          fencing_epoch: command.fencing_epoch,
          status: "connected",
          dashboard_url: "http://127.0.0.1:8787/dashboard/run-1",
          run_expires_at: new Date(Date.now() + 60_000).toISOString(),
          credit_state: "reserved"
        });
      }
      if (url.pathname.endsWith("commands:poll")) {
        return Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          run_id: command.run_id,
          session_id: command.session_id,
          status: "running",
          command
        });
      }
      if (url.pathname.endsWith(":complete") || url.pathname.endsWith(":fail")) {
        return Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          command_id: command.command_id,
          accepted: true
        });
      }
      if (url.pathname.endsWith(":cancel")) {
        return Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          run_id: command.run_id,
          status: "cancel_requested",
          credit_state: "consumed"
        });
      }
      return Response.json({
        protocol_version: RELAY_PROTOCOL_VERSION,
        run_id: command.run_id,
        status: "completed",
        outcome: "passed",
        credit_state: "consumed"
      });
    });
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "project-token",
      fetch: fetchMock
    });
    const created = await client.createRun({
      protocol_version: RELAY_PROTOCOL_VERSION,
      create_request_id: `crq_${"a".repeat(24)}`,
      packet: { key: packet.key, version: packet.version },
      config_sha256: command.config_sha256,
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: true,
          observation: true,
          cleanup: true,
          tool_events: true,
          observation_keys: ["order.status"]
        }
      }
    });
    expect(created.packet).toEqual(packet);
    await client.pollOperation({
      runId: command.run_id,
      sessionId: command.session_id,
      afterSequence: 0,
      fencingEpoch: command.fencing_epoch,
      waitMs: 0
    });
    await client.completeOperation(command, resultFor(command));
    await client.failOperation(
      command,
      { code: "TARGET_FAILED", safe_message: "Target failed.", retryable: false },
      "failed"
    );
    await client.cancelRun(command.run_id);
    await client.getRunStatus(command.run_id);
    expect(paths).toEqual([
      "POST /v1/relay/runs",
      "POST /v1/relay/sessions/session-1/commands:poll",
      "POST /v1/relay/commands/command-send-1:complete",
      "POST /v1/relay/commands/command-send-1:fail",
      "POST /v1/relay/runs/run-1:cancel",
      "GET /v1/relay/runs/run-1"
    ]);
  });

  it("allows only HTTPS or an HTTP loopback development relay", () => {
    expect(normalizeApiUrl("https://augmentworks.ai").origin).toBe("https://augmentworks.ai");
    expect(normalizeApiUrl("http://localhost:8787").origin).toBe("http://localhost:8787");
    expect(() => normalizeApiUrl("http://relay.example.com")).toThrowError(
      expect.objectContaining({ code: "INSECURE_API_URL" })
    );
    expect(() => normalizeApiUrl("https://user:secret@augmentworks.ai")).toThrowError(
      expect.objectContaining({ code: "INVALID_API_URL" })
    );
  });

  it("rejects oversized cloud responses before parsing them", async () => {
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "project-token",
      fetch: vi.fn<typeof fetch>(async () =>
        new Response("x", { headers: { "Content-Length": String(300 * 1024) } })
      )
    });
    await expect(client.getRunStatus("run-1")).rejects.toMatchObject({
      code: "RELAY_ENVELOPE_TOO_LARGE"
    });
  });

  it("rejects deeply nested JSON before recursive protocol validation", async () => {
    let nested: unknown = "leaf";
    for (let index = 0; index < 30; index += 1) nested = { child: nested };
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "project-token",
      fetch: vi.fn<typeof fetch>(async () => Response.json(nested))
    });
    await expect(client.getRunStatus("run-1")).rejects.toMatchObject({
      code: "EVIDENCE_LIMIT_EXCEEDED"
    });
  });

  it("keeps the timeout active while reading the response body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          }
        })
      );
    });
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "project-token",
      fetch: fetchMock,
      requestTimeoutMs: 10
    });
    await expect(client.getRunStatus("run-1")).rejects.toMatchObject({
      code: "RELAY_UNREACHABLE",
      retryable: true
    });
  });
});
