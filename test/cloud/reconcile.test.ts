import { describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { RELAY_PROTOCOL_VERSION } from "../../src/cloud/protocol.js";
import { RUN_INTENT_RECONCILE_PROTOCOL_VERSION } from "../../src/cloud/recovery-protocol.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";

const request = {
  protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
  create_request_id: `crq_${"a".repeat(32)}`,
  create_request_sha256: "b".repeat(64),
  workspace_id: "workspace-1",
  connector_id: "connector-1",
  retire_if_uncreated: false
} as const;

describe("run-intent reconcile client", () => {
  it("maps a missing route to RECOVERY_UNSUPPORTED without treating it as uncreated", async () => {
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "token",
      fetch: vi.fn(async () =>
        Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 })
      )
    });
    await expect(client.reconcileRunIntent(request)).rejects.toMatchObject({
      code: "RECOVERY_UNSUPPORTED"
    });
  });

  it("rejects a bound result whose request identity drifted", async () => {
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "token",
      fetch: vi.fn(async () =>
        Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "bound",
          create_request_id: `crq_${"z".repeat(32)}`,
          create_request_sha256: "c".repeat(64),
          binding: {
            protocol_version: RELAY_PROTOCOL_VERSION,
            create_request_id: `crq_${"z".repeat(32)}`,
            create_request_sha256: "c".repeat(64),
            create_disposition: "created",
            run_id: "run-other",
            session_id: "session-1",
            packet: { key: "support-refunds", version: "0.1.0", sha256: "a".repeat(64) },
            config_sha256: "d".repeat(64),
            fencing_epoch: 1,
            status: "completed",
            dashboard_url: "http://127.0.0.1:8787/portal/runs/run-other",
            run_expires_at: "2099-01-01T00:00:00.000Z",
            credit_state: "consumed"
          },
          target_execution: "terminal"
        })
      )
    });
    await expect(client.reconcileRunIntent(request)).rejects.toMatchObject({
      code: "RUN_BINDING_MISMATCH"
    });
  });

  it("does not treat extra fields on legacy create success as valid", async () => {
    const createRequest = {
      protocol_version: RELAY_PROTOCOL_VERSION,
      create_request_id: `crq_${"a".repeat(32)}`,
      packet: { key: "support-refunds", version: "0.1.0" },
      config_sha256: "b".repeat(64),
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    };
    const client = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "token",
      fetch: vi.fn(async () =>
        Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          create_request_id: createRequest.create_request_id,
          create_request_sha256: sha256(canonicalize(createRequest)),
          create_disposition: "created",
          run_id: "run-1",
          session_id: "session-1",
          packet: { key: "support-refunds", version: "0.1.0", sha256: "a".repeat(64) },
          config_sha256: createRequest.config_sha256,
          fencing_epoch: 1,
          status: "queued",
          dashboard_url: "http://127.0.0.1:8787/portal/runs/run-1",
          run_expires_at: "2099-01-01T00:00:00.000Z",
          credit_state: "reserved",
          evaluation: "pending"
        })
      )
    });
    await expect(client.createRun(createRequest)).rejects.toMatchObject({
      code: "INVALID_CLOUD_RESPONSE"
    });
  });
});
