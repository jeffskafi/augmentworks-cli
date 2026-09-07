import { z } from "zod";

export const SUITE_SCHEMA_VERSION = "aw-suite/1" as const;
export const FEATURE_PACKAGE_VERSION = "aw-feature/1" as const;
export const FEATURE_ERROR_SCHEMA_VERSION = "aw-feature-error/1" as const;
export const CUSTOMER_OWNED_SUITE_PACKET = {
  key: "customer-owned-suite",
  version: "1.0.0"
} as const;
export const SUITE_CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const SUPPORTED_DETERMINISTIC_OBSERVATIONS = [
  "policy.window_days",
  "policy.permitted_refusal"
] as const;

export const MAX_SUITE_FILE_BYTES = 64 * 1024;
export const MAX_SUITE_REFERENCE_BYTES_TOTAL = 64 * 1024;
export const MAX_SUITE_REFERENCE_ENTRIES = 16;
export const MAX_SUITE_CASES = 20;
export const MAX_SUITE_TURNS = 20;
export const MAX_SUITE_REPETITIONS = 3;
export const MAX_SUITE_CRITERIA = 16;
export const MAX_SUITE_TAGS = 16;
export const MAX_SUITE_FACTS = 16;
export const MAX_SUITE_OBSERVATIONS = 16;

export const SUITE_REFERENCE_KINDS = [
  "approved_policy",
  "reference_answer",
  "reference_facts",
  "allowed_escalation_route",
  "synthetic_fixture_facts"
] as const;

export const SUITE_CRITERION_KINDS = ["llm_rubric", "deterministic"] as const;
export const SUITE_REQUIREMENTS = ["required", "advisory"] as const;

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a bounded protocol identifier");

const observationKey = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/,
    "must be a dotted observation key"
  );

const relativeReferencePath = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:md|txt)$/, "must be a relative .md or .txt path")
  .refine((value) => !value.includes(".."), "must not contain parent-directory segments")
  .refine((value) => !value.startsWith("/"), "must be a relative path")
  .refine((value) => !/[*?[\]{}]/.test(value), "must not contain glob characters");

const tagsSchema = z.array(identifier).max(MAX_SUITE_TAGS);

export const SuiteReferenceKindSchema = z.enum(SUITE_REFERENCE_KINDS);
export const SuiteCriterionKindSchema = z.enum(SUITE_CRITERION_KINDS);
export const SuiteRequirementSchema = z.enum(SUITE_REQUIREMENTS);

const jsonScalar = z.union([z.string().max(8_000), z.number().finite(), z.boolean(), z.null()]);

export const SuiteObservationSchema = z
  .object({
    key: observationKey,
    expected: jsonScalar.optional()
  })
  .strict();

export const SuiteCriterionSchema = z
  .object({
    criterionId: identifier,
    requirement: SuiteRequirementSchema,
    kind: SuiteCriterionKindSchema,
    statement: z.string().min(1).max(4_000),
    referenceIds: z.array(identifier).max(MAX_SUITE_REFERENCE_ENTRIES).optional(),
    passConditions: z.array(z.string().min(1).max(2_000)).max(16).optional(),
    failConditions: z.array(z.string().min(1).max(2_000)).max(16).optional()
  })
  .strict();

export const SuiteTurnSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(8_000)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 64 * 1024,
        "message content exceeds the UTF-8 byte limit"
      )
  })
  .strict();

export const SuiteExpectedSchema = z
  .object({
    facts: z.array(z.string().min(1).max(2_000)).max(MAX_SUITE_FACTS),
    permittedRefusal: z.boolean().optional()
  })
  .strict();

export const SuiteCaseSchema = z
  .object({
    caseId: identifier,
    name: z.string().min(1).max(200).optional(),
    tags: tagsSchema.optional(),
    turns: z.array(SuiteTurnSchema).min(1).max(MAX_SUITE_TURNS),
    expected: SuiteExpectedSchema,
    criteria: z.array(SuiteCriterionSchema).min(1).max(MAX_SUITE_CRITERIA),
    observations: z.array(SuiteObservationSchema).max(MAX_SUITE_OBSERVATIONS).optional(),
    repetitions: z.number().int().min(1).max(MAX_SUITE_REPETITIONS).optional(),
    referenceIds: z.array(identifier).max(MAX_SUITE_REFERENCE_ENTRIES).optional()
  })
  .strict();

export const SuiteReferenceSchema = z
  .object({
    id: identifier,
    kind: SuiteReferenceKindSchema.default("reference_facts"),
    path: relativeReferencePath.optional(),
    content: z.string().max(16_000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.path === undefined && (value.content === undefined || value.content.trim() === "")) {
      context.addIssue({
        code: "custom",
        message: "each reference needs a path or inline content",
        path: ["path"]
      });
    }
  });

export const CustomerSuiteSchema = z
  .object({
    schemaVersion: z.literal(SUITE_SCHEMA_VERSION),
    suiteId: identifier,
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4_000).optional(),
    tags: tagsSchema.optional(),
    syntheticOnly: z.literal(true).optional(),
    references: z.array(SuiteReferenceSchema).max(MAX_SUITE_REFERENCE_ENTRIES).optional(),
    cases: z.array(SuiteCaseSchema).min(1).max(MAX_SUITE_CASES)
  })
  .strict()
  .superRefine((suite, context) => {
    const caseIds = new Map<string, number>();
    const criterionIds = new Map<string, string>();
    const referenceIds = new Set((suite.references ?? []).map((entry) => entry.id));
    const declaredReferenceIds = suite.references ?? [];
    const seenReferenceIds = new Set<string>();
    for (const [index, entry] of declaredReferenceIds.entries()) {
      if (seenReferenceIds.has(entry.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate reference id ${entry.id}`,
          path: ["references", index, "id"]
        });
      }
      seenReferenceIds.add(entry.id);
    }

    for (const [caseIndex, suiteCase] of suite.cases.entries()) {
      const previous = caseIds.get(suiteCase.caseId);
      if (previous !== undefined) {
        context.addIssue({
          code: "custom",
          message: `duplicate case id ${suiteCase.caseId}`,
          path: ["cases", caseIndex, "caseId"]
        });
      }
      caseIds.set(suiteCase.caseId, caseIndex);

      const caseReferenceIds = [
        ...(suiteCase.referenceIds ?? []),
        ...suiteCase.criteria.flatMap((criterion) => criterion.referenceIds ?? [])
      ];
      for (const [criterionIndex, criterion] of suiteCase.criteria.entries()) {
        const owner = criterionIds.get(criterion.criterionId);
        if (owner !== undefined) {
          context.addIssue({
            code: "custom",
            message: `duplicate criterion id ${criterion.criterionId} (also used by ${owner})`,
            path: ["cases", caseIndex, "criteria", criterionIndex, "criterionId"]
          });
        }
        criterionIds.set(criterion.criterionId, suiteCase.caseId);
        if (criterion.kind === "deterministic" && (suiteCase.observations?.length ?? 0) === 0) {
          context.addIssue({
            code: "custom",
            message: "deterministic criteria require supported observations on the case",
            path: ["cases", caseIndex, "observations"]
          });
        }
      }
      const supportedObservations = new Set<string>(SUPPORTED_DETERMINISTIC_OBSERVATIONS);
      for (const [observationIndex, observation] of (suiteCase.observations ?? []).entries()) {
        if (!supportedObservations.has(observation.key)) {
          context.addIssue({
            code: "custom",
            message: `unsupported deterministic observation ${observation.key}`,
            path: ["cases", caseIndex, "observations", observationIndex, "key"]
          });
        }
      }
      for (const referenceId of caseReferenceIds) {
        if (!referenceIds.has(referenceId)) {
          context.addIssue({
            code: "custom",
            message: `missing reference ${referenceId}`,
            path: ["cases", caseIndex, "referenceIds"]
          });
        }
      }
    }
  });

export type CustomerSuite = z.infer<typeof CustomerSuiteSchema>;
export type SuiteCase = z.infer<typeof SuiteCaseSchema>;
export type SuiteCriterion = z.infer<typeof SuiteCriterionSchema>;
export type SuiteReference = z.infer<typeof SuiteReferenceSchema>;
export type SuiteObservation = z.infer<typeof SuiteObservationSchema>;

const AUTHORING_KEY_MAP: Readonly<Record<string, string>> = {
  schema_version: "schemaVersion",
  suite_id: "suiteId",
  case_id: "caseId",
  criterion_id: "criterionId",
  permitted_refusal: "permittedRefusal",
  reference_ids: "referenceIds",
  pass_conditions: "passConditions",
  fail_conditions: "failConditions",
  synthetic_only: "syntheticOnly"
};

export function rewriteAuthoringKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child) => rewriteAuthoringKeys(child));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[AUTHORING_KEY_MAP[key] ?? key] = rewriteAuthoringKeys(child);
  }
  return output;
}

export function customerSuiteSchemaVersion(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const version = record["schemaVersion"] ?? record["schema_version"];
  return typeof version === "string" ? version : undefined;
}

export function looksLikeCustomerSuiteDocument(value: unknown): boolean {
  const version = customerSuiteSchemaVersion(value);
  return typeof version === "string" && version.startsWith("aw-suite/");
}

export function sourceLooksLikeCustomerSuite(text: string): boolean {
  return /(?:schema_version|schemaVersion)\s*[:=]\s*["']?aw-suite\//u.test(text);
}

export function policyWindowContradiction(texts: readonly string[]): string | undefined {
  const asserts14 = texts.some((text) =>
    /\b(?:within|of|is)\s+14[-\s]?days?\b|\b14[-\s]?day(?:s)?\s+(?:return|window|policy)\b/iu.test(text)
  );
  const asserts30 = texts.some(
    (text) =>
      (/\b(?:within|of|is)\s+30[-\s]?days?\b|\b30[-\s]?day(?:s)?\s+(?:return|window|policy)\b/iu.test(text) &&
        !/\bdoes not apply\b/iu.test(text) &&
        !/\bnot\b.{0,80}30[-\s]?day/iu.test(text))
  );
  if (asserts14 && asserts30) {
    return "Return-window expectations and references disagree (14-day vs 30-day). Resolve the contradiction before quote; the CLI will not ask a judge to reconcile it.";
  }
  return undefined;
}

export function suiteRequiresMultiTurn(suite: CustomerSuite): boolean {
  return suite.cases.some((suiteCase) => suiteCase.turns.length > 1);
}

export function suiteRequiresObservation(suite: CustomerSuite): boolean {
  return suite.cases.some((suiteCase) => (suiteCase.observations?.length ?? 0) > 0);
}

export function suiteEvaluationMode(suite: CustomerSuite): "deterministic" | "hybrid" {
  return suite.cases.some((suiteCase) =>
    suiteCase.criteria.some((criterion) => criterion.kind === "llm_rubric")
  )
    ? "hybrid"
    : "deterministic";
}

export function projectedAttemptCount(suite: CustomerSuite): number {
  return suite.cases.reduce((total, suiteCase) => total + (suiteCase.repetitions ?? 1), 0);
}

export function projectedTurnCount(suite: CustomerSuite): number {
  return suite.cases.reduce(
    (total, suiteCase) => total + suiteCase.turns.length * (suiteCase.repetitions ?? 1),
    0
  );
}
