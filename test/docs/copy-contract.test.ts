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

    expect(content).not.toMatch(
      /\bnpx(?:\s+(?:--yes|-y))?\s+["']?@augmentworks\/cli(?:@[^\s"'\x60]+)?["']?\s+(?:connect|run)\b/u
    );
    expect(content).not.toMatch(/(?:^|\s)augmentworks\s+(?:connect|run)\b/u);
  });

  it.each(documentedSurfaces)("%s does not contain a stale deployment gate", async (path) => {
    const content = await readSurface(path);

    expect(content).not.toMatch(
      /(?:production|hosted|relay|service)[^\n.]{0,100}(?:not deployed|undeployed|once deployed|until [^\n.]* deployed)/iu
    );
  });

  it.each(documentedSurfaces)("%s pins executable examples to CLI 0.2.0", async (path) => {
    const content = await readSurface(path);

    expect(content).not.toContain("@augmentworks/cli@0.1.0");
    for (const match of content.matchAll(/@augmentworks\/cli@(\d+\.\d+\.\d+)/gu)) {
      expect(match[1]).toBe("0.2.0");
    }
  });

  it("documents the registered local quickstart in execution order", async () => {
    const readme = await readSurface("README.md");
    const commands = [
      "npx --yes @augmentworks/cli@0.2.0 init --agent",
      "npx --yes @augmentworks/cli@0.2.0 doctor",
      "npx --yes @augmentworks/cli@0.2.0 test"
    ];

    const offsets = commands.map((command) => readme.indexOf(command));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(readme.slice(offsets[2]!)).toMatch(
      /test\s+\\\n\s+--local\s+\\\n[\s\S]{0,200}--packet support-refunds-starter@0\.1\.0/u
    );
    const tick = String.fromCharCode(96);
    for (const command of ["login", "logout", "whoami", "init", "doctor", "test", "schema"]) {
      expect(readme).toContain("| " + tick + command);
    }
  });

  it("documents separate platform and target credentials", async () => {
    const authentication = await readSurface("docs/authentication.md");
    const readme = await readSurface("README.md");
    const authenticationCopy = authentication.replace(/\s+/gu, " ");

    expect(authenticationCopy).toContain(
      "That connector credential is used only for CLI-to-AugmentWorks API"
    );
    expect(authenticationCopy).toContain("Target authentication is configured independently");
    expect(readme).toContain("Target authentication is separate");
  });

  it("requires an isolated synthetic target and synthetic-only data", async () => {
    const readme = (await readSurface("README.md")).replace(/\s+/gu, " ");
    const agentSetup = (await readSurface("docs/agent-setup.md")).replace(/\s+/gu, " ");
    const securityModel = (await readSurface("docs/security-model.md")).replace(/\s+/gu, " ");

    expect(readme).toContain("authorized, isolated synthetic targets");
    expect(readme).toContain(
      "Do not connect production systems or use production or regulated data."
    );
    expect(agentSetup).toContain(
      "Use only an authorized, isolated synthetic target in a test or staging environment and synthetic test data."
    );
    expect(agentSetup).not.toContain("Use test or staging data only.");
    expect(securityModel).toContain(
      "Use only an authorized, isolated synthetic target and synthetic test data."
    );
  });

  it("documents the local no-control-plane boundary without promising an air gap", async () => {
    const readme = (await readSurface("README.md")).replace(/\s+/gu, " ");
    const authentication = (await readSurface("docs/authentication.md")).replace(/\s+/gu, " ");
    const securityModel = (await readSurface("docs/security-model.md")).replace(/\s+/gu, " ");

    expect(readme).toContain("requires no AugmentWorks account and contacts no AugmentWorks service");
    expect(readme).toContain("configured target may itself be a network service");
    expect(authentication).toContain("Authentication is not used by `test --local`");
    expect(securityModel).toContain("contacts no AugmentWorks control-plane endpoint");
    expect(securityModel).toContain("not a promise of an air-gapped assessment");
  });

  it("documents strict local packet and schema contracts", async () => {
    const readme = await readSurface("README.md");
    const configuration = (await readSurface("docs/configuration.md")).replace(/\s+/gu, " ");

    expect(readme).toContain("support-refunds-starter@0.1.0");
    expect(readme).toContain("strict `aw-packet/0.1` JSON format");
    expect(readme).toContain("schema --kind local-packet");
    expect(readme).toContain("schema --kind local-result");
    expect(configuration).toContain('`schema_version: "aw-packet/0.1"`');
    expect(configuration).toContain("URLs, downloaded packets, JavaScript, and modules are not accepted");
  });

  it("preserves the local artifact trust boundary and fresh output contract", async () => {
    const trustLabel =
      "Local, customer-executed result. AugmentWorks did not receive or independently verify this run. This artifact is unsigned and is not a certification, audit, or hosted evidence record.";
    const readme = (await readSurface("README.md")).replace(/\s+/gu, " ");
    const securityModel = (await readSurface("docs/security-model.md")).replace(/\s+/gu, " ");
    const troubleshooting = (await readSurface("docs/troubleshooting.md")).replace(/\s+/gu, " ");

    expect(readme).toContain(trustLabel);
    expect(securityModel).toContain(trustLabel);
    expect(troubleshooting).toContain(trustLabel);
    expect(readme).toContain("`AW-LOCAL-RESULT-1`");
    expect(readme).toContain("`--output-dir <path>`");
    expect(readme).toContain("selected leaf must not already exist");
    expect(readme).toContain("self-contained static file with no scripts or external assets");
  });

  it("documents local cleanup, crash, and exit behavior", async () => {
    const readme = (await readSurface("README.md")).replace(/\s+/gu, " ");
    const securityModel = (await readSurface("docs/security-model.md")).replace(/\s+/gu, " ");
    const troubleshooting = (await readSurface("docs/troubleshooting.md")).replace(/\s+/gu, " ");

    expect(readme).toContain("A cleanup failure stops new attempts");
    expect(readme).toContain("A hard process or machine failure cannot guarantee cleanup");
    expect(securityModel).toContain("a second interrupt exits immediately");
    expect(troubleshooting).toContain("cleanup failure has exit code `6`");
    expect(troubleshooting).toContain("Hosted-only auth and relay codes `3` and `4` are unreachable");
  });
});
