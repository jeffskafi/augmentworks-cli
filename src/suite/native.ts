import { z } from "zod";

import producerSchema from "../../contracts/aw-feature-v1.producer.schema.json" with { type: "json" };
import { canonicalize, sha256 } from "../util/canonical.js";
import type { LoadedCustomerSuite } from "./load.js";
import { suiteError } from "./errors.js";

/** Exact producer schema from augmentworks@7ee82d2f; authoring aw-suite/1 stays separate. */
const { oneOf: _documentChoices, ...producerDefinitions } = producerSchema;
export const NativeSuiteSourceSchema = z.fromJSONSchema({
  ...producerDefinitions,
  $ref: "#/$defs/customerSuiteSource"
} as Parameters<typeof z.fromJSONSchema>[0]);

export function nativeSuiteSource(loaded: LoadedCustomerSuite): Record<string, unknown> {
  const suite = loaded.document;
  if (suite.suiteId.includes("/") || suite.cases.some((item) => item.caseId.length > 160)) {
    throw suiteError("SUITE_HOSTED_INCOMPATIBLE", "Hosted suite IDs cannot contain '/' and case IDs must be at most 160 characters.");
  }
  if (suite.cases.some((item) => (item.observations?.length ?? 0) > 0 || item.criteria.some((criterion) => criterion.kind === "deterministic"))) {
    throw suiteError("SUITE_HOSTED_OBSERVATION_UNSUPPORTED", "The hosted customer-suite producer does not execute deterministic observations. Use supported response-only criteria; no suite, quote, or run was created.");
  }
  const document = {
    schemaVersion: "aw-customer-suite/1",
    documentKind: "customer_suite_source",
    suiteId: suite.suiteId,
    displayName: suite.title,
    description: suite.description?.trim() ? suite.description : (suite.title.trim() || suite.suiteId),
    syntheticOnly: true,
    conversationMode: suite.cases.some((item) => item.turns.length > 1) ? "explicit_session_v1" : "single_turn",
    tags: suite.tags ?? [],
    references: loaded.references.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      sourceLabel: entry.path ?? `inline:${entry.id}`,
      content: entry.content
    })),
    cases: suite.cases.map((item) => {
      const explicitReferences = [...new Set([...(item.referenceIds ?? []), ...item.criteria.flatMap((criterion) => criterion.referenceIds ?? [])])];
      const hasExplicitReferences = item.referenceIds !== undefined || item.criteria.some((criterion) => criterion.referenceIds !== undefined);
      const referenceIds = hasExplicitReferences ? explicitReferences : loaded.references.map((entry) => entry.id);
      return {
        caseId: item.caseId,
        displayName: item.name ?? item.caseId,
        description: item.name?.trim() ? item.name : item.caseId,
        tags: item.tags ?? [],
        repetitions: item.repetitions ?? 1,
        conversationMode: item.turns.length > 1 ? "explicit_session_v1" : "single_turn",
        lifecycle: { prepare: false, observe: false, cleanup: false },
        requiredCapabilities: { prepare: false, observation: false, toolEvents: false, cleanup: false, multiTurn: item.turns.length > 1 },
        turns: item.turns,
        expected: {
          kind: item.expected.permittedRefusal === true ? "permitted_refusal" : "facts",
          facts: item.expected.facts,
          permittedRefusal: item.expected.permittedRefusal === true ? { mustRefuse: true, allowedAlternatives: [] } : null
        },
        criteria: item.criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          version: "1.0.0",
          kind: criterion.kind,
          requirement: criterion.requirement,
          statement: criterion.statement,
          passConditions: criterion.passConditions ?? [],
          failConditions: criterion.failConditions ?? [],
          allowedAlternatives: [],
          requiredEvidenceKinds: (criterion.referenceIds ?? referenceIds).length > 0 ? ["assistant_response", "reference_entry"] : ["assistant_response"],
          referenceIds: criterion.referenceIds ?? referenceIds
        })),
        supportedObservations: [],
        referenceIds
      };
    })
  };
  const parsed = NativeSuiteSourceSchema.safeParse(document);
  if (!parsed.success) {
    throw suiteError("SUITE_HOSTED_INCOMPATIBLE", "The authoring file exceeds the hosted customer-suite contract. No suite, quote, or run was created.", { field: parsed.error.issues[0]?.path.join(".") ?? "root" });
  }
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > 256_000) {
    throw suiteError("SUITE_TOO_LARGE", "Hosted customer-suite source exceeds 256000 bytes.");
  }
  // Native source keys are ASCII and all numbers are bounded integer repetitions.
  // Their canonicalization is identical to the producer's byte-sorted JSON hash.
  return document;
}

export function nativeSuiteContentHash(document: Record<string, unknown>): string {
  return sha256(canonicalize(document));
}
