import { resolve } from "node:path";

import { EXIT, AwError, exitCodeFor } from "../errors.js";
import { observationFailureJson } from "../baseline/format.js";
import { parseTimeoutMs, waitForOriginalRun } from "../baseline/wait.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies,
  type HostedAuthOptions
} from "../commands/hosted-auth.js";
import { classifyManifestReleasePolicy } from "./classify.js";
import { formatManifestGateHuman, manifestGateJson } from "./format.js";
import {
  buildManifestGateRequest,
  encodedGateDocumentBytes,
  mapManifestGateNetworkError,
  parseManifestGateResponse,
  redactGateDiagnostic
} from "./gate-v2.js";
import { loadDeclaredShardsFile } from "./progress.js";
import { loadManifestForReleaseGate } from "./load.js";
import { selectionError } from "./errors.js";
import { admitManifestWorkspace } from "./admit.js";

export interface ManifestGateOptions extends HostedAuthOptions {
  readonly manifestFile?: string;
  readonly declaredShards?: string;
  readonly json?: boolean;
  readonly wait?: boolean;
  readonly timeoutMs?: string;
  readonly cwd?: string;
}

export interface ManifestGateDependencies extends HostedAuthDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly setExitCode?: (code: number) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function runManifestReleaseGate(
  values: ManifestGateOptions,
  dependencies: ManifestGateDependencies = {}
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const json = values.json === true;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const secrets = collectRedactionSecrets(values);
  try {
    if (values.manifestFile === undefined || values.manifestFile.trim() === "") {
      throw selectionError("MANIFEST_FILE_REQUIRED", "gate --manifest-file requires a compiled suite-selection JSON document.");
    }
    const cwd = values.cwd ?? process.cwd();
    const manifest = await loadManifestForReleaseGate(values.manifestFile, cwd);
    const declared =
      values.declaredShards === undefined
        ? []
        : await loadDeclaredShardsFile(resolve(cwd, values.declaredShards));
    const request = buildManifestGateRequest(manifest, declared);
    const session = await authenticateHostedSession(values, dependencies);
    admitManifestWorkspace(manifest, session.tenant);
    if (values.wait === true) {
      const timeoutMs = parseTimeoutMs(values.timeoutMs);
      for (const shard of request.declaredShards) {
        await waitForOriginalRun({
          session,
          runId: shard.runId,
          timeoutMs,
          ...(values.signal === undefined ? {} : { signal: values.signal }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
          ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep })
        });
      }
    }
    let raw: unknown;
    try {
      raw = await session.cloud.evaluateManifestReleasePolicy(request, values.signal);
    } catch (error) {
      throw mapManifestGateNetworkError(error);
    }
    const result = parseManifestGateResponse(raw, request, { encodedBytes: encodedGateDocumentBytes(raw) });
    const classification = classifyManifestReleasePolicy(result);
    if (json) {
      stdout.write(`${JSON.stringify(manifestGateJson(result, classification))}\n`);
    } else {
      stdout.write(formatManifestGateHuman(result, classification));
    }
    if (classification.exitCode !== EXIT.OK) setExitCode(classification.exitCode);
  } catch (error) {
    const awError =
      error instanceof AwError
        ? error
        : new AwError({
            code: "INTERNAL",
            category: "local",
            message: "The manifest gate command could not be completed."
          });
    const safeMessage = redactGateDiagnostic(awError.message, secrets);
    const safeError = new AwError({
      code: awError.code,
      category: awError.category,
      message: safeMessage,
      retryable: awError.retryable,
      ...(awError.details === undefined ? {} : { details: redactDetails(awError.details) })
    });
    if (!json) throw safeError;
    stdout.write(observationFailureJson(safeError, exitCodeFor(awError)));
    stderr.write(
      `Error [${safeError.code}]: ${safeMessage} Re-query the original shard declarations. Do not start another billed assessment.\n`
    );
    setExitCode(exitCodeFor(awError));
  }
}

function collectRedactionSecrets(values: ManifestGateOptions): string[] {
  const env = values.env ?? process.env;
  return [env["AUGMENTWORKS_API_KEY"], env["AUGMENTWORKS_TOKEN"], env["AUGMENTWORKS_REFRESH_TOKEN"]].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function redactDetails(
  details: Readonly<Record<string, string | number | boolean>>
): Record<string, string | number | boolean> {
  const redacted: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      /authorization|cookie|token|secret|body|url|hash|run_id|manifest/i.test(key) &&
      key !== "http_status" &&
      key !== "retry_after_ms"
    ) {
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}
