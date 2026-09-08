import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SOURCE_COMPARE_COMMAND, SOURCE_GATE_COMMAND } from "../../src/release.js";
import { EXIT } from "../../src/errors.js";
import { runSourceCli } from "../util/cli-process.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("compare and gate command preflight", () => {
  it("rejects missing run and baseline identities without calling the API", async () => {
    const result = await runSourceCli(["compare", "--json"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AUGMENTWORKS_TOKEN: "aw_unused_token_for_preflight",
        AUGMENTWORKS_API_URL: "http://127.0.0.1:1"
      }
    });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    const payload = JSON.parse(result.stdout) as { ok: boolean; code: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("AMBIGUOUS_IDENTITY");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("documents source compare and gate commands without an unpublished npm pin", () => {
    expect(SOURCE_COMPARE_COMMAND).toContain("node dist/index.js compare");
    expect(SOURCE_GATE_COMMAND).toContain("node dist/index.js gate");
    expect(SOURCE_COMPARE_COMMAND).not.toContain("@0.3.3");
    expect(SOURCE_GATE_COMMAND).not.toContain("@0.3.3");
  });
});
