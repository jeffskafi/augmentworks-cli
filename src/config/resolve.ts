import { isIP } from "node:net";

import { canonicalize, sha256 } from "../util/canonical.js";
import type { AugmentWorksConfig, Diagnostic, ResolvedConfig } from "./types.js";
import { exactEnvironmentName } from "./environment.js";

function ipv4Number(hostname: string): number | undefined {
  if (isIP(hostname) !== 4) return undefined;
  const parts = hostname.split(".").map(Number);
  const [a, b, c, d] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function inIpv4Cidr(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

export function isLocalOrPrivateHost(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const ipv4 = ipv4Number(hostname);
  if (ipv4 !== undefined) {
    return (
      inIpv4Cidr(ipv4, 0x0a000000, 8) ||
      inIpv4Cidr(ipv4, 0x7f000000, 8) ||
      inIpv4Cidr(ipv4, 0xac100000, 12) ||
      inIpv4Cidr(ipv4, 0xc0a80000, 16) ||
      inIpv4Cidr(ipv4, 0xa9fe0000, 16)
    );
  }
  if (isIP(hostname) === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || /^fe[89ab]/.test(hostname);
  }
  return false;
}

function diagnostic(level: Diagnostic["level"], code: string, message: string, path?: string): Diagnostic {
  return { level, code, message, ...(path === undefined ? {} : { path }) };
}

function resolveRequiredEnvironment(
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
  path: string,
  diagnostics: Diagnostic[]
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === "") {
    diagnostics.push(diagnostic("error", "ENV_REQUIRED", `Required environment variable ${name} is not set.`, path));
    return undefined;
  }
  return value;
}

export interface ResolutionResult {
  readonly resolvedConfig?: ResolvedConfig;
  readonly diagnostics: readonly Diagnostic[];
}

export function resolveConfig(
  config: AugmentWorksConfig,
  configPath: string,
  configDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
  inheritedDiagnostics: readonly Diagnostic[] = []
): ResolutionResult {
  const diagnostics: Diagnostic[] = [...inheritedDiagnostics];
  const envName = exactEnvironmentName(config.target.base_url);
  const rawBaseUrl = envName === undefined
    ? config.target.base_url
    : resolveRequiredEnvironment(envName, environment, "target.base_url", diagnostics);

  let baseUrl: URL | undefined;
  if (rawBaseUrl !== undefined) {
    try {
      baseUrl = new URL(rawBaseUrl);
      if (!(["http:", "https:"] as string[]).includes(baseUrl.protocol)) {
        diagnostics.push(diagnostic("error", "BASE_URL_PROTOCOL_INVALID", "target.base_url must use HTTP or HTTPS.", "target.base_url"));
      }
      if (baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.search !== "" || baseUrl.hash !== "") {
        diagnostics.push(
          diagnostic(
            "error",
            "BASE_URL_CREDENTIALS_FORBIDDEN",
            "target.base_url cannot contain credentials, query parameters, or fragments.",
            "target.base_url"
          )
        );
      }
      if (baseUrl.protocol === "http:" && !isLocalOrPrivateHost(baseUrl.hostname)) {
        if (config.target.allow_insecure_http !== true) {
          diagnostics.push(
            diagnostic(
              "error",
              "INSECURE_HTTP_FORBIDDEN",
              "Public HTTP targets require target.allow_insecure_http: true; HTTPS is strongly recommended.",
              "target.base_url"
            )
          );
        } else {
          diagnostics.push(
            diagnostic(
              "warning",
              "INSECURE_HTTP_ALLOWED",
              "This target sends assessment data over unencrypted public HTTP.",
              "target.allow_insecure_http"
            )
          );
        }
      }
    } catch {
      diagnostics.push(diagnostic("error", "BASE_URL_INVALID", "target.base_url is not a valid absolute URL.", "target.base_url"));
    }
  }

  if (baseUrl !== undefined) {
    for (const [kind, operation] of Object.entries(config.target.operations)) {
      if (operation === undefined) continue;
      try {
        const operationUrl = new URL(operation.path, baseUrl);
        if (operationUrl.origin !== baseUrl.origin) {
          diagnostics.push(
            diagnostic("error", "OPERATION_ORIGIN_INVALID", "Operation paths must resolve on the configured target origin.", `target.operations.${kind}.path`)
          );
        }
      } catch {
        diagnostics.push(diagnostic("error", "OPERATION_PATH_INVALID", "Operation path is not a valid relative URL path.", `target.operations.${kind}.path`));
      }
    }
  }

  const authHeaders: Record<string, string> = Object.create(null) as Record<string, string>;
  const secrets: string[] = [];
  const bearerName = config.target.auth?.bearer_env;
  if (bearerName !== undefined) {
    const bearer = resolveRequiredEnvironment(bearerName, environment, "target.auth.bearer_env", diagnostics);
    if (bearer !== undefined) {
      authHeaders["Authorization"] = `Bearer ${bearer}`;
      secrets.push(bearer);
    }
  }
  for (const [header, variable] of Object.entries(config.target.auth?.headers_env ?? {})) {
    const value = resolveRequiredEnvironment(variable, environment, `target.auth.headers_env.${header}`, diagnostics);
    if (value !== undefined) {
      authHeaders[header] = value;
      secrets.push(value);
    }
  }

  if (diagnostics.some((item) => item.level === "error") || baseUrl === undefined) return { diagnostics };

  const operations = config.target.operations;
  const stateful =
    operations.prepare !== undefined &&
    operations.observe !== undefined &&
    operations.cleanup !== undefined &&
    (config.telemetry?.allow_observations?.length ?? 0) > 0;
  const sendResponse = operations.send.response;
  const mapsToolEvents =
    sendResponse === undefined ||
    Object.hasOwn(sendResponse, "tool_events") ||
    Object.hasOwn(sendResponse, "events");
  const toolEvents = mapsToolEvents && config.telemetry?.allow_tool_events === true;
  const level = stateful ? "stateful" : toolEvents ? "tool-aware" : "chat-only";
  const configDigest = sha256(canonicalize(config));
  const warnings = diagnostics.filter((item) => item.level === "warning").map((item) => item.message);

  return {
    diagnostics,
    resolvedConfig: {
      config,
      configPath,
      configDirectory,
      configDigest,
      baseUrl,
      authHeaders,
      secrets: [...new Set(secrets)],
      capabilities: {
        level,
        prepare: operations.prepare !== undefined,
        observation: operations.observe !== undefined,
        cleanup: operations.cleanup !== undefined,
        tool_events: toolEvents
      },
      warnings
    }
  };
}
