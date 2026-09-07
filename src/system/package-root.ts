import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AwError } from "../errors.js";

export async function resolveInstalledPackageRoot(
  from = fileURLToPath(new URL(".", import.meta.url))
): Promise<string> {
  let current = resolve(from);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(current, "package.json");
    if (await exists(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
        if (manifest.name === "@augmentworks/cli") return current;
      } catch {
        // Keep walking; a coincidental package.json is not this package.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new AwError({
    code: "PACKAGE_ROOT_MISSING",
    category: "config",
    message: "The installed @augmentworks/cli package root could not be found."
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
