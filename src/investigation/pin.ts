import { AwError } from "../errors.js";
import { CustomerSuiteSchema, type CustomerSuite } from "../suite/schema.js";
import { suiteCreateFields, type SuiteRevisionPin } from "../suite/admit.js";
import type { LoadedCustomerSuite, LoadedSuiteReference } from "../suite/load.js";
import { sha256 } from "../util/canonical.js";
import type { CreateRunAssessment } from "../cloud/protocol.js";
import type { CloudClient } from "../cloud/client.js";
import type { InvestigationExport } from "./schema.js";
import {
  investigationError,
  pinnedCaseUnavailableError,
  pinnedRevisionUnavailableError
} from "./errors.js";
import { rewriteInvestigationKeys } from "./schema.js";

export type PinnedInvestigationSelection = {
  readonly pin: SuiteRevisionPin;
  readonly caseId: string;
  readonly loaded: LoadedCustomerSuite;
  readonly assessment: CreateRunAssessment;
};

function stripReferenceHash(value: unknown): unknown {
  const rewritten = rewriteInvestigationKeys(value);
  if (rewritten === null || typeof rewritten !== "object" || Array.isArray(rewritten)) return rewritten;
  const record = rewritten as Record<string, unknown>;
  const references = record["references"];
  if (!Array.isArray(references)) return rewritten;
  return {
    ...record,
    references: references.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const reference = entry as Record<string, unknown>;
      const { contentHash: _hash, ...rest } = reference;
      return rest;
    })
  };
}

function loadedReferences(document: CustomerSuite): LoadedSuiteReference[] {
  return (document.references ?? []).map((reference) => {
    const content = reference.content ?? "";
    const encoded = Buffer.from(content, "utf8");
    return {
      id: reference.id,
      kind: reference.kind,
      ...(reference.path === undefined ? {} : { path: reference.path }),
      content,
      contentHash: sha256(encoded),
      bytes: encoded.byteLength
    };
  });
}

export function parsePinnedSuiteDocument(value: unknown): CustomerSuite {
  const rewritten = stripReferenceHash(value);
  const parsed = CustomerSuiteSchema.safeParse(rewritten);
  if (!parsed.success) {
    throw investigationError(
      "PINNED_REVISION_INVALID",
      "The pinned suite revision document is not a valid aw-suite/1 case file. Reproduction will not guess another revision.",
      { field: parsed.error.issues[0]?.path.join(".") ?? "root" }
    );
  }
  return parsed.data;
}

export function investigationCreateFields(
  loaded: LoadedCustomerSuite,
  pin: SuiteRevisionPin,
  caseId: string
): CreateRunAssessment {
  const fields = suiteCreateFields(loaded, pin);
  return {
    ...fields,
    selected_scenario_ids: [caseId]
  };
}

export async function resolvePinnedInvestigationSelection(options: {
  readonly document: InvestigationExport;
  readonly cloud: CloudClient;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<PinnedInvestigationSelection> {
  const identities = options.document.identities;
  if (identities.suiteRevisionId.toLowerCase() === "latest") {
    throw pinnedRevisionUnavailableError({
      suiteId: identities.suiteId,
      revisionId: identities.suiteRevisionId
    });
  }
  let revision;
  try {
    revision = await options.cloud.getSuiteRevision(
      identities.suiteId,
      identities.suiteRevisionId,
      options.signal
    );
  } catch (error) {
    if (error instanceof AwError && error.details?.["http_status"] === 404) {
      throw pinnedRevisionUnavailableError({
        suiteId: identities.suiteId,
        revisionId: identities.suiteRevisionId
      });
    }
    throw error;
  }
  if (revision.suiteId !== identities.suiteId || revision.revisionId !== identities.suiteRevisionId) {
    throw pinnedRevisionUnavailableError({
      suiteId: identities.suiteId,
      revisionId: identities.suiteRevisionId
    });
  }
  if (revision.contentHash !== identities.suiteContentHash) {
    throw investigationError(
      "PINNED_REVISION_HASH_MISMATCH",
      "The server-pinned suite content hash does not match the investigation. Reproduction will not substitute another revision.",
      { localHash: identities.suiteContentHash, serverHash: revision.contentHash }
    );
  }
  const record = revision as typeof revision & { document?: unknown };
  const sourceDocument = revision.canonicalDocument ?? record.document;
  if (sourceDocument === undefined) {
    throw pinnedRevisionUnavailableError({
      suiteId: identities.suiteId,
      revisionId: identities.suiteRevisionId
    });
  }
  const suite = parsePinnedSuiteDocument(sourceDocument);
  if (suite.suiteId !== identities.suiteId) {
    throw pinnedRevisionUnavailableError({
      suiteId: identities.suiteId,
      revisionId: identities.suiteRevisionId
    });
  }
  const selected = suite.cases.find((suiteCase) => suiteCase.caseId === identities.caseId);
  if (selected === undefined) {
    throw pinnedCaseUnavailableError(identities.caseId);
  }
  const references = loadedReferences(suite);
  const canonicalDocument = {
    schemaVersion: suite.schemaVersion,
    suiteId: suite.suiteId,
    title: suite.title,
    ...(suite.description === undefined ? {} : { description: suite.description }),
    ...(suite.tags === undefined ? {} : { tags: suite.tags }),
    ...(suite.syntheticOnly === undefined ? {} : { syntheticOnly: suite.syntheticOnly }),
    cases: suite.cases,
    references: references.map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      ...(reference.path === undefined ? {} : { path: reference.path }),
      content: reference.content,
      contentHash: reference.contentHash
    }))
  };
  const loaded: LoadedCustomerSuite = {
    sourcePath: `pinned://${identities.suiteId}/${identities.suiteRevisionId}`,
    directory: options.cwd,
    sourceBytes: 0,
    yamlSha256: identities.suiteContentHash,
    document: suite,
    canonicalDocument,
    contentHash: identities.suiteContentHash,
    references,
    diagnostics: []
  };
  const pin: SuiteRevisionPin = {
    suiteId: identities.suiteId,
    revisionId: identities.suiteRevisionId,
    contentHash: identities.suiteContentHash
  };
  return {
    pin,
    caseId: identities.caseId,
    loaded,
    assessment: investigationCreateFields(loaded, pin, identities.caseId)
  };
}
