import { constants as fsConstants } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { Command } from "commander";

import { AwError } from "../errors.js";
import { HOSTED_COMMAND_PIN, INIT_NEXT_STEPS, NPM_PACKAGE } from "../release.js";
import { loadStarterFiles, parseStarterId, type StarterId } from "../onboarding/starters.js";

const ENV_TEMPLATE = `# Local target settings. Keep .env out of version control.
CHATBOT_BASE_URL=http://localhost:8000
CHATBOT_API_KEY=
`;

const AGENT_TEMPLATE = `# AugmentWorks agent setup

Use the pinned AugmentWorks CLI when working on this integration:

\`\`\`bash
npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN} doctor -c augmentworks.yaml
\`\`\`

- Read \`augmentworks.yaml\`, \`augmentworks.assessment.yaml\`, and \`.env.example\`; never read, print, or commit \`.env\`.
- Keep target paths and request/response mappings declarative. Do not add executable mappings.
- Add only synthetic prepare, send, observe, and cleanup hooks required by the configured packet.
- Show the diff and ask before starting an assessment or changing external systems.
- Do not overwrite an edited assessment or reference file. Re-run init with --force only when replacing generated starters.
`;

export interface InitOptions {
  readonly config?: string;
  readonly cwd?: string;
  readonly force?: boolean;
  readonly agent?: boolean;
  readonly env?: boolean;
  readonly starter?: string;
}

export interface InitResult {
  readonly starter: StarterId;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly preserved: readonly string[];
}

export interface InitCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, content: string, mode: number, overwrite: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (overwrite) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function ensureIgnored(gitignorePath: string): Promise<"created" | "updated" | "preserved"> {
  let current = "";
  let hadFile = true;
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hadFile = false;
  }
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const additions: string[] = [];
  if (!(lines.includes(".env") || lines.includes("*.env") || lines.includes(".env*"))) {
    additions.push(".env");
  }
  if (
    !(
      lines.includes(".augmentworks") ||
      lines.includes(".augmentworks/") ||
      lines.includes("/.augmentworks") ||
      lines.includes("/.augmentworks/")
    )
  ) {
    additions.push(".augmentworks/");
  }
  if (additions.length === 0) return "preserved";
  const next = `${current}${current !== "" && !current.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`;
  const result = hadFile ? "updated" : "created";
  await atomicWrite(gitignorePath, next, 0o644, hadFile);
  return result;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const starter = parseStarterId(options.starter);
  const configPath = resolve(cwd, options.config ?? "augmentworks.yaml");
  const configDirectory = dirname(configPath);
  const envExamplePath = resolve(configDirectory, ".env.example");
  const envPath = resolve(configDirectory, ".env");
  const gitignorePath = resolve(configDirectory, ".gitignore");
  const agentPath = resolve(configDirectory, "augmentworks.agent.md");
  const force = options.force === true;
  const createEnvironment = options.env !== false;
  const starterFiles = await loadStarterFiles(starter);
  const generated = starterFiles.map((file) => resolve(configDirectory, file.relativePath));
  if (options.agent === true) generated.push(agentPath);
  if (!force) {
    const collision = (await Promise.all(generated.map(async (path) => ({ path, exists: await exists(path) })))).find(
      (item) => item.exists
    );
    if (collision !== undefined) {
      throw new AwError({
        code: "INIT_FILE_EXISTS",
        category: "config",
        message: `Refusing to overwrite existing file ${collision.path}. Use --force to replace generated files.`,
        details: { path: collision.path }
      });
    }
  }

  const created: string[] = [];
  const updated: string[] = [];
  const preserved: string[] = [];
  const writes: Array<[string, string]> = starterFiles.map((file) => [
    resolve(configDirectory, file.relativePath),
    file.content
  ]);
  if (options.agent === true) writes.push([agentPath, AGENT_TEMPLATE]);
  for (const [path, content] of writes) {
    const alreadyExists = await exists(path);
    await atomicWrite(path, content, 0o644, alreadyExists && force);
    (alreadyExists ? updated : created).push(path);
  }

  if (createEnvironment) {
    if (await exists(envPath)) preserved.push(envPath);
    else {
      const example = starterFiles.find((file) => file.relativePath === ".env.example");
      await atomicWrite(envPath, example?.content ?? ENV_TEMPLATE, 0o600, false);
      created.push(envPath);
    }
    const ignoreResult = await ensureIgnored(gitignorePath);
    if (ignoreResult === "created") created.push(gitignorePath);
    else if (ignoreResult === "updated") updated.push(gitignorePath);
    else preserved.push(gitignorePath);
  }

  return { starter, created, updated, preserved };
}

export function createInitCommand(dependencies: InitCommandDependencies = {}): Command {
  return new Command("init")
    .description("Create a complete AugmentWorks connector, assessment, and starter references")
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option("--starter <name>", "response-quality (default) or workflow", DEFAULT_STARTER_OPTION)
    .option("--agent", "also create repository-local coding-agent instructions")
    .option("--force", "replace generated files, but never replace an existing .env")
    .option("--no-env", "do not create a local .env or update .gitignore")
    .action(
      async (commandOptions: {
        config: string;
        starter?: string;
        agent?: boolean;
        force?: boolean;
        env: boolean;
      }) => {
        const result = await runInit({
          config: commandOptions.config,
          cwd: dependencies.cwd?.() ?? process.cwd(),
          force: commandOptions.force === true,
          agent: commandOptions.agent === true,
          env: commandOptions.env,
          ...(commandOptions.starter === undefined ? {} : { starter: commandOptions.starter })
        });
        const output = dependencies.stdout ?? process.stdout;
        output.write(`starter ${result.starter}\n`);
        for (const path of result.created) output.write(`created ${path}\n`);
        for (const path of result.updated) output.write(`updated ${path}\n`);
        for (const path of result.preserved) output.write(`preserved ${path}\n`);
        output.write(`${INIT_NEXT_STEPS}\n`);
      }
    );
}

const DEFAULT_STARTER_OPTION = "response-quality";
