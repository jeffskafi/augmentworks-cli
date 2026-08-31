import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CreateRunRequest,
  CreateRunResponse,
  RunStatusResponse
} from "../../src/cloud/protocol.js";
import {
  RunIntentStore,
  isExpectedWindowsDirectorySyncError,
  type CreateRunIntentRequest
} from "../../src/relay/run-intent.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";

const temporaryDirectories: string[] = [];
const CREATE_ID = `crq_${"a".repeat(32)}`;
const TENANT = {
  workspace_id: "workspace-test",
  connector_id: "connector-test"
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-run-intent-"));
  temporaryDirectories.push(directory);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return directory;
}

function request(overrides: Partial<CreateRunIntentRequest> = {}): CreateRunIntentRequest {
  return {
    protocol_version: "aw-relay/0.1",
    packet: { key: "support-refunds", version: "0.1.0" },
    config_sha256: "a".repeat(64),
    target: {
      name: "refunds-staging",
      boundary_sha256: "c".repeat(64),
      capabilities: {
        prepare: true,
        observation: true,
        cleanup: true,
        tool_events: true,
        observation_keys: ["order.refunded_amount", "order.status"]
      }
    },
    ...overrides
  };
}

function binding(
  createRequest: CreateRunRequest,
  overrides: Partial<CreateRunResponse> = {}
): CreateRunResponse {
  return {
    protocol_version: "aw-relay/0.1",
    create_request_id: createRequest.create_request_id,
    create_request_sha256: sha256(canonicalize(createRequest)),
    create_disposition: "created",
    run_id: "run-1",
    session_id: "session-1",
    packet: {
      key: "support-refunds",
      version: "0.1.0",
      sha256: "b".repeat(64)
    },
    config_sha256: "a".repeat(64),
    fencing_epoch: 1,
    status: "connected",
    dashboard_url: "https://augmentworks.ai/dashboard/run-1",
    run_expires_at: "2099-08-30T12:00:00.000Z",
    credit_state: "reserved",
    ...overrides
  };
}

function createRequest(): CreateRunRequest {
  return { ...request(), create_request_id: CREATE_ID };
}

function legacyIntent(bound: boolean): Record<string, unknown> {
  const create = createRequest();
  const timestamp = "2026-08-30T12:00:00.000Z";
  return {
    intent_version: "aw-run-intent/0.1",
    phase: bound ? "bound" : "pending_create",
    api_origin: "https://augmentworks.ai/",
    request: create,
    request_sha256: sha256(canonicalize(create)),
    ...(bound ? { binding: binding(create) } : {}),
    created_at: timestamp,
    updated_at: timestamp
  };
}

describe("RunIntentStore", () => {
  it("persists before create and resumes the exact secret-free request", async () => {
    const stateDirectory = await temporaryDirectory();
    const apiOrigin = new URL("http://127.0.0.1:8787/api/v1/");
    const first = new RunIntentStore({
      apiOrigin,
      tenant: TENANT,
      stateDirectory,
      createRequestId: () => CREATE_ID
    });
    await first.open();
    const created = await first.loadOrCreate(request());
    expect(created.resumed).toBe(false);
    expect(created.intent.request.create_request_id).toBe(CREATE_ID);
    const intentPath = first.path;
    await first.close();

    const serialized = await readFile(intentPath, "utf8");
    expect(serialized).not.toContain("target-secret");
    expect(serialized).not.toContain("CHATBOT_API_KEY");
    expect(serialized).not.toContain("/__augmentworks/");
    if (process.platform !== "win32") {
      expect((await lstat(intentPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(intentPath))).mode & 0o777).toBe(0o700);
    }

    const second = new RunIntentStore({
      apiOrigin,
      tenant: TENANT,
      stateDirectory
    });
    await second.open();
    const resumed = await second.loadOrCreate(request());
    expect(resumed.resumed).toBe(true);
    expect(resumed.intent.request).toEqual(created.intent.request);
    await second.close();

    const otherPrefix = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/api/v2/"),
      tenant: TENANT,
      stateDirectory
    });
    expect(otherPrefix.path).not.toBe(intentPath);
  });

  it("refuses a mismatched active request without replacing it", async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory,
      createRequestId: () => CREATE_ID
    });
    await store.open();
    await store.loadOrCreate(request());
    const before = await readFile(store.path, "utf8");
    await expect(
      store.loadOrCreate(request({ packet: { key: "another-packet", version: "0.1.0" } }))
    ).rejects.toMatchObject({ code: "ACTIVE_RUN_EXISTS" });
    await expect(
      store.loadOrCreate(
        request({
          target: {
            ...request().target,
            boundary_sha256: "d".repeat(64)
          }
        })
      )
    ).rejects.toMatchObject({ code: "ACTIVE_RUN_EXISTS" });
    expect(await readFile(store.path, "utf8")).toBe(before);
    await store.close();
  });

  it("rejects a connector or workspace switch before an active intent can be reused", async () => {
    const stateDirectory = await temporaryDirectory();
    const apiOrigin = new URL("https://augmentworks.ai/");
    const original = new RunIntentStore({
      apiOrigin,
      tenant: TENANT,
      stateDirectory,
      createRequestId: () => CREATE_ID
    });
    await original.open();
    await original.loadOrCreate(request());
    const before = await readFile(original.path, "utf8");
    await original.close();

    const switched = new RunIntentStore({
      apiOrigin,
      tenant: {
        workspace_id: "workspace-other",
        connector_id: "connector-other"
      },
      stateDirectory
    });
    await expect(switched.open()).rejects.toMatchObject({
      code: "ACTIVE_RUN_TENANT_MISMATCH"
    });
    expect(await readFile(original.path, "utf8")).toBe(before);
  });

  it("migrates a legacy bound intent only after authoritative run access is verified", async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory
    });
    await mkdir(dirname(store.path), { recursive: true, mode: 0o700 });
    await writeFile(store.path, `${JSON.stringify(legacyIntent(true))}\n`, {
      mode: 0o600
    });

    await store.open();
    const verifiedRuns: string[] = [];
    await expect(
      store.migrateLegacyTenantBinding(async (legacyBinding, tenant) => {
        verifiedRuns.push(legacyBinding.run_id);
        expect(tenant).toEqual(TENANT);
        return true;
      })
    ).resolves.toBe(true);
    expect(verifiedRuns).toEqual(["run-1"]);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toMatchObject({
      intent_version: "aw-run-intent/0.2",
      tenant: TENANT,
      phase: "bound"
    });
    await store.close();
  });

  it("refuses an unbound legacy intent instead of guessing its tenant", async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory
    });
    await mkdir(dirname(store.path), { recursive: true, mode: 0o700 });
    await writeFile(store.path, `${JSON.stringify(legacyIntent(false))}\n`, {
      mode: 0o600
    });

    await store.open();
    let verificationCalls = 0;
    await expect(
      store.migrateLegacyTenantBinding(async () => {
        verificationCalls += 1;
        return true;
      })
    ).rejects.toMatchObject({ code: "LEGACY_RUN_INTENT_TENANT_UNVERIFIED" });
    expect(verificationCalls).toBe(0);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toMatchObject({
      intent_version: "aw-run-intent/0.1",
      phase: "pending_create"
    });
    await store.close();
  });

  it("persists a binding and rejects immutable drift on replay", async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory,
      createRequestId: () => CREATE_ID
    });
    await store.open();
    const loaded = await store.loadOrCreate(request());
    const initial = binding(loaded.intent.request);
    await store.bind(initial);
    await store.bind(
      binding(loaded.intent.request, {
        create_disposition: "replayed",
        status: "running",
        credit_state: "consumed"
      })
    );
    await expect(
      store.bind(binding(loaded.intent.request, { session_id: "session-drift" }))
    ).rejects.toMatchObject({ code: "RUN_BINDING_MISMATCH" });
    await store.close();
  });

  it("removes an intent only after an authoritative terminal result", async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory,
      createRequestId: () => CREATE_ID
    });
    await store.open();
    const loaded = await store.loadOrCreate(request());
    await store.bind(binding(loaded.intent.request));
    const active: RunStatusResponse = {
      protocol_version: "aw-relay/0.1",
      run_id: "run-1",
      status: "running",
      credit_state: "consumed"
    };
    await expect(store.removeTerminal(active)).rejects.toMatchObject({
      code: "RUN_NOT_TERMINAL"
    });
    expect((await lstat(store.path)).isFile()).toBe(true);
    await store.removeTerminal({
      ...active,
      status: "completed",
      outcome: "passed"
    });
    await expect(lstat(store.path)).rejects.toMatchObject({ code: "ENOENT" });
    await store.close();
  });

  it("rejects symlinks and broad file permissions", async () => {
    if (process.platform === "win32") return;
    const stateDirectory = await temporaryDirectory();
    const probe = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory
    });
    await mkdir(dirname(probe.path), { mode: 0o700 });
    const target = join(stateDirectory, "attacker-state");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, probe.path);
    await expect(probe.open()).rejects.toMatchObject({
      code: "UNSAFE_RUN_INTENT"
    });

    await rm(probe.path);
    const valid = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory,
      createRequestId: () => CREATE_ID
    });
    await valid.open();
    await valid.loadOrCreate(request());
    const path = valid.path;
    await valid.close();
    await chmod(path, 0o644);
    const broad = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory
    });
    await expect(broad.open()).rejects.toMatchObject({
      code: "UNSAFE_RUN_INTENT"
    });
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  });

  it("rejects an existing broad state directory without chmodding it", async () => {
    if (process.platform === "win32") return;
    const stateDirectory = await temporaryDirectory();
    await chmod(stateDirectory, 0o755);
    const store = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory
    });
    await expect(store.open()).rejects.toMatchObject({
      code: "UNSAFE_STATE_DIRECTORY"
    });
    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o755);
  });

  it("leaves no partial snapshot after atomic state transitions", async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new RunIntentStore({
      apiOrigin: new URL("https://augmentworks.ai/"),
      tenant: TENANT,
      stateDirectory,
      createRequestId: () => CREATE_ID
    });
    await store.open();
    const loaded = await store.loadOrCreate(request());
    await store.bind(binding(loaded.intent.request));
    expect(JSON.parse(await readFile(store.path, "utf8"))).toMatchObject({
      phase: "bound"
    });
    expect((await readdir(dirname(store.path))).filter((name) => name.endsWith(".tmp"))).toEqual(
      []
    );
    await store.close();
  });
});

describe("Windows directory durability fallback", () => {
  it("tolerates only known unsupported directory-sync errors on Windows", () => {
    expect(isExpectedWindowsDirectorySyncError({ code: "EPERM" }, "win32")).toBe(true);
    expect(isExpectedWindowsDirectorySyncError({ code: "EPERM" }, "linux")).toBe(false);
    expect(isExpectedWindowsDirectorySyncError({ code: "EIO" }, "win32")).toBe(false);
  });
});
