import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { AwError } from "../errors.js";

export interface SchemaCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
}

export type BundledSchemaKind = "config" | "local-packet" | "local-result";

const SCHEMA_FILES: Readonly<Record<BundledSchemaKind, string>> = {
  config: "augmentworks.schema.json",
  "local-packet": "local-packet.schema.json",
  "local-result": "local-result.schema.json"
};

async function schemaPath(kind: BundledSchemaKind): Promise<string> {
  const filename = SCHEMA_FILES[kind];
  const candidates = [
    fileURLToPath(new URL(`../schemas/v1/${filename}`, import.meta.url)),
    fileURLToPath(new URL(`../../schemas/v1/${filename}`, import.meta.url))
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the source-tree or packaged location next.
    }
  }
  throw new Error(`The bundled AugmentWorks v1 ${kind} schema could not be found.`);
}

export async function readBundledSchema(
  kind: BundledSchemaKind = "config"
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(await schemaPath(kind), "utf8")) as Record<string, unknown>;
}

export async function runSchema(
  compact = false,
  kind: BundledSchemaKind = "config"
): Promise<string> {
  return `${JSON.stringify(await readBundledSchema(kind), null, compact ? undefined : 2)}\n`;
}

export function createSchemaCommand(dependencies: SchemaCommandDependencies = {}): Command {
  return new Command("schema")
    .description("Print a bundled AugmentWorks v1 JSON Schema")
    .option(
      "--kind <kind>",
      "schema kind: config, local-packet, or local-result",
      "config"
    )
    .option("--compact", "print compact JSON")
    .action(async (commandOptions: { compact?: boolean; kind: string }) => {
      if (!Object.hasOwn(SCHEMA_FILES, commandOptions.kind)) {
        throw new AwError({
          code: "SCHEMA_KIND_INVALID",
          category: "config",
          message: "Schema kind must be config, local-packet, or local-result."
        });
      }
      (dependencies.stdout ?? process.stdout).write(
        await runSchema(commandOptions.compact === true, commandOptions.kind as BundledSchemaKind)
      );
    });
}
