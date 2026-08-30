import { describe, expect, it, vi } from "vitest";

import {
  MacOsKeychainCredentialStore,
  WindowsDpapiCredentialStore,
  createCredentialStore,
  type CredentialHelperRunner,
  type CredentialHelperRuntime
} from "../../src/auth/credential-store.js";
import type { StoredCredential } from "../../src/auth/types.js";

const API_ORIGIN = new URL("https://augmentworks.ai");
const CREDENTIAL: StoredCredential = {
  accessToken: "aw_connector_native_access_token",
  refreshToken: "aw_connector_native_refresh_token",
  tokenType: "Bearer"
};
const SERIALIZED = `${JSON.stringify(CREDENTIAL)}\n`;

describe("native credential stores", () => {
  it("keeps a macOS Keychain credential out of process arguments", async () => {
    const calls: Array<{
      args: readonly string[];
      input?: string;
    }> = [];
    const runner: CredentialHelperRunner = async (_executable, args, options = {}) => {
      calls.push({
        args,
        ...(options.input === undefined ? {} : { input: options.input })
      });
      if (args[0] === "find-generic-password") {
        return { code: 0, stdout: SERIALIZED, stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        return { code: 44, stdout: "", stderr: "item not found" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const store = new MacOsKeychainCredentialStore(
      "/usr/bin/security",
      API_ORIGIN,
      runner
    );

    await store.save(CREDENTIAL);
    await expect(store.load()).resolves.toEqual(CREDENTIAL);
    await expect(store.delete()).resolves.toBeUndefined();

    const save = calls[0]!;
    expect(save.args).toEqual(["-i"]);
    expect(save.args.join(" ")).not.toContain(CREDENTIAL.accessToken);
    expect(save.args.join(" ")).not.toContain(CREDENTIAL.refreshToken);
    expect(save.input).not.toContain(CREDENTIAL.accessToken);
    expect(save.input).not.toContain(CREDENTIAL.refreshToken);
    const passwordHex = save.input?.match(/-X ([a-f0-9]+)\n$/)?.[1];
    expect(Buffer.from(passwordHex ?? "", "hex").toString("utf8")).toBe(SERIALIZED);
  });

  it("distinguishes a missing macOS item from a Keychain failure", async () => {
    const missing = new MacOsKeychainCredentialStore(
      "/usr/bin/security",
      API_ORIGIN,
      async () => ({ code: 44, stdout: "", stderr: "" })
    );
    await expect(missing.load()).resolves.toBeNull();

    const unavailable = new MacOsKeychainCredentialStore(
      "/usr/bin/security",
      API_ORIGIN,
      async () => ({ code: 36, stdout: "", stderr: "keychain locked" })
    );
    await expect(unavailable.load()).rejects.toMatchObject({ code: "CREDENTIAL_STORE" });
  });

  it("uses CurrentUser DPAPI and protected ACL checks without argv secrets on Windows", async () => {
    const calls: Array<{
      args: readonly string[];
      request: Record<string, unknown>;
    }> = [];
    const runner: CredentialHelperRunner = async (_executable, args, options = {}) => {
      const request = JSON.parse(options.input ?? "{}") as Record<string, unknown>;
      calls.push({ args, request });
      if (request["operation"] === "load") {
        return {
          code: 0,
          stdout: Buffer.from(SERIALIZED, "utf8").toString("base64"),
          stderr: ""
        };
      }
      if (request["operation"] === "delete") {
        return { code: 44, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const store = new WindowsDpapiCredentialStore(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Users\\dev\\AppData\\Local\\AugmentWorks\\credentials-test.dpapi",
      API_ORIGIN,
      runner
    );

    await store.save(CREDENTIAL);
    await expect(store.load()).resolves.toEqual(CREDENTIAL);
    await expect(store.delete()).resolves.toBeUndefined();

    const save = calls[0]!;
    const argv = save.args.join(" ");
    expect(argv).not.toContain(CREDENTIAL.accessToken);
    expect(argv).not.toContain(CREDENTIAL.refreshToken);
    expect(
      Buffer.from(String(save.request["credential_b64"]), "base64").toString("utf8")
    ).toBe(SERIALIZED);
    const encodedCommand = save.args[save.args.indexOf("-EncodedCommand") + 1]!;
    const helperScript = Buffer.from(encodedCommand, "base64").toString("utf16le");
    expect(helperScript).toContain("DataProtectionScope]::CurrentUser");
    expect(helperScript).toContain("AreAccessRulesProtected");
    expect(helperScript).toContain("FileAttributes]::ReparsePoint");
  });

  it("selects trusted absolute native helpers for macOS and Windows", async () => {
    const runner: CredentialHelperRunner = async () => ({ code: 44, stdout: "", stderr: "" });
    const findExecutable = vi.fn(async (name: string) => name);
    const helperRuntime = {
      findExecutable,
      runProcess: runner
    } as CredentialHelperRuntime;

    const mac = await createCredentialStore({
      apiOrigin: API_ORIGIN,
      platform: "darwin",
      env: {},
      helperRuntime
    });
    expect(mac.description).toBe("macOS login Keychain");
    expect(findExecutable).toHaveBeenCalledWith("/usr/bin/security", {
      env: {},
      platform: "darwin"
    });

    findExecutable.mockClear();
    const windows = await createCredentialStore({
      apiOrigin: API_ORIGIN,
      platform: "win32",
      env: { LOCALAPPDATA: "D:\\Users\\dev\\AppData\\Local", SystemRoot: "D:\\Windows" },
      helperRuntime
    });
    expect(windows.description).toContain("Windows DPAPI credential");
    expect(windows.description).toContain("D:\\Users\\dev\\AppData\\Local\\AugmentWorks");
    expect(findExecutable).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      expect.objectContaining({ platform: "win32" })
    );
  });

  it("refuses a plaintext fallback when Windows DPAPI is unavailable", async () => {
    const helperRuntime: CredentialHelperRuntime = {
      findExecutable: async () => null,
      runProcess: async () => ({ code: 1, stdout: "", stderr: "" })
    };
    await expect(
      createCredentialStore({
        apiOrigin: API_ORIGIN,
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
        helperRuntime,
        allowFileFallback: true
      })
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });
});
