import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDemo } from "../../src/demo/orchestrator.js";
import { EXIT } from "../../src/errors.js";
import { writeLocalArtifacts } from "../../src/local/artifacts.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("demo report errors", () => {
  it("fails the demo when report publication throws", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "augmentworks-demo-report-"));
    directories.push(cwd);
    await expect(
      runDemo(
        { cwd, outputDirectory: join(cwd, "out"), handleSignals: false, mode: "corrected" },
        {
          stderr: { write: () => true },
          local: {
            writeArtifacts: async () => {
              throw Object.assign(new Error("disk full"), { code: "LOCAL_REPORT_WRITE_FAILED" });
            }
          }
        }
      )
    ).rejects.toBeTruthy();
  }, 30_000);

  it("can run twice into different leaves", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "augmentworks-demo-repeat-"));
    directories.push(cwd);
    const first = await runDemo(
      { cwd, outputDirectory: join(cwd, "one"), handleSignals: false, mode: "faulty" },
      { stderr: { write: () => true } }
    );
    const second = await runDemo(
      { cwd, outputDirectory: join(cwd, "two"), handleSignals: false, mode: "faulty" },
      { stderr: { write: () => true } }
    );
    expect(first.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(second.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(first.summary.runs.faulty?.reports.json).not.toBe(second.summary.runs.faulty?.reports.json);
  }, 30_000);
});

void mkdir;
void writeFile;
void writeLocalArtifacts;
