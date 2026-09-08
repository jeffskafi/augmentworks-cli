import { CLI_VERSION, CONFIG_VERSION, RELAY_PROTOCOL_VERSION } from "./version.js";

export const NPM_PACKAGE = "@augmentworks/cli";
export const SOURCE_REPOSITORY = "https://github.com/jeffskafi/augmentworks-cli.git";
export const SOURCE_REPOSITORY_HTTPS = "https://github.com/jeffskafi/augmentworks-cli";
export const EXAMPLE_PATH = "examples/refund-agent";

export const SOURCE_PACKAGE_VERSION: string = CLI_VERSION;
/** Identity of this tarball. Distinct from last independently verified registry evidence. */
export const PUBLISHED_PACKAGE_VERSION: string = CLI_VERSION;
/**
 * True only after the matching registry tarball is downloaded and inspected.
 * Candidate metadata in this file must not be treated as that evidence.
 */
export const PUBLISHED_PACKAGE_VERIFIED = false;
/** Last independently verified npm tarball. Do not relabel 0.3.2 or 0.3.3 provenance. */
export const LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION = "0.3.2";
export const LAST_VERIFIED_PUBLISHED_GIT_HEAD = "d36ec8590b005445dba940d2df3abcb53971cea5";
export const LAST_VERIFIED_PUBLISHED_AT = "2026-09-06T14:33:30.670Z";
/** Immutable npm 0.3.3 (not this release). Do not overwrite or relabel. */
export const REGISTRY_0_3_3_GIT_HEAD = "4a08ea0d352f2515e725cb9ca946807112422436";
export const HOSTED_COMMAND_PIN: string = SOURCE_PACKAGE_VERSION;
export const LOCAL_DISTRIBUTION: "npm" | "git" =
  SOURCE_PACKAGE_VERSION === PUBLISHED_PACKAGE_VERSION ? "npm" : "git";

export const HOSTED_PACKET_REFERENCE = "support-refunds@0.1.0";
export const LOCAL_PACKET_REFERENCE = "support-refunds-starter@0.1.0";
export const PROTOCOL_VERSION = RELAY_PROTOCOL_VERSION;
export const TARGET_PROTOCOL_VERSION = "aw-target/0.1";

export type CliReleaseFixture = {
  readonly schema_version: "aw-cli-release/0.1";
  readonly npm_package: typeof NPM_PACKAGE;
  readonly source_package_version: string;
  readonly published_package_version: string;
  readonly published_package_verified: boolean;
  readonly recommended_cli_version: string;
  readonly hosted_command_pin: string;
  readonly local_distribution: "npm" | "git";
  readonly local_source_repository: string;
  readonly local_source_ref: string;
  readonly local_example_path: string;
  readonly hosted_packet: string;
  readonly local_packet: string;
  readonly protocol_version: string;
  readonly target_protocol_version: string;
  readonly config_version: number;
  readonly notes: string;
};

export const CLI_RELEASE: CliReleaseFixture = {
  schema_version: "aw-cli-release/0.1",
  npm_package: NPM_PACKAGE,
  source_package_version: SOURCE_PACKAGE_VERSION,
  published_package_version: PUBLISHED_PACKAGE_VERSION,
  published_package_verified: PUBLISHED_PACKAGE_VERIFIED,
  recommended_cli_version: HOSTED_COMMAND_PIN,
  hosted_command_pin: HOSTED_COMMAND_PIN,
  local_distribution: LOCAL_DISTRIBUTION,
  local_source_repository: SOURCE_REPOSITORY,
  local_source_ref: "main",
  local_example_path: EXAMPLE_PATH,
  hosted_packet: HOSTED_PACKET_REFERENCE,
  local_packet: LOCAL_PACKET_REFERENCE,
  protocol_version: PROTOCOL_VERSION,
  target_protocol_version: TARGET_PROTOCOL_VERSION,
  config_version: CONFIG_VERSION,
  notes:
    "Candidate 0.3.4 is the first-dollar customer-owned assessment package: suite validate/preview and test --suite, own-target starters and bounded probe, explicit session mode, offline mapping preview, quoted billing (--estimate / --max-credits), AUGMENTWORKS_API_KEY mode, and complete hosted report export. Generated and documented npx commands pin this package version (0.3.4), not 0.3.2. npm 0.3.3 remains an immutable registry artifact (gitHead 4a08ea0d352f2515e725cb9ca946807112422436, published 2026-09-07T16:21:14Z) and is not overwritten or relabeled; that tarball lacks suite validate/preview, test --suite, and starter/probe. Last independently verified published tarball remains @augmentworks/cli@0.3.2 (gitHead d36ec8590b005445dba940d2df3abcb53971cea5). Registry verification of 0.3.4 is recorded in docs/feature-readiness/first-dollar-registry-acceptance.json, not by flipping this candidate flag. Vendors aw-billing/1 from main 650472d91442a6866a7b6ef18e6dacc23a2a9260 including subscriptions_v1. The CLI does not subscribe, cancel, or collect payment methods. Live subscription sales stay gated on the server. Catalog list/show and selection compile consume aw-coverage-catalog/1 and aw-suite-selection/1 without a local compiler or pricing engine. Do not run @latest."
};

export function formatNpx(pin: string, argv: readonly string[]): string {
  const invocation = `npx --yes ${NPM_PACKAGE}@${pin}`;
  return argv.length === 0 ? invocation : `${invocation} ${argv.join(" ")}`;
}

export function formatWrappedCommand(prefix: string, command: string, lines: readonly string[]): string {
  if (lines.length === 0) return `${prefix} ${command}`;
  return [
    `${prefix} ${command} \\`,
    ...lines.map((line, index) => `  ${line}${index < lines.length - 1 ? " \\" : ""}`)
  ].join("\n");
}

export function formatSourceCli(argv: readonly string[]): string {
  return argv.length === 0 ? "node dist/index.js" : `node dist/index.js ${argv.join(" ")}`;
}

function formatDocumentedCli(command: string, lines: readonly string[]): string {
  if (LOCAL_DISTRIBUTION === "npm") {
    return formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${PUBLISHED_PACKAGE_VERSION}`, command, lines);
  }
  return formatWrappedCommand("node dist/index.js", command, lines);
}

export const HOSTED_COMMANDS = {
  login: formatNpx(HOSTED_COMMAND_PIN, ["login"]),
  loginDevice: formatNpx(HOSTED_COMMAND_PIN, ["login", "--device"]),
  logout: formatNpx(HOSTED_COMMAND_PIN, ["logout"]),
  whoami: formatNpx(HOSTED_COMMAND_PIN, ["whoami"]),
  initAgent: formatNpx(HOSTED_COMMAND_PIN, ["init", "--agent"]),
  doctor: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN}`, "doctor", [
    "-c augmentworks.yaml"
  ]),
  schemaConfig: formatNpx(HOSTED_COMMAND_PIN, ["schema", "--kind", "config"]),
  recover: formatNpx(HOSTED_COMMAND_PIN, ["recover"]),
  test: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN}`, "test", [
    "-c augmentworks.yaml",
    "--assessment ./augmentworks.assessment.yaml",
    "--profile quick",
    "--open"
  ])
} as const;

export const LOCAL_COMMANDS = {
  doctor: formatDocumentedCli("doctor", ["-c augmentworks.yaml"]),
  schemaPacket:
    LOCAL_DISTRIBUTION === "npm"
      ? formatNpx(PUBLISHED_PACKAGE_VERSION, ["schema", "--kind", "local-packet"])
      : formatSourceCli(["schema", "--kind", "local-packet"]),
  schemaResult:
    LOCAL_DISTRIBUTION === "npm"
      ? formatNpx(PUBLISHED_PACKAGE_VERSION, ["schema", "--kind", "local-result"])
      : formatSourceCli(["schema", "--kind", "local-result"]),
  test: formatDocumentedCli("test", [
    "--local",
    "-c augmentworks.yaml",
    `--packet ${LOCAL_PACKET_REFERENCE}`,
    "--open"
  ]),
  demo: formatDocumentedCli("demo", [])
} as const;

export const SOURCE_DEMO_COMMAND = formatSourceCli(["demo"]);
export const SOURCE_PREVIEW_MAPPING_COMMAND = formatSourceCli([
  "preview-mapping",
  "-c",
  "augmentworks.yaml",
  "--operation",
  "send",
  "--fixture",
  "./fixtures/send-response.json"
]);
export const SOURCE_PREVIEW_MAPPING_JSON_COMMAND = formatSourceCli([
  "preview-mapping",
  "-c",
  "augmentworks.yaml",
  "--operation",
  "send",
  "--fixture",
  "./fixtures/send-response.json",
  "--json"
]);
export const SOURCE_DEMO_JSON_COMMAND = formatSourceCli(["demo", "--json"]);
export const SOURCE_USAGE_COMMAND = formatSourceCli(["usage"]);
export const SOURCE_USAGE_JSON_COMMAND = formatSourceCli(["usage", "--json"]);
export const SOURCE_BILLING_COMMAND = formatSourceCli(["billing"]);
export const SOURCE_BILLING_JSON_COMMAND = formatSourceCli(["billing", "--json"]);
export const SOURCE_BILLING_PRINT_COMMAND = formatSourceCli(["billing", "--print"]);
export const SOURCE_INIT_COMMAND = formatSourceCli(["init"]);
export const SOURCE_INIT_WORKFLOW_COMMAND = formatSourceCli(["init", "--starter", "workflow"]);
export const SOURCE_PROBE_COMMAND = formatSourceCli(["probe", "-c", "augmentworks.yaml"]);
export const SOURCE_PROBE_JSON_COMMAND = formatSourceCli(["probe", "-c", "augmentworks.yaml", "--json"]);
export const SOURCE_PROBE_YES_COMMAND = formatSourceCli(["probe", "-c", "augmentworks.yaml", "--yes"]);
export const SOURCE_ESTIMATE_COMMAND = formatSourceCli([
  "test",
  "--assessment",
  "./augmentworks.assessment.yaml",
  "--estimate"
]);
export const SOURCE_ESTIMATE_JSON_COMMAND = formatSourceCli([
  "test",
  "--assessment",
  "./augmentworks.assessment.yaml",
  "--estimate",
  "--json"
]);
export const SOURCE_MAX_CREDITS_COMMAND = formatSourceCli([
  "test",
  "--assessment",
  "./augmentworks.assessment.yaml",
  "--profile",
  "quick",
  "--max-credits",
  "30",
  "--yes"
]);
export const SOURCE_RUN_STATUS_COMMAND = formatSourceCli(["run", "status", "<run-id>"]);
export const SOURCE_RUN_WAIT_COMMAND = formatSourceCli(["run", "wait", "<run-id>"]);
export const SOURCE_RUN_REPORT_COMMAND = formatSourceCli(["run", "report", "<run-id>", "--json"]);
export const SOURCE_COMPARE_COMMAND = formatSourceCli([
  "compare",
  "--run",
  "<run-id>",
  "--baseline",
  "<baseline-id>",
  "--json"
]);
export const SOURCE_GATE_COMMAND = formatSourceCli([
  "gate",
  "--run",
  "<run-id>",
  "--baseline",
  "<baseline-id>",
  "--json"
]);
export const SOURCE_GATE_WAIT_COMMAND = formatSourceCli([
  "gate",
  "--run",
  "<run-id>",
  "--baseline",
  "<baseline-id>",
  "--wait",
  "--timeout-ms",
  "60000",
  "--json"
]);
export const SOURCE_BASELINE_STATUS_COMMAND = formatSourceCli(["baseline", "status", "--json"]);
export const SOURCE_BASELINE_PROMOTE_COMMAND = formatSourceCli([
  "baseline",
  "promote",
  "--run",
  "<run-id>",
  "--baseline",
  "<baseline-id>",
  "--expected-revision",
  "<n>",
  "--json"
]);
export const SOURCE_SUITE_VALIDATE_COMMAND = formatSourceCli([
  "suite",
  "validate",
  "examples/customer-suites/faq-non-commerce.yaml"
]);
export const SOURCE_SUITE_PREVIEW_COMMAND = formatSourceCli([
  "suite",
  "preview",
  "examples/customer-suites/returns-14-day.yaml"
]);
export const SOURCE_SUITE_TEST_COMMAND = formatWrappedCommand("node dist/index.js", "test", [
  "--suite examples/customer-suites/faq-non-commerce.yaml",
  "--max-credits 30",
  "--yes"
]);
export const SOURCE_SUITE_ESTIMATE_COMMAND = formatSourceCli([
  "test",
  "--suite",
  "examples/customer-suites/faq-non-commerce.yaml",
  "--estimate"
]);
export const SOURCE_INVESTIGATION_INSPECT_COMMAND = formatSourceCli([
  "investigation",
  "inspect",
  "examples/investigations/response-only.json"
]);
export const SOURCE_INVESTIGATION_INSPECT_JSON_COMMAND = formatSourceCli([
  "investigation",
  "inspect",
  "examples/investigations/stateful.json",
  "--json"
]);
export const SOURCE_INVESTIGATION_FETCH_COMMAND = formatSourceCli([
  "investigation",
  "fetch",
  "--run",
  "<run-id>",
  "--evaluation",
  "<evaluation-id>",
  "--attempt",
  "<attempt-id>",
  "--criterion",
  "<criterion-id>",
  "--json"
]);
export const SOURCE_INVESTIGATION_EXPORT_COMMAND = formatSourceCli([
  "investigation",
  "export-regression",
  "examples/investigations/response-only.json",
  "--out",
  "regression.yaml"
]);
export const SOURCE_INVESTIGATION_TEST_COMMAND = formatWrappedCommand("node dist/index.js", "test", [
  "--investigation examples/investigations/response-only.json",
  "--max-credits 30",
  "--yes"
]);
export const SOURCE_CATALOG_LIST_COMMAND = formatSourceCli(["catalog", "list", "--json"]);
export const SOURCE_CATALOG_SHOW_COMMAND = formatSourceCli([
  "catalog",
  "show",
  "response-quality/0.1.0/R01"
]);
export const SOURCE_SELECTION_COMPILE_COMMAND = formatWrappedCommand("node dist/index.js", "selection compile", [
  "-c augmentworks.yaml",
  "--assessment ./augmentworks.assessment.yaml",
  "--out ./suite-selection.manifest.json"
]);
export const SOURCE_TEST_SHARD_COMMAND = formatWrappedCommand("node dist/index.js", "test", [
  "--manifest ./suite-selection.manifest.json",
  "--shard shard-000",
  "--max-credits 30",
  "--yes"
]);
export const SOURCE_GATE_MANIFEST_COMMAND = formatSourceCli([
  "gate",
  "--manifest-file",
  "./suite-selection.manifest.json",
  "--declared-shards",
  "./suite-selection.declared-shards.json",
  "--json"
]);

export const PUBLISHED_LOCAL_COMMANDS = {
  doctor: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${PUBLISHED_PACKAGE_VERSION}`, "doctor", [
    "-c augmentworks.yaml"
  ]),
  test: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${PUBLISHED_PACKAGE_VERSION}`, "test", [
    "--local",
    "-c augmentworks.yaml",
    `--packet ${LOCAL_PACKET_REFERENCE}`,
    "--open"
  ]),
  demo: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${PUBLISHED_PACKAGE_VERSION}`, "demo", [])
} as const;

export const SOURCE_ASSESSMENT_COMMANDS = {
  doctor: formatWrappedCommand("node dist/index.js", "doctor", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile quick"
  ]),
  testQuick: formatWrappedCommand("node dist/index.js", "test", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile quick",
    "--max-credits 30",
    "--yes"
  ]),
  testFull: formatWrappedCommand("node dist/index.js", "test", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile full",
    "--max-credits 30",
    "--yes"
  ])
} as const;

export const DOCTOR_EXAMPLE_OUTPUT = `OK OFFLINE_CHECK_COMPLETE: No target hooks or cloud operations were invoked.
Doctor passed.`;

export const HOSTED_TEST_KEEP_TERMINAL =
  "Keep this terminal open until the assessment finishes. There is no separate connect command.";

export function initNextSteps(
  configDisplay = "augmentworks.yaml",
  assessmentDisplay = "augmentworks.assessment.yaml"
): string {
  const created = `${configDisplay}, ${assessmentDisplay}, starter references, and the packaged fixture server`;
  const preview = formatSourceCli([
    "preview-mapping",
    "-c",
    configDisplay,
    "--operation",
    "send",
    "--fixture",
    "./fixtures/send-response.json"
  ]);
  const probePlan = formatSourceCli(["probe", "-c", configDisplay]);
  const probeYes = formatSourceCli(["probe", "-c", configDisplay, "--yes"]);
  const prefix =
    LOCAL_DISTRIBUTION === "npm"
      ? `Next: edit .env with isolated synthetic target values, then run doctor. This build created ${created}.`
      : `Next: edit .env with isolated synthetic target values, then run doctor. This source build created ${created}. Published ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN} does not generate those assessment files.`;
  return `${prefix} Then ${preview}, ${probePlan} to read the bounded plan, and ${probeYes} only after that review. Hosted spending consent is --max-credits N; npm --yes is not a ceiling. Doctor and init never probe.`;
}

export const INIT_NEXT_STEPS = initNextSteps();

export const LOGIN_NEXT_STEPS = `Next: run doctor, then keep this terminal open for hosted test --assessment ./augmentworks.assessment.yaml --profile quick --max-credits N --yes. There is no separate connect command. npm --yes is not a spending ceiling.`;

export function allowedDocumentedNpxPins(): readonly string[] {
  const pins = new Set<string>([HOSTED_COMMAND_PIN]);
  if (LOCAL_DISTRIBUTION === "npm") pins.add(PUBLISHED_PACKAGE_VERSION);
  return [...pins];
}
