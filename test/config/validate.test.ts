import { describe, expect, it } from "vitest";

import { validateConfigObject } from "../../src/config/validate.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";

function config(overrides: Partial<AugmentWorksConfig["target"]> = {}): AugmentWorksConfig {
  return {
    version: 1,
    target: {
      name: "test",
      connector: "http",
      base_url: "http://localhost:8000",
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          request: { message: "$input.message" },
          response: { content: "$.answer" }
        }
      },
      ...overrides
    }
  };
}

describe("configuration validation", () => {
  it("rejects unknown keys", () => {
    const value = config() as AugmentWorksConfig & { unexpected: boolean };
    value.unexpected = true;
    expect(validateConfigObject(value).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONFIG_SCHEMA_INVALID", level: "error" })])
    );
  });

  it.each([
    ["request interpolation", { message: "prefix $input.message" }, "REQUEST_MAPPING_INVALID"],
    ["response filters", undefined, "RESPONSE_MAPPING_INVALID"],
    ["literal secret", { token: "sk-abcdefghijklmnopqrstuvwxyz" }, "LITERAL_SECRET_FORBIDDEN"]
  ])("rejects unsafe %s", (_label, request, expectedCode) => {
    const value = config();
    if (request === undefined) value.target.operations.send.response = { content: "$..answer" };
    else value.target.operations.send.request = request;
    expect(validateConfigObject(value).diagnostics.map((item) => item.code)).toContain(expectedCode);
  });

  it("requires the full stateful lifecycle", () => {
    const value = config({
      operations: {
        send: config().target.operations.send,
        prepare: { method: "POST", path: "/prepare" }
      }
    });
    expect(validateConfigObject(value).diagnostics.map((item) => item.code)).toContain("LIFECYCLE_INCOMPLETE");
  });

  it("uses allowlist language when stateful observation telemetry is not configured", () => {
    const value = config({
      operations: {
        send: config().target.operations.send,
        prepare: { method: "POST", path: "/prepare" },
        observe: { method: "POST", path: "/observe" },
        cleanup: { method: "POST", path: "/cleanup" }
      }
    });

    expect(validateConfigObject(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OBSERVATIONS_NOT_ALLOWED",
          level: "warning",
          message:
            "Stateful hooks are configured, but no observation keys are allowlisted to leave this machine.",
          path: "telemetry.allow_observations"
        })
      ])
    );
  });

  it("rejects dynamic and cross-origin-looking paths", () => {
    const value = config();
    value.target.operations.send.path = "//attacker.example/collect";
    expect(validateConfigObject(value).diagnostics.map((item) => item.code)).toContain("OPERATION_PATH_INVALID");
  });

  it("requires uppercase exact environment references", () => {
    const value = config({ base_url: "${chatbot_url}" });
    expect(validateConfigObject(value).diagnostics.map((item) => item.code)).toContain("CONFIG_SCHEMA_INVALID");
  });

  it("rejects reserved authentication headers before execution", () => {
    const value = config({ auth: { headers_env: { "AW-Command-Id": "CHATBOT_API_KEY" } } });
    expect(validateConfigObject(value).diagnostics.map((item) => item.code)).toContain("AUTH_HEADER_FORBIDDEN");
  });

  it.each([
    ["base URL", { base_url: "${AUGMENTWORKS_API_URL}" }],
    ["bearer auth", { auth: { bearer_env: "AUGMENTWORKS_TOKEN" } }],
    [
      "custom auth header",
      { auth: { headers_env: { "X-Target-Key": "AUGMENTWORKS_CONNECTOR_TOKEN" } } }
    ]
  ])("never allows a platform credential variable to configure %s", (_label, overrides) => {
    const result = validateConfigObject(
      config(overrides as Partial<AugmentWorksConfig["target"]>)
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLATFORM_ENV_REFERENCE_FORBIDDEN",
          level: "error"
        })
      ])
    );
  });

  it("allows localhost HTTP but gates public HTTP", () => {
    const publicConfig = config({ base_url: "http://example.com" });
    const denied = resolveConfig(publicConfig, "/tmp/augmentworks.yaml", "/tmp", {});
    expect(denied.diagnostics.map((item) => item.code)).toContain("INSECURE_HTTP_FORBIDDEN");

    const explicitlyAllowed = config({ base_url: "http://example.com", allow_insecure_http: true });
    const allowed = resolveConfig(explicitlyAllowed, "/tmp/augmentworks.yaml", "/tmp", {});
    expect(allowed.resolvedConfig).toBeDefined();
    expect(allowed.diagnostics.map((item) => item.code)).toContain("INSECURE_HTTP_ALLOWED");
  });

  it.each([
    ["an unmapped semantic response", undefined, true],
    ["the events response alias", { content: "$.answer", events: "$.events" }, true],
    ["the tool_events response alias", { content: "$.answer", tool_events: "$.events" }, true],
    ["a content-only response mapping", { content: "$.answer" }, false]
  ] as const)("detects tool-event capability from %s", (_label, response, expected) => {
    const value = config();
    value.telemetry = { allow_tool_events: true };
    if (response === undefined) delete value.target.operations.send.response;
    else value.target.operations.send.response = response;

    const result = resolveConfig(value, "/tmp/augmentworks.yaml", "/tmp", {});
    expect(result.resolvedConfig?.capabilities.tool_events).toBe(expected);
    expect(result.resolvedConfig?.capabilities.level).toBe(expected ? "tool-aware" : "chat-only");
  });

  it.each(["events", "tool_events"] as const)(
    "warns when the %s response alias lacks telemetry consent",
    (alias) => {
      const value = config();
      value.target.operations.send.response = {
        content: "$.answer",
        [alias]: "$.events"
      };
      expect(validateConfigObject(value).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "TOOL_EVENTS_NOT_ALLOWED", level: "warning" })
        ])
      );
    }
  );

  it("warns that target response metadata mappings are ignored", () => {
    const value = config();
    value.target.operations.send.response = {
      content: "$.answer",
      metadata: "$.metadata"
    };
    expect(validateConfigObject(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RESPONSE_METADATA_IGNORED",
          level: "warning",
          path: "target.operations.send.response.metadata"
        })
      ])
    );
  });
});
