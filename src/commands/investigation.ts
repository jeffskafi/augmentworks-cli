import { Command } from "commander";

import {
  exportInvestigationRegression,
  fetchInvestigation,
  inspectInvestigation,
  type InvestigationCommandDependencies,
  type InvestigationCommandOptions
} from "../investigation/execute.js";

export function createInvestigationCommand(
  dependencies: InvestigationCommandDependencies = {}
): Command {
  const investigation = new Command("investigation").description(
    "Inspect or fetch a safe failure investigation and export a reviewed regression draft without running a target"
  );

  investigation
    .command("inspect")
    .description(
      "Validate and display a local aw-investigation-export/1 file without running a target, shell command, or evaluator"
    )
    .argument("<file>", "investigation JSON path")
    .option("--json", "write one machine-readable inspection object to stdout")
    .option("-c, --config <path>", "optional local config used only to qualify mapping prerequisites")
    .action(async (file: string, values: InvestigationCommandOptions) => {
      await inspectInvestigation({ ...values, file }, dependencies);
    });

  investigation
    .command("fetch")
    .description(
      "Download a saved run's investigation artifact. Observation only; does not quote, admit, or execute the target"
    )
    .requiredOption("--run <run-id>", "original run ID")
    .requiredOption("--evaluation <evaluation-id>", "evaluation ID")
    .requiredOption("--attempt <attempt-id>", "attempt ID")
    .requiredOption("--criterion <criterion-id>", "criterion ID")
    .option("--out <path>", "optional JSON file to save the artifact")
    .option("--json", "write one machine-readable inspection object to stdout")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(async (values: InvestigationCommandOptions) => {
      await fetchInvestigation(values, dependencies);
    });

  investigation
    .command("export-regression")
    .description(
      "Write a reviewed aw-suite/1 regression draft from the original expected condition, not the failing chatbot output"
    )
    .argument("<file>", "investigation JSON path")
    .requiredOption("--out <path>", "aw-suite/1 YAML path")
    .option("--json", "write one machine-readable export object to stdout")
    .action(async (file: string, values: InvestigationCommandOptions) => {
      await exportInvestigationRegression({ ...values, file }, dependencies);
    });

  return investigation;
}
