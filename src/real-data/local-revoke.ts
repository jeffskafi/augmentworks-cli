import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getStateDirectory } from "../relay/state-dir.js";
import { UUID_PATTERN } from "./documents.js";
import { realDataError } from "./errors.js";

export async function revokeLocalScope(
  scopeId: string,
  options: { readonly stateDirectory?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  if (!UUID_PATTERN.test(scopeId)) {
    throw realDataError("INVALID_EXECUTION_SCOPE", "Local scope revocation requires a UUID scopeId.");
  }
  const ids = await loadRevokedLocalScopeIds(options);
  ids.add(scopeId.toLowerCase());
  const directory = join(scopeRoot(options), "execution-scopes");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    revokedPath(options),
    `${JSON.stringify({ schemaVersion: "aw-local-scope-revocation/1", scopeIds: [...ids].sort() }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

export async function loadRevokedLocalScopeIds(
  options: { readonly stateDirectory?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(revokedPath(options), "utf8")) as {
      readonly scopeIds?: unknown;
    };
    const ids = Array.isArray(raw.scopeIds)
      ? raw.scopeIds.filter((value): value is string => typeof value === "string")
      : [];
    return new Set(ids.map((value) => value.toLowerCase()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw realDataError("LOCAL_SCOPE_REVOKED", "Could not read the local scope revocation list.", undefined, error);
  }
}

function scopeRoot(options: { readonly stateDirectory?: string; readonly env?: NodeJS.ProcessEnv }): string {
  return options.stateDirectory ?? getStateDirectory(options.env);
}

function revokedPath(options: { readonly stateDirectory?: string; readonly env?: NodeJS.ProcessEnv }): string {
  return join(scopeRoot(options), "execution-scopes", "revoked.json");
}
