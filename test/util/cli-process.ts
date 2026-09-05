import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceEntrypoint = resolve(projectRoot, "src/index.ts");
const tsxImportUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const maxCapturedBytes = 2 * 1024 * 1024;

export interface CliProcessOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

export interface CliProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runSourceCli(
  args: readonly string[],
  options: CliProcessOptions
): Promise<CliProcessResult> {
  const child = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", "--import", tsxImportUrl, sourceEntrypoint, ...args],
    {
    cwd: options.cwd,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      ...options.env
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  let capturedBytes = 0;
  const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
    capturedBytes += chunk.byteLength;
    if (capturedBytes > maxCapturedBytes) {
      child.kill("SIGTERM");
      return;
    }
    if (target === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();

  const timeoutMs = options.timeoutMs ?? 20_000;
  let timeout: NodeJS.Timeout | undefined;
  const result = await new Promise<CliProcessResult>((fulfill, reject) => {
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    timeout.unref?.();
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      fulfill({ exitCode, signal, stdout, stderr });
    });
  }).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });

  if (capturedBytes > maxCapturedBytes) {
    throw new Error(`CLI output exceeded ${String(maxCapturedBytes)} bytes`);
  }
  if (result.signal !== null) {
    throw new Error(`CLI was terminated by ${result.signal}; stderr: ${result.stderr}`);
  }
  return result;
}
