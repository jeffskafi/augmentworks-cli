import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";

import { loadAssessmentFile } from "../assessment/load.js";
import type { ResolvedConfig } from "../config/types.js";
import { formatSelectionHuman, selectionCompileJson } from "../selection/format.js";
import {
  compileRequestFromAssessment,
  compileRequestFromFlags,
  conversationModeFromConfig,
  parseCompileRequest,
  resolveSelectionAdvertisement,
  type SelectionAdvertisement
} from "../selection/request.js";
import {
  SelectionProfileSchema,
  type CompileSuiteSelectionRequest,
  type SelectionProfile,
  type SuiteSelectionManifest
} from "../selection/schema.js";
import { hostedSelectionUnsupportedLocalError, selectionError } from "../selection/errors.js";
import {
  assertShardWithinPerRunLimits,
  requireExecutableManifest,
  requirePinnedSelectionVersion
} from "../selection/admit.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies,
  type HostedAuthOptions
} from "./hosted-auth.js";

export interface SelectionCommandDependencies extends HostedAuthDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
  readonly env?: NodeJS.ProcessEnv;
}

function write(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

export function createSelectionCommand(dependencies: SelectionCommandDependencies = {}): Command {
  const selection = new Command("selection").description(
    "Compile a server-owned deterministic suite selection without creating a billable run"
  );
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const cwd = (): string => dependencies.cwd?.() ?? process.cwd();

  selection
    .command("compile")
    .description(
      "Ask the server compiler for included/excluded/incompatible cases and bounded shards. Not a quote."
    )
    .option(
      "-c, --config <path>",
      "connector YAML for advertised lifecycle, observation, and conversation capabilities; a missing default file is capability-free single-turn",
      "augmentworks.yaml"
    )
    .option("--assessment <path>", "assessment file with optional smoke/release selection fields")
    .option("--profile <profile>", "smoke or release (overrides assessment selection.profile)")
    .option("--include-catalog", "include the public catalog inventory when no suite_revision_id is set")
    .option("--include-tags <tags>", "comma-separated include tags")
    .option("--exclude-tags <tags>", "comma-separated exclude tags")
    .option("--out <path>", "write the immutable compile document as JSON")
    .option("--json", "write machine-readable compile output")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .option("--local", "rejected; compile is hosted-only")
    .action(
      async (
        values: {
          config: string;
          assessment?: string;
          profile?: string;
          includeCatalog?: boolean;
          includeTags?: string;
          excludeTags?: string;
          out?: string;
          json?: boolean;
          allowFileCredentials?: boolean;
          local?: boolean;
        },
        command: Command
      ) => {
        if (values.local === true) throw hostedSelectionUnsupportedLocalError();
        const workingDirectory = cwd();
        const profile =
          values.profile === undefined ? undefined : parseSelectionProfile(values.profile);
        const advertisement = await resolveSelectionAdvertisement({
          configPath: values.config,
          cwd: workingDirectory,
          allowMissingDefault: command.getOptionValueSource("config") !== "cli",
          ...(dependencies.env === undefined ? {} : { processEnv: dependencies.env })
        });
        const request = await buildCompileRequest({
          assessment: values.assessment,
          cwd: workingDirectory,
          advertisement,
          profile,
          includeCatalog: values.includeCatalog === true,
          includeTags: splitTags(values.includeTags),
          excludeTags: splitTags(values.excludeTags)
        });
        const authOptions: HostedAuthOptions = {
          ...(values.allowFileCredentials === undefined
            ? {}
            : { allowFileCredentials: values.allowFileCredentials }),
          ...(dependencies.env === undefined ? {} : { env: dependencies.env })
        };
        const session = await authenticateHostedSession(authOptions, dependencies);
        const manifest = await session.cloud.compileSuiteSelection(request);
        if (values.assessment !== undefined) {
          const loaded = await loadAssessmentFile({ path: values.assessment, cwd: workingDirectory });
          requirePinnedSelectionVersion(manifest, loaded.document.selection?.suite_version);
        }
        if (values.out !== undefined) {
          const outPath = resolve(workingDirectory, values.out);
          await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8" });
          write(stderr, `Wrote immutable manifest ${outPath}`);
        }
        if (values.json === true) {
          write(stdout, `${JSON.stringify(selectionCompileJson(manifest))}\n`);
        } else {
          write(stdout, formatSelectionHuman(manifest));
        }
        if (!manifest.executable || manifest.includedCaseCount === 0) {
          requireExecutableManifest(manifest);
        }
        for (const shard of manifest.shards) {
          assertShardWithinPerRunLimits(manifest, shard);
        }
      }
    );

  return selection;
}

export async function compileHostedSelection(options: {
  readonly request: CompileSuiteSelectionRequest;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly suiteVersion?: string;
  readonly signal?: AbortSignal;
}): Promise<SuiteSelectionManifest> {
  const manifest =
    options.signal === undefined
      ? await options.session.cloud.compileSuiteSelection(options.request)
      : await options.session.cloud.compileSuiteSelection(options.request, options.signal);
  requirePinnedSelectionVersion(manifest, options.suiteVersion);
  return manifest;
}

function parseSelectionProfile(value: string): SelectionProfile {
  const parsed = SelectionProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw selectionError("SELECTION_PROFILE_INVALID", "Selection profile must be smoke or release.");
  }
  return parsed.data;
}

function splitTags(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}

async function buildCompileRequest(options: {
  readonly assessment: string | undefined;
  readonly cwd: string;
  readonly advertisement: SelectionAdvertisement;
  readonly profile: SelectionProfile | undefined;
  readonly includeCatalog: boolean;
  readonly includeTags: string[] | undefined;
  readonly excludeTags: string[] | undefined;
}): Promise<CompileSuiteSelectionRequest> {
  if (options.assessment !== undefined) {
    const loaded = await loadAssessmentFile({ path: options.assessment, cwd: options.cwd });
    if (loaded.document.selection === undefined && !options.includeCatalog && options.profile === undefined) {
      throw selectionError(
        "SELECTION_BLOCK_REQUIRED",
        "This assessment file has no selection block. Add smoke/release selection fields or pass --include-catalog --profile smoke|release."
      );
    }
    if (loaded.document.selection !== undefined) {
      const fromFile = compileRequestFromAssessment(loaded, options.advertisement, options.profile);
      return parseCompileRequest(
        {
          ...fromFile,
          ...(options.includeTags === undefined ? {} : { includeTags: options.includeTags }),
          ...(options.excludeTags === undefined ? {} : { excludeTags: options.excludeTags })
        },
        options.advertisement
      );
    }
  }
  if (options.profile === undefined) {
    throw selectionError(
      "SELECTION_PROFILE_INVALID",
      "Pass --profile smoke|release or an assessment file with a selection block."
    );
  }
  return compileRequestFromFlags({
    advertisement: options.advertisement,
    profile: options.profile,
    includeCatalog: true,
    ...(options.includeTags === undefined ? {} : { includeTags: options.includeTags }),
    ...(options.excludeTags === undefined ? {} : { excludeTags: options.excludeTags })
  });
}

export function advertisedConversationMode(resolved: ResolvedConfig): "single_turn" | "explicit_session_v1" {
  return conversationModeFromConfig(resolved);
}
