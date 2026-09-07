import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { AwError } from "../errors.js";
import { resolveInstalledPackageRoot } from "../system/package-root.js";

export const STARTER_IDS = ["response-quality", "workflow"] as const;
export type StarterId = (typeof STARTER_IDS)[number];
export const DEFAULT_STARTER: StarterId = "response-quality";
export const STARTER_CONNECTOR_RELATIVE_PATH = "augmentworks.yaml";
export const STARTER_ASSESSMENT_RELATIVE_PATH = "augmentworks.assessment.yaml";
export const STARTER_ENV_EXAMPLE_RELATIVE_PATH = ".env.example";

export interface StarterFile {
  readonly relativePath: string;
  readonly content: string;
}

export function parseStarterId(value: string | undefined): StarterId {
  const starter = value === undefined || value === "" ? DEFAULT_STARTER : value;
  if ((STARTER_IDS as readonly string[]).includes(starter)) return starter as StarterId;
  throw new AwError({
    code: "INIT_STARTER_UNKNOWN",
    category: "config",
    message:
      "Unknown --starter. Use response-quality (hosted FAQ assessment) or workflow (support-refunds hooks).",
    details: { starter }
  });
}

export async function loadStarterFiles(
  starter: StarterId,
  packageRoot?: string
): Promise<readonly StarterFile[]> {
  const root = packageRoot ?? (await resolveInstalledPackageRoot());
  const starterRoot = join(root, "assets", "starters", starter);
  const files: StarterFile[] = [];
  await visit(starterRoot, "");
  if (files.length === 0) {
    throw new AwError({
      code: "INIT_STARTER_MISSING",
      category: "config",
      message: `The packaged ${starter} starter assets are missing from the installed CLI.`
    });
  }
  const required = [
    STARTER_CONNECTOR_RELATIVE_PATH,
    STARTER_ASSESSMENT_RELATIVE_PATH,
    STARTER_ENV_EXAMPLE_RELATIVE_PATH
  ];
  for (const relativePath of required) {
    if (!files.some((file) => file.relativePath === relativePath)) {
      throw new AwError({
        code: "INIT_STARTER_MISSING",
        category: "config",
        message: `The packaged ${starter} starter is missing ${relativePath}.`
      });
    }
  }
  return files;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new AwError({
        code: "INIT_STARTER_MISSING",
        category: "config",
        message: `The packaged ${starter} starter could not be read.`,
        cause: error
      });
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ relativePath, content: await readFile(path, "utf8") });
    }
  }
}

export function starterReferencePaths(files: readonly StarterFile[]): readonly string[] {
  return files
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath.startsWith("references/") && /\.(?:md|txt)$/u.test(relativePath))
    .sort();
}
