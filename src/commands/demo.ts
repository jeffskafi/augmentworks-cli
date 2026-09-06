import { Command } from "commander";

import { EXIT } from "../errors.js";
import { demoModeFrom, runDemo, type DemoOrchestratorDependencies } from "../demo/orchestrator.js";
import { formatDemoHuman, formatDemoJson } from "../demo/summary.js";

export interface DemoCommandDependencies extends DemoOrchestratorDependencies {
  readonly setExitCode?: (code: number) => void;
}

export function createDemoCommand(dependencies: DemoCommandDependencies = {}): Command {
  return new Command("demo")
    .description(
      "Run the packaged loopback refund demonstration (faulty then corrected) without login, API keys, or a cloned example"
    )
    .option("--json", "emit an AW-DEMO-SUMMARY-1 JSON object on stdout; progress goes to stderr")
    .option("--open", "open the last generated local HTML report")
    .option("--output-dir <path>", "fresh parent directory for failing/ and passing/ reports")
    .option("--mode <mode>", "full, faulty, or corrected", "full")
    .action(
      async (values: { json?: boolean; open?: boolean; outputDir?: string; mode: string }) => {
        const stdout = dependencies.stdout ?? process.stdout;
        const stderr = dependencies.stderr ?? process.stderr;
        const setExitCode =
          dependencies.setExitCode ??
          ((code: number) => {
            process.exitCode = code;
          });
        const result = await runDemo(
          {
            json: values.json === true,
            ...(values.open === undefined ? {} : { open: values.open }),
            ...(values.outputDir === undefined ? {} : { outputDirectory: values.outputDir }),
            mode: demoModeFrom(values.mode)
          },
          { ...dependencies, stdout, stderr }
        );
        stdout.write(
          values.json === true ? formatDemoJson(result.summary) : formatDemoHuman(result.summary)
        );
        if (result.exitCode !== EXIT.OK) setExitCode(result.exitCode);
      }
    );
}
