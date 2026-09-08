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
    "schemas/v1/customer-suite.schema.json",
    "schemas/v1/investigation-export.schema.json",
    "packets/support-refunds-starter/0.1.0/packet.json",
    "schemas/v1/cli-release.json",
    "assets/demo/packet.json",
    "assets/demo/augmentworks.yaml",
    "assets/starters/response-quality/augmentworks.yaml",
    "assets/starters/response-quality/augmentworks.assessment.yaml",
    "assets/starters/response-quality/augmentworks.session.yaml",
    "assets/starters/response-quality/own-chatbot.suite.yaml",
    "assets/starters/response-quality/OWN-TARGET.md",
    "assets/starters/response-quality/.env.example",
    "assets/starters/response-quality/server.mjs",
    "assets/starters/response-quality/session-server.mjs",
    "assets/starters/response-quality/fixtures/send-response.json",
    "assets/starters/response-quality/fixtures/session-send-response.json",
    "assets/starters/response-quality/references/faq.md",
    "assets/starters/response-quality/references/restocking.md",
    "assets/starters/response-quality/references/warranty.md",
    "assets/starters/response-quality/references/old-returns.md",
    "assets/starters/workflow/augmentworks.yaml",
    "assets/starters/workflow/augmentworks.assessment.yaml",
    "assets/starters/workflow/.env.example",
    "assets/starters/workflow/OWN-TARGET.md",
    "assets/starters/workflow/server.mjs",
    "assets/starters/workflow/fixtures/send-response.json",
    "assets/starters/workflow/fixtures/observe-response.json",
    "assets/starters/workflow/fixtures/prepare-response.json",
    "assets/starters/workflow/references/refund-policy.md",
    "assets/customer-suites/faq-non-commerce.yaml",
    "assets/customer-suites/returns-14-day.yaml",
    "assets/customer-suites/references/faq.md",
    "assets/customer-suites/references/returns-14-day.md",
    "contracts/discovery-manifest.json",
    "contracts/discovery-manifest.schema.json",
    "contracts/aw-billing-v1.schema.json",
    "contracts/aw-billing-v1.fixtures.json",
    "contracts/aw-billing-v1.lock.json",
    "contracts/aw-run-report-v1.schema.json",
    "contracts/aw-run-report-v1.fixtures.json",
    "contracts/aw-run-report-v1.lock.json",
    "contracts/aw-suite-v1.lock.json",
    "contracts/aw-release-policy-v1.lock.json",
    "contracts/aw-release-policy-v1.fixtures.json",
    "contracts/aw-investigation-export-v1.lock.json",
    "contracts/aw-investigation-export-v1.fixtures.json",
    "assets/investigations/response-only.json",
    "assets/investigations/stateful.json"
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

    const packedHelp = execCli(["--help"]);
    for (const command of [
      "login",
      "logout",
      "whoami",
      "usage",
      "billing",
      "init",
      "doctor",
      "preview-mapping",
      "probe",
      "demo",
      "catalog",
      "selection",
      "test",
      "suite",
      "run",
      "compare",
      "gate",
      "baseline",
      "investigation",
      "recover",
      "schema"
    ]) {
      assert(
        new RegExp(`^  ${command}(?: \\[options\\])?`, "m").test(packedHelp.stdout),
        `packed CLI --help is missing ${command}`
      );
    }
    const probeHelp = execCli(["probe", "--help"]);
    assert(probeHelp.stdout.includes("bounded synthetic connection probe"), "packed CLI is missing probe description");
    assert(probeHelp.stdout.includes("--yes"), "packed CLI is missing probe --yes");
    assert(probeHelp.stdout.includes("Never runs during doctor or init"), "packed probe help omitted doctor/init boundary");

    const runHelp = execCli(["run", "--help"]);
    assert(runHelp.stdout.includes("report"), "packed CLI is missing run report");
    const reportHelp = execCli(["run", "report", "--help"]);
    assert(reportHelp.stdout.includes("--json"), "packed CLI is missing run report --json");

    const compareHelp = execCli(["compare", "--help"]);
    assert(compareHelp.stdout.includes("--run"), "packed CLI is missing compare --run");
    assert(compareHelp.stdout.includes("--baseline"), "packed CLI is missing compare --baseline");
    assert(compareHelp.stdout.includes("--json"), "packed CLI is missing compare --json");
    const gateHelp = execCli(["gate", "--help"]);
    assert(gateHelp.stdout.includes("--wait"), "packed CLI is missing gate --wait");
    assert(gateHelp.stdout.includes("--timeout-ms"), "packed CLI is missing gate --timeout-ms");
    assert(gateHelp.stdout.includes("--manifest-file"), "packed CLI is missing gate --manifest-file");
    const catalogHelp = execCli(["catalog", "--help"]);
    assert(catalogHelp.stdout.includes("list"), "packed CLI is missing catalog list");
    assert(catalogHelp.stdout.includes("show"), "packed CLI is missing catalog show");
    const selectionHelp = execCli(["selection", "--help"]);
    assert(selectionHelp.stdout.includes("compile"), "packed CLI is missing selection compile");
    const testHelpSelection = execCli(["test", "--help"]);
    assert(testHelpSelection.stdout.includes("--manifest"), "packed CLI is missing test --manifest");
    assert(testHelpSelection.stdout.includes("--all-shards"), "packed CLI is missing test --all-shards");
    const baselineHelp = execCli(["baseline", "--help"]);
    assert(baselineHelp.stdout.includes("status"), "packed CLI is missing baseline status");
    assert(baselineHelp.stdout.includes("promote"), "packed CLI is missing baseline promote");
    const investigationHelp = execCli(["investigation", "--help"]);
    assert(investigationHelp.stdout.includes("inspect"), "packed CLI is missing investigation inspect");
    assert(investigationHelp.stdout.includes("fetch"), "packed CLI is missing investigation fetch");
    assert(investigationHelp.stdout.includes("export-regression"), "packed CLI is missing investigation export-regression");
    const testHelpInvestigation = execCli(["test", "--help"]);
    assert(testHelpInvestigation.stdout.includes("--investigation"), "packed CLI is missing test --investigation");
    assert(testHelpInvestigation.stdout.includes("--headless"), "packed CLI is missing test --headless");

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
    for (const kind of ["local-packet", "local-result", "customer-suite", "investigation-export"]) {
      const localSchema = JSON.parse(execCli(["schema", "--kind", kind, "--compact"]).stdout);
      assert(localSchema.type === "object", `${kind} schema command returned an unexpected root`);
    }

    execCli(["init", "--starter", "workflow"], { cwd: assessmentDirectory });
    await Promise.all([
      access(join(assessmentDirectory, "augmentworks.yaml"), fsConstants.R_OK),
      access(join(assessmentDirectory, "augmentworks.assessment.yaml"), fsConstants.R_OK),
      access(join(assessmentDirectory, "references", "refund-policy.md"), fsConstants.R_OK),
      access(join(assessmentDirectory, ".env.example"), fsConstants.R_OK),
      access(join(assessmentDirectory, ".env"), fsConstants.R_OK),
      access(join(assessmentDirectory, "server.mjs"), fsConstants.R_OK),
      access(join(assessmentDirectory, "OWN-TARGET.md"), fsConstants.R_OK),
      access(join(assessmentDirectory, "fixtures", "send-response.json"), fsConstants.R_OK)
    ]);
    assert(
      (await readFile(join(assessmentDirectory, "augmentworks.assessment.yaml"), "utf8")).includes(
        "support-refunds"
      ),
      "workflow starter must generate the support-refunds assessment"
    );
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

    const doctorOffline = execCli(["doctor", "-c", "augmentworks.yaml", "--offline"], {
      cwd: assessmentDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:65535",
        CHATBOT_API_KEY: "pack-smoke-placeholder"
      }
    });
    assert(
      doctorOffline.stdout.includes("CONNECTION_PROBE_AVAILABLE"),
      "packed doctor must advertise probe without calling the target"
    );
    assert(
      doctorOffline.stdout.includes("OFFLINE_CHECK_COMPLETE"),
      "packed doctor skipped the offline marker"
    );

    process.stdout.write("[pack smoke] checking probe preflight does not call the target\n");
    const probePlan = execCli(["probe", "-c", "augmentworks.yaml", "--json"], {
      cwd: assessmentDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:1",
        CHATBOT_API_KEY: "pack-smoke-probe-secret",
        AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
      }
    });
    let probePlanReport;
    try {
      probePlanReport = JSON.parse(probePlan.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `packed probe --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${probePlan.stdout}`
      );
    }
    assert(probePlanReport.schema_version === "AW-CONNECTION-PROBE-1", "probe schema is wrong");
    assert(probePlanReport.executed === false, "probe without --yes executed target calls");
    assert(probePlanReport.ok === true, "probe preflight should succeed");
    assert(probePlanReport.credits_consumed === 0, "probe preflight consumed credits");
    assert(probePlanReport.hosted_contacted === false, "probe preflight contacted hosted API");
    assert(probePlanReport.pattern === "stateful", "workflow probe pattern was not stateful");
    assert(probePlanReport.preflight?.call_count === 4, "stateful probe plan should be 4 calls");
    assert(
      !probePlan.stdout.includes("pack-smoke-probe-secret"),
      "target credential leaked into probe preflight stdout"
    );
    assert(
      !probePlan.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into probe preflight stdout"
    );

    process.stdout.write("[pack smoke] checking init --config custom filename\n");
    const customDirectory = join(consumerDirectory, "custom-config");
    await mkdir(customDirectory, { recursive: true });
    await writeFile(join(customDirectory, "augmentworks.yaml"), "# sibling-default-must-remain\n", "utf8");
    const customInit = execCli(["init", "-c", "custom.yaml", "--no-env"], { cwd: customDirectory });
    assert(
      customInit.stdout.includes("custom.yaml"),
      "init --config must mention the requested filename"
    );
    assert(
      !customInit.stdout.includes("created augmentworks.yaml, augmentworks.assessment.yaml"),
      "init --config must not claim it created the default connector filename"
    );
    await Promise.all([
      access(join(customDirectory, "custom.yaml"), fsConstants.R_OK),
      access(join(customDirectory, "augmentworks.assessment.yaml"), fsConstants.R_OK),
      access(join(customDirectory, "references", "faq.md"), fsConstants.R_OK),
      access(join(customDirectory, ".env.example"), fsConstants.R_OK)
    ]);
    assert(
      (await readFile(join(customDirectory, "augmentworks.yaml"), "utf8")) ===
        "# sibling-default-must-remain\n",
      "init --config must not replace a sibling default connector"
    );
    assert(!existsSync(join(customDirectory, ".env")), "init --no-env must not create .env");
    execCli(["doctor", "-c", "custom.yaml", "--offline"], {
      cwd: customDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:65535",
        CHATBOT_API_KEY: "pack-smoke-placeholder"
      }
    });

    process.stdout.write("[pack smoke] checking offline preview-mapping from packed CLI\n");
    const previewHelp = execCli(["preview-mapping", "--help"]);
    assert(previewHelp.stdout.includes("--fixture"), "packed CLI is missing preview-mapping --fixture");
    assert(previewHelp.stdout.includes("--operation"), "packed CLI is missing preview-mapping --operation");
    assert(previewHelp.stdout.includes("--json"), "packed CLI is missing preview-mapping --json");
    await writeFile(
      join(assessmentDirectory, "send-fixture.json"),
      `${JSON.stringify({ answer: "Packed preview says hello.", finished: true, events: [] })}\n`,
      "utf8"
    );
    const previewRun = execCli(
      [
        "preview-mapping",
        "-c",
        "augmentworks.yaml",
        "--operation",
        "send",
        "--fixture",
        "send-fixture.json",
        "--json"
      ],
      {
        cwd: assessmentDirectory,
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used",
          CHATBOT_API_KEY: "ambient-secret-must-not-be-used"
        }
      }
    );
    let previewReport;
    try {
      previewReport = JSON.parse(previewRun.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `packed preview-mapping --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${previewRun.stdout}`
      );
    }
    assert(previewReport.schema_version === "AW-MAPPING-PREVIEW-1", "preview schema is wrong");
    assert(previewReport.ok === true, "packed preview-mapping did not succeed");
    assert(previewReport.offline === true, "packed preview-mapping was not marked offline");
    assert(previewReport.credits_consumed === 0, "packed preview-mapping consumed credits");
    assert(typeof previewReport.evidence?.canonical === "string", "packed preview omitted canonical evidence");
    assert(
      !previewRun.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into preview stdout"
    );
    assert(
      !previewRun.stdout.includes("ambient-secret-must-not-be-used"),
      "ambient target credential leaked into preview stdout"
    );

    process.stdout.write("[pack smoke] checking offline customer suite validate/preview from packed CLI\n");
    const suiteHelp = execCli(["suite", "--help"]);
    assert(suiteHelp.stdout.includes("validate"), "packed CLI is missing suite validate");
    assert(suiteHelp.stdout.includes("preview"), "packed CLI is missing suite preview");
    const testHelp = execCli(["test", "--help"]);
    assert(testHelp.stdout.includes("--suite"), "packed CLI is missing test --suite");
    const packedSuites = join(installedRoot, "assets", "customer-suites");
    for (const sample of ["faq-non-commerce.yaml", "returns-14-day.yaml"]) {
      const suitePath = join(packedSuites, sample);
      const validateRun = execCli(["suite", "validate", suitePath, "--json"], {
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      });
      let validateReport;
      try {
        validateReport = JSON.parse(validateRun.stdout);
      } catch (error) {
        throw new SmokeFailure(
          `packed suite validate --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${validateRun.stdout}`
        );
      }
      assert(validateReport.ok === true, `packed suite validate failed for ${sample}`);
      assert(validateReport.localPreview?.authoritativePrice === false, "suite validate claimed an authoritative price");
      assert(validateReport.localPreview?.executesTarget === false, "suite validate claimed target execution");
      assert(validateReport.localPreview?.callsLlm === false, "suite validate claimed an LLM call");
      const previewSuite = execCli(["suite", "preview", suitePath], {
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      });
      assert(previewSuite.stdout.includes("not a price"), `packed suite preview omitted the price disclaimer for ${sample}`);
      assert(previewSuite.stdout.includes("executes_target: no"), `packed suite preview omitted executes_target for ${sample}`);
      assert(
        !validateRun.stdout.includes("poison-hosted-token-must-not-be-used"),
        "hosted credential leaked into suite validate stdout"
      );
    }

    process.stdout.write("[pack smoke] checking offline investigation inspect from packed CLI\n");
    const packedInvestigations = join(installedRoot, "assets", "investigations");
    for (const sample of ["response-only.json", "stateful.json"]) {
      const investigationPath = join(packedInvestigations, sample);
      const inspectRun = execCli(["investigation", "inspect", investigationPath, "--json"], {
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      });
      let inspectReport;
      try {
        inspectReport = JSON.parse(inspectRun.stdout);
      } catch (error) {
        throw new SmokeFailure(
          `packed investigation inspect --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${inspectRun.stdout}`
        );
      }
      assert(inspectReport.ok === true, `packed investigation inspect failed for ${sample}`);
      assert(inspectReport.admissionCalls === 0, "investigation inspect must not admit a run");
      assert(inspectReport.executesTarget === false, "investigation inspect claimed target execution");
      assert(inspectReport.executesShell === false, "investigation inspect claimed shell execution");
      assert(inspectReport.callsEvaluator === false, "investigation inspect claimed an evaluator");
      assert(inspectReport.copiedCommandsAreData === true, "investigation inspect must treat command fragments as data");
      assert(
        !inspectRun.stdout.includes("poison-hosted-token-must-not-be-used"),
        "hosted credential leaked into investigation inspect stdout"
      );
    }

    process.stdout.write("[pack smoke] running generated workflow fixture through packed CLI\n");
    const targetOrigin = "http://127.0.0.1:18473";
    targetProcess = spawn(
      process.execPath,
      [join(assessmentDirectory, "server.mjs")],
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
    const probeYes = execCli(["probe", "-c", "augmentworks.yaml", "--yes", "--json"], {
      cwd: assessmentDirectory,
      env: {
        CHATBOT_BASE_URL: targetOrigin,
        CHATBOT_API_KEY: "pack-smoke-target-key",
        AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
        AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
      }
    });
    let probeYesReport;
    try {
      probeYesReport = JSON.parse(probeYes.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `packed probe --yes --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${probeYes.stdout}`
      );
    }
    assert(probeYesReport.ok === true, "packed workflow probe --yes failed");
    assert(probeYesReport.executed === true, "packed probe --yes did not execute");
    assert(probeYesReport.credits_consumed === 0, "packed probe consumed credits");
    assert(Array.isArray(probeYesReport.calls) && probeYesReport.calls.length === 4, "workflow probe did not make 4 calls");
    assert(
      (probeYesReport.calls ?? []).map((call) => call.phase).join(",") === "prepare,send,observe,cleanup",
      "workflow probe phases were not prepare/send/observe/cleanup"
    );
    assert(
      !probeYes.stdout.includes("pack-smoke-target-key"),
      "target credential leaked into probe --yes stdout"
    );
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

    process.stdout.write("[pack smoke] checking packed response-only starter, suite, and probe\n");
    const responseDirectory = join(consumerDirectory, "response-only");
    await mkdir(responseDirectory, { recursive: true });
    execCli(["init", "--starter", "response-only"], { cwd: responseDirectory });
    const responseYaml = await readFile(join(responseDirectory, "augmentworks.yaml"), "utf8");
    assert(!/^ {4}prepare:/m.test(responseYaml), "response-only starter must not generate unused prepare hooks");
    assert(!/^ {4}observe:/m.test(responseYaml), "response-only starter must not generate unused observe hooks");
    assert(!/^ {4}cleanup:/m.test(responseYaml), "response-only starter must not generate unused cleanup hooks");
    await Promise.all([
      access(join(responseDirectory, "server.mjs"), fsConstants.R_OK),
      access(join(responseDirectory, "session-server.mjs"), fsConstants.R_OK),
      access(join(responseDirectory, "own-chatbot.suite.yaml"), fsConstants.R_OK),
      access(join(responseDirectory, "OWN-TARGET.md"), fsConstants.R_OK),
      access(join(responseDirectory, "fixtures", "send-response.json"), fsConstants.R_OK)
    ]);
    const responseDoctor = execCli(["doctor", "-c", "augmentworks.yaml", "--offline"], {
      cwd: responseDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:65535",
        CHATBOT_API_KEY: "pack-smoke-response-key"
      }
    });
    assert(
      responseDoctor.stdout.includes("CONNECTION_PROBE_AVAILABLE"),
      "response-only doctor must advertise probe without calling the target"
    );
    const suiteValidate = execCli(["suite", "validate", "own-chatbot.suite.yaml", "--json"], {
      cwd: responseDirectory,
      env: {
        AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
        AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
      }
    });
    const suiteReport = JSON.parse(suiteValidate.stdout);
    assert(suiteReport.ok === true, "packed own-chatbot suite validate failed");
    assert(suiteReport.caseCount === 5, "own-chatbot suite must have five cases");
    const responsePreview = execCli(
      [
        "preview-mapping",
        "-c",
        "augmentworks.yaml",
        "--operation",
        "send",
        "--fixture",
        "fixtures/send-response.json",
        "--json"
      ],
      { cwd: responseDirectory }
    );
    const responsePreviewReport = JSON.parse(responsePreview.stdout);
    assert(responsePreviewReport.ok === true, "packed response-only preview-mapping failed");
    const responseOrigin = "http://127.0.0.1:18474";
    targetProcess = spawn(process.execPath, [join(responseDirectory, "server.mjs")], {
      cwd: responseDirectory,
      env: {
        ...process.env,
        CHATBOT_BASE_URL: responseOrigin,
        CHATBOT_API_KEY: "pack-smoke-response-key"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    await waitForTarget(responseOrigin, targetProcess);
    const responseProbe = execCli(["probe", "-c", "augmentworks.yaml", "--yes", "--json"], {
      cwd: responseDirectory,
      env: {
        CHATBOT_BASE_URL: responseOrigin,
        CHATBOT_API_KEY: "pack-smoke-response-key"
      }
    });
    const responseProbeReport = JSON.parse(responseProbe.stdout);
    assert(responseProbeReport.ok === true, "packed response-only probe --yes failed");
    assert(responseProbeReport.pattern === "response-only", "response-only probe pattern was wrong");
    assert(responseProbeReport.calls?.length === 1, "response-only probe should make one send call");
    assert(
      !responseProbe.stdout.includes("pack-smoke-response-key"),
      "target credential leaked into response-only probe stdout"
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

    process.stdout.write("[pack smoke] packed billing HTTP fixture through installed binary\n");
    const fixture = spawnSync(process.execPath, [join(projectRoot, "scripts", "packed-billing-fixture.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AUGMENTWORKS_PACKED_BIN: packedCli,
        NO_COLOR: "1"
      },
      encoding: "utf8",
      timeout: 240_000,
      windowsHide: true
    });
    if (fixture.error !== undefined) {
      throw new SmokeFailure(`packed billing fixture failed to start: ${fixture.error.message}`);
    }
    if (fixture.status !== 0) {
      throw new SmokeFailure(
        [
          "packed billing HTTP fixture failed",
          fixture.stdout.trim(),
          fixture.stderr.trim()
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    process.stdout.write(fixture.stdout);

    process.stdout.write("[pack smoke] packed report HTTP fixture through installed binary\n");
    const reportFixture = spawnSync(process.execPath, [join(projectRoot, "scripts", "packed-report-fixture.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AUGMENTWORKS_PACKED_BIN: packedCli,
        NO_COLOR: "1"
      },
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true
    });
    if (reportFixture.error !== undefined) {
      throw new SmokeFailure(`packed report fixture failed to start: ${reportFixture.error.message}`);
    }
    if (reportFixture.status !== 0) {
      throw new SmokeFailure(
        [
          "packed report HTTP fixture failed",
          reportFixture.stdout.trim(),
          reportFixture.stderr.trim()
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    process.stdout.write(reportFixture.stdout);

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
      throw new SmokeFailure(`fixture server exited before startup: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Target startup is bounded by the deadline below.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new SmokeFailure("fixture server did not become healthy within 10 seconds");
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
