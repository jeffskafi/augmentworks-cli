import { Buffer } from "node:buffer";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { AwError } from "../errors.js";
import { loadEnvironment } from "./environment.js";
import { resolveConfig } from "./resolve.js";
import type { ConfigInspection, Diagnostic, InspectConfigOptions, ResolvedConfig } from "./types.js";
import { validateConfigObject } from "./validate.js";
import { parseYamlStrict, StrictYamlError } from "./yaml.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

function errorDiagnostic(code: string, message: string, path?: string): Diagnostic {
  return { level: "error", code, message, ...(path === undefined ? {} : { path }) };
}

export async function inspectConfig(options: InspectConfigOptions = {}): Promise<ConfigInspection> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const requestedPath = resolve(cwd, options.configPath ?? "augmentworks.yaml");
  let configPath: string;
  let source: string;
  try {
    configPath = await realpath(requestedPath);
    source = await readFile(configPath, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      diagnostics: [
        errorDiagnostic(
          missing ? "CONFIG_FILE_NOT_FOUND" : "CONFIG_FILE_UNREADABLE",
          missing ? `Configuration file not found: ${requestedPath}` : `Could not read configuration file: ${requestedPath}`,
          requestedPath
        )
      ]
    };
  }

  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) {
    return {
      diagnostics: [errorDiagnostic("CONFIG_FILE_TOO_LARGE", "Configuration files cannot exceed 1 MiB.", configPath)]
    };
  }

  let rawConfig: unknown;
  try {
    rawConfig = parseYamlStrict(source);
  } catch (error) {
    if (error instanceof StrictYamlError) {
      return { diagnostics: [errorDiagnostic(error.code, error.message, error.path ?? configPath)] };
    }
    return { diagnostics: [errorDiagnostic("YAML_PARSE_ERROR", "The configuration file is not valid YAML.", configPath)] };
  }

  const validation = validateConfigObject(rawConfig);
  const diagnostics: Diagnostic[] = [
    { level: "ok", code: "CONFIG_FILE_LOADED", message: `Loaded ${configPath}.`, path: configPath },
    ...validation.diagnostics
  ];
  if (validation.config === undefined || diagnostics.some((item) => item.level === "error")) return { diagnostics };
  diagnostics.push({ level: "ok", code: "CONFIG_VALID", message: "Configuration schema and mappings are valid." });

  const configDirectory = dirname(configPath);
  const environmentResult = await loadEnvironment(resolve(configDirectory, ".env"), options.processEnv ?? process.env);
  diagnostics.push(...environmentResult.diagnostics);
  if (environmentResult.diagnostics.some((item) => item.level === "error")) return { diagnostics };

  const resolution = resolveConfig(
    validation.config,
    configPath,
    configDirectory,
    environmentResult.environment,
    diagnostics.filter((item) => item.level === "warning")
  );
  diagnostics.push(...resolution.diagnostics.filter((item) => !diagnostics.includes(item)));
  if (resolution.resolvedConfig === undefined) return { diagnostics };
  diagnostics.push({
    level: "ok",
    code: "CONNECTOR_READY",
    message: `Connector capability level: ${resolution.resolvedConfig.capabilities.level}.`
  });
  return { diagnostics, resolvedConfig: resolution.resolvedConfig };
}

export async function loadConfig(options: InspectConfigOptions = {}): Promise<ResolvedConfig> {
  const inspection = await inspectConfig(options);
  if (inspection.resolvedConfig !== undefined) return inspection.resolvedConfig;
  const firstError = inspection.diagnostics.find((item) => item.level === "error");
  throw new AwError({
    code: firstError?.code ?? "CONFIG_INVALID",
    category: "config",
    message: firstError?.message ?? "The AugmentWorks configuration is invalid.",
    ...(firstError?.path === undefined ? {} : { details: { path: firstError.path } })
  });
}
