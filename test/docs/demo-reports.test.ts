import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("synthetic documentation reports", () => {
  it("keeps genuine failing and passing sample reports", async () => {
    const failing = JSON.parse(
      await readFile(resolve(root, "docs/examples/demo-reports/failing/report.json"), "utf8")
    ) as { outcome: string; packet: { id: string; sha256: string }; provenance: { cloud_contacted: boolean } };
    const passing = JSON.parse(
      await readFile(resolve(root, "docs/examples/demo-reports/passing/report.json"), "utf8")
    ) as { outcome: string; packet: { sha256: string } };
    const excerpt = JSON.parse(
      await readFile(resolve(root, "docs/examples/demo-reports/excerpt-normalized.json"), "utf8")
    ) as { _comment: string; outcome: string };

    expect(failing.outcome).toBe("failed");
    expect(passing.outcome).toBe("passed");
    expect(failing.packet.id).toBe("support-refunds-demo");
    expect(failing.packet.sha256).toBe(passing.packet.sha256);
    expect(failing.provenance.cloud_contacted).toBe(false);
    expect(excerpt._comment).toContain("Normalized excerpt");
    expect(excerpt.outcome).toBe("failed");
  });
});
