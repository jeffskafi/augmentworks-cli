import { Command } from "commander";

import { AwError } from "../errors.js";
import { formatSuitePreview, formatSuiteValidate } from "../suite/format.js";
import { loadCustomerSuiteFile } from "../suite/load.js";
import { formatSuitePreflight, preflightCustomerSuite } from "../suite/preflight.js";
import { previewCustomerSuite } from "../suite/preview.js";

export interface SuiteCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
  readonly env?: NodeJS.ProcessEnv;
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

export async function runSuitePreflight(
  file: string,
  cwd: string,
  options: { readonly configPath?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<{
  readonly preflight: Awaited<ReturnType<typeof preflightCustomerSuite>>;
  readonly text: string;
}> {
  const loaded = await loadCustomerSuiteFile(file, cwd);
  const preflight = await preflightCustomerSuite(loaded, {
    cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath })
  });
  return { preflight, text: formatSuitePreflight(preflight) };
}

function requireSuiteFile(file: string): string {
  if (file.trim() === "") {
    throw new AwError({
      code: "SUITE_FILE_REQUIRED",
      category: "config",
      message: "Provide a customer suite file path."
    });
  }
  return file;
}

export function createSuiteCommand(dependencies: SuiteCommandDependencies = {}): Command {
  const suite = new Command("suite").description(
    "Validate, preview, or preflight a customer-owned hosted suite file without calling a target or an LLM"
  );

  const write = (message: string): void => {
    (dependencies.stdout ?? process.stdout).write(`${message}\n`);
  };
  const cwd = (): string => dependencies.cwd?.() ?? process.cwd();

  suite
    .command("validate")
    .description("Parse and validate an aw-suite/1 or aw-suite/2 file offline")
    .argument("<file>", "YAML or JSON suite path")
    .option("--json", "write machine-readable validation output")
    .action(async (file: string, values: { json?: boolean }) => {
      const result = await runSuiteValidate(requireSuiteFile(file), cwd());
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
      const result = await runSuitePreview(requireSuiteFile(file), cwd());
      if (values.json === true) {
        write(JSON.stringify({ ok: true, action: "preview", ...result.preview }));
        return;
      }
      write(result.text);
    });

  suite
    .command("preflight")
    .description(
      "Report schema, workspace, approved origin, expiry, permitted operations/messages, and a finite credit ceiling without sending a target message or buying credits"
    )
    .argument("<file>", "YAML or JSON suite path")
    .option("-c, --config <path>", "optional connector config used only to match the approved origin")
    .option("--json", "write machine-readable preflight output")
    .action(async (file: string, values: { json?: boolean; config?: string }) => {
      const result = await runSuitePreflight(requireSuiteFile(file), cwd(), {
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
        ...(values.config === undefined ? {} : { configPath: values.config })
      });
      if (values.json === true) {
        write(JSON.stringify(result.preflight));
        return;
      }
      write(result.text);
    });

  return suite;
}
