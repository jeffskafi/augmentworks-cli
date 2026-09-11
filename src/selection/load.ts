import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { SuiteSelectionManifestSchema, SUITE_SELECTION_SCHEMA_VERSION_V2, type SuiteSelectionManifest } from "./schema.js";
import { requireSavedSuiteManifest } from "./admit.js";
import { selectionError } from "./errors.js";

export async function loadSuiteSelectionManifest(
  path: string,
  cwd = process.cwd()
): Promise<SuiteSelectionManifest> {
  const resolved = resolve(cwd, path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolved, "utf8")) as unknown;
  } catch (cause) {
    throw selectionError("MANIFEST_FILE_INVALID", `Could not read suite selection manifest ${resolved}.`, {
      cause
    });
  }
  const parsed = SuiteSelectionManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? issue.path.join(".") : "root";
    throw selectionError(
      "MANIFEST_FILE_INVALID",
      `The suite selection manifest is invalid at ${location}: ${issue?.message ?? "schema validation failed"}.`
    );
  }
  if (parsed.data.schemaVersion === SUITE_SELECTION_SCHEMA_VERSION_V2) {
    requireSavedSuiteManifest(parsed.data);
  }
  return parsed.data;
}
