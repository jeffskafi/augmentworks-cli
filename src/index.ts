import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";

export { createCli, runCli, type CliIo } from "./cli.js";
export {
  CLI_VERSION,
  CONFIG_VERSION,
  RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION_V2
} from "./version.js";
export { CLI_RELEASE, HOSTED_COMMANDS, LOCAL_COMMANDS } from "./release.js";

function isDirectInvocation(metaUrl: string, argvEntry: string | undefined): boolean {
  if (argvEntry === undefined) return false;
  const modulePath = fileURLToPath(metaUrl);
  const entryPath = resolve(argvEntry);
  try {
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    return modulePath === entryPath;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv);
}
