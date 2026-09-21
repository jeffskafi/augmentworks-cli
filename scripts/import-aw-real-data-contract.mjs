import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  EXPECTED_FIXTURES_SHA256,
  EXPECTED_SCHEMA_SHA256,
  FIXTURES_PATH,
  GENERATED_PATH,
  LOCK_PATH,
  SCHEMA_PATH,
  SOURCE_COMMIT,
  generatedContractSource,
  hashFile,
  root
} from "./aw-real-data-contract.mjs";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const from = argValue("--from") ?? process.env.AUGMENTWORKS_MAIN_REPO;
if (from === undefined || from === "") {
  throw new Error(
    "Usage: node scripts/import-aw-real-data-contract.mjs --from <path-to-jeffskafi/augmentworks>\n" +
      "Or set AUGMENTWORKS_MAIN_REPO. Main owns aw-real-data-1 schema and fixtures at " +
      SOURCE_COMMIT +
      "."
  );
}

const mainRoot = resolve(from);
const schemaSource = resolve(mainRoot, "docs/contracts/aw-real-data-1.schema.json");
const fixturesSource = resolve(mainRoot, "docs/contracts/aw-real-data-1.fixtures.json");
const checksumsSource = resolve(mainRoot, "docs/contracts/aw-real-data-1.checksums.json");

const git = spawnSync("git", ["-C", mainRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
if (git.status !== 0) {
  throw new Error(`Could not read main repository HEAD at ${mainRoot}: ${git.stderr}`);
}
const commit = git.stdout.trim();
if (commit !== SOURCE_COMMIT) {
  process.stderr.write(
    `Warning: main HEAD ${commit} is not the frozen R01 commit ${SOURCE_COMMIT}. Import still verifies checksums.json.\n`
  );
}

await mkdir(resolve(root, "contracts"), { recursive: true });
await mkdir(resolve(root, "src/real-data/generated"), { recursive: true });
await copyFile(schemaSource, SCHEMA_PATH);
await copyFile(fixturesSource, FIXTURES_PATH);

const schemaHash = await hashFile(SCHEMA_PATH);
const fixturesHash = await hashFile(FIXTURES_PATH);
const checksums = JSON.parse(await readFile(checksumsSource, "utf8"));
const expectedSchema =
  checksums.files?.["docs/contracts/aw-real-data-1.schema.json"] ?? checksums.schema ?? EXPECTED_SCHEMA_SHA256;
const expectedFixtures =
  checksums.files?.["docs/contracts/aw-real-data-1.fixtures.json"] ??
  checksums.fixtures ??
  EXPECTED_FIXTURES_SHA256;
if (schemaHash !== expectedSchema || fixturesHash !== expectedFixtures) {
  throw new Error(
    `Imported files do not match main checksums.json.\n` +
      `schema ${schemaHash} expected ${expectedSchema}\n` +
      `fixtures ${fixturesHash} expected ${expectedFixtures}`
  );
}
if (schemaHash !== EXPECTED_SCHEMA_SHA256 || fixturesHash !== EXPECTED_FIXTURES_SHA256) {
  throw new Error(
    `Imported files do not match the frozen R01 hashes recorded in AUG-188.\n` +
      `schema ${schemaHash} expected ${EXPECTED_SCHEMA_SHA256}\n` +
      `fixtures ${fixturesHash} expected ${EXPECTED_FIXTURES_SHA256}`
  );
}

const lock = {
  schemaVersion: "aw-real-data/1",
  algorithm: "sha256",
  imported: true,
  releaseEnabled: false,
  runtimeEnforced: false,
  source: {
    repository: "https://github.com/jeffskafi/augmentworks.git",
    commit: SOURCE_COMMIT,
    schema: "docs/contracts/aw-real-data-1.schema.json",
    fixtures: "docs/contracts/aw-real-data-1.fixtures.json",
    checksums: "docs/contracts/aw-real-data-1.checksums.json",
    spec: "docs/contracts/aw-real-data-1.md"
  },
  expected: {
    schema: EXPECTED_SCHEMA_SHA256,
    fixtures: EXPECTED_FIXTURES_SHA256
  },
  files: {
    "contracts/aw-real-data-1.schema.json": schemaHash,
    "contracts/aw-real-data-1.fixtures.json": fixturesHash
  },
  contract: {
    revision: 1,
    executionScope: "aw-execution-scope/1",
    localExecutionScope: "aw-local-execution-scope/1",
    authorizedPacket: "aw-packet/authorized-1",
    localAuthorizedPacket: "aw-packet/local-authorized-1",
    suiteSchema: "aw-suite/3",
    nativeSuite: "aw-customer-suite/3",
    reportScope: "authorized-1",
    capabilitiesPath: "/v1/capabilities",
    executionScopePath: "/v1/execution-scopes/{scopeId}",
    privacyInterface: {
      applyRedactionProfile: "applyRedactionProfile(input, profile, policy, secrets)",
      sealDataHandlingReceipt: "sealDataHandlingReceipt(result, policy, profile, processor)"
    }
  }
};

await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
await writeFile(GENERATED_PATH, generatedContractSource(lock), "utf8");
process.stdout.write(
  `Imported aw-real-data/1 from ${commit}\nschema=${schemaHash}\nfixtures=${fixturesHash}\nreleaseEnabled=false\n`
);
