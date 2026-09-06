import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { runDemo } from "../../src/demo/orchestrator.js";
import { DEMO_PACKET_SHA256 } from "../../src/demo/resources.js";
import { DEMO_SUMMARY_SCHEMA } from "../../src/demo/types.js";
import { EXIT } from "../../src/errors.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "augmentworks-demo-test-"));
  directories.push(directory);
  return directory;
}

function collect(chunks: string[]): Pick<NodeJS.WriteStream, "write"> {
  return {
    write(value: string) {
      chunks.push(value);
      return true;
    }
  };
}

describe("packaged demo", () => {
  it(
    "fails then passes the same packet and writes distinct reports",
    async () => {
      const cwd = await workspace();
      const outputDirectory = join(cwd, "demo-output");
      const result = await runDemo(
        { cwd, outputDirectory, json: true, handleSignals: false },
        { stderr: collect([]) }
      );

      expect(result.exitCode).toBe(EXIT.OK);
      expect(result.summary.ok).toBe(true);
      expect(result.summary.schema_version).toBe(DEMO_SUMMARY_SCHEMA);
      expect(result.summary.kind).toBe("synthetic_local_demo");
      expect(result.summary.runs.faulty?.exit_code).toBe(EXIT.ASSESSMENT_FAILED);
      expect(result.summary.runs.corrected?.exit_code).toBe(EXIT.OK);
      expect(result.summary.story?.faultyObservation).toBe("refunded");
      expect(result.records[0]?.result.packet.sha256).toBe(DEMO_PACKET_SHA256);
      expect(result.records[0]?.result.provenance.cloud_contacted).toBe(false);

      const failing = JSON.parse(await readFile(join(outputDirectory, "failing", "report.json"), "utf8")) as {
        outcome: string;
      };
      const passing = JSON.parse(await readFile(join(outputDirectory, "passing", "report.json"), "utf8")) as {
        outcome: string;
        packet: { sha256: string };
      };
      expect(failing.outcome).toBe("failed");
      expect(passing.outcome).toBe("passed");
      expect(passing.packet.sha256).toBe(DEMO_PACKET_SHA256);
    },
    30_000
  );

  it(
    "does not consume ambient target configuration or credentials",
    async () => {
      const cwd = await workspace();
      await writeFile(
        join(cwd, "augmentworks.yaml"),
        "version: 1\ntarget:\n  name: poisoned\n  connector: http\n  base_url: ${CHATBOT_BASE_URL}\n  operations:\n    send:\n      method: POST\n      path: /chat\n",
        "utf8"
      );
      await writeFile(
        join(cwd, ".env"),
        "CHATBOT_BASE_URL=https://poisoned.example\nCHATBOT_API_KEY=ambient-secret-must-not-be-used\n",
        "utf8"
      );
      const stdout: string[] = [];
      const result = await runDemo(
        {
          cwd,
          outputDirectory: join(cwd, "isolated-output"),
          json: true,
          handleSignals: false,
          env: {
            ...process.env,
            CHATBOT_BASE_URL: "https://poisoned.example",
            CHATBOT_API_KEY: "ambient-secret-must-not-be-used",
            AUGMENTWORKS_TOKEN: "poison-hosted-token",
            AUGMENTWORKS_API_URL: "https://poisoned.example"
          }
        },
        { stderr: collect([]), stdout: collect(stdout) }
      );
      expect(result.exitCode).toBe(EXIT.OK);
      expect(result.summary.ok).toBe(true);
      const combined = `${JSON.stringify(result.summary)}\n${await readFile(join(cwd, "isolated-output", "failing", "report.json"), "utf8")}`;
      expect(combined).not.toContain("ambient-secret-must-not-be-used");
      expect(combined).not.toContain("poison-hosted-token");
      expect(combined).not.toContain("poisoned.example");
    },
    30_000
  );

  it(
    "returns internal failure when the faulty implementation unexpectedly passes",
    async () => {
      const cwd = await workspace();
      const result = await runDemo(
        {
          cwd,
          outputDirectory: join(cwd, "unexpected-pass"),
          json: true,
          handleSignals: false,
          policies: { faulty: "enforce-limit", corrected: "enforce-limit" }
        },
        { stderr: collect([]) }
      );
      expect(result.summary.ok).toBe(false);
      expect(result.exitCode).toBe(EXIT.INTERNAL);
      expect(result.summary.runs.faulty?.outcome).toBe("passed");
    },
    30_000
  );

  it(
    "does not start the corrected run after a cleanup failure",
    async () => {
      const cwd = await workspace();
      const result = await runDemo(
        {
          cwd,
          outputDirectory: join(cwd, "cleanup-fail"),
          json: true,
          handleSignals: false,
          cleanupMode: "fail"
        },
        { stderr: collect([]) }
      );
      expect(result.exitCode).toBe(EXIT.CLEANUP);
      expect(result.summary.ok).toBe(false);
      expect(result.summary.cleanup.ok).toBe(false);
      expect(result.records).toHaveLength(1);
      expect(result.summary.runs.corrected).toBeNull();
    },
    30_000
  );

  it(
    "refuses to overwrite an existing demo output directory",
    async () => {
      const cwd = await workspace();
      const outputDirectory = join(cwd, "already-there");
      await mkdir(outputDirectory);
      await expect(
        runDemo({ cwd, outputDirectory, handleSignals: false }, { stderr: collect([]) })
      ).rejects.toMatchObject({ code: "LOCAL_OUTPUT_EXISTS" });
    },
    15_000
  );

  it(
    "supports output paths with spaces and machine-readable stdout",
    async () => {
      const cwd = await workspace();
      const outputDirectory = join(cwd, "report dir", "run one");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(["node", "augmentworks", "demo", "--json", "--output-dir", outputDirectory], {
        stdout: collect(stdout),
        stderr: collect(stderr)
      });
      expect(exitCode).toBe(EXIT.OK);
      const parsed = JSON.parse(stdout.join("")) as { schema_version: string; ok: boolean };
      expect(parsed.schema_version).toBe(DEMO_SUMMARY_SCHEMA);
      expect(parsed.ok).toBe(true);
      expect(stdout.join("")).not.toContain("Starting packaged");
      expect(stderr.join("")).toContain("Starting packaged synthetic refund demo.");
      await readFile(join(outputDirectory, "failing", "report.json"), "utf8");
      await readFile(join(outputDirectory, "passing", "junit.xml"), "utf8");
    },
    30_000
  );

  it(
    "mode faulty preserves the underlying assertion exit code",
    async () => {
      const cwd = await workspace();
      const result = await runDemo(
        {
          cwd,
          outputDirectory: join(cwd, "faulty-only"),
          mode: "faulty",
          json: true,
          handleSignals: false
        },
        { stderr: collect([]) }
      );
      expect(result.summary.ok).toBe(true);
      expect(result.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
      expect(result.summary.runs.corrected).toBeNull();
    },
    30_000
  );

  it(
    "contacts only the loopback demo target",
    async () => {
      const cwd = await workspace();
      const urls: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        urls.push(url);
        return originalFetch(input, init);
      }) as typeof fetch;
      try {
        const result = await runDemo(
          {
            cwd,
            outputDirectory: join(cwd, "loopback-output"),
            json: true,
            handleSignals: false
          },
          { stderr: collect([]) }
        );
        expect(result.exitCode).toBe(EXIT.OK);
        expect(urls.length).toBeGreaterThan(0);
        expect(urls.every((url) => url.startsWith("http://127.0.0.1:"))).toBe(true);
        expect(urls.join("\n")).not.toMatch(/augmentworks\.ai|registry\.npmjs|openai|anthropic|telemetry/iu);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    30_000
  );
});
