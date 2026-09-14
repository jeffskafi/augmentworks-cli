import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { computeManifestIntegrityHash } from "../../src/selection/admit.js";
import { classifyManifestReleasePolicy } from "../../src/selection/classify.js";
import { EXIT, AwError } from "../../src/errors.js";
import {
  EvaluateManifestGateRequestSchema,
  MANIFEST_GATE_FORBIDDEN_REQUEST_KEYS,
  MANIFEST_GATE_MAX_BYTES,
  MANIFEST_GATE_SERVER_REASON_CODES,
  ManifestReleasePolicyV2Schema,
  SELECTION_PATHS,
  type EvaluateManifestGateRequest,
  type SuiteSelectionManifest
} from "../../src/selection/schema.js";
import {
  bindDeclaredShardsForGate,
  buildManifestGateRequest,
  mapManifestGateNetworkError,
  parseManifestGateResponse,
  requireGateManifest
} from "../../src/selection/gate-v2.js";
import { formatManifestGateHuman } from "../../src/selection/format.js";
import { runSourceCli } from "../util/cli-process.js";
import { listenLoopback, readJsonBody, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_gate_v2";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH_B = "3b4e26299b49dfd5a93b035b1e49efb6f069b1ff032e9f161ff699fa6de94c4e";

const v1Fixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-suite-selection-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };

const v2Contract = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-manifest-release-gate-v2.fixtures.json"), "utf8")
) as {
  discoveredPaths: Record<string, string>;
  reasonCodes: string[];
  forbiddenRequestKeys: string[];
  fixtures: Record<string, { request?: unknown; status?: number; response?: unknown; body?: string }>;
};

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  response.writeHead(status, {
    "content-type": headers["content-type"] ?? "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function identity(): Record<string, unknown> {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspace_id: WORKSPACE,
    workspace_name: "Test Workspace",
    connector_id: "connector_test",
    connector_name: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"]
  };
}

async function startMock(
  handler: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> | boolean
): Promise<{ server: ListeningServer; paths: string[]; authHeaders: string[] }> {
  const paths: string[] = [];
  const authHeaders: string[] = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    paths.push(`${request.method ?? "GET"} ${url.pathname}`);
    const authorization = request.headers.authorization;
    if (typeof authorization === "string") authHeaders.push(authorization);
    void Promise.resolve(handler(request, response, url)).then((handled) => {
      if (!handled && !response.writableEnded) {
        send(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
      }
    });
  });
  const server = await listenLoopback(httpServer);
  servers.push(server);
  return { server, paths, authHeaders };
}

function runEnv(apiOrigin?: string, extras: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AUGMENTWORKS_API_URL: apiOrigin ?? "http://127.0.0.1:1",
    AUGMENTWORKS_TOKEN: TOKEN,
    AUGMENTWORKS_API_KEY: "",
    AUGMENTWORKS_REFRESH_TOKEN: "",
    CI: "1",
    NO_COLOR: "1",
    ...extras
  };
}

function executableManifest(): SuiteSelectionManifest {
  const raw = v1Fixtures.fixtures["compile_executable"]?.response as SuiteSelectionManifest;
  return { ...raw, manifestHash: computeManifestIntegrityHash(raw) };
}

function multiShardManifest(): SuiteSelectionManifest {
  const base = executableManifest();
  const first = base.shards[0];
  if (first === undefined) throw new Error("missing shard");
  const draft: SuiteSelectionManifest = {
    ...base,
    shards: [first, { ...first, shardId: "shard-001", shardIndex: 1, shardIdentityHash: HASH_B }]
  };
  return { ...draft, manifestHash: computeManifestIntegrityHash(draft) };
}

function artifact(
  manifest: SuiteSelectionManifest,
  runIds: readonly string[],
  extras: Partial<{
    declaredShards: unknown;
    shardIdentityHash: string;
  }> = {}
): Record<string, unknown> {
  return {
    schemaVersion: "aw-selection-artifact/1",
    manifestHash: manifest.manifestHash,
    expectedShardIds: manifest.shards.map((shard) => shard.shardId),
    declaredShards:
      extras.declaredShards ??
      manifest.shards.map((shard, index) => ({
        shardId: shard.shardId,
        shardIdentityHash: extras.shardIdentityHash ?? shard.shardIdentityHash,
        runId: runIds[index] ?? RUN_A
      })),
    missingShardIds: [],
    skippedShardIds: [],
    failedShardIds: [],
    createsBillableRun: false
  };
}

async function writeGateFiles(
  manifest: SuiteSelectionManifest,
  declared: Record<string, unknown> | undefined
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "aw-gate-v2-"));
  temporaryDirectories.push(cwd);
  await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (declared !== undefined) {
    await writeFile(join(cwd, "declared-shards.json"), `${JSON.stringify(declared)}\n`, "utf8");
  }
  return cwd;
}

function goldenRequest(name: string): EvaluateManifestGateRequest {
  return EvaluateManifestGateRequestSchema.parse(v2Contract.fixtures[name]?.request);
}

function expectCode(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AwError);
    expect((error as AwError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("aw-manifest-release-gate-v2 golden fixtures", () => {
  it("keeps the consumer fixture checksum aligned with the lock file", async () => {
    const lock = JSON.parse(
      await readFile(resolve(projectRoot, "contracts/aw-manifest-release-gate-v2.lock.json"), "utf8")
    ) as { source: { consumerFixturesChecksum: string } };
    const bytes = await readFile(resolve(projectRoot, "contracts/aw-manifest-release-gate-v2.fixtures.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(lock.source.consumerFixturesChecksum);
  });

  it("freezes identity-only requests and both documented route aliases", () => {
    expect(v2Contract.discoveredPaths["evaluateManifest"]).toBe(`POST ${SELECTION_PATHS.evaluateManifest}`);
    expect(v2Contract.discoveredPaths["evaluateManifestAlias"]).toBe(`POST ${SELECTION_PATHS.evaluateManifestAlias}`);
    expect(SELECTION_PATHS.evaluateManifest).not.toBe(SELECTION_PATHS.evaluateManifestAlias);
    const one = goldenRequest("request_one_shard");
    const multi = goldenRequest("request_multi_shard");
    expect(one.declaredShards).toHaveLength(1);
    expect(multi.declaredShards).toHaveLength(2);
    for (const key of v2Contract.forbiddenRequestKeys) {
      expect(one).not.toHaveProperty(key);
      expect(MANIFEST_GATE_FORBIDDEN_REQUEST_KEYS).toContain(key);
    }
    expect(v2Contract.reasonCodes).toEqual([...MANIFEST_GATE_SERVER_REASON_CODES]);
    expect(EvaluateManifestGateRequestSchema.safeParse({ ...one, manifest: {} }).success).toBe(false);
    expect(EvaluateManifestGateRequestSchema.safeParse({ ...one, declaredShards: [] }).success).toBe(false);
  });

  it("parses the golden pass and domain receipts", () => {
    const request = goldenRequest("request_one_shard");
    const pass = parseManifestGateResponse(v2Contract.fixtures["response_pass"]?.response, request);
    expect(classifyManifestReleasePolicy(pass).exitCode).toBe(0);
    const block = parseManifestGateResponse(v2Contract.fixtures["response_block"]?.response, request);
    expect(classifyManifestReleasePolicy(block).exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    const incomplete = parseManifestGateResponse(v2Contract.fixtures["response_incomplete"]?.response, request);
    expect(classifyManifestReleasePolicy(incomplete).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const incompatible = parseManifestGateResponse(v2Contract.fixtures["response_incompatible"]?.response, request);
    expect(classifyManifestReleasePolicy(incompatible).exitCode).toBe(EXIT.CONFIG);
    const passText = formatManifestGateHuman(pass, classifyManifestReleasePolicy(pass));
    expect(passText).toContain("Decision: pass");
    expect(passText).toContain("Next action:");
    expect(passText).not.toContain("policyVersion");
  });
});

describe("manifest gate v2 preflight", () => {
  it("accepts exact one-shard and reordered multi-shard declarations", () => {
    const one = executableManifest();
    requireGateManifest(one);
    const bound = bindDeclaredShardsForGate(one, [
      { shardId: "shard-000", shardIdentityHash: one.shards[0]!.shardIdentityHash, runId: RUN_A }
    ]);
    const request = buildManifestGateRequest(one, bound);
    expect(request.schemaVersion).toBe("aw-manifest-release-gate-request/2");
    expect(Object.keys(request).sort()).toEqual(["declaredShards", "manifestHash", "schemaVersion"]);

    const multi = multiShardManifest();
    const reordered = buildManifestGateRequest(multi, [
      { shardId: "shard-001", shardIdentityHash: HASH_B, runId: RUN_B },
      { shardId: "shard-000", shardIdentityHash: multi.shards[0]!.shardIdentityHash, runId: RUN_A }
    ]);
    expect(reordered.declaredShards.map((shard) => shard.shardId)).toEqual(["shard-000", "shard-001"]);
  });

  it("rejects empty, non-executable, zero-case, and tampered manifests before constructing a request", () => {
    const empty = v1Fixtures.fixtures["compile_empty"]?.response as SuiteSelectionManifest;
    expectCode(() => requireGateManifest({ ...empty, manifestHash: computeManifestIntegrityHash(empty) }), "MANIFEST_EMPTY");
    const executable = executableManifest();
    const notExecutable = {
      ...executable,
      executable: false,
      unexecutableReason: "The compiled selection is not executable."
    };
    expectCode(
      () => requireGateManifest({ ...notExecutable, manifestHash: computeManifestIntegrityHash(notExecutable) }),
      "MANIFEST_NOT_EXECUTABLE"
    );
    expectCode(() => requireGateManifest({ ...executable, manifestHash: "a".repeat(64) }), "MANIFEST_INTEGRITY_MISMATCH");
    expectCode(
      () => requireGateManifest({ ...executable, includedCaseCount: 0, manifestHash: executable.manifestHash }),
      "MANIFEST_INTEGRITY_MISMATCH"
    );
  });

  it("rejects missing, extra, duplicate, wrong-hash, and invalid declarations", () => {
    const one = executableManifest();
    expectCode(() => bindDeclaredShardsForGate(one, []), "MANIFEST_DECLARATION_INCOMPLETE");
    expectCode(
      () =>
        bindDeclaredShardsForGate(one, [
          { shardId: "shard-000", shardIdentityHash: one.shards[0]!.shardIdentityHash, runId: RUN_A },
          { shardId: "shard-001", shardIdentityHash: HASH_B, runId: RUN_B }
        ]),
      "MANIFEST_DECLARATION_INCOMPLETE"
    );
    expectCode(
      () =>
        bindDeclaredShardsForGate(one, [
          { shardId: "shard-000", shardIdentityHash: one.shards[0]!.shardIdentityHash, runId: RUN_A },
          { shardId: "shard-000", shardIdentityHash: one.shards[0]!.shardIdentityHash, runId: RUN_B }
        ]),
      "MANIFEST_DECLARATION_DUPLICATE"
    );
    expectCode(
      () => bindDeclaredShardsForGate(one, [{ shardId: "shard-000", shardIdentityHash: HASH_B, runId: RUN_A }]),
      "MANIFEST_DECLARATION_INCOMPLETE"
    );
    expectCode(
      () =>
        bindDeclaredShardsForGate(one, [
          { shardId: "shard-000", shardIdentityHash: one.shards[0]!.shardIdentityHash, runId: "not-a-uuid" }
        ]),
      "MANIFEST_DECLARATION_INCOMPLETE"
    );
    const seventeen = Array.from({ length: 17 }, (_, index) => ({
      shardId: `shard-${String(index).padStart(3, "0")}`,
      shardIdentityHash: "a".repeat(64),
      runId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${String(index).padStart(2, "0")}`
    }));
    expectCode(() => bindDeclaredShardsForGate(one, seventeen), "MANIFEST_DECLARATION_INCOMPLETE");
  });
});

describe("manifest gate v2 response identity proof", () => {
  const request = goldenRequest("request_one_shard");

  it("maps adversarial golden receipts to stable fail-closed codes", () => {
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_v1"]?.response, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_unknown_version"]?.response, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_empty_resolved"]?.response, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_wrong_manifest"]?.response, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_wrong_run"]?.response, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_extra_field"]?.response, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_caller_evidence"]?.response, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_pass_coverage_false"]?.response, request),
      "MANIFEST_GATE_RESPONSE_MISMATCH"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_nonterminal_pass"]?.response, request),
      "MANIFEST_GATE_RESPONSE_MISMATCH"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_pass_billable"]?.response, request),
      "CREATES_BILLABLE_RUN"
    );
    const unknown = parseManifestGateResponse(v2Contract.fixtures["response_unknown_reason"]?.response, request);
    expect(classifyManifestReleasePolicy(unknown).reasonCodes).toEqual(["MANIFEST_GATE_UNKNOWN_REASON"]);
    expect(classifyManifestReleasePolicy(unknown).exitCode).not.toBe(0);
    const passBody = v2Contract.fixtures["response_pass"]?.response as Record<string, unknown>;
    const shard = (passBody["resolvedShards"] as Record<string, unknown>[])[0];
    expect(shard).toBeDefined();
    expectCode(
      () => parseManifestGateResponse({ ...passBody, resolvedShards: [shard, { ...shard }] }, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () =>
        parseManifestGateResponse(
          { ...passBody, resolvedShards: [{ ...shard, executionState: "done" }] },
          request
        ),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
  });

  it("rejects oversized and multi-shard golden receipts against a one-shard request", () => {
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_pass"]?.response, request, { encodedBytes: MANIFEST_GATE_MAX_BYTES + 1 }),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    expectCode(
      () => parseManifestGateResponse(v2Contract.fixtures["response_pass_multi"]?.response, request),
      "MANIFEST_GATE_CONTRACT_UNSUPPORTED"
    );
    const classified = classifyManifestReleasePolicy(
      parseManifestGateResponse(v2Contract.fixtures["response_pass_multi"]?.response, goldenRequest("request_multi_shard"))
    );
    expect(classified.exitCode).toBe(0);
  });

  it("maps HTTP/auth/network families without echoing server bodies", () => {
    const notFound = mapManifestGateNetworkError(
      new AwError({
        code: "CLOUD_REQUEST_FAILED",
        category: "relay",
        message: "owned by workspace other-tenant",
        details: { http_status: 404 }
      })
    );
    expect(notFound.code).toBe("MANIFEST_GATE_NOT_FOUND");
    expect(notFound.message).not.toMatch(/other-tenant/);
    expect(mapManifestGateNetworkError(new AwError({
      code: "CLOUD_REQUEST_FAILED",
      category: "relay",
      message: "upgrade",
      details: { http_status: 426 }
    })).code).toBe("MANIFEST_GATE_CONTRACT_UNSUPPORTED");
    expect(mapManifestGateNetworkError(new AwError({
      code: "CLOUD_REQUEST_FAILED",
      category: "relay",
      message: "limited",
      retryable: true,
      details: { http_status: 429, retry_after_ms: 1000 }
    })).code).toBe("MANIFEST_GATE_RATE_LIMITED");
    expect(mapManifestGateNetworkError(new AwError({
      code: "RELAY_UNREACHABLE",
      category: "relay",
      message: "The AugmentWorks relay response timed out.",
      retryable: true
    })).code).toBe("MANIFEST_GATE_TIMEOUT");
    expect(
      mapManifestGateNetworkError(
        new AwError({
          code: "RELAY_UNREACHABLE",
          category: "relay",
          message: "Could not reach the AugmentWorks relay.",
          cause: Object.assign(new Error("certificate verify failed"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })
        })
      ).code
    ).toBe("MANIFEST_GATE_TLS");
    expect(
      mapManifestGateNetworkError(
        new AwError({
          code: "RELAY_UNREACHABLE",
          category: "relay",
          message: "Could not reach the AugmentWorks relay.",
          cause: new Error("URI requested responds with a redirect, redirect mode is set to error")
        })
      ).code
    ).toBe("MANIFEST_GATE_UNSAFE_REDIRECT");
    expect(
      mapManifestGateNetworkError(
        new AwError({
          code: "RELAY_UNREACHABLE",
          category: "relay",
          message: "Could not reach the AugmentWorks relay.",
          cause: new Error("request timeout")
        })
      ).code
    ).toBe("MANIFEST_GATE_TIMEOUT");
    expect(
      mapManifestGateNetworkError(
        new AwError({
          code: "CLOUD_REQUEST_FAILED",
          category: "relay",
          retryable: true,
          message: "timeout",
          details: { http_status: 408 }
        })
      ).code
    ).toBe("MANIFEST_GATE_TIMEOUT");
  });
});

describe("manifest gate v2 CLI", () => {
  it("does not authenticate or POST for invalid local preflight", async () => {
    const emptyManifest = v1Fixtures.fixtures["compile_empty"]?.response as SuiteSelectionManifest;
    const cwd = await writeGateFiles(
      { ...emptyManifest, manifestHash: computeManifestIntegrityHash(emptyManifest) },
      undefined
    );
    const { server: emptyServer, paths } = await startMock(() => false);
    const empty = await runSourceCli(["gate", "--manifest-file", "suite-selection.manifest.json", "--json"], {
      cwd,
      env: runEnv(emptyServer.baseUrl, { AUGMENTWORKS_TOKEN: "", AUGMENTWORKS_API_KEY: "" })
    });
    expect(empty.exitCode).toBe(EXIT.CONFIG);
    expect(empty.stderr).toContain("MANIFEST_EMPTY");
    expect(paths).toEqual([]);

    const hashed = executableManifest();
    const { server: incompleteServer, paths: incompletePaths } = await startMock(() => false);
    const incompleteCwd = await writeGateFiles(hashed, undefined);
    const incomplete = await runSourceCli(["gate", "--manifest-file", "suite-selection.manifest.json", "--json"], {
      cwd: incompleteCwd,
      env: runEnv(incompleteServer.baseUrl)
    });
    expect(incomplete.exitCode).toBe(EXIT.CONFIG);
    expect(incomplete.stderr).toContain("MANIFEST_DECLARATION_INCOMPLETE");
    expect(JSON.parse(incomplete.stdout).code).toBe("MANIFEST_DECLARATION_INCOMPLETE");
    expect(incompletePaths).toEqual([]);

    const { server: tamperedServer, paths: tamperedPaths } = await startMock(() => false);
    const tamperedCwd = await writeGateFiles({ ...hashed, manifestHash: "a".repeat(64) }, artifact(hashed, [RUN_A]));
    const tampered = await runSourceCli(
      ["gate", "--manifest-file", "suite-selection.manifest.json", "--declared-shards", "declared-shards.json", "--json"],
      { cwd: tamperedCwd, env: runEnv(tamperedServer.baseUrl) }
    );
    expect(tampered.stderr).toContain("MANIFEST_INTEGRITY_MISMATCH");
    expect(tamperedPaths).toEqual([]);

    const blocked = { ...hashed, executable: false, unexecutableReason: "The compiled selection is not executable." };
    const { server: nonExecServer, paths: nonExecPaths } = await startMock(() => false);
    const nonExecCwd = await writeGateFiles(
      { ...blocked, manifestHash: computeManifestIntegrityHash(blocked) },
      artifact(hashed, [RUN_A])
    );
    const nonExec = await runSourceCli(
      ["gate", "--manifest-file", "suite-selection.manifest.json", "--declared-shards", "declared-shards.json", "--json"],
      { cwd: nonExecCwd, env: runEnv(nonExecServer.baseUrl) }
    );
    expect(nonExec.stderr).toContain("MANIFEST_NOT_EXECUTABLE");
    expect(nonExecPaths).toEqual([]);
  });

  it("exits 0 only for an exact authoritative v2 pass and POSTs identity-only to /v1", async () => {
    const manifest = executableManifest();
    const cwd = await writeGateFiles(manifest, artifact(manifest, [RUN_A]));
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === SELECTION_PATHS.evaluateManifest) {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        expect(body["schemaVersion"]).toBe("aw-manifest-release-gate-request/2");
        expect(body).not.toHaveProperty("manifest");
        expect(body).not.toHaveProperty("expectedManifestHash");
        expect(Object.keys(body).sort()).toEqual(["declaredShards", "manifestHash", "schemaVersion"]);
        expect(body["manifestHash"]).toBe(manifest.manifestHash);
        const pass = ManifestReleasePolicyV2Schema.parse({
          documentKind: "aw-manifest-release-policy/2",
          manifestHash: manifest.manifestHash,
          decision: "pass",
          coverageComplete: true,
          evidenceSource: "server",
          reasonCodes: [],
          resolvedShards: [
            {
              shardId: "shard-000",
              shardIdentityHash: manifest.shards[0]!.shardIdentityHash,
              runId: RUN_A,
              executionState: "completed",
              evaluationStatus: "completed",
              decision: "pass"
            }
          ],
          createsBillableRun: false
        });
        send(response, 200, pass);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(
      ["gate", "--manifest-file", "suite-selection.manifest.json", "--declared-shards", "declared-shards.json", "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      assessment: string;
      decision: string;
      documentKind: string;
      evidenceSource: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.assessment).toBe("passed");
    expect(payload.decision).toBe("pass");
    expect(payload.documentKind).toBe("aw-manifest-release-policy/2");
    expect(payload.evidenceSource).toBe("server");
    expect(paths).toContain(`POST ${SELECTION_PATHS.evaluateManifest}`);
    expect(paths).not.toContain(`POST ${SELECTION_PATHS.evaluateManifestAlias}`);
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
  });

  it("maps authoritative block/incomplete/incompatible and never falls back to v1 pass", async () => {
    const manifest = executableManifest();
    for (const [name, exitCode] of [
      ["response_block", EXIT.ASSESSMENT_FAILED],
      ["response_incomplete", EXIT.EVALUATION_INCOMPLETE],
      ["response_incompatible", EXIT.CONFIG]
    ] as const) {
      const cwd = await writeGateFiles(manifest, artifact(manifest, [RUN_A]));
      const fixture = v2Contract.fixtures[name]?.response as Record<string, unknown>;
      const { server } = await startMock(async (request, response, url) => {
        if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
          send(response, 200, identity());
          return true;
        }
        if (request.method === "POST" && url.pathname === SELECTION_PATHS.evaluateManifest) {
          send(response, 200, { ...fixture, manifestHash: manifest.manifestHash, resolvedShards: [
            {
              ...((fixture["resolvedShards"] as Record<string, unknown>[])[0] ?? {}),
              shardIdentityHash: manifest.shards[0]!.shardIdentityHash
            }
          ] });
          return true;
        }
        return false;
      });
      const result = await runSourceCli(
        ["gate", "--manifest-file", "suite-selection.manifest.json", "--declared-shards", "declared-shards.json", "--json"],
        { cwd, env: runEnv(server.baseUrl) }
      );
      expect(result.exitCode).toBe(exitCode);
      expect(JSON.parse(result.stdout).ok).toBe(false);
    }

    const v1Cwd = await writeGateFiles(manifest, artifact(manifest, [RUN_A]));
    const v1 = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === SELECTION_PATHS.evaluateManifest) {
        send(response, 200, v2Contract.fixtures["response_v1"]?.response);
        return true;
      }
      return false;
    });
    const v1Result = await runSourceCli(
      ["gate", "--manifest-file", "suite-selection.manifest.json", "--declared-shards", "declared-shards.json", "--json"],
      { cwd: v1Cwd, env: runEnv(v1.server.baseUrl) }
    );
    expect(v1Result.exitCode).toBe(EXIT.RELAY);
    expect(v1Result.stderr).toContain("MANIFEST_GATE_CONTRACT_UNSUPPORTED");
    expect(v1Result.stderr).not.toContain("Bearer ");
    expect(v1Result.stdout).not.toContain(TOKEN);
  });

  it("maps HTML, malformed, oversized, 401/403/404/409/426/429/5xx without leaking secrets or foreign-workspace existence", async () => {
    const manifest = executableManifest();
    const cases: Array<{
      name: string;
      status: number;
      body: unknown;
      headers?: Record<string, string>;
      code: string;
    }> = [
      { name: "html", status: 200, body: "<html>pass</html>", headers: { "content-type": "text/html" }, code: "MANIFEST_GATE_CONTRACT_UNSUPPORTED" },
      { name: "malformed", status: 200, body: "{not-json", code: "MANIFEST_GATE_CONTRACT_UNSUPPORTED" },
      { name: "oversized", status: 200, body: { padding: "n".repeat(70 * 1024) }, code: "MANIFEST_GATE_CONTRACT_UNSUPPORTED" },
      { name: "401", status: 401, body: { error: { code: "UNAUTHORIZED", message: `token ${TOKEN}` } }, code: "CLOUD_AUTH_REJECTED" },
      { name: "403", status: 403, body: { error: { code: "FORBIDDEN", message: "missing action" } }, code: "CLOUD_AUTH_REJECTED" },
      { name: "404", status: 404, body: { error: { code: "NOT_FOUND", message: "owned by workspace other-tenant" } }, code: "MANIFEST_GATE_NOT_FOUND" },
      { name: "409", status: 409, body: { error: { code: "CONFLICT", message: "conflict" } }, code: "MANIFEST_GATE_IMMUTABLE_CONFLICT" },
      { name: "426", status: 426, body: { error: { code: "UPGRADE_REQUIRED", message: "v1" } }, code: "MANIFEST_GATE_CONTRACT_UNSUPPORTED" },
      { name: "429", status: 429, body: { error: { code: "RATE_LIMITED", message: "slow" } }, headers: { "Retry-After": "0" }, code: "MANIFEST_GATE_RATE_LIMITED" },
      { name: "500", status: 500, body: { error: { code: "INTERNAL", message: "boom" } }, code: "MANIFEST_GATE_UNAVAILABLE" }
    ];
    for (const testCase of cases) {
      const cwd = await writeGateFiles(manifest, artifact(manifest, [RUN_A]));
      const { server, paths } = await startMock(async (request, response, url) => {
        if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
          send(response, 200, identity());
          return true;
        }
        if (request.method === "POST" && url.pathname === SELECTION_PATHS.evaluateManifest) {
          send(response, testCase.status, testCase.body, testCase.headers ?? {});
          return true;
        }
        return false;
      });
      const result = await runSourceCli(
        ["gate", "--manifest-file", "suite-selection.manifest.json", "--declared-shards", "declared-shards.json", "--json"],
        { cwd, env: runEnv(server.baseUrl) }
      );
      expect(result.exitCode, testCase.name).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`, testCase.name).toContain(testCase.code);
      expect(`${result.stderr}\n${result.stdout}`, testCase.name).not.toContain(TOKEN);
      expect(`${result.stderr}\n${result.stdout}`, testCase.name).not.toContain("other-tenant");
      const evaluatePosts = paths.filter((path) => path === `POST ${SELECTION_PATHS.evaluateManifest}`);
      if (testCase.name === "429" || testCase.name === "500") {
        expect(evaluatePosts, testCase.name).toHaveLength(3);
      } else {
        expect(evaluatePosts.length, testCase.name).toBeLessThanOrEqual(2);
      }
    }
  });

  it("does not follow a cross-origin redirect with the bearer", async () => {
    const manifest = executableManifest();
    const cwd = await writeGateFiles(manifest, artifact(manifest, [RUN_A]));
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === SELECTION_PATHS.evaluateManifest) {
        response.writeHead(302, { Location: "http://example.com/steal", authorization: `Bearer ${TOKEN}` });
        response.end();
        return true;
      }
      return false;
    });
    const result = await runSourceCli(
      ["gate", "--manifest-file", "suite-selection.manifest.json", "--declared-shards", "declared-shards.json", "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/MANIFEST_GATE_UNSAFE_REDIRECT|MANIFEST_GATE_CONTRACT_UNSUPPORTED|RELAY_UNREACHABLE/);
    expect(paths.filter((path) => path === `POST ${SELECTION_PATHS.evaluateManifest}`)).toHaveLength(1);
    expect(result.stderr).not.toContain(TOKEN);
    expect(result.stdout).not.toContain(TOKEN);
  });
});
