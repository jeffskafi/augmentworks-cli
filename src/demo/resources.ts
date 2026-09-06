import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AwError } from "../errors.js";
import { loadLocalPacket, parseLocalPacket } from "../local/packet.js";
import { sha256Json } from "../local/canonical.js";
import type { LocalJson, PacketManifest } from "../local/types.js";

export const DEMO_PACKET_RELATIVE_PATH = "assets/demo/packet.json";
export const DEMO_CONFIG_RELATIVE_PATH = "assets/demo/augmentworks.yaml";
export const DEMO_PACKET_SHA256 =
  "8d2d9f4f8c8143cf7db8b1637d87d855327e787aa6019b64f334c7989ccb54b6";

export interface DemoAssets {
  readonly packageRoot: string;
  readonly packetPath: string;
  readonly configPath: string;
  readonly manifest: PacketManifest;
  readonly packetSha256: string;
}

export async function resolveInstalledPackageRoot(
  from = fileURLToPath(new URL(".", import.meta.url))
): Promise<string> {
  let current = resolve(from);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(current, "package.json");
    const packetPath = join(current, DEMO_PACKET_RELATIVE_PATH);
    if ((await exists(manifestPath)) && (await exists(packetPath))) {
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
    code: "DEMO_ASSETS_MISSING",
    category: "config",
    message:
      "The packaged demo assets could not be found relative to the installed @augmentworks/cli package."
  });
}

export async function loadDemoAssets(packageRoot?: string): Promise<DemoAssets> {
  const root = packageRoot ?? (await resolveInstalledPackageRoot());
  const packetPath = join(root, DEMO_PACKET_RELATIVE_PATH);
  const configPath = join(root, DEMO_CONFIG_RELATIVE_PATH);
  if (!(await exists(configPath))) {
    throw new AwError({
      code: "DEMO_ASSETS_MISSING",
      category: "config",
      message: "The packaged demo configuration is missing from the installed package."
    });
  }
  const loaded = await loadLocalPacket({ reference: packetPath, cwd: root });
  if (loaded.binding.sha256 !== DEMO_PACKET_SHA256) {
    throw new AwError({
      code: "DEMO_PACKET_INTEGRITY_FAILED",
      category: "config",
      message: "The packaged demo packet failed its immutable integrity check."
    });
  }
  return {
    packageRoot: root,
    packetPath,
    configPath,
    manifest: loaded.manifest,
    packetSha256: loaded.binding.sha256
  };
}

export async function readDemoConfigTemplate(configPath: string): Promise<string> {
  return readFile(configPath, "utf8");
}

export function demoPacketDigestFromUnknown(value: unknown): string {
  return sha256Json(parseLocalPacket(value) as unknown as LocalJson);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
