import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { localExitCode, runLocalTest } from "../../src/commands/local-test.js";
import { createTestCommand, type TestDependencies } from "../../src/commands/test.js";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { ConnectorResult } from "../../src/connector/types.js";
import { EXIT } from "../../src/errors.js";
import type { LoadedLocalPacket } from "../../src/local/packet.js";
import type { LocalConnector } from "../../src/local/runner.js";
import type { LocalRunResult, PacketManifest } from "../../src/local/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-local-command-"));
  directories.push(directory);
  return directory;
}

function manifest(): PacketManifest {
  return {
    schema_version: "aw-packet/0.1",
    packet_id: "command-test",
    version: "0.1.0",
    name: "Command test",
    description: "A synthetic local command test.",
    domain: "test",
    synthetic_only: true,
    required_capabilities: {
      multi_turn: false,
      observation: false,
      tool_events: false,
      cleanup: false
    },
    scenarios: [
      {
        key: "command-test.chat",
        name: "Chat",
        category: "test",
        severity: "low",
        description: "Exercise one local send.",
        expected_behavior: "The target responds locally.",
        fixture: {},
        turns: [{ content: "hello" }],
        observation_keys: [],
        assertions: [
          {
            kind: "assistant_contains",
            key: "hello",
            description: "The assistant responds.",
            value: "hello"
          }
        ],
        repetitions: 1,
        pass_threshold: 1
      }
    ]
  };
}

function resolvedConfig(): ResolvedConfig {
  return {
    config: {
      version: 1,
      target: {
        name: "local-command-target",
        connector: "http",
        base_url: "http://127.0.0.1:8000",
        operations: { send: { method: "POST", path: "/chat" } }
      }
    },
    configPath: "/not-exposed/augmentworks.yaml",
    configDirectory: "/not-exposed",
    configDigest: "b".repeat(64),
    baseUrl: new URL("http://127.0.0.1:8000"),
    authHeaders: {},
    secrets: ["configured-secret-canary"],
    capabilities: {
      level: "chat-only",
      prepare: false,
      observation: false,
      cleanup: false,
      tool_events: false
    },
    warnings: []
  };
}

function loadedPacket(): LoadedLocalPacket {
  const packet = manifest();
  return {
    manifest: packet,
    binding: {
      id: packet.packet_id,
      version: packet.version,
      sha256: "a".repeat(64),
      name: packet.name
    },
    source: { kind: "bundled", reference: "command-test@0.1.0" },
    derivedCommandCount: 1
  };
}

function localConnector(): LocalConnector {
  return {
    execute: async (kind, _input, context): Promise<ConnectorResult> => {
      if (kind !== "send") throw new Error(`unexpected ${kind}`);
      return {
        protocol_version: "aw-target/0.1",
        turn_id: context.turnId!,
        message: { role: "assistant", content: "hello from local target" },
        events: [],
        finished: true,
        metadata: {}
      };
    },
    isIdempotent: () => false
  };
}

function localDependencies() {
  const resolved = resolvedConfig();
  return {
    doctor: vi.fn(async () => ({
      ok: true,
      configPath: resolved.configPath,
      offline: true as const,
      diagnostics: [],
      resolvedConfig: resolved
    })),
    packetLoader: vi.fn(async () => loadedPacket()),
    connector: vi.fn(() => localConnector()),
    signals: {
      on: vi.fn(),
      off: vi.fn(),
      exit: vi.fn((code: number): never => {
        throw new Error(`unexpected process exit ${code}`);
      })
    }
  };
}

describe("test --local", () => {
  it("branches before hosted auth/cloud/relay work and emits only the sanitized result on stdout", async () => {
    const cwd = await temporaryDirectory();
    const outputDirectory = resolve(cwd, "reports", "exact-leaf");
    let stdout = "";
    let stderr = "";
    const apiOrigin = vi.fn((): URL => {
      throw new Error("hosted API origin must not run");
    });
    const accessToken = vi.fn(async (): Promise<string> => {
      throw new Error("hosted credentials must not load");
    });
    const cloud = vi.fn((): never => {
      throw new Error("hosted cloud client must not initialize");
    });
    const intentStore = vi.fn((): never => {
      throw new Error("hosted relay state must not initialize");
    });
    const relayRunner = vi.fn((): never => {
      throw new Error("hosted relay runner must not initialize");
    });
    const exitCodes: number[] = [];
    const dependencies: TestDependencies = {
      apiOrigin,
      accessToken,
      cloud,
      intentStore,
      runner: relayRunner,
      local: localDependencies(),
      stdout: {
        write: (value) => {
          stdout += String(value);
          return true;
        }
      },
      stderr: {
        write: (value) => {
          stderr += String(value);
          return true;
        }
      },
      setExitCode: (code) => exitCodes.push(code)
    };
    const command = createTestCommand(dependencies).exitOverride();

    await command.parseAsync(
      [
        "node",
        "augmentworks",
        "--local",
        "--packet",
        "command-test@0.1.0",
        "--output-dir",
        outputDirectory,
        "--json"
      ],
      { from: "node" }
    );

    expect(apiOrigin).not.toHaveBeenCalled();
    expect(accessToken).not.toHaveBeenCalled();
    expect(cloud).not.toHaveBeenCalled();
    expect(intentStore).not.toHaveBeenCalled();
    expect(relayRunner).not.toHaveBeenCalled();
    expect(exitCodes).toEqual([]);
    const parsed = JSON.parse(stdout) as LocalRunResult;
    expect(parsed).toMatchObject({
      schema_version: "AW-LOCAL-RESULT-1",
      outcome: "passed",
      provenance: { cloud_contacted: false, platform_received: false }
    });
    expect(stdout).not.toContain(outputDirectory);
    expect(stdout).not.toContain("configured-secret-canary");
    expect(stderr).toContain("LOCAL MODE");
    expect(stderr).toContain("AugmentWorks did not receive or independently verify this run");
    expect(JSON.parse(await readFile(resolve(outputDirectory, "report.json"), "utf8"))).toEqual(
      parsed
    );
  });

  it("anchors the default artifact directory to options.cwd, not process.cwd", async () => {
    const cwd = await temporaryDirectory();
    const local = localDependencies();

    const result = await runLocalTest(
      { cwd, packet: "command-test@0.1.0", json: true, handleSignals: false },
      { ...local, stderr: { write: () => true } }
    );

    expect(result.artifacts.directory.startsWith(resolve(cwd, ".augmentworks", "runs"))).toBe(
      true
    );
    expect(result.result.outcome).toBe("passed");
  });

  it("uses the documented local exit-code precedence", async () => {
    const cwd = await temporaryDirectory();
    const pass = await runLocalTest(
      {
        cwd,
        packet: "command-test@0.1.0",
        outputDirectory: "pass-report",
        handleSignals: false
      },
      { ...localDependencies(), stderr: { write: () => true } }
    );
    const withOutcome = (outcome: LocalRunResult["outcome"]) => ({
      ...pass,
      result: { ...pass.result, outcome }
    });

    expect(localExitCode(pass)).toBe(EXIT.OK);
    expect(localExitCode(withOutcome("failed"))).toBe(EXIT.ASSESSMENT_FAILED);
    expect(localExitCode(withOutcome("inconclusive"))).toBe(EXIT.ASSESSMENT_FAILED);
    expect(localExitCode(withOutcome("error"))).toBe(EXIT.TARGET);
    expect(localExitCode({ ...pass, interrupted: true })).toBe(EXIT.INTERRUPTED);
    expect(
      localExitCode({
        ...pass,
        interrupted: true,
        result: {
          ...pass.result,
          attempts: pass.result.attempts.map((attempt) => ({
            ...attempt,
            cleanup_status: "failed" as const
          }))
        }
      })
    ).toBe(EXIT.CLEANUP);
  });
});
