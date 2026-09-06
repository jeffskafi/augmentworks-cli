#!/usr/bin/env node

import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePackReport } from "./npm-pack-report.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandTimeoutMs = 120_000;

class SmokeFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeFailure";
  }
}

function assert(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

function resolveNpmJsCli(binName) {
  const fileName = `${binName}-cli.js`;
  const fromLifecycle =
    typeof process.env.npm_execpath === "string" && process.env.npm_execpath.length > 0
      ? process.env.npm_execpath
      : undefined;
  const candidates = [];
  if (fromLifecycle !== undefined) {
    if (binName === "npm") candidates.push(fromLifecycle);
    candidates.push(join(dirname(fromLifecycle), fileName));
  }
  const prefix = dirname(process.execPath);
  candidates.push(
    join(prefix, "node_modules", "npm", "bin", fileName),
    join(prefix, "..", "lib", "node_modules", "npm", "bin", fileName)
  );
  return candidates.find((path) => existsSync(path));
}

function runJsCli(binName, args, options = {}) {
  const cli = resolveNpmJsCli(binName);
  if (cli !== undefined) {
    return run(process.execPath, [cli, ...args], options);
  }
  // Node 22+ on Windows rejects spawn of .cmd shims without a shell (EINVAL).
  return run(process.platform === "win32" ? `${binName}.cmd` : binName, args, {
    ...options,
    shell: process.platform === "win32"
  });
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: commandTimeoutMs,
    windowsHide: true,
    ...(options.shell === true ? { shell: true } : {})
  });

  if (result.error !== undefined) {
    throw new SmokeFailure(
      `Could not run ${executable} ${args.join(" ")}: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new SmokeFailure(
      [
        `Command failed (${String(result.status)}): ${executable} ${args.join(" ")}`,
        result.stdout.trim(),
        result.stderr.trim()
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

async function walkFiles(root) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  }

  await visit(root);
  return files;
}

function normalizePath(path) {
  return path.split(sep).join("/").replace(/^package\//, "");
}

function assertInventory(report) {
  const files = report.files.map((entry) => normalizePath(String(entry.path)));
  const fileSet = new Set(files);
  const required = [
    "package.json",
    "dist/index.js",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md"
  ];

  for (const path of required) {
    assert(fileSet.has(path), `published tarball is missing ${path}`);
  }
  assert(
    files.some((path) => path.startsWith("schemas/") && path.endsWith(".schema.json")),
    "published tarball is missing its versioned JSON Schema"
  );
  for (const path of [
    "schemas/v1/local-packet.schema.json",
    "schemas/v1/local-result.schema.json",
    "packets/support-refunds-starter/0.1.0/packet.json",
    "schemas/v1/cli-release.json",
    "assets/demo/packet.json",
    "assets/demo/augmentworks.yaml",
    "contracts/discovery-manifest.json",
    "contracts/discovery-manifest.schema.json"
  ]) {
    assert(fileSet.has(path), `published tarball is missing ${path}`);
  }

  const forbiddenPrefixes = ["src/", "test/", "tests/", "scripts/", "examples/", ".github/", "docs/", "agent-resources/"];
  for (const path of files) {
    assert(
      !forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
      `development-only path leaked into the tarball: ${path}`
    );
    const basename = path.slice(path.lastIndexOf("/") + 1);
    assert(basename !== ".env", `secret-bearing .env file leaked into the tarball: ${path}`);
    assert(!/\.(?:pem|key|p12|pfx)$/i.test(path), `private-key-shaped file leaked into the tarball: ${path}`);
    assert(!path.endsWith(".ts") || path.endsWith(".d.ts"), `TypeScript source leaked into the tarball: ${path}`);
  }
}

async function assertNoEmbeddedSecrets(packageRoot) {
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bnpm_[A-Za-z0-9]{30,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\baw_(?:project|connector)_[A-Za-z0-9_-]{16,}\b/
  ];

  for (const path of await walkFiles(packageRoot)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) continue;
    const content = await readFile(path, "utf8");
    for (const pattern of secretPatterns) {
      assert(!pattern.test(content), `possible credential embedded in ${normalizePath(relative(packageRoot, path))}`);
    }
  }
}

async function assertNoHostedJudgeClient(packageRoot) {
  const forbidden = [
    /@anthropic-ai(?:\/sdk)?/,
    /ANTHROPIC_API_KEY/,
    /from ["']@anthropic-ai/
  ];
  for (const path of await walkFiles(packageRoot)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) continue;
    const normalized = normalizePath(relative(packageRoot, path));
    assert(
      !normalized.includes("anthropic"),
      `hosted judge client path leaked into the tarball: ${normalized}`
    );
    const content = await readFile(path, "utf8");
    for (const pattern of forbidden) {
      assert(
        !pattern.test(content),
        `hosted judge client or ANTHROPIC credential leaked into ${normalized}`
      );
    }
  }
}

async function assertBundledLicenseCoverage(packageRoot) {
  const bundle = await readFile(join(packageRoot, "dist", "index.js"), "utf8");
  const notices = await readFile(join(packageRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const embeddedPackages = new Set(
    [...bundle.matchAll(/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g)].map(
      (match) => match[1]
    )
  );
  assert(
    embeddedPackages.size > 0,
    "could not detect bundled runtime packages for license validation"
  );

  for (const packageName of [...embeddedPackages].sort()) {
    const documentedAsHeading = notices.includes(`## ${packageName} `);
    const documentedAsListItem = notices.includes(`\`${packageName}\` `);
    assert(
      documentedAsHeading || documentedAsListItem,
      `THIRD_PARTY_NOTICES.md is missing bundled package ${packageName}`
    );
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "augmentworks-cli-pack-"));
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const assessmentDirectory = join(consumerDirectory, "assessment");
  let targetProcess;

  try {
    await writeFile(join(temporaryRoot, "README"), "Temporary npm pack smoke workspace.\n", "utf8");
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(consumerDirectory, { recursive: true }),
      mkdir(assessmentDirectory, { recursive: true })
    ]);

    process.stdout.write("[pack smoke] building package\n");
    runJsCli("npm", ["run", "build"]);

    process.stdout.write("[pack smoke] creating and inspecting tarball\n");
    const packed = runJsCli("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDirectory
    ]);
    const report = parsePackReport(packed.stdout);
    assertInventory(report);

    const tarballPath = join(packDirectory, report.filename);
    await access(tarballPath, fsConstants.R_OK);

    const rootManifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    assert(report.name === rootManifest.name, "tarball package name differs from package.json");
    assert(report.version === rootManifest.version, "tarball version differs from package.json");

    process.stdout.write("[pack smoke] executing tarball through npx\n");
    const directVersion = runJsCli(
      "npx",
      ["--yes", "--package", tarballPath, "augmentworks", "--version"],
      {
        cwd: consumerDirectory
      }
    );
    assert(
      directVersion.stdout.trim() === rootManifest.version,
      `npx --version returned ${JSON.stringify(directVersion.stdout.trim())}, expected ${rootManifest.version}`
    );

    await writeFile(
      join(consumerDirectory, "package.json"),
      JSON.stringify({ name: "augmentworks-cli-pack-smoke", private: true, version: "0.0.0" }, null, 2) + "\n",
      "utf8"
    );
    runJsCli(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
      { cwd: consumerDirectory }
    );

    const installedRoot = join(consumerDirectory, "node_modules", "@augmentworks", "cli");
    const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    assert(installedManifest.name === "@augmentworks/cli", "installed package has the wrong name");
    assert(installedManifest.version === rootManifest.version, "installed package has the wrong version");
    assert(installedManifest.bin?.augmentworks === "dist/index.js", "installed package has the wrong bin mapping");
    await assertNoEmbeddedSecrets(installedRoot);
    await assertNoHostedJudgeClient(installedRoot);
    await assertBundledLicenseCoverage(installedRoot);

    const installedBin = join(
      consumerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "augmentworks.cmd" : "augmentworks"
    );
    await access(installedBin, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    if (process.platform !== "win32") {
      const executable = await stat(join(installedRoot, "dist", "index.js"));
      assert((executable.mode & 0o111) !== 0, "published CLI entrypoint is not executable");
    }

    const execCli = (args, options = {}) =>
      runJsCli("npm", ["exec", "--", "augmentworks", ...args], {
        cwd: options.cwd ?? consumerDirectory,
        env: options.env
      });

    const installedVersion = execCli(["--version"]);
    assert(installedVersion.stdout.trim() === rootManifest.version, "installed CLI version is inconsistent");

    const recoverHelp = execCli(["recover", "--help"]);
    assert(recoverHelp.stdout.includes("--retire"), "packed CLI is missing recover --retire");
    assert(recoverHelp.stdout.includes("--resume"), "packed CLI is missing recover --resume");
    assert(recoverHelp.stdout.includes("--cancel"), "packed CLI is missing recover --cancel");
    assert(!recoverHelp.stdout.includes("--force-delete"), "packed CLI advertised --force-delete");

    process.stdout.write("[pack smoke] checking schema, init, and offline doctor\n");
    const schemaResult = execCli(["schema"]);
    let schema;
    try {
      schema = JSON.parse(schemaResult.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `augmentworks schema did not print JSON: ${error instanceof Error ? error.message : String(error)}\n${schemaResult.stdout}`
      );
    }
    assert(schema !== null && typeof schema === "object", "schema command returned a non-object");
    assert(schema.type === "object", "schema command returned an unexpected root schema");
    for (const kind of ["local-packet", "local-result"]) {
      const localSchema = JSON.parse(execCli(["schema", "--kind", kind, "--compact"]).stdout);
      assert(localSchema.type === "object", `${kind} schema command returned an unexpected root`);
    }

    execCli(["init"], { cwd: assessmentDirectory });
    await Promise.all([
      access(join(assessmentDirectory, "augmentworks.yaml"), fsConstants.R_OK),
      access(join(assessmentDirectory, ".env.example"), fsConstants.R_OK),
      access(join(assessmentDirectory, ".env"), fsConstants.R_OK)
    ]);
    const generatedEnvironment = await readFile(join(assessmentDirectory, ".env"), "utf8");
    assert(
      /^CHATBOT_API_KEY=\s*$/m.test(generatedEnvironment),
      "init must leave the target API key empty for the user to supply"
    );
    assert(
      (await readFile(join(assessmentDirectory, ".gitignore"), "utf8"))
        .split(/\r?\n/)
        .includes(".env"),
      "init must add .env to .gitignore"
    );
    if (process.platform !== "win32") {
      const environmentMode = (await stat(join(assessmentDirectory, ".env"))).mode & 0o777;
      assert(environmentMode === 0o600, `init created .env with unsafe mode ${environmentMode.toString(8)}`);
    }

    execCli(["doctor", "-c", "augmentworks.yaml", "--offline"], {
      cwd: assessmentDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:65535",
        CHATBOT_API_KEY: "pack-smoke-placeholder"
      }
    });

    process.stdout.write("[pack smoke] running bundled packet locally through packed CLI\n");
    const targetOrigin = "http://127.0.0.1:18473";
    targetProcess = spawn(
      process.execPath,
      [join(projectRoot, "examples", "refund-agent", "server.mjs")],
      {
        cwd: assessmentDirectory,
        env: {
          ...process.env,
          CHATBOT_BASE_URL: targetOrigin,
          CHATBOT_API_KEY: "pack-smoke-target-key"
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    await waitForTarget(targetOrigin, targetProcess);
    const localOutput = join(assessmentDirectory, "packed-local-report");
    const localRun = execCli(
      [
        "test",
        "--local",
        "-c",
        "augmentworks.yaml",
        "--packet",
        "support-refunds-starter@0.1.0",
        "--output-dir",
        localOutput,
        "--json"
      ],
      {
        cwd: assessmentDirectory,
        env: {
          CHATBOT_BASE_URL: targetOrigin,
          CHATBOT_API_KEY: "pack-smoke-target-key",
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      }
    );
    const localResult = JSON.parse(localRun.stdout);
    assert(localResult.schema_version === "AW-LOCAL-RESULT-1", "local result schema is wrong");
    assert(localResult.outcome === "passed", `packed local assessment was ${localResult.outcome}`);
    assert(localResult.provenance?.cloud_contacted === false, "local result claims cloud contact");
    assert(localResult.provenance?.platform_received === false, "local result claims upload");
    assert(
      !localRun.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into local output"
    );
    await Promise.all(
      ["report.json", "junit.xml", "report.html"].map((name) =>
        access(join(localOutput, name), fsConstants.R_OK)
      )
    );
    await stopTarget(targetProcess);
    targetProcess = undefined;

    process.stdout.write("[pack smoke] running packaged demo from installed tarball\n");
    const demoDirectory = join(consumerDirectory, "demo space", "run");
    await mkdir(demoDirectory, { recursive: true });
    await writeFile(
      join(demoDirectory, "augmentworks.yaml"),
      "version: 1\ntarget:\n  name: must-not-be-used\n  connector: http\n  base_url: ${CHATBOT_BASE_URL}\n  operations:\n    send:\n      method: POST\n      path: /chat\n",
      "utf8"
    );
    const demoOutput = join(demoDirectory, "demo-output");
    const packedCli = join(installedRoot, "dist", "index.js");
    const demoRun = run(
      process.execPath,
      [packedCli, "demo", "--json", "--output-dir", demoOutput],
      {
        cwd: demoDirectory,
        env: {
          CHATBOT_BASE_URL: "https://poisoned.example",
          CHATBOT_API_KEY: "ambient-secret-must-not-be-used",
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      }
    );
    let demoSummary;
    try {
      demoSummary = JSON.parse(demoRun.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `packed demo --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${demoRun.stdout}`
      );
    }
    assert(demoSummary.schema_version === "AW-DEMO-SUMMARY-1", "demo summary schema is wrong");
    assert(demoSummary.kind === "synthetic_local_demo", "demo summary kind is wrong");
    assert(demoSummary.ok === true, "packed demo story did not succeed");
    assert(demoSummary.runs?.faulty?.exit_code === 10, "faulty demo exit was not preserved as 10");
    assert(demoSummary.runs?.corrected?.exit_code === 0, "corrected demo exit was not 0");
    assert(
      !demoRun.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into demo stdout"
    );
    assert(
      !demoRun.stdout.includes("ambient-secret-must-not-be-used"),
      "ambient target credential leaked into demo stdout"
    );
    await Promise.all(
      ["failing/report.json", "passing/report.json", "failing/junit.xml", "passing/report.html"].map((name) =>
        access(join(demoOutput, name), fsConstants.R_OK)
      )
    );
    const demoHelp = execCli(["demo", "--help"]);
    assert(demoHelp.stdout.includes("--json"), "packed CLI is missing demo --json");
    assert(demoHelp.stdout.includes("--mode"), "packed CLI is missing demo --mode");

    process.stdout.write(
      `[pack smoke] passed (${String(report.entryCount)} files, ${String(report.size)} compressed bytes)\n`
    );
  } finally {
    if (targetProcess !== undefined) await stopTarget(targetProcess);
    if (process.env.AUGMENTWORKS_KEEP_SMOKE_TMP === "1") {
      process.stdout.write(`[pack smoke] retained ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function waitForTarget(origin, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const stderr = await streamText(child.stderr);
      throw new SmokeFailure(`refund target exited before startup: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Target startup is bounded by the deadline below.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new SmokeFailure("refund target did not become healthy within 10 seconds");
}

async function stopTarget(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function streamText(stream) {
  if (stream === null) return "";
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pack smoke] ${message}\n`);
  process.exitCode = 1;
});
