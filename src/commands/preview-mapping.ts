import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";

import type { AugmentWorksConfig, Diagnostic, JsonValue } from "../config/types.js";
import { validateConfigObject } from "../config/validate.js";
import { parseYamlStrict, StrictYamlError } from "../config/yaml.js";
import {
  HUMAN_EVIDENCE_LISTING_LIMIT_BYTES,
  isOperationKind,
  MAPPING_PREVIEW_SCHEMA_VERSION,
  PREVIEW_DISCLAIMER,
  previewMappedEvidence,
  truncateUtf8,
  type MappingPreviewResult
} from "../connector/mapping-preview.js";
import { AwError, EXIT, sanitizeTerminal, type OperationKind } from "../errors.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import { LIMITS } from "../util/limits.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface PreviewMappingOptions {
  readonly config?: string;
  readonly fixture: string;
  readonly operation?: string;
  readonly cwd?: string;
}

export interface PreviewMappingDocument extends MappingPreviewResult {
  readonly config_path: string;
  readonly fixture_path: string;
  readonly fixture_bytes: number | null;
}

export interface PreviewMappingCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
  readonly setExitCode?: (code: number) => void;
}

class BoundedFileError extends Error {
  readonly diagnosticCode:
    | "CONFIG_FILE_TOO_LARGE"
    | "CONFIG_FILE_UNREADABLE"
    | "FIXTURE_FILE_TOO_LARGE"
    | "FIXTURE_FILE_UNREADABLE";

  constructor(
    diagnosticCode:
      | "CONFIG_FILE_TOO_LARGE"
      | "CONFIG_FILE_UNREADABLE"
      | "FIXTURE_FILE_TOO_LARGE"
      | "FIXTURE_FILE_UNREADABLE",
    message: string
  ) {
    super(message);
    this.name = "BoundedFileError";
    this.diagnosticCode = diagnosticCode;
  }
}

export async function runPreviewMapping(
  options: PreviewMappingOptions
): Promise<PreviewMappingDocument> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.config ?? "augmentworks.yaml");
  const fixturePath = resolve(cwd, options.fixture);
  const operationName = options.operation ?? "send";
  const diagnostics: Diagnostic[] = [];

  if (!isOperationKind(operationName)) {
    return documentFromDiagnostics("send", configPath, fixturePath, null, [
      {
        level: "error",
        code: "OPERATION_KIND_INVALID",
        message: "Operation must be prepare, send, observe, or cleanup."
      }
    ]);
  }

  let config: AugmentWorksConfig | undefined;
  try {
    const source = await readBoundedRegularFile(configPath, MAX_CONFIG_BYTES, "config");
    diagnostics.push({
      level: "ok",
      code: "CONFIG_FILE_LOADED",
      message: `Loaded ${configPath}.`,
      path: configPath
    });
    let rawConfig: unknown;
    try {
      rawConfig = parseYamlStrict(source);
    } catch (error) {
      if (error instanceof StrictYamlError) {
        diagnostics.push({
          level: "error",
          code: error.code,
          message: error.message,
          ...(error.path === undefined ? { path: configPath } : { path: error.path })
        });
      } else {
        diagnostics.push({
          level: "error",
          code: "YAML_PARSE_ERROR",
          message: "The configuration file is not valid YAML.",
          path: configPath
        });
      }
      return documentFromDiagnostics(operationName, configPath, fixturePath, null, diagnostics);
    }
    const validation = validateConfigObject(rawConfig);
    diagnostics.push(...validation.diagnostics);
    config = validation.config;
  } catch (error) {
    diagnostics.push(fileDiagnostic(error, configPath, "config"));
    return documentFromDiagnostics(operationName, configPath, fixturePath, null, diagnostics);
  }

  if (config === undefined || diagnostics.some((item) => item.level === "error")) {
    return documentFromDiagnostics(operationName, configPath, fixturePath, null, diagnostics);
  }

  diagnostics.push({
    level: "ok",
    code: "PREVIEW_ENV_NOT_LOADED",
    message: "Preview did not load .env, process secrets, or contact a network endpoint."
  });

  let fixtureBytes: number | null = null;
  let response: JsonValue;
  try {
    const source = await readBoundedRegularFile(fixturePath, LIMITS.targetResponseBytes, "fixture");
    fixtureBytes = Buffer.byteLength(source, "utf8");
    diagnostics.push({
      level: "ok",
      code: "FIXTURE_LOADED",
      message: `Read ${fixtureBytes} bytes from the fixture file.`,
      path: fixturePath
    });
    response = parseFixtureJson(source, fixturePath);
  } catch (error) {
    diagnostics.push(fileDiagnostic(error, fixturePath, "fixture"));
    return documentFromDiagnostics(operationName, configPath, fixturePath, fixtureBytes, diagnostics);
  }

  const preview = previewMappedEvidence({
    kind: operationName,
    config,
    response
  });
  return {
    ...preview,
    config_path: configPath,
    fixture_path: fixturePath,
    fixture_bytes: fixtureBytes,
    diagnostics: [...diagnostics, ...preview.diagnostics]
  };
}

function parseFixtureJson(source: string, path: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const position = jsonPosition(error);
    throw new AwError({
      code: "FIXTURE_JSON_INVALID",
      category: "config",
      message:
        position === undefined
          ? "The fixture is not valid JSON."
          : `The fixture is not valid JSON (at position ${position}).`,
      details: {
        path,
        ...(position === undefined ? {} : { position })
      }
    });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new AwError({
      code: "FIXTURE_TYPE_INVALID",
      category: "config",
      message: "The fixture must be a JSON object or array.",
      details: { path }
    });
  }
  return parsed as JsonValue;
}

function jsonPosition(error: unknown): number | undefined {
  if (!(error instanceof SyntaxError)) return undefined;
  const match = /position\s+(\d+)/u.exec(error.message);
  if (match?.[1] === undefined) return undefined;
  const position = Number(match[1]);
  return Number.isSafeInteger(position) ? position : undefined;
}

function documentFromDiagnostics(
  operation: OperationKind,
  configPath: string,
  fixturePath: string,
  fixtureBytes: number | null,
  diagnostics: readonly Diagnostic[]
): PreviewMappingDocument {
  return {
    schema_version: MAPPING_PREVIEW_SCHEMA_VERSION,
    ok: false,
    offline: true,
    operation,
    config_path: configPath,
    fixture_path: fixturePath,
    fixture_bytes: fixtureBytes,
    fields: [],
    redactions: [],
    truncations: [],
    evidence: null,
    evidence_canonical: null,
    evidence_sha256: null,
    evidence_bytes: null,
    diagnostics: [
      ...diagnostics,
      {
        level: "ok",
        code: "PREVIEW_DISCLAIMER",
        message: PREVIEW_DISCLAIMER
      }
    ],
    disclaimer: PREVIEW_DISCLAIMER
  };
}

function fileDiagnostic(error: unknown, path: string, kind: "config" | "fixture"): Diagnostic {
  if (error instanceof AwError) {
    return {
      level: "error",
      code: error.code,
      message: error.message,
      path
    };
  }
  const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
  const bounded = error instanceof BoundedFileError ? error : undefined;
  if (kind === "config") {
    return {
      level: "error",
      code: missing ? "CONFIG_FILE_NOT_FOUND" : (bounded?.diagnosticCode ?? "CONFIG_FILE_UNREADABLE"),
      message: missing
        ? `Configuration file not found: ${path}`
        : (bounded?.message ?? `Could not read configuration file: ${path}`),
      path
    };
  }
  return {
    level: "error",
    code: missing ? "FIXTURE_FILE_NOT_FOUND" : (bounded?.diagnosticCode ?? "FIXTURE_FILE_UNREADABLE"),
    message: missing
      ? `Fixture file not found: ${path}`
      : (bounded?.message ?? `Could not read fixture file: ${path}`),
    path
  };
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  kind: "config" | "fixture"
): Promise<string> {
  const tooLarge = kind === "config" ? "CONFIG_FILE_TOO_LARGE" : "FIXTURE_FILE_TOO_LARGE";
  const unreadable = kind === "config" ? "CONFIG_FILE_UNREADABLE" : "FIXTURE_FILE_UNREADABLE";
  const label = kind === "config" ? "configuration" : "fixture";
  if ((await findUnsafeSymbolicLinkComponent(path)) !== undefined) {
    throw new BoundedFileError(unreadable, `The ${label} path cannot contain symbolic links.`);
  }
  const beforeOpen = await lstat(path);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new BoundedFileError(
      unreadable,
      `The ${label} path must be a regular file and cannot be a symbolic link.`
    );
  }
  if (beforeOpen.size > maxBytes) {
    throw new BoundedFileError(tooLarge, `${capitalize(label)} files cannot exceed ${maxBytes} bytes.`);
  }
  const noFollow =
    process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0;
  const nonBlocking =
    process.platform !== "win32" && typeof fsConstants.O_NONBLOCK === "number"
      ? fsConstants.O_NONBLOCK
      : 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlocking);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== beforeOpen.dev || metadata.ino !== beforeOpen.ino) {
      throw new BoundedFileError(unreadable, `The ${label} file changed while it was being opened.`);
    }
    if (metadata.size > maxBytes) {
      throw new BoundedFileError(tooLarge, `${capitalize(label)} files cannot exceed ${maxBytes} bytes.`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remainingWithSentinel = maxBytes - total + 1;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remainingWithSentinel));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new BoundedFileError(tooLarge, `${capitalize(label)} files cannot exceed ${maxBytes} bytes.`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new BoundedFileError(unreadable, `The ${label} file is not valid UTF-8 text.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new BoundedFileError(unreadable, `The ${label} path cannot be a symbolic link.`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function formatPreviewMappingHuman(report: PreviewMappingDocument): string {
  const marker = { ok: "OK", warning: "WARN", error: "ERROR" } as const;
  const lines = [
    "Mapping preview (offline)",
    "",
    `Operation: ${report.operation}`,
    `Config: ${report.config_path}`,
    `Fixture: ${report.fixture_path}${report.fixture_bytes === null ? "" : ` (${report.fixture_bytes} bytes)`}`,
    "",
    "Fields:"
  ];
  if (report.fields.length === 0) {
    lines.push("  (no response mapping fields)");
  } else {
    for (const field of report.fields) {
      const extra =
        field.status === "omitted" && field.omitted_reason !== undefined
          ? ` (${field.omitted_reason})`
          : field.selector_offset === undefined
            ? ""
            : ` (selector offset ${field.selector_offset})`;
      lines.push(`  ${field.status.toUpperCase().padEnd(18)} ${field.field}  ${field.selector}${extra}`);
      if (field.display !== undefined) {
        lines.push(`    listing: ${field.display}`);
      }
    }
  }
  lines.push("", "Redactions:");
  if (report.redactions.length === 0) {
    lines.push("  (none in mapped fields)");
  } else {
    for (const redaction of report.redactions) {
      lines.push(`  ${redaction.field}  ${redaction.location}`);
    }
  }
  lines.push("", "Truncations:");
  if (report.truncations.length === 0) {
    lines.push("  (none)");
  } else {
    for (const truncation of report.truncations) {
      const decision =
        truncation.rejected === true
          ? `rejected at ${truncation.original_bytes} bytes`
          : truncation.truncated
            ? `${truncation.original_bytes} -> ${truncation.display_bytes} bytes (${truncation.scope})`
            : `${truncation.original_bytes} bytes (${truncation.scope})`;
      lines.push(`  ${truncation.field}  ${decision}`);
    }
  }
  lines.push("");
  if (
    report.evidence_canonical !== null &&
    report.evidence_bytes !== null &&
    report.evidence_sha256 !== null
  ) {
    lines.push(
      `Evidence: canonical aw-target/0.1, ${report.evidence_bytes} bytes, sha256 ${report.evidence_sha256}`
    );
    if (report.evidence_bytes <= HUMAN_EVIDENCE_LISTING_LIMIT_BYTES) {
      lines.push(report.evidence_canonical);
    } else {
      lines.push(
        `${truncateUtf8(report.evidence_canonical, HUMAN_EVIDENCE_LISTING_LIMIT_BYTES)}… [truncated ${report.evidence_bytes} bytes; --json prints the exact payload]`
      );
    }
  } else {
    lines.push("Evidence: not serialized because mapping diagnostics failed.");
  }
  lines.push("");
  for (const item of report.diagnostics) {
    const suffix = item.path === undefined ? "" : ` (${item.path})`;
    lines.push(`${marker[item.level]} ${item.code}: ${item.message}${suffix}`);
  }
  lines.push(report.disclaimer);
  lines.push(report.ok ? "Preview passed." : "Preview found mapping problems.");
  return `${sanitizeTerminal(lines.join("\n"))}\n`;
}

export function formatPreviewMappingJson(report: PreviewMappingDocument): string {
  return `${sanitizeTerminal(
    JSON.stringify(
      {
        schema_version: report.schema_version,
        ok: report.ok,
        offline: report.offline,
        operation: report.operation,
        config_path: report.config_path,
        fixture_path: report.fixture_path,
        fixture_bytes: report.fixture_bytes,
        fields: report.fields,
        redactions: report.redactions,
        truncations: report.truncations,
        evidence: report.evidence,
        evidence_canonical: report.evidence_canonical,
        evidence_sha256: report.evidence_sha256,
        evidence_bytes: report.evidence_bytes,
        diagnostics: report.diagnostics,
        disclaimer: report.disclaimer
      },
      null,
      2
    )
  )}\n`;
}

export function createPreviewMappingCommand(
  dependencies: PreviewMappingCommandDependencies = {}
): Command {
  return new Command("preview-mapping")
    .description(
      "Preview response mappings and the exact sanitized evidence payload without calling the target"
    )
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .requiredOption("-f, --fixture <path>", "synthetic JSON response fixture")
    .option("--operation <kind>", "prepare, send, observe, or cleanup", "send")
    .option("--json", "emit stable machine-readable preview")
    .action(
      async (commandOptions: {
        config: string;
        fixture: string;
        operation: string;
        json?: boolean;
      }) => {
        const report = await runPreviewMapping({
          config: commandOptions.config,
          fixture: commandOptions.fixture,
          operation: commandOptions.operation,
          cwd: dependencies.cwd?.() ?? process.cwd()
        });
        (dependencies.stdout ?? process.stdout).write(
          commandOptions.json === true
            ? formatPreviewMappingJson(report)
            : formatPreviewMappingHuman(report)
        );
        if (!report.ok) {
          (dependencies.setExitCode ??
            ((code) => {
              process.exitCode = code;
            }))(EXIT.CONFIG);
        }
      }
    );
}

export const previewMappingFormatters = {
  human: formatPreviewMappingHuman,
  json: formatPreviewMappingJson
} as const;
