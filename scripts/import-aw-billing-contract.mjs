import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  FIXTURES_PATH,
  LOCK_PATH,
  SCHEMA_PATH,
  generatedContractSource,
  hashFile,
  root
} from "./aw-billing-contract.mjs";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const from = argValue("--from") ?? process.env.AUGMENTWORKS_MAIN_REPO;
if (from === undefined || from === "") {
  throw new Error(
    "Usage: node scripts/import-aw-billing-contract.mjs --from <path-to-jeffskafi/augmentworks>\n" +
      "Or set AUGMENTWORKS_MAIN_REPO. Main owns the aw-billing/1 schema and fixtures."
  );
}

const mainRoot = resolve(from);
const schemaSource = resolve(mainRoot, "docs/contracts/aw-billing-v1.schema.json");
const fixturesSource = resolve(mainRoot, "docs/contracts/aw-billing-v1.fixtures.json");
const handoffSource = resolve(mainRoot, "docs/billing-cursor-handoff.md");
const checksumsSource = resolve(mainRoot, "docs/contracts/aw-billing-v1.checksums.json");

const git = spawnSync("git", ["-C", mainRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
if (git.status !== 0) {
  throw new Error(`Could not read main repository HEAD at ${mainRoot}: ${git.stderr}`);
}
const commit = git.stdout.trim();

await mkdir(resolve(root, "contracts"), { recursive: true });
await mkdir(resolve(root, "docs/billing"), { recursive: true });
await mkdir(resolve(root, "src/billing/generated"), { recursive: true });
await copyFile(schemaSource, SCHEMA_PATH);
await copyFile(fixturesSource, FIXTURES_PATH);
await copyFile(handoffSource, resolve(root, "docs/billing/main-source-handoff.md"));

const schemaHash = await hashFile(SCHEMA_PATH);
const fixturesHash = await hashFile(FIXTURES_PATH);
const checksums = JSON.parse(await readFile(checksumsSource, "utf8"));
const expectedSchema = checksums.files["docs/contracts/aw-billing-v1.schema.json"];
const expectedFixtures = checksums.files["docs/contracts/aw-billing-v1.fixtures.json"];
if (schemaHash !== expectedSchema || fixturesHash !== expectedFixtures) {
  throw new Error(
    `Imported files do not match main checksums.json.\n` +
      `schema ${schemaHash} expected ${expectedSchema}\n` +
      `fixtures ${fixturesHash} expected ${expectedFixtures}`
  );
}

const fixtures = JSON.parse(await readFile(FIXTURES_PATH, "utf8"));
const lock = {
  schemaVersion: "aw-billing/1",
  algorithm: "sha256",
  source: {
    repository: "https://github.com/jeffskafi/augmentworks.git",
    commit,
    handoff: "docs/billing-cursor-handoff.md",
    schema: "docs/contracts/aw-billing-v1.schema.json",
    fixtures: "docs/contracts/aw-billing-v1.fixtures.json"
  },
  files: {
    "contracts/aw-billing-v1.schema.json": schemaHash,
    "contracts/aw-billing-v1.fixtures.json": fixturesHash
  },
  contract: {
    primaryPaths: {
      capabilities: "/v1/billing/capabilities",
      usage: "/v1/billing/usage"
    },
    aliases: {
      capabilities: ["/api/v1/billing/capabilities"],
      usage: ["/api/v1/billing/usage"]
    },
    readScope: fixtures.contract.readScope,
    advertisedCapabilities: fixtures.contract.advertisedCapabilities,
    reservedCapabilities: fixtures.contract.reservedCapabilities
  }
};

await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
await writeFile(
  resolve(root, "src/billing/generated/contract.ts"),
  generatedContractSource(lock),
  "utf8"
);
process.stdout.write(
  `Imported aw-billing/1 from ${commit}\nschema=${schemaHash}\nfixtures=${fixturesHash}\n`
);
