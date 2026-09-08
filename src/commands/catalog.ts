import { Command } from "commander";

import {
  findCatalogTarget,
  loadCoverageCatalog,
  type CatalogLoadOptions
} from "../catalog/load.js";
import {
  catalogDetailJson,
  catalogListJson,
  formatCatalogCaseHuman,
  formatCatalogListHuman,
  formatCatalogPacketHuman,
  formatCatalogProfileHuman
} from "../catalog/format.js";
import type { CatalogCase, CatalogPacket, CatalogProfile } from "../catalog/schema.js";
import { catalogError } from "../catalog/errors.js";

export interface CatalogCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDirectory?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

function write(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

function loadOptions(
  values: { catalogVersion?: string },
  dependencies: CatalogCommandDependencies
): CatalogLoadOptions {
  return {
    ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
    ...(dependencies.stateDirectory === undefined ? {} : { stateDirectory: dependencies.stateDirectory }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(values.catalogVersion === undefined ? {} : { catalogVersion: values.catalogVersion })
  };
}

export function createCatalogCommand(dependencies: CatalogCommandDependencies = {}): Command {
  const catalog = new Command("catalog").description(
    "List or show the public coverage catalog without login. Static counts are informative, not a quote."
  );
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  catalog
    .command("list")
    .description("List catalog packets, profiles, and cases")
    .option("--json", "write machine-readable catalog output")
    .option("--catalog-version <version>", "request a specific catalogVersion (stale versions fail closed)")
    .action(async (values: { json?: boolean; catalogVersion?: string }) => {
      const loaded = await loadCoverageCatalog(loadOptions(values, dependencies));
      if (loaded.stale) {
        write(
          stderr,
          "Using a bounded stale catalog copy after a fetch error. Re-run when the catalog is reachable. Do not quote from a stale checksum."
        );
      }
      if (values.json === true) {
        write(stdout, `${JSON.stringify(catalogListJson(loaded.catalog, loaded))}\n`);
        return;
      }
      write(stdout, formatCatalogListHuman(loaded.catalog, loaded));
    });

  catalog
    .command("show")
    .description("Show one catalog case, profile, or packet@version")
    .argument("<id>", "case id, profile id, or packet@version")
    .option("--json", "write machine-readable catalog output")
    .option("--catalog-version <version>", "request a specific catalogVersion (stale versions fail closed)")
    .action(async (id: string, values: { json?: boolean; catalogVersion?: string }) => {
      if (id.trim() === "") {
        throw catalogError("CATALOG_TARGET_REQUIRED", "Provide a case id, profile id, or packet@version.", {
          category: "config"
        });
      }
      const loaded = await loadCoverageCatalog(loadOptions(values, dependencies));
      if (loaded.stale) {
        write(
          stderr,
          "Using a bounded stale catalog copy after a fetch error. Re-run when the catalog is reachable. Do not quote from a stale checksum."
        );
      }
      const target = findCatalogTarget(loaded.catalog, id);
      if (values.json === true) {
        write(stdout, `${JSON.stringify(catalogDetailJson(loaded.catalog, target.value, target.kind))}\n`);
        return;
      }
      if (target.kind === "case") {
        write(stdout, formatCatalogCaseHuman(loaded.catalog, target.value as CatalogCase));
        return;
      }
      if (target.kind === "packet") {
        write(stdout, formatCatalogPacketHuman(target.value as CatalogPacket));
        return;
      }
      write(stdout, formatCatalogProfileHuman(target.value as CatalogProfile));
    });

  return catalog;
}
