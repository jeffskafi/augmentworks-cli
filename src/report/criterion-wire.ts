import { z } from "zod";

import {
  CRITERION_DETAIL_SCHEMA_VERSION,
  CRITERION_PAGE_MAX,
  CriterionDetailSchema,
  CriterionIndexSchema,
  MappedAvailabilitySchema,
  type CriterionDetail,
  type CriterionIndex,
  type EvaluationBinding,
  type ExportDiagnostic
} from "./schema.js";

export const PRODUCER_CRITERION_DOCUMENT_SCHEMA_VERSION = "aw-criterion-detail/1" as const;
export const PRODUCER_FEATURE_PACKAGE_VERSION = "aw-feature/1" as const;

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedUrl = z.string().url().max(2_048);

const PRODUCER_WIRE_VERDICTS = [
  "pass",
  "fail",
  "error",
  "not_judged",
  "uncertain",
  "inconclusive",
  "not_applicable"
] as const;

type ProducerWireVerdict = (typeof PRODUCER_WIRE_VERDICTS)[number];

const ProducerWireVerdictSchema = z.enum(PRODUCER_WIRE_VERDICTS);
const ProducerVerdictFieldSchema = z.union([ProducerWireVerdictSchema, z.null(), z.string()]);

const ProducerIndexItemSchema = z
  .object({
    criterionId: identifier,
    criterionKey: identifier.optional(),
    requirement: z.enum(["required", "advisory"]).optional(),
    required: z.boolean().optional(),
    verdict: ProducerVerdictFieldSchema.optional(),
    detailUrl: boundedUrl.nullable().optional(),
    evidence: z.unknown().optional()
  })
  .passthrough();

const ProducerIndexSchema = z
  .object({
    schemaVersion: z.literal(CRITERION_DETAIL_SCHEMA_VERSION),
    evaluationId: identifier,
    evaluationRevision: z.number().int().min(0).max(1_000_000),
    snapshotHash: sha256Digest,
    attemptId: identifier,
    items: z.array(ProducerIndexItemSchema).max(CRITERION_PAGE_MAX),
    nextCursor: z.string().max(4_096).nullable(),
    limit: z.number().int().min(1).max(CRITERION_PAGE_MAX),
    totalInAttempt: z.number().int().min(0).max(10_000),
    createsBillableRun: z.literal(false),
    runId: identifier.optional(),
    workspaceId: identifier.optional(),
    documentKind: z.string().min(1).max(120).optional(),
    packageVersion: z.string().min(1).max(80).optional()
  })
  .passthrough();

const ProducerDocumentSchema = z
  .object({
    schemaVersion: z
      .union([
        z.literal(PRODUCER_CRITERION_DOCUMENT_SCHEMA_VERSION),
        z.literal(CRITERION_DETAIL_SCHEMA_VERSION)
      ])
      .optional(),
    criterionId: identifier,
    criterionKey: identifier.optional(),
    evaluationId: identifier.optional(),
    evaluationRevision: z.number().int().min(0).max(1_000_000).optional(),
    snapshotHash: sha256Digest.optional(),
    attemptId: identifier.optional(),
    runId: identifier.optional(),
    workspaceId: identifier.optional(),
    requirement: z.enum(["required", "advisory"]).optional(),
    required: z.boolean().optional(),
    verdict: ProducerVerdictFieldSchema,
    evidence: z.unknown().optional()
  })
  .passthrough();

const ProducerDetailSchema = z
  .object({
    schemaVersion: z.literal(CRITERION_DETAIL_SCHEMA_VERSION),
    document: ProducerDocumentSchema,
    inspection: z.unknown().optional(),
    createsBillableRun: z.literal(false).optional(),
    runId: identifier.optional(),
    workspaceId: identifier.optional(),
    documentKind: z.string().min(1).max(120).optional(),
    packageVersion: z.string().min(1).max(80).optional()
  })
  .passthrough();

export type CriterionWireContext = {
  readonly runId: string;
  readonly attemptId: string;
  readonly binding: EvaluationBinding;
  readonly workspaceId?: string;
  readonly indexUrl?: URL;
};

export type CriterionWireIndex = CriterionIndex & {
  readonly totalInAttempt: number | null;
  readonly limit: number | null;
  readonly source: "producer" | "legacy";
};

type CriterionWireMismatch = "id" | "binding" | "workspace";

export type CriterionWireFailure = {
  readonly ok: false;
  readonly diagnostic: ExportDiagnostic;
  readonly fatal: boolean;
  readonly mismatch?: CriterionWireMismatch;
};

export type CriterionWirePageResult =
  | { readonly ok: true; readonly kind: "index"; readonly index: CriterionWireIndex }
  | { readonly ok: true; readonly kind: "detail"; readonly detail: CriterionDetail }
  | CriterionWireFailure;

export type CriterionWireDetailResult =
  | { readonly ok: true; readonly kind: "detail"; readonly detail: CriterionDetail }
  | CriterionWireFailure;

type MappedVerdict = {
  readonly verdict: CriterionDetail["verdict"];
  readonly wireVerdict: ProducerWireVerdict | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFailure(value: unknown): value is CriterionWireFailure {
  return isRecord(value) && value["ok"] === false && isRecord(value["diagnostic"]);
}

function diagnostic(code: string, message: string): ExportDiagnostic {
  return { code, message };
}

function schemaFailure(message: string): CriterionWireFailure {
  return {
    ok: false,
    fatal: false,
    diagnostic: diagnostic("CRITERION_SCHEMA_INVALID", message)
  };
}

function mismatchFailure(mismatch: CriterionWireMismatch, code: string, message: string): CriterionWireFailure {
  return {
    ok: false,
    fatal: true,
    mismatch,
    diagnostic: diagnostic(code, message)
  };
}

function billableFailure(): CriterionWireFailure {
  return {
    ok: false,
    fatal: false,
    diagnostic: diagnostic(
      "CRITERION_BILLABLE_CLAIM",
      "A criterion response claimed createsBillableRun true; refusing a billed read."
    )
  };
}

function verifyPresentIdentities(
  present: {
    readonly runId?: string | undefined;
    readonly workspaceId?: string | undefined;
    readonly evaluationId?: string | undefined;
    readonly evaluationRevision?: number | undefined;
    readonly snapshotHash?: string | undefined;
    readonly attemptId?: string | undefined;
  },
  context: CriterionWireContext
): CriterionWireFailure | undefined {
  if (present.runId !== undefined && present.runId !== context.runId) {
    return mismatchFailure(
      "id",
      "CRITERION_ID_MISMATCH",
      "A criterion document did not match the parent run or attempt."
    );
  }
  if (present.attemptId !== undefined && present.attemptId !== context.attemptId) {
    return mismatchFailure(
      "id",
      "CRITERION_ID_MISMATCH",
      "A criterion document did not match the parent run or attempt."
    );
  }
  if (
    (present.evaluationId !== undefined && present.evaluationId !== context.binding.evaluationId) ||
    (present.evaluationRevision !== undefined &&
      present.evaluationRevision !== context.binding.evaluationRevision) ||
    (present.snapshotHash !== undefined && present.snapshotHash !== context.binding.snapshotHash)
  ) {
    return mismatchFailure(
      "binding",
      "CRITERION_BINDING_MISMATCH",
      "A criterion document was not pinned to the report evaluation binding."
    );
  }
  if (
    present.workspaceId !== undefined &&
    context.workspaceId !== undefined &&
    present.workspaceId !== context.workspaceId
  ) {
    return mismatchFailure(
      "workspace",
      "CRITERION_WORKSPACE_MISMATCH",
      "A criterion document workspaceId did not match the pinned report workspace."
    );
  }
  return undefined;
}

function mapVerdict(value: unknown): MappedVerdict | CriterionWireFailure {
  if (value === null) {
    return { verdict: "not_judged", wireVerdict: null };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      fatal: false,
      diagnostic: diagnostic(
        "CRITERION_VERDICT_UNSUPPORTED",
        "A criterion verdict was not a supported producer or export value."
      )
    };
  }
  if (value === "pass" || value === "fail" || value === "error" || value === "not_judged" || value === "uncertain") {
    return { verdict: value, wireVerdict: value };
  }
  if (value === "inconclusive") {
    return { verdict: "uncertain", wireVerdict: "inconclusive" };
  }
  if (value === "not_applicable") {
    return { verdict: "not_judged", wireVerdict: "not_applicable" };
  }
  return {
    ok: false,
    fatal: false,
    diagnostic: diagnostic(
      "CRITERION_VERDICT_UNSUPPORTED",
      `Unsupported criterion verdict ${value} was not converted to a passing result.`
    )
  };
}

function mapRequirement(source: {
  readonly requirement?: "required" | "advisory" | undefined;
  readonly required?: boolean | undefined;
}): { ok: true; required: boolean } | { ok: true; required: undefined } | CriterionWireFailure {
  if (source.requirement !== undefined && source.required !== undefined) {
    const fromRequirement = source.requirement === "required";
    if (fromRequirement !== source.required) {
      return schemaFailure("A criterion requirement field contradicted required.");
    }
  }
  if (source.requirement === "required" || source.required === true) return { ok: true, required: true };
  if (source.requirement === "advisory" || source.required === false) return { ok: true, required: false };
  return { ok: true, required: undefined };
}

function asText(value: unknown): string | null | undefined | CriterionWireFailure {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > 64 * 1024) {
      return schemaFailure("Criterion evidence text exceeded the 64KiB bound.");
    }
    return value;
  }
  return schemaFailure("Criterion evidence text was not a string or null.");
}

function asSha256(value: unknown): string | null | undefined | CriterionWireFailure {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) return value;
  return schemaFailure("Criterion evidence sha256 was not a 64-character lowercase hex digest.");
}

function mapEvidence(value: unknown): { ok: true; evidence: CriterionDetail["evidence"] } | CriterionWireFailure {
  if (value === undefined || value === null) {
    return {
      ok: true,
      evidence: { availability: "missing", text: null, sha256: null, truncated: false }
    };
  }
  if (!isRecord(value)) {
    return schemaFailure("Criterion evidence was not an object.");
  }
  const nested = isRecord(value["content"])
    ? value["content"]
    : isRecord(value["body"])
      ? value["body"]
      : undefined;
  const availabilityRaw = value["availability"];
  if (availabilityRaw === undefined) {
    return {
      ok: true,
      evidence: { availability: "missing", text: null, sha256: null, truncated: false }
    };
  }
  const availabilityParsed = MappedAvailabilitySchema.safeParse(availabilityRaw);
  if (!availabilityParsed.success) {
    return schemaFailure("Criterion evidence availability was not a known retained value.");
  }
  const availability = availabilityParsed.data;
  const textResult = asText(value["text"] ?? nested?.["text"]);
  if (isFailure(textResult)) return textResult;
  const shaResult = asSha256(value["sha256"] ?? nested?.["sha256"]);
  if (isFailure(shaResult)) return shaResult;
  const text = textResult === undefined ? null : textResult;
  const digest = shaResult === undefined ? null : shaResult;
  let truncated: boolean;
  if (value["truncated"] === true || value["truncated"] === false) {
    truncated = value["truncated"];
  } else if (availability === "available" || availability === "redacted") {
    truncated = true;
  } else {
    truncated = false;
  }
  return {
    ok: true,
    evidence: {
      availability,
      text,
      sha256: digest,
      truncated
    }
  };
}

export function criterionDetailUrlFromIndex(indexUrl: URL, criterionId: string): string {
  const url = new URL(indexUrl.href);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}/${encodeURIComponent(criterionId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function convertProducerItem(
  item: z.infer<typeof ProducerIndexItemSchema>,
  context: CriterionWireContext
): { ok: true; item: CriterionIndex["criteria"][number] } | CriterionWireFailure {
  const requirement = mapRequirement(item);
  if (isFailure(requirement)) return requirement;
  const required = requirement.required ?? true;
  const verdictResult = item.verdict === undefined ? undefined : mapVerdict(item.verdict);
  if (isFailure(verdictResult)) return verdictResult;
  const mappedVerdict = verdictResult;
  let evidence: CriterionDetail["evidence"] | undefined;
  if (item.evidence !== undefined) {
    const mapped = mapEvidence(item.evidence);
    if (isFailure(mapped)) return mapped;
    evidence = mapped.evidence;
  }
  let detailUrl = item.detailUrl ?? null;
  if (evidence === undefined) {
    if (detailUrl === null && context.indexUrl !== undefined) {
      detailUrl = criterionDetailUrlFromIndex(context.indexUrl, item.criterionId);
    }
  }
  const converted = {
    criterionId: item.criterionId,
    ...(item.criterionKey === undefined ? {} : { criterionKey: item.criterionKey }),
    required,
    verdict: mappedVerdict?.verdict ?? "not_judged",
    detailUrl,
    ...(evidence === undefined ? {} : { evidence }),
    ...(mappedVerdict === undefined ? {} : { wireVerdict: mappedVerdict.wireVerdict })
  };
  return { ok: true, item: converted };
}

function toWireIndex(
  index: CriterionIndex,
  extras: { totalInAttempt: number | null; limit: number | null; source: "producer" | "legacy" }
): CriterionWireIndex {
  return {
    ...index,
    totalInAttempt: extras.totalInAttempt,
    limit: extras.limit,
    source: extras.source
  };
}

function convertProducerIndex(
  payload: unknown,
  context: CriterionWireContext
): CriterionWirePageResult {
  if (isRecord(payload) && payload["createsBillableRun"] === true) return billableFailure();
  const parsed = ProducerIndexSchema.safeParse(payload);
  if (!parsed.success) {
    return schemaFailure("A criterion page did not match aw-criterion-detail-read/1.");
  }
  const mismatch = verifyPresentIdentities(parsed.data, context);
  if (mismatch !== undefined) return mismatch;
  if (parsed.data.items.length > parsed.data.limit) {
    return schemaFailure("A criterion page returned more items than its limit.");
  }
  const criteria: CriterionIndex["criteria"] = [];
  for (const item of parsed.data.items) {
    const converted = convertProducerItem(item, context);
    if (!converted.ok) return converted;
    criteria.push(converted.item);
  }
  const nextCursor =
    parsed.data.nextCursor === null || parsed.data.nextCursor === "" ? null : parsed.data.nextCursor;
  const converted = {
    schemaVersion: CRITERION_DETAIL_SCHEMA_VERSION,
    runId: parsed.data.runId ?? context.runId,
    ...(parsed.data.workspaceId === undefined ? {} : { workspaceId: parsed.data.workspaceId }),
    evaluationId: parsed.data.evaluationId,
    evaluationRevision: parsed.data.evaluationRevision,
    snapshotHash: parsed.data.snapshotHash,
    attemptId: parsed.data.attemptId,
    criteria,
    page: {
      nextCursor,
      hasMore: nextCursor !== null,
      totalCriteria: parsed.data.totalInAttempt
    },
    totalInAttempt: parsed.data.totalInAttempt,
    limit: parsed.data.limit,
    createsBillableRun: false,
    source: "producer" as const
  };
  const internal = CriterionIndexSchema.safeParse(converted);
  if (!internal.success) {
    return schemaFailure("A producer criterion page could not be converted to the export index.");
  }
  return {
    ok: true,
    kind: "index",
    index: toWireIndex(internal.data, {
      totalInAttempt: parsed.data.totalInAttempt,
      limit: parsed.data.limit,
      source: "producer"
    })
  };
}

function convertProducerDetail(
  payload: unknown,
  context: CriterionWireContext
): CriterionWireDetailResult {
  if (isRecord(payload) && payload["createsBillableRun"] === true) return billableFailure();
  const parsed = ProducerDetailSchema.safeParse(payload);
  if (!parsed.success) {
    return schemaFailure("A criterion detail document did not match aw-criterion-detail-read/1.");
  }
  const document = parsed.data.document;
  const mismatch = verifyPresentIdentities(
    {
      runId: document.runId ?? parsed.data.runId,
      workspaceId: document.workspaceId ?? parsed.data.workspaceId,
      evaluationId: document.evaluationId,
      evaluationRevision: document.evaluationRevision,
      snapshotHash: document.snapshotHash,
      attemptId: document.attemptId
    },
    context
  );
  if (mismatch !== undefined) return mismatch;
  const requirement = mapRequirement(document);
  if (isFailure(requirement)) return requirement;
  const verdictResult = mapVerdict(document.verdict);
  if (isFailure(verdictResult)) return verdictResult;
  const evidenceResult = mapEvidence(document.evidence);
  if (isFailure(evidenceResult)) return evidenceResult;
  const converted = {
    schemaVersion: CRITERION_DETAIL_SCHEMA_VERSION,
    runId: document.runId ?? parsed.data.runId ?? context.runId,
    ...((document.workspaceId ?? parsed.data.workspaceId) === undefined
      ? {}
      : { workspaceId: document.workspaceId ?? parsed.data.workspaceId }),
    evaluationId: document.evaluationId ?? context.binding.evaluationId,
    evaluationRevision: document.evaluationRevision ?? context.binding.evaluationRevision,
    snapshotHash: document.snapshotHash ?? context.binding.snapshotHash,
    attemptId: document.attemptId ?? context.attemptId,
    criterionId: document.criterionId,
    ...(document.criterionKey === undefined ? {} : { criterionKey: document.criterionKey }),
    required: requirement.required ?? true,
    verdict: verdictResult.verdict,
    evidence: evidenceResult.evidence,
    wireVerdict: verdictResult.wireVerdict
  };
  const internal = CriterionDetailSchema.safeParse(converted);
  if (!internal.success) {
    return schemaFailure("A producer criterion detail could not be converted to the export document.");
  }
  return { ok: true, kind: "detail", detail: internal.data };
}

function convertLegacyIndex(payload: unknown, context: CriterionWireContext): CriterionWirePageResult {
  const parsed = CriterionIndexSchema.safeParse(payload);
  if (!parsed.success) {
    return schemaFailure("A criterion page did not match aw-criterion-detail-read/1.");
  }
  const mismatch = verifyPresentIdentities(parsed.data, context);
  if (mismatch !== undefined) return mismatch;
  return {
    ok: true,
    kind: "index",
    index: toWireIndex(parsed.data, {
      totalInAttempt: parsed.data.page.totalCriteria,
      limit: null,
      source: "legacy"
    })
  };
}

function convertLegacyDetail(payload: unknown, context: CriterionWireContext): CriterionWireDetailResult {
  const parsed = CriterionDetailSchema.safeParse(payload);
  if (!parsed.success) {
    return schemaFailure("A criterion detail document did not match aw-criterion-detail-read/1.");
  }
  const mismatch = verifyPresentIdentities(parsed.data, context);
  if (mismatch !== undefined) return mismatch;
  return { ok: true, kind: "detail", detail: parsed.data };
}

function featureErrorFailure(payload: Record<string, unknown>): CriterionWireFailure | undefined {
  if (payload["schemaVersion"] !== "aw-feature-error/1") return undefined;
  const error = isRecord(payload["error"]) ? payload["error"] : undefined;
  const message =
    typeof error?.["message"] === "string" && error["message"].length > 0
      ? error["message"].slice(0, 500)
      : "AugmentWorks returned an aw-feature-error/1 envelope instead of criterion detail.";
  return schemaFailure(message);
}

export function parseCriterionWirePage(
  payload: unknown,
  context: CriterionWireContext
): CriterionWirePageResult {
  if (!isRecord(payload)) {
    return schemaFailure("A criterion page did not match aw-criterion-detail-read/1.");
  }
  const featureError = featureErrorFailure(payload);
  if (featureError !== undefined) return featureError;
  const hasItems = Array.isArray(payload["items"]);
  const hasCriteria = Array.isArray(payload["criteria"]);
  const hasDocument = isRecord(payload["document"]);
  const hasFlatCriterion = typeof payload["criterionId"] === "string";
  if (hasItems && hasCriteria) {
    return schemaFailure("A criterion page mixed producer items with legacy criteria fields.");
  }
  if (hasItems) return convertProducerIndex(payload, context);
  if (hasDocument) return convertProducerDetail(payload, context);
  if (hasCriteria) return convertLegacyIndex(payload, context);
  if (hasFlatCriterion) return convertLegacyDetail(payload, context);
  return schemaFailure("A criterion page did not match aw-criterion-detail-read/1.");
}

export function parseCriterionWireDetail(
  payload: unknown,
  context: CriterionWireContext
): CriterionWireDetailResult {
  if (!isRecord(payload)) {
    return schemaFailure("A criterion detail document did not match aw-criterion-detail-read/1.");
  }
  const featureError = featureErrorFailure(payload);
  if (featureError !== undefined) return featureError;
  if (isRecord(payload["document"])) return convertProducerDetail(payload, context);
  return convertLegacyDetail(payload, context);
}

function wireVerdictOf(detail: CriterionDetail): unknown {
  return (detail as CriterionDetail & { readonly wireVerdict?: unknown }).wireVerdict;
}

export function criterionWireVerdictDiagnostics(
  details: readonly CriterionDetail[]
): ExportDiagnostic[] {
  const diagnostics: ExportDiagnostic[] = [];
  for (const detail of details) {
    if (!detail.required) continue;
    const wire = wireVerdictOf(detail);
    const incompleteWire =
      wire === null ||
      wire === "not_judged" ||
      wire === "inconclusive" ||
      wire === "not_applicable";
    if (incompleteWire) {
      diagnostics.push(
        diagnostic(
          "CRITERION_VERDICT_INCOMPLETE",
          `Required criterion ${detail.criterionId} retained a non-passing producer verdict.`
        )
      );
      continue;
    }
    if (wire === undefined && (detail.verdict === "not_judged" || detail.verdict === "uncertain")) {
      diagnostics.push(
        diagnostic(
          "CRITERION_VERDICT_INCOMPLETE",
          `Required criterion ${detail.criterionId} was not a completed pass or fail judgment.`
        )
      );
    }
  }
  return diagnostics;
}
