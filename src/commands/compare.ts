import { Command } from "commander";

import {
  runReleasePolicyCommand,
  type PolicyCommandDependencies,
  type PolicyCommandOptions
} from "../baseline/execute.js";

export function createCompareCommand(dependencies: PolicyCommandDependencies = {}): Command {
  return new Command("compare")
    .description(
      "Compare a candidate run against an explicit pinned baseline without starting a test or consuming credits"
    )
    .option("--run <run-id>", "candidate run ID")
    .option("--baseline <baseline-id>", "pinned baseline ID")
    .option("--json", "write one machine-readable comparison object to stdout; diagnostics go to stderr")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(async (values: PolicyCommandOptions) => {
      await runReleasePolicyCommand("compare", values, dependencies);
    });
}
