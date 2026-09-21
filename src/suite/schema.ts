import { z } from "zod";

import { SuiteExecutionScopeRefSchema } from "../real-data/documents.js";
import { LiveTargetContractSchema, LIVE_MAX_CASES } from "./live-target.js";

export const SUITE_SCHEMA_VERSION = "aw-suite/1" as const;
export const SUITE_SCHEMA_VERSION_V2 = "aw-suite/2" as const;
export const SUITE_SCHEMA_VERSION_V3 = "aw-suite/3" as const;
export const FEATURE_PACKAGE_VERSION = "aw-feature/1" as const;
export const FEATURE_ERROR_SCHEMA_VERSION = "aw-feature-error/1" as const;
export const CUSTOMER_OWNED_SUITE_PACKET = {
  key: "aw-customer-suite",
  version: "1.0.0"
} as const;
export const CUSTOMER_OWNED_SUITE_PACKET_V2 = {
  key: "aw-customer-suite",
  version: "2.0.0"
} as const;
export const CUSTOMER_OWNED_SUITE_PACKET_V3 = {
  key: "aw-customer-suite",
  version: "3.0.0"
} as const;
export const SUPPORTED_SUITE_SCHEMA_VERSIONS = [
  SUITE_SCHEMA_VERSION,
  SUITE_SCHEMA_VERSION_V2,
  SUITE_SCHEMA_VERSION_V3
] as const;
export const AUTHORIZED_MAX_TURNS = 3;
export const LIVE_SUITE_REFERENCE_KINDS = [
  "approved_policy",
  "reference_answer",
  "reference_facts",
  "allowed_escalation_route"
] as const;
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

const LiveSuiteReferenceSchema = z
  .object({
    id: identifier,
    kind: z.enum(LIVE_SUITE_REFERENCE_KINDS).default("reference_facts"),
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

function refineCustomerSuiteDocument(
  suite: {
    cases: z.infer<typeof SuiteCaseSchema>[];
    references?: Array<{ id: string }> | undefined;
  },
  context: z.RefinementCtx,
  options: { readonly live: boolean }
): void {
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
      if (options.live) {
        if (suiteCase.turns.length !== 1) {
          context.addIssue({
            code: "custom",
            message: "live informational cases must be exactly one turn",
            path: ["cases", caseIndex, "turns"]
          });
        }
        if ((suiteCase.repetitions ?? 1) !== 1) {
          context.addIssue({
            code: "custom",
            message: "live informational cases admit one repetition",
            path: ["cases", caseIndex, "repetitions"]
          });
        }
        if ((suiteCase.observations?.length ?? 0) > 0) {
          context.addIssue({
            code: "custom",
            message: "live informational cases cannot declare observations",
            path: ["cases", caseIndex, "observations"]
          });
        }
        for (const [criterionIndex, criterion] of suiteCase.criteria.entries()) {
          if (criterion.kind !== "llm_rubric") {
            context.addIssue({
              code: "custom",
              message: "live informational cases require response-only llm_rubric criteria",
              path: ["cases", caseIndex, "criteria", criterionIndex, "kind"]
            });
          }
        }
      }
    }
}

const LIVE_FORBIDDEN_CONTENT =
  /prompt\s*injection|jailbreak|penetration\s*test|security\s*prob|exploit|ssn\b|social security|credit card|password dump|pii\b/iu;

export const CustomerSuiteV1Schema = z
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
  .superRefine((suite, context) => refineCustomerSuiteDocument(suite, context, { live: false }));

export const CustomerSuiteV2Schema = z
  .object({
    schemaVersion: z.literal(SUITE_SCHEMA_VERSION_V2),
    suiteId: identifier,
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4_000).optional(),
    tags: tagsSchema.optional(),
    syntheticOnly: z.literal(false),
    liveTarget: LiveTargetContractSchema,
    references: z.array(LiveSuiteReferenceSchema).max(MAX_SUITE_REFERENCE_ENTRIES).optional(),
    cases: z.array(SuiteCaseSchema).min(1).max(LIVE_MAX_CASES)
  })
  .strict()
  .superRefine((suite, context) => {
    refineCustomerSuiteDocument(suite, context, { live: true });
    const texts = [
      suite.title,
      suite.description ?? "",
      ...suite.cases.flatMap((suiteCase) => [
        suiteCase.name ?? "",
        ...suiteCase.turns.map((turn) => turn.content),
        ...suiteCase.expected.facts,
        ...suiteCase.criteria.map((criterion) => criterion.statement)
      ])
    ];
    if (texts.some((text) => LIVE_FORBIDDEN_CONTENT.test(text))) {
      context.addIssue({
        code: "custom",
        message:
          "live informational suites cannot include prompt injection, security probing, transactions, or sensitive personal data",
        path: ["cases"]
      });
    }
  });

export const CustomerSuiteV3Schema = z
  .object({
    schemaVersion: z.literal(SUITE_SCHEMA_VERSION_V3),
    suiteId: identifier,
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4_000).optional(),
    tags: tagsSchema.optional(),
    executionScope: SuiteExecutionScopeRefSchema,
    references: z.array(SuiteReferenceSchema).max(MAX_SUITE_REFERENCE_ENTRIES).optional(),
    cases: z.array(SuiteCaseSchema).min(1).max(MAX_SUITE_CASES)
  })
  .strict()
  .superRefine((suite, context) => {
    refineCustomerSuiteDocument(suite, context, { live: false });
    for (const [caseIndex, suiteCase] of suite.cases.entries()) {
      if (suiteCase.turns.length > AUTHORIZED_MAX_TURNS) {
        context.addIssue({
          code: "custom",
          message: `authorized suites admit at most ${String(AUTHORIZED_MAX_TURNS)} turns per case`,
          path: ["cases", caseIndex, "turns"]
        });
      }
    }
  });

export const CustomerSuiteSchema = z.discriminatedUnion("schemaVersion", [
  CustomerSuiteV1Schema,
  CustomerSuiteV2Schema,
  CustomerSuiteV3Schema
]);

export type CustomerSuiteV1 = z.infer<typeof CustomerSuiteV1Schema>;
export type CustomerSuiteV2 = z.infer<typeof CustomerSuiteV2Schema>;
export type CustomerSuiteV3 = z.infer<typeof CustomerSuiteV3Schema>;
export type CustomerSuite = z.infer<typeof CustomerSuiteSchema>;
export type SuiteCase = z.infer<typeof SuiteCaseSchema>;
export type SuiteCriterion = z.infer<typeof SuiteCriterionSchema>;
export type SuiteReference = z.infer<typeof SuiteReferenceSchema>;
export type SuiteObservation = z.infer<typeof SuiteObservationSchema>;

export function isLiveCustomerSuite(suite: CustomerSuite): suite is CustomerSuiteV2 {
  return suite.schemaVersion === SUITE_SCHEMA_VERSION_V2;
}

export function isAuthorizedCustomerSuite(suite: CustomerSuite): suite is CustomerSuiteV3 {
  return suite.schemaVersion === SUITE_SCHEMA_VERSION_V3;
}

export function isSupportedSuiteSchemaVersion(version: string): boolean {
  return (SUPPORTED_SUITE_SCHEMA_VERSIONS as readonly string[]).includes(version);
}

const AUTHORING_KEY_MAP: Readonly<Record<string, string>> = {
  schema_version: "schemaVersion",
  suite_id: "suiteId",
  case_id: "caseId",
  criterion_id: "criterionId",
  permitted_refusal: "permittedRefusal",
  reference_ids: "referenceIds",
  pass_conditions: "passConditions",
  fail_conditions: "failConditions",
  synthetic_only: "syntheticOnly",
  live_target: "liveTarget",
  authorization_kind: "authorizationKind",
  authorization_ref: "authorizationRef",
  expires_at: "expiresAt",
  max_messages: "maxMessages",
  execution_scope: "executionScope",
  scope_id: "scopeId",
  scope_hash: "scopeHash",
  data_origin: "dataOrigin",
  data_class: "dataClass",
  data_policy: "dataPolicy",
  action_policy: "actionPolicy",
  max_actions: "maxActions",
  max_commands: "maxCommands",
  max_runtime_seconds: "maxRuntimeSeconds",
  max_credits: "maxCredits",
  target_boundary: "targetBoundary",
  assessed_origin: "assessedOrigin",
  allowed_operations: "allowedOperations"
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
