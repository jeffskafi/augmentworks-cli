import { constants as fsConstants } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { Command } from "commander";

import { AwError } from "../errors.js";

const CONFIG_TEMPLATE = `# yaml-language-server: $schema=https://augmentworks.ai/schemas/v1/augmentworks.schema.json
version: 1

target:
  name: refunds-staging
  connector: http
  base_url: \${CHATBOT_BASE_URL}

  auth:
    bearer_env: CHATBOT_API_KEY

  operations:
    prepare:
      method: POST
      path: /__augmentworks/prepare
      idempotent: true
      request:
        run_id: $input.run_id
        attempt_id: $input.attempt_id
        fixture: $input.fixture

    send:
      method: POST
      path: /chat
      idempotent: false
      request:
        message: $input.message.content
        session_id: $input.attempt_id
      response:
        content: $.answer
        tool_events: $.events

    observe:
      method: POST
      path: /__augmentworks/observe
      idempotent: true
      request:
        attempt_id: $input.attempt_id
        request_id: $input.request_id
        probe_keys: $input.probe_keys
      response:
        order.status: $.order.status
        order.refunded_amount: $.order.refunded_amount

    cleanup:
      method: POST
      path: /__augmentworks/cleanup
      idempotent: true
      request:
        attempt_id: $input.attempt_id

telemetry:
  allow_tool_events: true
  allow_observations:
    - order.status
    - order.refunded_amount
`;

const ENV_TEMPLATE = `# Local target settings. Keep .env out of version control.
CHATBOT_BASE_URL=http://localhost:8000
CHATBOT_API_KEY=
`;

const AGENT_TEMPLATE = `# AugmentWorks agent setup

Use the pinned AugmentWorks CLI when working on this integration:

\`\`\`bash
npx --yes @augmentworks/cli@0.1.0 doctor -c augmentworks.yaml
\`\`\`

- Read \`augmentworks.yaml\` and \`.env.example\`; never read, print, or commit \`.env\`.
- Keep target paths and request/response mappings declarative. Do not add executable mappings.
- Add only synthetic prepare, send, observe, and cleanup hooks required by the configured packet.
- Show the diff and ask before starting an assessment or changing external systems.
`;

export interface InitOptions {
  readonly config?: string;
  readonly cwd?: string;
  readonly force?: boolean;
  readonly agent?: boolean;
  readonly env?: boolean;
}

export interface InitResult {
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
  if (lines.includes(".env") || lines.includes("*.env") || lines.includes(".env*")) return "preserved";
  const next = `${current}${current !== "" && !current.endsWith("\n") ? "\n" : ""}.env\n`;
  const result = hadFile ? "updated" : "created";
  await atomicWrite(gitignorePath, next, 0o644, hadFile);
  return result;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.config ?? "augmentworks.yaml");
  const configDirectory = dirname(configPath);
  const envExamplePath = resolve(configDirectory, ".env.example");
  const envPath = resolve(configDirectory, ".env");
  const gitignorePath = resolve(configDirectory, ".gitignore");
  const agentPath = resolve(configDirectory, "augmentworks.agent.md");
  const force = options.force === true;
  const createEnvironment = options.env !== false;

  const generated = [configPath, envExamplePath, ...(options.agent === true ? [agentPath] : [])];
  if (!force) {
    const collision = (await Promise.all(generated.map(async (path) => ({ path, exists: await exists(path) })))).find((item) => item.exists);
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
  for (const [path, content] of [
    [configPath, CONFIG_TEMPLATE],
    [envExamplePath, ENV_TEMPLATE],
    ...(options.agent === true ? ([[agentPath, AGENT_TEMPLATE]] as Array<[string, string]>) : [])
  ] as Array<[string, string]>) {
    const alreadyExists = await exists(path);
    await atomicWrite(path, content, 0o644, alreadyExists && force);
    (alreadyExists ? updated : created).push(path);
  }

  if (createEnvironment) {
    if (await exists(envPath)) preserved.push(envPath);
    else {
      await atomicWrite(envPath, ENV_TEMPLATE, 0o600, false);
      created.push(envPath);
    }
    const ignoreResult = await ensureIgnored(gitignorePath);
    if (ignoreResult === "created") created.push(gitignorePath);
    else if (ignoreResult === "updated") updated.push(gitignorePath);
    else preserved.push(gitignorePath);
  }

  return { created, updated, preserved };
}

export function createInitCommand(dependencies: InitCommandDependencies = {}): Command {
  return new Command("init")
    .description("Create a deterministic AugmentWorks connector configuration")
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option("--agent", "also create repository-local coding-agent instructions")
    .option("--force", "replace generated files, but never replace an existing .env")
    .option("--no-env", "do not create a local .env or update .gitignore")
    .action(async (commandOptions: { config: string; agent?: boolean; force?: boolean; env: boolean }) => {
      const result = await runInit({
        config: commandOptions.config,
        cwd: dependencies.cwd?.() ?? process.cwd(),
        force: commandOptions.force === true,
        agent: commandOptions.agent === true,
        env: commandOptions.env
      });
      const output = dependencies.stdout ?? process.stdout;
      for (const path of result.created) output.write(`created ${path}\n`);
      for (const path of result.updated) output.write(`updated ${path}\n`);
      for (const path of result.preserved) output.write(`preserved ${path}\n`);
      output.write("Next: edit .env, then run `augmentworks doctor`.\n");
    });
}
