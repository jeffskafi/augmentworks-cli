import { lstat, realpath } from "node:fs/promises";
import { parse as parsePath, resolve, sep } from "node:path";

const DARWIN_ROOT_ALIASES = new Map<string, string>([
  ["/etc", "/private/etc"],
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"]
]);

export async function findUnsafeSymbolicLinkComponent(
  path: string
): Promise<string | undefined> {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;

  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    if (!(await lstat(current)).isSymbolicLink()) continue;
    if (await isDarwinSystemRootAlias(current, index)) continue;
    return current;
  }
  return undefined;
}

async function isDarwinSystemRootAlias(path: string, componentIndex: number): Promise<boolean> {
  if (process.platform !== "darwin" || componentIndex !== 0) return false;
  const expectedTarget = DARWIN_ROOT_ALIASES.get(path);
  if (expectedTarget === undefined) return false;
  try {
    return resolve(await realpath(path)) === expectedTarget;
  } catch {
    return false;
  }
}
