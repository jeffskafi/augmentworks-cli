import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const documentedSurfaces = [
  "README.md",
  "docs/agent-setup.md",
  "docs/authentication.md",
  "docs/configuration.md",
  "docs/protocol.md",
  "docs/security-model.md",
  "docs/troubleshooting.md",
  "examples/refund-agent/README.md"
] as const;

async function readSurface(path: string): Promise<string> {
  return await readFile(resolve(projectRoot, path), "utf8");
}

describe("customer-facing CLI copy", () => {
  it.each(documentedSurfaces)("%s does not advertise an unregistered command", async (path) => {
    const content = await readSurface(path);

    expect(content).not.toMatch(/@augmentworks\/cli@0\.1\.0\s+(?:connect|run)\b/u);
    expect(content).not.toMatch(/(?:^|\s)augmentworks\s+(?:connect|run)\b/u);
  });

  it.each(documentedSurfaces)("%s does not contain a stale deployment gate", async (path) => {
    const content = await readSurface(path);

    expect(content).not.toMatch(
      /(?:production|hosted|relay|service)[^\n.]{0,100}(?:not deployed|undeployed|once deployed|until [^\n.]* deployed)/iu
    );
  });

  it("documents the registered v0.1 quickstart in execution order", async () => {
    const readme = await readSurface("README.md");
    const commands = [
      "npx --yes @augmentworks/cli@0.1.0 login",
      "npx --yes @augmentworks/cli@0.1.0 init --agent",
      "npx --yes @augmentworks/cli@0.1.0 doctor",
      "npx --yes @augmentworks/cli@0.1.0 test"
    ];

    const offsets = commands.map((command) => readme.indexOf(command));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    const tick = String.fromCharCode(96);
    for (const command of ["login", "logout", "whoami", "init", "doctor", "test", "schema"]) {
      expect(readme).toContain("| " + tick + command);
    }
  });

  it("documents separate platform and target credentials", async () => {
    const authentication = await readSurface("docs/authentication.md");
    const readme = await readSurface("README.md");
    const authenticationCopy = authentication.replace(/\\s+/gu, " ");

    expect(authenticationCopy).toContain(
      "That connector credential is used only for CLI-to-AugmentWorks API"
    );
    expect(authenticationCopy).toContain("Target authentication is configured independently");
    expect(readme).toContain("Target authentication is separate");
  });
});
