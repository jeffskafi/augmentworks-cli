import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

export interface SchemaCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
}

async function schemaPath(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL("../schemas/v1/augmentworks.schema.json", import.meta.url)),
    fileURLToPath(new URL("../../schemas/v1/augmentworks.schema.json", import.meta.url))
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the source-tree or packaged location next.
    }
  }
  throw new Error("The bundled AugmentWorks v1 schema could not be found.");
}

export async function readBundledSchema(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(await schemaPath(), "utf8")) as Record<string, unknown>;
}

export async function runSchema(compact = false): Promise<string> {
  return `${JSON.stringify(await readBundledSchema(), null, compact ? undefined : 2)}\n`;
}

export function createSchemaCommand(dependencies: SchemaCommandDependencies = {}): Command {
  return new Command("schema")
    .description("Print the bundled augmentworks.yaml JSON Schema")
    .option("--compact", "print compact JSON")
    .action(async (commandOptions: { compact?: boolean }) => {
      (dependencies.stdout ?? process.stdout).write(await runSchema(commandOptions.compact === true));
    });
}
