import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("account-free commands stay off the billing client", () => {
  it("does not import billing from doctor, demo, schema, or local-test", async () => {
    for (const relative of [
      "src/commands/doctor.ts",
      "src/commands/demo.ts",
      "src/commands/schema.ts",
      "src/commands/local-test.ts"
    ]) {
      const source = await readFile(resolve(root, relative), "utf8");
      expect(source).not.toMatch(/billing/i);
    }
  });
});
