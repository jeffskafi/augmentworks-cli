import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function augmentWorksConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"];
    return path.join(localAppData === undefined || localAppData === "" ? os.homedir() : localAppData, "AugmentWorks");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AugmentWorks");
  }
  const xdgConfigHome = env["XDG_CONFIG_HOME"];
  return path.join(xdgConfigHome === undefined || xdgConfigHome === "" ? path.join(os.homedir(), ".config") : xdgConfigHome, "augmentworks");
}

export function credentialFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return path.join(augmentWorksConfigDirectory(env, platform), "credentials.json");
}

export function originScopedCredentialFilePath(
  apiOrigin: URL,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const originDigest = createHash("sha256").update(apiOrigin.origin).digest("hex").slice(0, 16);
  return path.join(augmentWorksConfigDirectory(env, platform), `credentials-${originDigest}.json`);
}
