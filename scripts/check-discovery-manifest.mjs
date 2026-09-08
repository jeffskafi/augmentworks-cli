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
if (!LAST_VERIFIED_PUBLISHED_DISCOVERY.capabilities.localDemo) {
  throw new Error("The last verified published 0.3.2 snapshot must advertise localDemo.");
}
if (LAST_VERIFIED_PUBLISHED_DISCOVERY.package.version !== "0.3.2") {
  throw new Error(
    "The last independently verified published snapshot must remain 0.3.2 until a later registry tarball is inspected. Do not relabel 0.3.2 or 0.3.3 provenance."
  );
}
if (committed.package.version === "0.3.4" && committed.package.releaseStatus !== "development") {
  throw new Error(
    "Candidate 0.3.4 must stay development-status in the committed discovery manifest until registry verification."
  );
}
process.stdout.write(
  `CLI discovery contract ok: ${committed.package.name}@${committed.package.version} (${committed.package.releaseStatus})\n`
);
