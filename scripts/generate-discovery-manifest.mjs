import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDiscoveryManifest, sourceDiscoveryManifest } from "../src/discovery.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = sourceDiscoveryManifest();
const parsed = parseDiscoveryManifest(manifest);
if (!parsed.ok) {
  throw new Error(`Generated discovery manifest is invalid:\n${parsed.errors.join("\n")}`);
}
const path = resolve(root, "contracts/discovery-manifest.json");
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${path}\n`);
