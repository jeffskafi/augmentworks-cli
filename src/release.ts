import { CLI_VERSION, CONFIG_VERSION, RELAY_PROTOCOL_VERSION } from "./version.js";

export const NPM_PACKAGE = "@augmentworks/cli";
export const SOURCE_REPOSITORY = "https://github.com/jeffskafi/augmentworks-cli.git";
export const SOURCE_REPOSITORY_HTTPS = "https://github.com/jeffskafi/augmentworks-cli";
export const EXAMPLE_PATH = "examples/refund-agent";

export const SOURCE_PACKAGE_VERSION: string = CLI_VERSION;
export const PUBLISHED_PACKAGE_VERSION: string = "0.3.0";
export const PUBLISHED_PACKAGE_VERIFIED = true;
export const HOSTED_COMMAND_PIN: string = PUBLISHED_PACKAGE_VERSION;
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
    "Published @augmentworks/cli@0.3.0 includes hosted --assessment / --profile, aw-relay/0.2, recover, and test --local. Hosted npx commands pin this verified package. Clone this repository for example servers; the npm tarball omits examples/."
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
  ])
} as const;

export const SOURCE_ASSESSMENT_COMMANDS = {
  doctor: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN}`, "doctor", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile quick"
  ]),
  testQuick: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN}`, "test", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile quick",
    "--open"
  ]),
  testFull: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN}`, "test", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile full",
    "--open"
  ])
} as const;

export const DOCTOR_EXAMPLE_OUTPUT = `OK OFFLINE_CHECK_COMPLETE: No target hooks or cloud operations were invoked.
Doctor passed.`;

export const HOSTED_TEST_KEEP_TERMINAL =
  "Keep this terminal open until the assessment finishes. There is no separate connect command.";

export const INIT_NEXT_STEPS =
  LOCAL_DISTRIBUTION === "npm"
    ? `Next: edit .env with isolated synthetic target values, then run doctor. Hosted test uses ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN} ${HOSTED_PACKET_REFERENCE} and keeps this terminal open.`
    : `Next: edit .env with isolated synthetic target values, then run doctor. Hosted test uses ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN} ${HOSTED_PACKET_REFERENCE} and keeps this terminal open. Local --local requires source ${SOURCE_PACKAGE_VERSION} until that version is published.`;

export const LOGIN_NEXT_STEPS = `Next: run doctor, then keep this terminal open for hosted test --assessment ./augmentworks.assessment.yaml --profile quick --open. There is no separate connect command.`;

export function allowedDocumentedNpxPins(): readonly string[] {
  const pins = new Set<string>([HOSTED_COMMAND_PIN]);
  if (LOCAL_DISTRIBUTION === "npm") pins.add(PUBLISHED_PACKAGE_VERSION);
  return [...pins];
}
