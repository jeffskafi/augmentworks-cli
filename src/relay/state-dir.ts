import { homedir } from "node:os";
import { join } from "node:path";

import { AwError } from "../errors.js";

export function getStateDirectory(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env["AUGMENTWORKS_STATE_DIR"]?.trim();
  if (override) return override;

  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"]?.trim();
    if (!localAppData) throw missingStateDirectory();
    return join(localAppData, "AugmentWorks");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "AugmentWorks");
  }
  const xdgState = env["XDG_STATE_HOME"]?.trim();
  return xdgState ? join(xdgState, "augmentworks") : join(homedir(), ".local", "state", "augmentworks");
}

function missingStateDirectory(): AwError {
  return new AwError({
    code: "STATE_DIRECTORY_UNAVAILABLE",
    category: "local",
    message: "Could not determine a secure operating-system state directory."
  });
}
