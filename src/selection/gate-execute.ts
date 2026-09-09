import { resolve } from "node:path";

import { EXIT, AwError, exitCodeFor } from "../errors.js";
import { createsBillableRunError } from "../baseline/errors.js";
import { observationFailureJson } from "../baseline/format.js";
import { parseTimeoutMs, waitForOriginalRun } from "../baseline/wait.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies,
  type HostedAuthOptions
} from "../commands/hosted-auth.js";
import { classifyManifestReleasePolicy } from "./classify.js";
import { formatManifestGateHuman, manifestGateJson } from "./format.js";
import { loadDeclaredShardsFile } from "./progress.js";
import { loadSuiteSelectionManifest } from "./load.js";
import { selectionError } from "./errors.js";
import type { DeclaredShard } from "./schema.js";

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
  try {
    if (values.manifestFile === undefined || values.manifestFile.trim() === "") {
      throw selectionError("MANIFEST_FILE_REQUIRED", "gate --manifest-file requires a compiled suite-selection JSON document.");
    }
    const cwd = values.cwd ?? process.cwd();
    const manifest = await loadSuiteSelectionManifest(values.manifestFile, cwd);
    const declared: DeclaredShard[] =
      values.declaredShards === undefined
        ? []
        : await loadDeclaredShardsFile(resolve(cwd, values.declaredShards));
    const session = await authenticateHostedSession(values, dependencies);
    if (values.wait === true) {
      const timeoutMs = parseTimeoutMs(values.timeoutMs);
      for (const shard of declared) {
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
    const result = await session.cloud.evaluateManifestReleasePolicy({
      schemaVersion: "aw-suite-selection/1",
      manifest,
      expectedManifestHash: manifest.manifestHash,
      declaredShards: declared
    });
    if (result.createsBillableRun) throw createsBillableRunError();
    const classification = classifyManifestReleasePolicy(result);
    if (json) {
      stdout.write(`${JSON.stringify(manifestGateJson(result, classification))}\n`);
    } else {
      stdout.write(formatManifestGateHuman(result));
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
    if (!json) throw awError;
    stdout.write(observationFailureJson(awError, exitCodeFor(awError)));
    stderr.write(
      `${awError.message} Re-query the original run IDs. Do not start another billed assessment.\n`
    );
    setExitCode(exitCodeFor(awError));
  }
}
