import { z } from "zod";

export const ASSESSMENT_FILE_SCHEMA = "aw-assessment-file/1" as const;
export const DISCLOSURE_VERSION = "aw-judge-disclosure/1" as const;
export const MAX_ASSESSMENT_FILE_BYTES = 64 * 1024;
export const MAX_REFERENCE_BYTES_TOTAL = 64 * 1024;
export const MAX_REFERENCE_ENTRIES = 16;

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a bounded protocol identifier");
const semver = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/);

export const AssessmentProfileSchema = z.enum(["quick", "full", "combined", "custom"]);
export const EvaluationModeSchema = z.enum(["deterministic", "hybrid"]);
export const ReferenceKindSchema = z.enum([
  "approved_policy",
  "reference_answer",
  "reference_facts",
  "allowed_escalation_route",
  "synthetic_fixture_facts"
]);

const relativeReferencePath = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:md|txt)$/, "must be a relative .md or .txt path")
  .refine((value) => !value.includes(".."), "must not contain parent-directory segments")
  .refine((value) => !value.startsWith("/"), "must be a relative path")
  .refine((value) => !/[*?[\]{}]/.test(value), "must not contain glob characters");

const localReferenceSchema = z
  .object({
    path: relativeReferencePath,
    id: identifier,
    kind: ReferenceKindSchema.default("reference_facts")
  })
  .strict();

const hostedReferenceSchema = z
  .object({
    id: identifier
  })
  .strict();

const packetSelectionSchema = z
  .object({
    key: identifier,
    version: semver,
    scenarios: z.array(identifier).max(20).optional()
  })
  .strict();

const parameterValueSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);

export const AssessmentFileSchema = z
  .object({
    schema_version: z.literal(ASSESSMENT_FILE_SCHEMA),
    profile: AssessmentProfileSchema,
    evaluation_mode: EvaluationModeSchema,
    packets: z.array(packetSelectionSchema).min(1).max(2),
    references: z
      .object({
        local: z.array(localReferenceSchema).max(MAX_REFERENCE_ENTRIES).optional(),
        hosted: z.array(hostedReferenceSchema).max(MAX_REFERENCE_ENTRIES).optional()
      })
      .strict()
      .optional(),
    parameters: z
      .record(identifier, z.record(z.string().max(80), parameterValueSchema))
      .optional(),
    knowledge_boundary: z.string().max(4_000).optional(),
    target_already_configured: z.boolean().optional(),
    refund_policy: z
      .object({
        amount_cap_minor_units: z.number().int().min(0).max(1_000_000_000),
        currency: z.string().length(3).regex(/^[A-Z]{3}$/),
        eligibility_rule: z.string().min(1).max(500),
        refusal_enforcement_mode: z.enum(["refuse_before_tool", "tool_enforced_denial"]),
        require_confirmation: z.boolean(),
        unit_adapter_version: z.literal("usd-cents/1"),
        prose: z.string().max(8_000).optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    const localCount = value.references?.local?.length ?? 0;
    const hostedCount = value.references?.hosted?.length ?? 0;
    if (localCount > 0 && hostedCount > 0) {
      context.addIssue({
        code: "custom",
        message: "Use local reference paths or hosted reference ids, not both",
        path: ["references"]
      });
    }
    if (localCount + hostedCount > MAX_REFERENCE_ENTRIES) {
      context.addIssue({
        code: "custom",
        message: `At most ${MAX_REFERENCE_ENTRIES} reference entries are allowed`,
        path: ["references"]
      });
    }
    const parameterBindings = value["parameters"] ?? {};
    if (Object.keys(parameterBindings).length > 20) {
      context.addIssue({
        code: "custom",
        message: "at most 20 scenario parameter bindings are allowed",
        path: ["parameters"]
      });
    }
    for (const [scenarioId, bindings] of Object.entries(parameterBindings)) {
      if (Object.keys(bindings).length > 32) {
        context.addIssue({
          code: "custom",
          message: "at most 32 parameters are allowed per scenario",
          path: ["parameters", scenarioId]
        });
      }
    }
    if (value.profile === "custom") {
      const selected = value.packets.flatMap((packet) => packet.scenarios ?? []);
      if (selected.length === 0) {
        context.addIssue({
          code: "custom",
          message: "custom profiles must select at least one scenario id",
          path: ["packets"]
        });
      }
    }
    const packetKeys = value.packets.map((packet) => `${packet.key}@${packet.version}`);
    if (new Set(packetKeys).size !== packetKeys.length) {
      context.addIssue({
        code: "custom",
        message: "packet selections must be unique",
        path: ["packets"]
      });
    }
  });

export type AssessmentProfile = z.infer<typeof AssessmentProfileSchema>;
export type EvaluationMode = z.infer<typeof EvaluationModeSchema>;
export type AssessmentFile = z.infer<typeof AssessmentFileSchema>;
export type LocalReferenceSpec = z.infer<typeof localReferenceSchema>;
export type PacketSelection = z.infer<typeof packetSelectionSchema>;
