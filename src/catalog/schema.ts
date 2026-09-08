import { z } from "zod";

export const COVERAGE_CATALOG_SCHEMA_VERSION = "aw-coverage-catalog/1" as const;
export const COVERAGE_CATALOG_DOCUMENT_KIND = "coverage_catalog" as const;
export const COVERAGE_CATALOG_ERROR_KIND = "coverage_catalog_error" as const;
export const CATALOG_CACHE_SCHEMA_VERSION = "aw-catalog-cache/1" as const;

export const CATALOG_PATHS = {
  coverage: "/v1/catalog/coverage"
} as const;

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const semver = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/);

const hooksSchema = z
  .object({
    prepare: z.boolean(),
    observation: z.boolean().optional(),
    observe: z.boolean().optional(),
    toolEvents: z.boolean().optional(),
    cleanup: z.boolean()
  })
  .passthrough();

const criterionSchema = z
  .object({
    criterionId: identifier,
    statement: z.string().min(1).max(2_000),
    kind: z.string().min(1).max(80)
  })
  .passthrough();

export const CatalogCaseSchema = z
  .object({
    caseId: identifier,
    version: z.string().min(1).max(80),
    packetKey: identifier,
    packetVersion: semver,
    packetSha256: sha256.optional(),
    name: z.string().min(1).max(200),
    category: z.string().min(1).max(80).optional(),
    severity: z.string().min(1).max(80).optional(),
    behaviorDescription: z.string().min(1).max(4_000),
    exampleInput: z.string().min(1).max(4_000),
    requiredHooks: hooksSchema,
    lifecycle: z.record(z.string(), z.unknown()).optional(),
    observationKeys: z.array(z.string().min(1).max(300)).max(64).optional(),
    referenceBindingIds: z.array(identifier).max(16),
    requiredCriteria: z.array(criterionSchema).max(32),
    advisoryCriteria: z.array(criterionSchema).max(32),
    conversationMode: z.string().min(1).max(80),
    conversationStrategy: z.string().min(1).max(80).optional(),
    turnCount: z.number().int().min(1).max(20).optional(),
    selectableProfileIds: z.array(identifier).max(16)
  })
  .passthrough();

export const CatalogPacketSchema = z
  .object({
    packetKey: identifier,
    version: semver,
    sha256: sha256.optional(),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(4_000),
    evaluationMode: z.string().min(1).max(80),
    syntheticOnly: z.boolean().optional(),
    requiredHooks: hooksSchema,
    caseIds: z.array(identifier).max(48),
    starterName: z.string().min(1).max(80).optional(),
    assessmentFilename: z.string().min(1).max(200).optional()
  })
  .passthrough();

export const CatalogProfileSchema = z
  .object({
    profileId: identifier,
    mode: z.string().min(1).max(80).optional(),
    assessmentProfile: z.string().min(1).max(80).optional(),
    label: z.string().min(1).max(200),
    description: z.string().min(1).max(4_000),
    packetBindings: z
      .array(
        z
          .object({
            key: identifier,
            version: semver,
            sha256: sha256.optional()
          })
          .passthrough()
      )
      .max(4)
      .optional(),
    selectedCaseIds: z.array(identifier).max(48).optional(),
    repetitions: z.number().int().min(1).max(8).optional(),
    informativeExecutionCount: z.number().int().min(0).max(10_000).optional(),
    compiled: z.unknown().nullable().optional(),
    requires: z.unknown().optional(),
    operatorGuidance: z.unknown().optional()
  })
  .passthrough();

export const CoverageCatalogSchema = z
  .object({
    schemaVersion: z.literal(COVERAGE_CATALOG_SCHEMA_VERSION),
    documentKind: z.literal(COVERAGE_CATALOG_DOCUMENT_KIND),
    catalogVersion: semver,
    catalogChecksum: sha256,
    createsBillableRun: z.boolean(),
    staticCountsAreInformative: z.boolean(),
    quoteIsAuthoritative: z.boolean(),
    packetSchema: z.string().min(1).max(80).optional(),
    cache: z
      .object({
        etag: z.string().min(1).max(200),
        maxAgeSeconds: z.number().int().min(0).max(86_400),
        staleIfErrorSeconds: z.number().int().min(0).max(604_800)
      })
      .passthrough(),
    billing: z
      .object({
        quotePath: z.string().min(1).max(200).optional(),
        quoteIsAuthoritative: z.boolean().optional(),
        staticCountsAreNotPermission: z.boolean().optional()
      })
      .passthrough()
      .optional(),
    conversation: z
      .object({
        capabilityVersion: z.string().min(1).max(80).optional(),
        implementedModes: z.array(z.string().min(1).max(80)).max(8),
        reservedModes: z.array(z.string().min(1).max(80)).max(8).optional(),
        defaultMode: z.string().min(1).max(80).optional(),
        verifiedSessionMode: z.string().min(1).max(80).optional()
      })
      .passthrough(),
    discovery: z.record(z.string(), z.unknown()).optional(),
    customerSuite: z.record(z.string(), z.unknown()).optional(),
    publishedPackets: z.array(CatalogPacketSchema).min(1).max(8),
    profiles: z.array(CatalogProfileSchema).min(1).max(16),
    cases: z.array(CatalogCaseSchema).min(1).max(48),
    notes: z.array(z.string().max(1_000)).max(16).optional()
  })
  .passthrough();

export const CoverageCatalogErrorSchema = z
  .object({
    schemaVersion: z.literal(COVERAGE_CATALOG_SCHEMA_VERSION),
    documentKind: z.literal(COVERAGE_CATALOG_ERROR_KIND),
    createsBillableRun: z.boolean(),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(1_000),
        retryable: z.boolean().optional()
      })
      .passthrough(),
    catalog: CoverageCatalogSchema.optional()
  })
  .passthrough();

export const CatalogCacheRecordSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_CACHE_SCHEMA_VERSION),
    origin: z.string().url(),
    etag: z.string().min(1).max(200),
    checksum: sha256,
    catalogVersion: semver,
    fetchedAtMs: z.number().int().min(0),
    maxAgeSeconds: z.number().int().min(0).max(86_400),
    staleIfErrorSeconds: z.number().int().min(0).max(604_800),
    document: CoverageCatalogSchema
  })
  .strict();

export type CoverageCatalog = z.infer<typeof CoverageCatalogSchema>;
export type CoverageCatalogError = z.infer<typeof CoverageCatalogErrorSchema>;
export type CatalogCase = z.infer<typeof CatalogCaseSchema>;
export type CatalogPacket = z.infer<typeof CatalogPacketSchema>;
export type CatalogProfile = z.infer<typeof CatalogProfileSchema>;
export type CatalogCacheRecord = z.infer<typeof CatalogCacheRecordSchema>;
