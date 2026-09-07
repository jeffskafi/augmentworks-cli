import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatPreviewMappingHuman,
  formatPreviewMappingJson,
  runPreviewMapping
} from "../../src/commands/preview-mapping.js";
import { parseYamlStrict } from "../../src/config/yaml.js";
import { validateConfigObject } from "../../src/config/validate.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import {
  normalizeConnectorResult,
  previewMappedEvidence,
  PREVIEW_CORRELATION,
  PREVIEW_DISCLAIMER
} from "../../src/connector/index.js";
import { canonicalize } from "../../src/util/canonical.js";
import { LIMITS } from "../../src/util/limits.js";
import { runSourceCli } from "../util/cli-process.js";

const fixtureRoot = resolve(fileURLToPath(new URL("../fixtures/mapping-preview", import.meta.url)));
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryDirectories: string[] = [];

const SEEDED_SECRETS = [
  "sk-syntheticpreviewvalue",
  "unselected-nested-secret-value",
  "gho_syntheticPreviewTok12",
  "unselected-password-value",
  "customer.private@example.test",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.signaturepreview1234"
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function readYamlConfig(name: string): Promise<AugmentWorksConfig> {
  const source = await readFile(resolve(fixtureRoot, name), "utf8");
  const validation = validateConfigObject(parseYamlStrict(source));
  expect(validation.config).toBeDefined();
  return validation.config as AugmentWorksConfig;
}

async function readJsonFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(fixtureRoot, name), "utf8"));
}

function assertNoSeededSecrets(...values: unknown[]): void {
  const text = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const secret of SEEDED_SECRETS) {
    expect(text).not.toContain(secret);
  }
}

describe("mapping preview service", () => {
  it("serializes the same canonical send evidence as the production connector", async () => {
    const config = await readYamlConfig("send-only.yaml");
    const response = (await readJsonFixture("send-valid.json")) as never;
    const preview = previewMappedEvidence({ kind: "send", config, response });
    const production = normalizeConnectorResult({
      kind: "send",
      input: {
        attempt_id: PREVIEW_CORRELATION.attemptId,
        turn_id: PREVIEW_CORRELATION.turnId,
        request_id: PREVIEW_CORRELATION.requestId,
        run_id: PREVIEW_CORRELATION.runId
      },
      context: { ...PREVIEW_CORRELATION },
      response,
      responseMap: config.target.operations.send.response,
      allowToolEvents: false,
      allowedObservations: new Set(),
      secrets: []
    });

    expect(preview.ok).toBe(true);
    expect(preview.offline).toBe(true);
    expect(preview.evidence_canonical).toBe(canonicalize(production));
    expect(preview.evidence_bytes).toBe(Buffer.byteLength(canonicalize(production), "utf8"));
    expect(preview.fields.map((field) => [field.field, field.status])).toEqual([
      ["content", "extracted"],
      ["tool_events", "omitted"],
      ["finished", "extracted"],
      ["metadata", "omitted"]
    ]);
    expect(preview.disclaimer).toBe(PREVIEW_DISCLAIMER);
  });

  it("redacts mapped credential shapes and never emits unselected nested secrets", async () => {
    const config = await readYamlConfig("send-only.yaml");
    const response = (await readJsonFixture("send-nested-secrets.json")) as never;
    const preview = previewMappedEvidence({ kind: "send", config, response });
    const serialized = JSON.stringify(preview);

    expect(preview.ok).toBe(true);
    expect(preview.redactions.some((entry) => entry.field === "content")).toBe(true);
    expect(preview.evidence_canonical).toContain("[REDACTED]");
    expect(preview.fields.find((field) => field.field === "tool_events")?.status).toBe("omitted");
    expect(preview.fields.find((field) => field.field === "metadata")?.status).toBe("omitted");
    assertNoSeededSecrets(serialized, preview.evidence_canonical, ...preview.fields.map((field) => field.display));
  });

  it("explains missing required mapped fields without producing evidence", async () => {
    const config = await readYamlConfig("send-only.yaml");
    const response = (await readJsonFixture("send-missing-content.json")) as never;
    const preview = previewMappedEvidence({ kind: "send", config, response });

    expect(preview.ok).toBe(false);
    expect(preview.evidence).toBeNull();
    expect(preview.fields.find((field) => field.field === "content")?.status).toBe("missing");
    expect(preview.diagnostics.some((item) => item.code === "MAPPING_VALUE_MISSING")).toBe(true);
    expect(preview.diagnostics.some((item) => item.path === "target.operations.send.response.content")).toBe(
      true
    );
    assertNoSeededSecrets(JSON.stringify(preview));
  });

  it("covers observe allowlisting and cleanup without extra hooks", async () => {
    const config = await readYamlConfig("stateful.yaml");
    const observeResponse = (await readJsonFixture("observe-valid.json")) as never;
    const observe = previewMappedEvidence({
      kind: "observe",
      config,
      response: observeResponse
    });
    const cleanup = previewMappedEvidence({
      kind: "cleanup",
      config,
      response: {}
    });
    const productionObserve = normalizeConnectorResult({
      kind: "observe",
      input: {
        attempt_id: PREVIEW_CORRELATION.attemptId,
        request_id: PREVIEW_CORRELATION.requestId,
        run_id: PREVIEW_CORRELATION.runId
      },
      context: { ...PREVIEW_CORRELATION },
      response: observeResponse,
      responseMap: config.target.operations.observe?.response,
      allowToolEvents: true,
      allowedObservations: new Set(["order.status", "order.refunded_amount"]),
      secrets: []
    });

    expect(observe.ok).toBe(true);
    expect(observe.evidence_canonical).toBe(canonicalize(productionObserve));
    expect(observe.fields.find((field) => field.field === "customer.email")?.status).toBe("omitted");
    expect(cleanup.ok).toBe(true);
    expect(cleanup.evidence).toMatchObject({
      protocol_version: "aw-target/0.1",
      status: "cleaned",
      attempt_id: PREVIEW_CORRELATION.attemptId
    });
    assertNoSeededSecrets(JSON.stringify(observe), JSON.stringify(cleanup));
  });

  it("records visible truncation for long mapped content and oversized payloads", () => {
    const config: AugmentWorksConfig = {
      version: 1,
      target: {
        name: "chat-preview",
        connector: "http",
        base_url: "http://127.0.0.1:9",
        operations: {
          send: {
            method: "POST",
            path: "/chat",
            response: { content: "$.answer" }
          }
        }
      }
    };
    const longContent = `The synthetic assistant said ${"x".repeat(400)}.`;
    const longPreview = previewMappedEvidence({
      kind: "send",
      config,
      response: { answer: longContent }
    });
    expect(longPreview.ok).toBe(true);
    expect(longPreview.truncations.some((item) => item.truncated && item.scope === "human_listing")).toBe(
      true
    );
    expect(longPreview.fields.find((field) => field.field === "content")?.display).toContain("[truncated");
    expect(longPreview.evidence_canonical).toContain(longContent);
  });

  it("records visible truncation for oversized mapped content", () => {
    const config: AugmentWorksConfig = {
      version: 1,
      target: {
        name: "chat-preview",
        connector: "http",
        base_url: "http://127.0.0.1:9",
        operations: {
          send: {
            method: "POST",
            path: "/chat",
            response: { content: "$.answer" }
          }
        }
      }
    };
    const oversized = "x".repeat(LIMITS.maxMessageBytes + 8);
    const preview = previewMappedEvidence({
      kind: "send",
      config,
      response: { answer: oversized, internal: { raw_token: "unselected-nested-secret-value" } }
    });

    expect(preview.ok).toBe(false);
    expect(preview.truncations.some((item) => item.scope === "evidence_limit" && item.rejected === true)).toBe(
      true
    );
    expect(preview.fields.find((field) => field.field === "content")?.display).not.toContain(oversized);
    expect(JSON.stringify(preview)).not.toContain(oversized);
    assertNoSeededSecrets(JSON.stringify(preview));
  });
});

describe("preview-mapping command", () => {
  it("previews a valid fixture without loading .env or calling fetch", async () => {
    const previousFetch = globalThis.fetch;
    const fetchMock = async () => {
      throw new Error("preview-mapping must not use fetch");
    };
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const report = await runPreviewMapping({
        cwd: fixtureRoot,
        config: "send-only.yaml",
        fixture: "send-nested-secrets.json",
        operation: "send"
      });
      const human = formatPreviewMappingHuman(report);
      const json = formatPreviewMappingJson(report);

      expect(report.ok).toBe(true);
      expect(report.offline).toBe(true);
      expect(report.diagnostics.map((item) => item.code)).toContain("PREVIEW_ENV_NOT_LOADED");
      expect(human).toContain("EXTRACTED");
      expect(human).toContain("OMITTED");
      expect(human).toContain(PREVIEW_DISCLAIMER);
      expect(json).toContain("AW-MAPPING-PREVIEW-1");
      assertNoSeededSecrets(human, json);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("does not read sibling .env values into output", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-preview-"));
    temporaryDirectories.push(directory);
    await writeFile(
      resolve(directory, "augmentworks.yaml"),
      await readFile(resolve(fixtureRoot, "send-only.yaml"), "utf8"),
      "utf8"
    );
    await writeFile(
      resolve(directory, "fixture.json"),
      await readFile(resolve(fixtureRoot, "send-valid.json"), "utf8"),
      "utf8"
    );
    await writeFile(resolve(directory, ".env"), "CHATBOT_API_KEY=env-secret-must-not-be-read\n", {
      encoding: "utf8",
      mode: 0o600
    });

    const report = await runPreviewMapping({
      cwd: directory,
      fixture: "fixture.json"
    });
    const json = formatPreviewMappingJson(report);

    expect(report.ok).toBe(true);
    expect(json).not.toContain("env-secret-must-not-be-read");
    expect(report.diagnostics.map((item) => item.code)).not.toContain("ENV_FILE_LOADED");
  });

  it("explains a malformed selector with a config location", async () => {
    const report = await runPreviewMapping({
      cwd: fixtureRoot,
      config: "send-malformed-selector.yaml",
      fixture: "send-valid.json"
    });
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((item) => item.code === "RESPONSE_MAPPING_INVALID")).toBe(true);
    expect(report.diagnostics.some((item) => item.path === "target.operations.send.response.content")).toBe(
      true
    );
    expect(report.evidence).toBeNull();
  });

  it("explains an unsafe selector without starting a hosted run", async () => {
    const report = await runPreviewMapping({
      cwd: fixtureRoot,
      config: "send-unsafe-selector.yaml",
      fixture: "send-valid.json"
    });
    expect(report.ok).toBe(false);
    expect(report.fields[0]?.status).toBe("unsafe_selector");
    expect(report.diagnostics.some((item) => item.code === "UNSAFE_SELECTOR")).toBe(true);
    expect(report.diagnostics.some((item) => item.path === "target.operations.send.response.content")).toBe(
      true
    );
  });

  it("reports malformed JSON with a numeric position and no fixture snippet", async () => {
    const report = await runPreviewMapping({
      cwd: fixtureRoot,
      config: "send-only.yaml",
      fixture: "send-malformed.json"
    });
    const json = formatPreviewMappingJson(report);
    const human = formatPreviewMappingHuman(report);

    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((item) => item.code === "FIXTURE_JSON_INVALID")).toBe(true);
    expect(json).toMatch(/at position \d+/u);
    expect(human).not.toContain("The synthetic order is still paid.");
  });

  it("dispatches from the CLI entrypoint with exit 2 on missing fields", async () => {
    const result = await runSourceCli(
      [
        "preview-mapping",
        "-c",
        resolve(fixtureRoot, "send-only.yaml"),
        "--fixture",
        resolve(fixtureRoot, "send-missing-content.json"),
        "--json"
      ],
      { cwd: projectRoot }
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.map((item) => item.code)).toContain("MAPPING_VALUE_MISSING");
    assertNoSeededSecrets(result.stdout, result.stderr);
  });

  it("previews observe evidence from the packed command surface", async () => {
    const result = await runSourceCli(
      [
        "preview-mapping",
        "-c",
        resolve(fixtureRoot, "stateful.yaml"),
        "--fixture",
        resolve(fixtureRoot, "observe-valid.json"),
        "--operation",
        "observe",
        "--json"
      ],
      { cwd: projectRoot }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      operation: string;
      evidence: { observations: Array<{ key: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe("observe");
    expect(parsed.evidence.observations.map((item) => item.key).sort()).toEqual([
      "order.refunded_amount",
      "order.status"
    ]);
    assertNoSeededSecrets(result.stdout);
  });
});
