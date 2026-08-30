import { describe, expect, it } from "vitest";

import { targetBoundarySha256 } from "../../src/config/boundary.js";
import type {
  AugmentWorksConfig,
  ResolvedConfig
} from "../../src/config/types.js";

function resolved(options: {
  baseUrl?: string;
  method?: "GET" | "POST";
  path?: string;
  secret?: string;
} = {}): ResolvedConfig {
  const baseUrl = options.baseUrl ?? "https://target.example/api";
  const secret = options.secret ?? "first-secret";
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "target",
      connector: "http",
      base_url: "${TARGET_BASE_URL}",
      auth: { bearer_env: "TARGET_API_KEY" },
      operations: {
        send: {
          method: options.method ?? "POST",
          path: options.path ?? "/chat"
        }
      }
    }
  };
  return {
    config,
    configPath: "/project/augmentworks.yaml",
    configDirectory: "/project",
    configDigest: "a".repeat(64),
    baseUrl: new URL(baseUrl),
    authHeaders: { Authorization: `Bearer ${secret}` },
    secrets: [secret],
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

describe("targetBoundarySha256", () => {
  it("ignores secret rotation but binds the resolved URL and fixed operation boundary", () => {
    const initial = targetBoundarySha256(resolved());
    expect(targetBoundarySha256(resolved({ secret: "rotated-secret" }))).toBe(initial);
    expect(targetBoundarySha256(resolved({ baseUrl: "https://other.example/api" }))).not.toBe(
      initial
    );
    expect(targetBoundarySha256(resolved({ baseUrl: "https://target.example/other" }))).not.toBe(
      initial
    );
    expect(targetBoundarySha256(resolved({ path: "/v2/chat" }))).not.toBe(initial);
    expect(targetBoundarySha256(resolved({ method: "GET" }))).not.toBe(initial);
  });

  it("normalizes only a trailing base pathname slash", () => {
    expect(targetBoundarySha256(resolved({ baseUrl: "https://target.example/api/" }))).toBe(
      targetBoundarySha256(resolved({ baseUrl: "https://target.example/api" }))
    );
  });
});
