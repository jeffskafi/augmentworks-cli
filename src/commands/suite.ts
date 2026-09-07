import { Command } from "commander";

import { AwError } from "../errors.js";
import { formatSuitePreview, formatSuiteValidate } from "../suite/format.js";
import { loadCustomerSuiteFile } from "../suite/load.js";
import { previewCustomerSuite } from "../suite/preview.js";

export interface SuiteCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
}

export async function runSuiteValidate(file: string, cwd: string): Promise<{
  readonly preview: ReturnType<typeof previewCustomerSuite>;
  readonly text: string;
}> {
  const loaded = await loadCustomerSuiteFile(file, cwd);
  const preview = previewCustomerSuite(loaded);
  return { preview, text: formatSuiteValidate(preview) };
}

export async function runSuitePreview(file: string, cwd: string): Promise<{
  readonly preview: ReturnType<typeof previewCustomerSuite>;
  readonly text: string;
}> {
  const loaded = await loadCustomerSuiteFile(file, cwd);
  const preview = previewCustomerSuite(loaded);
  return { preview, text: formatSuitePreview(preview) };
}

export function createSuiteCommand(dependencies: SuiteCommandDependencies = {}): Command {
  const suite = new Command("suite").description(
    "Validate or preview a customer-owned hosted suite file without calling a target or an LLM"
  );

  const write = (message: string): void => {
    (dependencies.stdout ?? process.stdout).write(`${message}\n`);
  };
  const cwd = (): string => dependencies.cwd?.() ?? process.cwd();

  suite
    .command("validate")
    .description("Parse and validate an aw-suite/1 file offline")
    .argument("<file>", "YAML or JSON suite path")
    .option("--json", "write machine-readable validation output")
    .action(async (file: string, values: { json?: boolean }) => {
      if (file.trim() === "") {
        throw new AwError({
          code: "SUITE_FILE_REQUIRED",
          category: "config",
          message: "Provide a customer suite file path."
        });
      }
      const result = await runSuiteValidate(file, cwd());
      if (values.json === true) {
        write(
          JSON.stringify({
            ok: true,
            action: "validate",
            ...result.preview,
            localPreview: result.preview.localPreview
          })
        );
        return;
      }
      write(result.text);
    });

  suite
    .command("preview")
    .description(
      "Show materialized inputs, expected conditions, and bounded case/turn counts. Not a price; does not execute a target or an LLM"
    )
    .argument("<file>", "YAML or JSON suite path")
    .option("--json", "write machine-readable preview output")
    .action(async (file: string, values: { json?: boolean }) => {
      if (file.trim() === "") {
        throw new AwError({
          code: "SUITE_FILE_REQUIRED",
          category: "config",
          message: "Provide a customer suite file path."
        });
      }
      const result = await runSuitePreview(file, cwd());
      if (values.json === true) {
        write(JSON.stringify({ ok: true, action: "preview", ...result.preview }));
        return;
      }
      write(result.text);
    });

  return suite;
}
