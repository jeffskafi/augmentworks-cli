import { Command } from "commander";

import {
  runReleasePolicyCommand,
  type PolicyCommandDependencies,
  type PolicyCommandOptions
} from "../baseline/execute.js";

export function createGateCommand(dependencies: PolicyCommandDependencies = {}): Command {
  return new Command("gate")
    .description(
      "Evaluate the hosted release policy for an explicit candidate run and pinned baseline without starting a test"
    )
    .option("--run <run-id>", "candidate run ID")
    .option("--baseline <baseline-id>", "pinned baseline ID")
    .option("--wait", "wait on the original run's billing status before evaluating the gate")
    .option("--timeout-ms <ms>", "maximum wait in milliseconds when --wait is set", "900000")
    .option("--json", "write one machine-readable gate object to stdout; diagnostics go to stderr")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(async (values: PolicyCommandOptions) => {
      await runReleasePolicyCommand("gate", values, dependencies);
    });
}
