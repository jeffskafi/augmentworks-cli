import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function augmentWorksConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"];
    return path.win32.join(
      localAppData === undefined || localAppData === "" ? os.homedir() : localAppData,
      "AugmentWorks"
    );
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
  return pathForPlatform(platform).join(
    augmentWorksConfigDirectory(env, platform),
    "credentials.json"
  );
}

export function originScopedCredentialFilePath(
  apiOrigin: URL,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const originDigest = createHash("sha256").update(apiOrigin.origin).digest("hex").slice(0, 16);
  return pathForPlatform(platform).join(
    augmentWorksConfigDirectory(env, platform),
    `credentials-${originDigest}.json`
  );
}

export function originScopedCredentialDpapiPath(
  apiOrigin: URL,
  env: NodeJS.ProcessEnv = process.env
): string {
  const originDigest = createHash("sha256").update(apiOrigin.origin).digest("hex").slice(0, 16);
  return path.win32.join(
    augmentWorksConfigDirectory(env, "win32"),
    `credentials-${originDigest}.dpapi`
  );
}

export function originScopedCredentialRefreshLockPath(
  apiOrigin: URL,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const credentialPath = originScopedCredentialFilePath(apiOrigin, env, platform);
  return `${credentialPath.slice(0, -".json".length)}.refresh.lock`;
}

function pathForPlatform(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}
