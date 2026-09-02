import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectConfig, loadConfig } from "../../src/config/load.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-config-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function chatConfig(baseUrl = "${CHATBOT_BASE_URL}"): string {
  return `version: 1
target:
  name: chat-staging
  connector: http
  base_url: ${baseUrl}
  auth:
    bearer_env: CHATBOT_API_KEY
  operations:
    send:
      method: POST
      path: /chat
      request:
        message: $input.message
      response:
        content: $.answer
`;
}

describe("loadConfig", () => {
  it("loads .env beside the config and gives process environment precedence", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, "augmentworks.yaml"), chatConfig(), "utf8");
    await writeFile(
      resolve(directory, ".env"),
      "CHATBOT_BASE_URL=http://localhost:7000\nCHATBOT_API_KEY=file-secret\n",
      { encoding: "utf8", mode: 0o600 }
    );

    const resolved = await loadConfig({
      cwd: directory,
      processEnv: {
        CHATBOT_BASE_URL: "http://localhost:8000",
        CHATBOT_API_KEY: "process-secret"
      }
    });

    expect(resolved.baseUrl.href).toBe("http://localhost:8000/");
    expect(resolved.authHeaders["Authorization"]).toBe("Bearer process-secret");
    expect(resolved.secrets).toEqual(["process-secret"]);
    expect(resolved.capabilities.level).toBe("chat-only");
  });

  it("produces the same unresolved digest across comments and key ordering", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    await writeFile(resolve(first, "augmentworks.yaml"), chatConfig("http://localhost:8000"), "utf8");
    await writeFile(
      resolve(second, "augmentworks.yaml"),
      `# semantically identical
target:
  operations:
    send:
      response: { content: $.answer }
      request: { message: $input.message }
      path: /chat
      method: POST
  base_url: http://localhost:8000
  connector: http
  name: chat-staging
  auth:
    bearer_env: CHATBOT_API_KEY
version: 1
`,
      "utf8"
    );
    const environment = { CHATBOT_API_KEY: "local-value" };
    const [left, right] = await Promise.all([
      loadConfig({ cwd: first, processEnv: environment }),
      loadConfig({ cwd: second, processEnv: environment })
    ]);
    expect(left.configDigest).toBe(right.configDigest);
  });

  it("rejects missing environment values without exposing another secret", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, "augmentworks.yaml"), chatConfig(), "utf8");
    const inspection = await inspectConfig({ cwd: directory, processEnv: { UNRELATED_SECRET: "do-not-print" } });
    expect(inspection.resolvedConfig).toBeUndefined();
    expect(inspection.diagnostics.map((item) => item.code)).toContain("ENV_REQUIRED");
    expect(JSON.stringify(inspection.diagnostics)).not.toContain("do-not-print");
  });

  it("rejects a symlinked .env", async () => {
    const directory = await temporaryDirectory();
    const secretPath = resolve(directory, "secret-values");
    await writeFile(resolve(directory, "augmentworks.yaml"), chatConfig(), "utf8");
    await writeFile(secretPath, "CHATBOT_BASE_URL=http://localhost:8000\nCHATBOT_API_KEY=secret\n", "utf8");
    const { symlink } = await import("node:fs/promises");
    await symlink(secretPath, resolve(directory, ".env"));
    const inspection = await inspectConfig({ cwd: directory, processEnv: {} });
    expect(inspection.diagnostics.map((item) => item.code)).toContain("ENV_FILE_INVALID");
  });

  it("rejects an oversized .env without reading it unbounded", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, "augmentworks.yaml"), chatConfig(), "utf8");
    await writeFile(resolve(directory, ".env"), `CHATBOT_BASE_URL=${"x".repeat(300_000)}`, {
      encoding: "utf8",
      mode: 0o600
    });

    const inspection = await inspectConfig({ cwd: directory, processEnv: {} });
    const invalidEnvironment = inspection.diagnostics.find((item) => item.code === "ENV_FILE_INVALID");
    expect(invalidEnvironment?.message).toContain("size limit");
    expect(inspection.resolvedConfig).toBeUndefined();
  });

  it("rejects symlinked, non-regular, invalid UTF-8, and oversized config inputs", async () => {
    const directory = await temporaryDirectory();
    const realConfig = resolve(directory, "real.yaml");
    await writeFile(realConfig, chatConfig("http://localhost:8000"), "utf8");
    await symlink(realConfig, resolve(directory, "linked.yaml"));
    await mkdir(resolve(directory, "directory.yaml"));
    await writeFile(resolve(directory, "invalid.yaml"), Buffer.from([0xff, 0xfe]));
    await writeFile(resolve(directory, "oversized.yaml"), Buffer.alloc(1024 * 1024 + 1, 0x20));

    const linked = await inspectConfig({ cwd: directory, configPath: "linked.yaml" });
    const nonRegular = await inspectConfig({ cwd: directory, configPath: "directory.yaml" });
    const invalid = await inspectConfig({ cwd: directory, configPath: "invalid.yaml" });
    const oversized = await inspectConfig({ cwd: directory, configPath: "oversized.yaml" });

    expect(linked.diagnostics[0]).toMatchObject({ code: "CONFIG_FILE_UNREADABLE" });
    expect(nonRegular.diagnostics[0]).toMatchObject({ code: "CONFIG_FILE_UNREADABLE" });
    expect(invalid.diagnostics[0]).toMatchObject({ code: "CONFIG_FILE_UNREADABLE" });
    expect(oversized.diagnostics[0]).toMatchObject({ code: "CONFIG_FILE_TOO_LARGE" });
  });

  it.runIf(process.platform !== "win32")("warns when .env permissions expose secrets to other users", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, "augmentworks.yaml"), chatConfig(), "utf8");
    const envPath = resolve(directory, ".env");
    await writeFile(envPath, "CHATBOT_BASE_URL=http://localhost:8000\nCHATBOT_API_KEY=secret\n", "utf8");
    await chmod(envPath, 0o644);
    const inspection = await inspectConfig({ cwd: directory, processEnv: {} });
    expect(inspection.resolvedConfig).toBeDefined();
    expect(inspection.diagnostics.map((item) => item.code)).toContain("ENV_FILE_PERMISSIONS");
  });
});
