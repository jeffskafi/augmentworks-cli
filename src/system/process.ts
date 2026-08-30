import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { AwError } from "../errors.js";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function findExecutable(
  name: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform } = {}
): Promise<string | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathValue = env["PATH"] ?? "";
  const pathExtensions =
    platform === "win32"
      ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of pathExtensions) {
      const candidate = path.join(directory, platform === "win32" ? `${name}${extension}` : name);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return null;
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly timeoutMs?: number;
    readonly allowFailure?: boolean;
    readonly env?: NodeJS.ProcessEnv;
  } = {}
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env })
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finishError = (error: AwError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };

    const consume = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        finishError(
          new AwError({
            code: "CREDENTIAL_STORE",
            category: "local",
            message: "Credential helper produced too much output."
          })
        );
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
    child.on("error", (cause) => {
      finishError(
        new AwError({
          code: "CREDENTIAL_STORE",
          category: "local",
          message: "Could not start the operating-system credential helper.",
          cause
        })
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && options.allowFailure !== true) {
        reject(
          new AwError({
            code: "CREDENTIAL_STORE",
            category: "local",
            message: "The operating-system credential helper failed."
          })
        );
      } else {
        resolve(result);
      }
    });

    const timer = setTimeout(() => {
      finishError(
        new AwError({
          code: "CREDENTIAL_STORE",
          category: "local",
          message: "The operating-system credential helper timed out."
        })
      );
    }, options.timeoutMs ?? 10_000);
    timer.unref();

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input, "utf8");
  });
}
