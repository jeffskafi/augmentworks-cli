import { sanitizeTerminal } from "../errors.js";
import type { CatalogCase, CatalogPacket, CatalogProfile, CoverageCatalog } from "./schema.js";

export type CatalogListJson = {
  readonly ok: true;
  readonly schemaVersion: string;
  readonly catalogVersion: string;
  readonly catalogChecksum: string;
  readonly createsBillableRun: boolean;
  readonly staticCountsAreInformative: boolean;
  readonly quoteIsAuthoritative: boolean;
  readonly cache: {
    readonly fresh: boolean;
    readonly stale: boolean;
    readonly etag: string;
    readonly maxAgeSeconds: number;
  };
  readonly conversation: CoverageCatalog["conversation"];
  readonly packets: readonly Record<string, unknown>[];
  readonly profiles: readonly Record<string, unknown>[];
  readonly cases: readonly Record<string, unknown>[];
};

export function catalogListJson(
  catalog: CoverageCatalog,
  cache: { readonly fresh: boolean; readonly stale: boolean }
): CatalogListJson {
  return {
    ok: true,
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    catalogChecksum: catalog.catalogChecksum,
    createsBillableRun: catalog.createsBillableRun,
    staticCountsAreInformative: catalog.staticCountsAreInformative,
    quoteIsAuthoritative: catalog.quoteIsAuthoritative,
    cache: {
      fresh: cache.fresh,
      stale: cache.stale,
      etag: catalog.cache.etag,
      maxAgeSeconds: catalog.cache.maxAgeSeconds
    },
    conversation: catalog.conversation,
    packets: catalog.publishedPackets.map(packetSummary),
    profiles: catalog.profiles.map(profileSummary),
    cases: catalog.cases.map(caseSummary)
  };
}

export function formatCatalogListHuman(
  catalog: CoverageCatalog,
  cache: { readonly fresh: boolean; readonly stale: boolean }
): string {
  const lines = [
    `Catalog ${sanitizeTerminal(catalog.catalogVersion)} (${sanitizeTerminal(catalog.schemaVersion)})`,
    `Checksum ${sanitizeTerminal(catalog.catalogChecksum)}`,
    `Cache ${cache.fresh ? "fresh" : cache.stale ? "stale-if-error" : "revalidated"}`,
    "Static counts are informative. POST /v1/billing/quote is the only cost preview.",
    `Creates billable run: ${catalog.createsBillableRun ? "yes" : "no"}`,
    `Conversation implemented: ${catalog.conversation.implementedModes.join(", ")}`,
    `Reserved: ${(catalog.conversation.reservedModes ?? []).join(", ") || "none"}`,
    "",
    "Packets:"
  ];
  for (const packet of catalog.publishedPackets) {
    lines.push(
      `- ${sanitizeTerminal(packet.packetKey)}@${sanitizeTerminal(packet.version)} (${String(packet.caseIds.length)} cases, ${sanitizeTerminal(packet.evaluationMode)})`
    );
  }
  lines.push("", "Profiles:");
  for (const profile of catalog.profiles) {
    const count =
      profile.informativeExecutionCount == null
        ? "n/a"
        : String(profile.informativeExecutionCount);
    lines.push(
      `- ${sanitizeTerminal(profile.profileId)}: ${sanitizeTerminal(profile.label)} (informative executions ${count})`
    );
  }
  lines.push("", "Cases:");
  for (const catalogCase of catalog.cases) {
    lines.push(
      `- ${sanitizeTerminal(catalogCase.caseId)} [${sanitizeTerminal(catalogCase.conversationMode)}] ${sanitizeTerminal(catalogCase.name)}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function catalogDetailJson(
  catalog: CoverageCatalog,
  target: CatalogCase | CatalogPacket | CatalogProfile,
  kind: "case" | "packet" | "profile"
): Record<string, unknown> {
  return {
    ok: true,
    kind,
    catalogVersion: catalog.catalogVersion,
    catalogChecksum: catalog.catalogChecksum,
    createsBillableRun: catalog.createsBillableRun,
    staticCountsAreInformative: catalog.staticCountsAreInformative,
    quoteIsAuthoritative: catalog.quoteIsAuthoritative,
    detail: target
  };
}

export function formatCatalogCaseHuman(catalog: CoverageCatalog, catalogCase: CatalogCase): string {
  const hooks = Object.entries(catalogCase.requiredHooks)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  const required = catalogCase.requiredCriteria.map((entry) => entry.statement);
  const advisory = catalogCase.advisoryCriteria.map((entry) => entry.statement);
  const availability = caseAvailability(catalog, catalogCase);
  return [
    `Case ${sanitizeTerminal(catalogCase.caseId)}`,
    `Version ${sanitizeTerminal(catalogCase.version)} · packet ${sanitizeTerminal(catalogCase.packetKey)}@${sanitizeTerminal(catalogCase.packetVersion)}`,
    `Behavior: ${sanitizeTerminal(catalogCase.behaviorDescription)}`,
    `Example: ${sanitizeTerminal(catalogCase.exampleInput)}`,
    `Hooks: ${hooks.length === 0 ? "none" : hooks.join(", ")}`,
    `References: ${catalogCase.referenceBindingIds.join(", ") || "none"}`,
    `Session: ${sanitizeTerminal(catalogCase.conversationMode)}`,
    `Required criteria: ${required.length === 0 ? "none" : required.join("; ")}`,
    `Advisory criteria: ${advisory.length === 0 ? "none" : advisory.join("; ")}`,
    `Profiles: ${catalogCase.selectableProfileIds.join(", ") || "none"}`,
    `Availability: ${availability}`,
    "Static catalog counts are not permission to bypass a server quote."
  ].join("\n") + "\n";
}

export function formatCatalogPacketHuman(packet: CatalogPacket): string {
  const hooks = Object.entries(packet.requiredHooks)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  return [
    `Packet ${sanitizeTerminal(packet.packetKey)}@${sanitizeTerminal(packet.version)}`,
    sanitizeTerminal(packet.name),
    sanitizeTerminal(packet.description),
    `Evaluation: ${sanitizeTerminal(packet.evaluationMode)}`,
    `Hooks: ${hooks.length === 0 ? "none" : hooks.join(", ")}`,
    `Cases: ${packet.caseIds.join(", ")}`
  ].join("\n") + "\n";
}

export function formatCatalogProfileHuman(profile: CatalogProfile): string {
  const compiled =
    profile.compiled !== null &&
    typeof profile.compiled === "object" &&
    !Array.isArray(profile.compiled)
      ? (profile.compiled as Record<string, unknown>)
      : undefined;
  const exclusions = Array.isArray(compiled?.["exclusions"]) ? compiled["exclusions"] : [];
  return [
    `Profile ${sanitizeTerminal(profile.profileId)}`,
    sanitizeTerminal(profile.label),
    sanitizeTerminal(profile.description),
    `Assessment profile: ${sanitizeTerminal(profile.assessmentProfile ?? "n/a")}`,
    `Informative executions: ${profile.informativeExecutionCount == null ? "n/a" : String(profile.informativeExecutionCount)}`,
    `Selected cases: ${(profile.selectedCaseIds ?? []).join(", ") || "none"}`,
    `Compile exclusions: ${exclusions.length === 0 ? "none" : String(exclusions.length)}`,
    "Informative counts match the compiler only when required hooks and session mode are present."
  ].join("\n") + "\n";
}

function packetSummary(packet: CatalogPacket): Record<string, unknown> {
  return {
    packetKey: packet.packetKey,
    version: packet.version,
    name: packet.name,
    evaluationMode: packet.evaluationMode,
    requiredHooks: packet.requiredHooks,
    caseIds: packet.caseIds
  };
}

function profileSummary(profile: CatalogProfile): Record<string, unknown> {
  return {
    profileId: profile.profileId,
    label: profile.label,
    assessmentProfile: profile.assessmentProfile ?? null,
    informativeExecutionCount: profile.informativeExecutionCount ?? null,
    selectedCaseIds: profile.selectedCaseIds ?? [],
    repetitions: profile.repetitions ?? null
  };
}

function caseSummary(catalogCase: CatalogCase): Record<string, unknown> {
  return {
    caseId: catalogCase.caseId,
    version: catalogCase.version,
    name: catalogCase.name,
    packetKey: catalogCase.packetKey,
    packetVersion: catalogCase.packetVersion,
    conversationMode: catalogCase.conversationMode,
    requiredHooks: catalogCase.requiredHooks,
    referenceBindingIds: catalogCase.referenceBindingIds,
    requiredCriteria: catalogCase.requiredCriteria.map((entry) => entry.criterionId),
    advisoryCriteria: catalogCase.advisoryCriteria.map((entry) => entry.criterionId),
    selectableProfileIds: catalogCase.selectableProfileIds
  };
}

function caseAvailability(catalog: CoverageCatalog, catalogCase: CatalogCase): string {
  if (catalogCase.selectableProfileIds.length === 0) {
    return "not selectable in a public profile";
  }
  const customer = catalog.customerSuite as { ownership?: unknown } | undefined;
  if (typeof customer?.ownership === "string" && customer.ownership.includes("not_public")) {
    return `selectable in ${catalogCase.selectableProfileIds.join(", ")}; customer suites stay workspace-scoped`;
  }
  return `selectable in ${catalogCase.selectableProfileIds.join(", ")}`;
}
