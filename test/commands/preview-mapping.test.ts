import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runPreviewMapping } from "../../src/commands/preview-mapping.js";
import { EXIT } from "../../src/errors.js";
import { runSourceCli } from "../util/cli-process.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtureRoot = resolve(projectRoot, "test/fixtures/mapping-preview");
const directories: string[] = [];

const CHAT_YAML = `version: 1
target:
  name: preview-chat
  connector: http
  base_url: \${CHATBOT_BASE_URL}
  auth:
    bearer_env: CHATBOT_API_KEY
  operations:
    send:
      method: POST
      path: /chat
      response:
        content: $.answer
        finish_reason: $.finish_reason
        finished: $.finished
        tool_events: $.events
telemetry:
  allow_tool_events: false
  allow_observations: []
`;

const STATEFUL_YAML = `version: 1
target:
  name: preview-stateful
  connector: http
  base_url: \${CHATBOT_BASE_URL}
  operations:
    prepare:
      method: POST
      path: /prepare
      idempotent: true
    send:
      method: POST
      path: /chat
      response:
        content: $.answer
        finished: $.finished
        tool_events: $.events
    observe:
      method: POST
      path: /observe
      idempotent: true
      response:
        order.status: $.order.status
        order.refunded_amount: $.order.refunded_amount
        order.refundable: $.order.refundable
    cleanup:
      method: POST
      path: /cleanup
      idempotent: true
telemetry:
  allow_tool_events: true
  allow_observations:
    - order.status
    - order.refunded_amount
    - order.refundable
`;

const INVALID_SELECTOR_YAML = `version: 1
target:
  name: preview-chat
  connector: http
  base_url: http://127.0.0.1:9
  operations:
    send:
      method: POST
      path: /chat
      response:
        content: $.answer[
`;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "augmentworks-preview-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("preview-mapping command", () => {
  it("previews send evidence without reading .env, unrelated files, or the network", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "augmentworks.yaml"), CHAT_YAML, "utf8");
    await writeFile(join(directory, ".env"), "CHATBOT_API_KEY=env-secret-must-not-leak\nLEAK_ME=dotenv-secret-must-not-leak\n", "utf8");
    await writeFile(join(directory, "unrelated-secrets.json"), '{"token":"unrelated-file-secret-must-not-leak"}\n', "utf8");
    await writeFile(
      join(directory, "send.json"),
      await readFile(join(fixtureRoot, "send-nested-secrets.json"), "utf8"),
      "utf8"
    );
    const fetchMock = vi.fn(async () => new Response("nope"));
    vi.stubGlobal("fetch", fetchMock);

    const report = await runPreviewMapping({
      cwd: directory,
      config: "augmentworks.yaml",
      operation: "send",
      fixture: "send.json"
    });

    expect(report.ok).toBe(true);
    expect(report.offline).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const text = JSON.stringify(report);
    expect(text).not.toContain("env-secret-must-not-leak");
    expect(text).not.toContain("dotenv-secret-must-not-leak");
    expect(text).not.toContain("unrelated-file-secret-must-not-leak");
    expect(text).not.toContain("synthetic-preview-bearer-token");
    expect(text).not.toContain("SYNTHETIC_EXCLUDED_SECRET_do_not_leak");
    expect(text).toContain("[REDACTED]");
    expect(report.omitted.map((item) => item.field)).toContain("tool_events");
  });

  it("explains malformed JSON without echoing fixture text", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "augmentworks.yaml"), CHAT_YAML, "utf8");
    await writeFile(
      join(directory, "bad.json"),
      '{ "answer": "malformed-secret-must-not-leak"\n',
      "utf8"
    );

    const report = await runPreviewMapping({
      cwd: directory,
      fixture: "bad.json"
    });

    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toContain("FIXTURE_JSON_INVALID");
    expect(report.diagnostics.find((item) => item.code === "FIXTURE_JSON_INVALID")?.message).toMatch(
      /at position \d+/u
    );
    expect(JSON.stringify(report)).not.toContain("malformed-secret-must-not-leak");
  });

  it("explains an unsafe selector from YAML without starting a hosted run", async () => {
    const report = await runPreviewMapping({
      cwd: fixtureRoot,
      config: "send-unsafe-selector.yaml",
      fixture: "send-valid.json"
    });

    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toContain("UNSAFE_SELECTOR");
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNSAFE_SELECTOR",
          path: "target.operations.send.response.content"
        })
      ])
    );
    expect(JSON.stringify(report)).not.toContain("The synthetic order is still paid.");
  });

  it("previews the basic-chat example fixture without a target call", async () => {
    const exampleRoot = resolve(projectRoot, "examples/basic-chat");
    const fetchMock = vi.fn(async () => new Response("nope"));
    vi.stubGlobal("fetch", fetchMock);

    const report = await runPreviewMapping({
      cwd: exampleRoot,
      config: "augmentworks.yaml",
      operation: "send",
      fixture: "fixtures/send-preview.json"
    });

    expect(report.ok).toBe(true);
    expect(report.offline).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.extracted.map((item) => item.field).sort()).toEqual(["content", "finished"]);
  });

  it("explains a malformed selector from YAML with a configuration path", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "augmentworks.yaml"), INVALID_SELECTOR_YAML, "utf8");
    await writeFile(join(directory, "send.json"), '{"answer":"selector-secret-must-not-leak","finished":true}\n', "utf8");

    const report = await runPreviewMapping({
      cwd: directory,
      fixture: "send.json"
    });

    expect(report.ok).toBe(false);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RESPONSE_MAPPING_INVALID",
          path: "target.operations.send.response.content"
        })
      ])
    );
    expect(JSON.stringify(report)).not.toContain("selector-secret-must-not-leak");
  });

  it("explains a trailing-dot selector from the YAML fixture with a configuration path", async () => {
    const report = await runPreviewMapping({
      cwd: fixtureRoot,
      config: "send-malformed-selector.yaml",
      fixture: "send-valid.json"
    });

    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toContain("RESPONSE_MAPPING_INVALID");
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RESPONSE_MAPPING_INVALID",
          path: "target.operations.send.response.content"
        })
      ])
    );
    expect(JSON.stringify(report)).not.toContain("The synthetic order is still paid.");
  });

  it("previews observe and cleanup without requiring a send hook invocation", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "augmentworks.yaml"), STATEFUL_YAML, "utf8");
    await writeFile(
      join(directory, "observe.json"),
      await readFile(join(fixtureRoot, "observe-valid.json"), "utf8"),
      "utf8"
    );

    const observe = await runPreviewMapping({
      cwd: directory,
      operation: "observe",
      fixture: "observe.json"
    });
    expect(observe.ok).toBe(true);
    expect(JSON.stringify(observe)).not.toContain("SYNTHETIC_OBSERVE_EXCLUDED_SECRET_do_not_leak");

    const cleanup = await runPreviewMapping({
      cwd: directory,
      operation: "cleanup"
    });
    expect(cleanup.ok).toBe(true);
    expect(cleanup.evidence?.result).toMatchObject({ status: "cleaned" });
  });

  it("refuses symbolic-link fixtures and does not follow them", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "augmentworks.yaml"), CHAT_YAML, "utf8");
    const outside = join(directory, "outside.json");
    await writeFile(outside, '{"answer":"symlink-secret-must-not-leak"}\n', "utf8");
    await symlink(outside, join(directory, "send.json"));

    const report = await runPreviewMapping({
      cwd: directory,
      fixture: "send.json"
    });
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toContain("FIXTURE_UNREADABLE");
    expect(JSON.stringify(report)).not.toContain("symlink-secret-must-not-leak");
  });

  it("dispatches from the packed CLI surface and prints JSON for checks", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "augmentworks.yaml"), CHAT_YAML, "utf8");
    await writeFile(
      join(directory, "send.json"),
      await readFile(join(fixtureRoot, "send-valid.json"), "utf8"),
      "utf8"
    );

    const result = await runSourceCli(
      ["preview-mapping", "-c", "augmentworks.yaml", "--operation", "send", "--fixture", "send.json", "--json"],
      { cwd: directory, env: { CHATBOT_API_KEY: "process-env-secret-must-not-leak" } }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { ok: boolean; offline: boolean; credits_consumed: number };
    expect(payload.ok).toBe(true);
    expect(payload.offline).toBe(true);
    expect(payload.credits_consumed).toBe(0);
    expect(result.stdout).not.toContain("process-env-secret-must-not-leak");
  });

  it("returns the configuration exit code for missing required fields", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "augmentworks.yaml"), CHAT_YAML, "utf8");
    await writeFile(
      join(directory, "send.json"),
      await readFile(join(fixtureRoot, "send-missing-content.json"), "utf8"),
      "utf8"
    );

    const result = await runSourceCli(
      ["preview-mapping", "--fixture", "send.json"],
      { cwd: directory }
    );
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("MAPPING_VALUE_MISSING");
    expect(result.stdout).toContain("target.operations.send.response.content");
    expect(result.stdout).toContain("No hosted run started");
    expect(result.stdout).not.toContain("missing-content-must-not-leak-SYNTHETIC");
  });
});
