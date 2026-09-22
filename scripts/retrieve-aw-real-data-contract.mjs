#!/usr/bin/env node

/**
 * Attempt to vendor frozen R01 schema/fixture bytes from jeffskafi/augmentworks
 * at the pinned commit. Never fabricates files or sets imported:true on failure.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  EXPECTED_FIXTURES_SHA256,
  EXPECTED_SCHEMA_SHA256,
  SOURCE_COMMIT,
  fileExists,
  hashFile,
  root
} from "./aw-real-data-contract.mjs";

const RETRIEVAL_PATH = resolve(root, "contracts/aw-real-data-1.retrieval.json");
const SCHEMA_PATH = resolve(root, "contracts/aw-real-data-1.schema.json");
const FIXTURES_PATH = resolve(root, "contracts/aw-real-data-1.fixtures.json");
const REPO = "jeffskafi/augmentworks";
const SOURCE_FILES = [
  "docs/contracts/aw-real-data-1.schema.json",
  "docs/contracts/aw-real-data-1.fixtures.json",
  "docs/contracts/aw-real-data-1.checksums.json"
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    cwd: options.cwd ?? root,
    env: options.env ?? process.env
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal ?? null,
    stdout: (result.stdout ?? "").slice(0, 4_000),
    stderr: (result.stderr ?? "").slice(0, 4_000),
    error: result.error === undefined ? null : result.error.message
  };
}

function summarize(attempt) {
  const blob = `${attempt.stdout}\n${attempt.stderr}\n${attempt.error ?? ""}`;
  const statusMatch = blob.match(/HTTP (\d{3})/u);
  const messageMatch = blob.match(/"message"\s*:\s*"([^"]+)"/u);
  return {
    command: attempt.command,
    status: attempt.status,
    signal: attempt.signal,
    error: attempt.error,
    httpStatus: statusMatch?.[1] ?? null,
    message: messageMatch?.[1] ?? attempt.stderr.trim().split("\n").at(-1) ?? null
  };
}

async function main() {
  await mkdir(resolve(root, "contracts"), { recursive: true });
  const attempts = [];

  attempts.push(
    summarize(run("gh", ["api", "user"])),
    summarize(run("gh", ["api", `repos/${REPO}`])),
    ...SOURCE_FILES.map((path) =>
      summarize(run("gh", ["api", `repos/${REPO}/contents/${path}?ref=${SOURCE_COMMIT}`]))
    ),
    summarize(
      run(
        "gh",
        [
          "api",
          "-H",
          "Accept: application/vnd.github.raw",
          `repos/${REPO}/contents/${SOURCE_FILES[0]}?ref=${SOURCE_COMMIT}`
        ]
      )
    ),
    summarize(run("gh", ["api", `repos/${REPO}/git/trees/${SOURCE_COMMIT}`])),
    summarize(
      run("git", ["ls-remote", `https://github.com/${REPO}.git`, SOURCE_COMMIT], { timeout: 20_000 })
    )
  );

  const localRoot = process.env.AUGMENTWORKS_MAIN_REPO?.trim();
  if (localRoot) {
    const schemaSource = resolve(localRoot, "docs/contracts/aw-real-data-1.schema.json");
    attempts.push({
      command: `read ${schemaSource}`,
      status: (await fileExists(schemaSource)) ? 0 : 2,
      signal: null,
      error: null,
      httpStatus: null,
      message: (await fileExists(schemaSource)) ? "local schema present" : "local schema absent"
    });
  } else {
    attempts.push({
      command: "AUGMENTWORKS_MAIN_REPO",
      status: 2,
      signal: null,
      error: null,
      httpStatus: null,
      message: "unset; no local main checkout provided"
    });
  }

  const schemaPresent = await fileExists(SCHEMA_PATH);
  const fixturesPresent = await fileExists(FIXTURES_PATH);
  const imported = schemaPresent && fixturesPresent;
  let schemaHash = null;
  let fixturesHash = null;
  let verified = false;
  if (imported) {
    schemaHash = await hashFile(SCHEMA_PATH);
    fixturesHash = await hashFile(FIXTURES_PATH);
    verified =
      schemaHash === EXPECTED_SCHEMA_SHA256 && fixturesHash === EXPECTED_FIXTURES_SHA256;
  }

  const retrieval = {
    schemaVersion: "aw-real-data-1-retrieval/1",
    attemptedAt: new Date().toISOString(),
    source: {
      repository: `https://github.com/${REPO}.git`,
      commit: SOURCE_COMMIT,
      files: SOURCE_FILES
    },
    expected: {
      schema: EXPECTED_SCHEMA_SHA256,
      fixtures: EXPECTED_FIXTURES_SHA256
    },
    imported,
    verified,
    files: imported
      ? {
          "contracts/aw-real-data-1.schema.json": schemaHash,
          "contracts/aw-real-data-1.fixtures.json": fixturesHash
        }
      : {},
    attempts,
    conclusion: imported
      ? verified
        ? "Exact frozen R01 schema/fixture bytes were retrieved and checksum-verified."
        : "Files were present but did not match the frozen R01 SHA-256 values; imported remains false."
      : "Exact R01 schema/fixture JSON were not vendored. The CLI GitHub token cannot read private jeffskafi/augmentworks (gh api 404 Not Found / user 403 Resource not accessible by integration; git ls-remote: Repository not found). Files were not fabricated. lock.imported remains false."
  };

  await writeFile(RETRIEVAL_PATH, `${JSON.stringify(retrieval, null, 2)}\n`, "utf8");
  if (imported && !verified) {
    throw new Error(retrieval.conclusion);
  }
  process.stdout.write(`${retrieval.conclusion}\nrecorded ${RETRIEVAL_PATH}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
