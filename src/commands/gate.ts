import { Command } from "commander";

import {
  runReleasePolicyCommand,
  type PolicyCommandDependencies,
  type PolicyCommandOptions
} from "../baseline/execute.js";
import { runManifestReleaseGate } from "../selection/gate-execute.js";
import { selectionError } from "../selection/errors.js";

export function createGateCommand(dependencies: PolicyCommandDependencies = {}): Command {
  return new Command("gate")
    .description(
      "Evaluate the hosted release policy for an explicit candidate run and pinned baseline without starting a test"
    )
    .option("--run <run-id>", "candidate run ID")
    .option("--baseline <baseline-id>", "pinned baseline ID")
    .option(
      "--manifest-file <path>",
      "compiled aw-suite-selection/1 manifest; evaluates whole-manifest coverage instead of --run/--baseline"
    )
    .option(
      "--declared-shards <path>",
      "artifact from test --artifact-out listing per-shard run IDs (required for a complete coverage set)"
    )
    .option("--wait", "wait on the original run's billing status before evaluating the gate")
    .option("--timeout-ms <ms>", "maximum wait in milliseconds when --wait is set", "900000")
    .option("--json", "write one machine-readable gate object to stdout; diagnostics go to stderr")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(
      async (
        values: PolicyCommandOptions & { manifestFile?: string; declaredShards?: string }
      ) => {
        if (values.manifestFile !== undefined) {
          if (values.run !== undefined || values.baseline !== undefined) {
            throw selectionError(
              "MANIFEST_GATE_CONFLICT",
              "Use either --manifest-file (whole-suite shards) or --run plus --baseline, not both."
            );
          }
          await runManifestReleaseGate(values, dependencies);
          return;
        }
        await runReleasePolicyCommand("gate", values, dependencies);
      }
    );
}
