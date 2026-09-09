import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAssessmentFile } from "../../src/assessment/load.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { validateConfigObject } from "../../src/config/validate.js";
import { parseYamlStrict } from "../../src/config/yaml.js";
import { AwError } from "../../src/errors.js";
import type { ResolvedConfig } from "../../src/config/types.js";
import {
  CAPABILITY_FREE_SELECTION_ADVERTISEMENT,
  compileRequestFromAssessment,
  compileRequestFromFlags,
  resolveSelectionAdvertisement,
  selectionAdvertisementFromResolved
} from "../../src/selection/request.js";
import { CompileSuiteSelectionRequestSchema } from "../../src/selection/schema.js";
import {
  ACTION_CONNECTOR_CAPABILITIES,
  ACTION_QUICK_CASE_IDS,
  ACTION_QUICK_OBSERVATION_KEYS,
  actionConnectorYaml,
  actionQuickAssessmentYaml,
  actionQuickIncompatibilityReasons,
  CAPABILITY_FREE_SNAPSHOT,
  chatConnectorYaml
} from "./connectors.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-selection-request-"));
  directories.push(directory);
  return directory;
}

function resolvedFromYaml(source: string): ResolvedConfig {
  const raw = parseYamlStrict(source);
  const validation = validateConfigObject(raw);
  if (validation.config === undefined) {
    throw new Error(validation.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
  }
  const result = resolveConfig(validation.config, "/tmp/augmentworks.yaml", "/tmp", {});
  if (result.resolvedConfig === undefined) {
    throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
  }
  return result.resolvedConfig;
}

describe("suite-selection compile request capabilities", () => {
  it("accepts the server-owned camelCase capability snapshot", () => {
    const parsed = CompileSuiteSelectionRequestSchema.safeParse({
      schemaVersion: "aw-suite-selection/1",
      profile: "release",
      conversationMode: "single_turn",
      includeCatalog: true,
      capabilities: ACTION_CONNECTOR_CAPABILITIES
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.capabilities).toEqual(ACTION_CONNECTOR_CAPABILITIES);
  });

  it("rejects a compile body that omits capabilities", () => {
    const parsed = CompileSuiteSelectionRequestSchema.safeParse({
      schemaVersion: "aw-suite-selection/1",
      profile: "release",
      conversationMode: "single_turn",
      includeCatalog: true
    });
    expect(parsed.success).toBe(false);
  });

  it("maps a stateful connector onto the compile snapshot without upgrading hooks", () => {
    const resolved = resolvedFromYaml(actionConnectorYaml());
    expect(selectionAdvertisementFromResolved(resolved)).toEqual({
      conversationMode: "single_turn",
      capabilities: ACTION_CONNECTOR_CAPABILITIES
    });
  });

  it("maps explicit-session configuration to multiTurn without changing action hooks", () => {
    const resolved = resolvedFromYaml(actionConnectorYaml({ session: true }));
    const advertisement = selectionAdvertisementFromResolved(resolved);
    expect(advertisement.conversationMode).toBe("explicit_session_v1");
    expect(advertisement.capabilities).toEqual({
      ...ACTION_CONNECTOR_CAPABILITIES,
      multiTurn: true
    });
  });

  it("maps a response-only connector to an explicit capability-free snapshot", () => {
    const resolved = resolvedFromYaml(chatConnectorYaml());
    expect(selectionAdvertisementFromResolved(resolved).capabilities).toEqual(CAPABILITY_FREE_SNAPSHOT);
    expect(selectionAdvertisementFromResolved(resolved).conversationMode).toBe("single_turn");
  });

  it("does not advertise toolEvents when they are mapped but not allowed", () => {
    const resolved = resolvedFromYaml(actionConnectorYaml({ allowToolEvents: false }));
    expect(resolved.capabilities.tool_events).toBe(false);
    expect(selectionAdvertisementFromResolved(resolved).capabilities.toolEvents).toBe(false);
    expect(selectionAdvertisementFromResolved(resolved).capabilities.prepare).toBe(true);
  });

  it("omits a removed observation key instead of inventing it", () => {
    const resolved = resolvedFromYaml(
      actionConnectorYaml({
        observationKeys: ["order.refunded_amount", "order.refundable"]
      })
    );
    expect(selectionAdvertisementFromResolved(resolved).capabilities.observationKeys).toEqual([
      "order.refundable",
      "order.refunded_amount"
    ]);
  });

  it("uses the same helper for flag compile and assessment compile", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(resolve(cwd, "references"));
    await writeFile(resolve(cwd, "references/refund-policy.md"), "# Synthetic refund policy\n", "utf8");
    await writeFile(resolve(cwd, "augmentworks.assessment.yaml"), actionQuickAssessmentYaml(), "utf8");
    const loaded = await loadAssessmentFile({ path: "augmentworks.assessment.yaml", cwd });
    const advertisement = selectionAdvertisementFromResolved(resolvedFromYaml(actionConnectorYaml()));
    const fromFlags = compileRequestFromFlags({
      advertisement,
      profile: "smoke",
      includeCatalog: true
    });
    const fromAssessment = compileRequestFromAssessment(loaded, advertisement);
    expect(fromFlags.capabilities).toEqual(ACTION_CONNECTOR_CAPABILITIES);
    expect(fromAssessment.capabilities).toEqual(fromFlags.capabilities);
    expect(fromAssessment.conversationMode).toBe(fromFlags.conversationMode);
    expect(fromAssessment.requestedCaseIds).toEqual([...ACTION_QUICK_CASE_IDS]);
  });

  it("treats a missing default YAML as explicit capability-free single-turn", async () => {
    const cwd = await temporaryDirectory();
    const advertisement = await resolveSelectionAdvertisement({
      configPath: "augmentworks.yaml",
      cwd,
      allowMissingDefault: true
    });
    expect(advertisement).toEqual(CAPABILITY_FREE_SELECTION_ADVERTISEMENT);
  });

  it("fails an explicit missing or malformed config before any compile body is built", async () => {
    const cwd = await temporaryDirectory();
    await expect(
      resolveSelectionAdvertisement({
        configPath: "missing.yaml",
        cwd,
        allowMissingDefault: false
      })
    ).rejects.toMatchObject({ code: "CONFIG_FILE_NOT_FOUND" });

    await writeFile(resolve(cwd, "broken.yaml"), "version: [\n", "utf8");
    await expect(
      resolveSelectionAdvertisement({
        configPath: "broken.yaml",
        cwd,
        allowMissingDefault: true
      })
    ).rejects.toBeInstanceOf(AwError);

    await writeFile(resolve(cwd, "incomplete.yaml"), actionConnectorYaml({ omitPrepare: true }), "utf8");
    await expect(
      resolveSelectionAdvertisement({
        configPath: "incomplete.yaml",
        cwd,
        allowMissingDefault: true
      })
    ).rejects.toMatchObject({ code: "LIFECYCLE_INCOMPLETE" });

    await writeFile(
      resolve(cwd, "unresolved.yaml"),
      `version: 1
target:
  name: chat
  connector: http
  base_url: \${CHATBOT_BASE_URL}
  operations:
    send:
      method: POST
      path: /chat
`,
      "utf8"
    );
    await expect(
      resolveSelectionAdvertisement({
        configPath: "unresolved.yaml",
        cwd,
        allowMissingDefault: true
      })
    ).rejects.toMatchObject({ code: "ENV_REQUIRED" });
  });

  it("reports a distinct server incompatibility for each omitted action capability", () => {
    for (const hook of ["prepare", "observation", "toolEvents", "cleanup"] as const) {
      const snapshot = { ...ACTION_CONNECTOR_CAPABILITIES, [hook]: false };
      if (hook === "observation") snapshot.observationKeys = [];
      expect(actionQuickIncompatibilityReasons(snapshot)).toContain(
        hook === "toolEvents" ? "capability_tool_events" : `capability_${hook}`
      );
    }
    for (const key of ACTION_QUICK_OBSERVATION_KEYS) {
      const observationKeys = ACTION_QUICK_OBSERVATION_KEYS.filter((entry) => entry !== key);
      expect(
        actionQuickIncompatibilityReasons({
          ...ACTION_CONNECTOR_CAPABILITIES,
          observationKeys
        })
      ).toEqual(["capability_observation_key"]);
    }
    expect(actionQuickIncompatibilityReasons(ACTION_CONNECTOR_CAPABILITIES)).toEqual([]);
    expect(actionQuickIncompatibilityReasons(CAPABILITY_FREE_SNAPSHOT)).toEqual([
      "capability_prepare",
      "capability_observation",
      "capability_tool_events",
      "capability_cleanup",
      "capability_observation_key",
      "capability_observation_key",
      "capability_observation_key"
    ]);
  });
});
