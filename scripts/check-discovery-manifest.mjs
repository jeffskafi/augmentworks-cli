import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LAST_VERIFIED_PUBLISHED_DISCOVERY,
  parseDiscoveryManifest,
  sourceDiscoveryManifest
} from "../src/discovery.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committed = JSON.parse(
  await readFile(resolve(root, "contracts/discovery-manifest.json"), "utf8")
);
const expected = sourceDiscoveryManifest();
const parsed = parseDiscoveryManifest(committed);
if (!parsed.ok) {
  throw new Error(`Committed discovery manifest is invalid:\n${parsed.errors.join("\n")}`);
}
if (JSON.stringify(committed) !== JSON.stringify(expected)) {
  throw new Error(
    "contracts/discovery-manifest.json is out of date. Run npm run generate:discovery."
  );
}
const published = parseDiscoveryManifest(LAST_VERIFIED_PUBLISHED_DISCOVERY);
if (!published.ok) {
  throw new Error(`Last verified published snapshot is invalid:\n${published.errors.join("\n")}`);
}
if (LAST_VERIFIED_PUBLISHED_DISCOVERY.capabilities.localDemo) {
  throw new Error("The last verified published 0.3.1 snapshot must not advertise localDemo.");
}
process.stdout.write(
  `CLI discovery contract ok: ${committed.package.name}@${committed.package.version} (${committed.package.releaseStatus})\n`
);
