import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeLocalContentCleanup,
  planLocalContentCleanup
} from "../../src/data-policy/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local content cleanup", () => {
  it("deletes only owned content files and preserves recovery identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-privacy-cleanup-"));
    directories.push(root);
    const journal = join(root, "run-aaaa.jsonl");
    const intent = join(root, "active.intent");
    const lock = join(root, "run-aaaa.jsonl.lock");
    const outside = join(root, "..", `aw-privacy-outside-${process.pid}`);
    await writeFile(journal, '{"event":"completed"}\n', "utf8");
    await writeFile(intent, '{"run_id":"run-1"}\n', "utf8");
    await writeFile(lock, "lock\n", "utf8");
    await writeFile(outside, "leave-me\n", "utf8");
    directories.push(outside);

    const plan = planLocalContentCleanup({
      stateDirectory: root,
      candidates: [
        { path: journal, kind: "journal_content" },
        { path: intent, kind: "journal_content" },
        { path: lock, kind: "journal_content" },
        { path: outside, kind: "journal_content" }
      ]
    });
    expect(plan.preservesRecoveryState).toBe(true);
    expect(plan.neverDeletesWorkingDirectories).toBe(true);
    expect(plan.eligible.map((item) => item.path)).toEqual([journal]);
    expect(plan.skipped.map((item) => item.reason).sort()).toEqual([
      "outside_state_directory",
      "recovery_identifier",
      "recovery_identifier"
    ]);

    const result = await executeLocalContentCleanup(plan);
    expect(result.deleted).toBe(1);
    await expect(readFile(journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(intent, "utf8")).toContain("run-1");
    expect(await readFile(lock, "utf8")).toBe("lock\n");
    expect(await readFile(outside, "utf8")).toBe("leave-me\n");
  });

  it("refuses to delete a directory even if listed as eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-privacy-cleanup-dir-"));
    directories.push(root);
    const nested = join(root, "reports");
    await mkdir(nested);
    await writeFile(join(nested, "keep.txt"), "keep\n", "utf8");
    const plan = {
      ...planLocalContentCleanup({
        stateDirectory: root,
        candidates: [{ path: nested, kind: "local_report_content" as const }]
      }),
      eligible: [{ path: nested, kind: "local_report_content" as const }]
    };
    const result = await executeLocalContentCleanup(plan);
    expect(result.deleted).toBe(0);
    expect(await readFile(join(nested, "keep.txt"), "utf8")).toBe("keep\n");
  });
});
