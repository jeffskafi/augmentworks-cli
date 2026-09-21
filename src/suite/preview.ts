import {
  SUPPORTED_DETERMINISTIC_OBSERVATIONS,
  isAuthorizedCustomerSuite,
  isLiveCustomerSuite,
  projectedAttemptCount,
  projectedTurnCount,
  suiteEvaluationMode,
  suiteRequiresMultiTurn,
  type CustomerSuite,
  type SuiteCase
} from "./schema.js";
import { suitePacketBinding } from "./admit.js";
import type { LoadedCustomerSuite } from "./load.js";

export type SuiteCasePreview = {
  readonly caseId: string;
  readonly name: string | null;
  readonly tags: readonly string[];
  readonly turns: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly expectedFacts: readonly string[];
  readonly permittedRefusal: boolean | null;
  readonly criteria: ReadonlyArray<{
    readonly criterionId: string;
    readonly kind: string;
    readonly requirement: "required" | "advisory";
    readonly statement: string;
  }>;
  readonly observations: ReadonlyArray<{ readonly key: string; readonly expected?: unknown }>;
  readonly referenceIds: readonly string[];
};

export type SuitePreview = {
  readonly schemaVersion: string;
  readonly suiteId: string;
  readonly title: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly caseCount: number;
  readonly projectedAttemptCount: number;
  readonly projectedTurnCount: number;
  readonly requiresMultiTurn: boolean;
  readonly evaluationMode: "deterministic" | "hybrid";
  readonly tags: readonly string[];
  readonly syntheticOnly: boolean;
  readonly liveTarget: {
    readonly schemaVersion: string;
    readonly mode: "informational";
    readonly origin: string;
    readonly authorizationKind: string;
    readonly authorizationRef: string;
    readonly expiresAt: string;
    readonly maxMessages: number;
  } | null;
  readonly packet: { readonly key: string; readonly version: string };
  readonly executionScope: {
    readonly schemaVersion: string;
    readonly scopeId: string;
    readonly revision: number | null;
    readonly scopeHash: string | null;
  } | null;
  readonly references: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly path?: string;
    readonly contentHash: string;
  }>;
  readonly supportedDeterministicObservations: readonly string[];
  readonly cases: readonly SuiteCasePreview[];
  readonly localPreview: {
    readonly authoritativePrice: false;
    readonly executesTarget: false;
    readonly callsLlm: false;
  };
};

function previewCase(suiteCase: SuiteCase): SuiteCasePreview {
  return {
    caseId: suiteCase.caseId,
    name: suiteCase.name ?? null,
    tags: suiteCase.tags ?? [],
    turns: suiteCase.turns.map((turn) => ({ role: "user", content: turn.content })),
    expectedFacts: suiteCase.expected.facts,
    permittedRefusal: suiteCase.expected.permittedRefusal ?? null,
    criteria: suiteCase.criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      kind: criterion.kind,
      requirement: criterion.requirement,
      statement: criterion.statement
    })),
    observations: (suiteCase.observations ?? []).map((observation) => ({
      key: observation.key,
      ...(observation.expected === undefined ? {} : { expected: observation.expected })
    })),
    referenceIds: suiteCase.referenceIds ?? []
  };
}

export function previewCustomerSuite(loaded: LoadedCustomerSuite): SuitePreview {
  const document: CustomerSuite = loaded.document;
  const live = isLiveCustomerSuite(document);
  const authorized = isAuthorizedCustomerSuite(document);
  return {
    schemaVersion: document.schemaVersion,
    suiteId: document.suiteId,
    title: document.title,
    sourcePath: loaded.sourcePath,
    contentHash: loaded.contentHash,
    caseCount: document.cases.length,
    projectedAttemptCount: projectedAttemptCount(document),
    projectedTurnCount: projectedTurnCount(document),
    requiresMultiTurn: suiteRequiresMultiTurn(document),
    evaluationMode: suiteEvaluationMode(document),
    tags: document.tags ?? [],
    syntheticOnly: !live && !authorized,
    liveTarget: live
      ? {
          schemaVersion: document.liveTarget.schemaVersion,
          mode: document.liveTarget.mode,
          origin: document.liveTarget.origin,
          authorizationKind: document.liveTarget.authorizationKind,
          authorizationRef: document.liveTarget.authorizationRef,
          expiresAt: document.liveTarget.expiresAt,
          maxMessages: document.liveTarget.maxMessages
        }
      : null,
    packet: suitePacketBinding(loaded),
    executionScope: authorized
      ? {
          schemaVersion: document.executionScope.schemaVersion,
          scopeId: document.executionScope.scopeId,
          revision: document.executionScope.revision ?? null,
          scopeHash: document.executionScope.scopeHash ?? null
        }
      : null,
    references: loaded.references.map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      ...(reference.path === undefined ? {} : { path: reference.path }),
      contentHash: reference.contentHash
    })),
    supportedDeterministicObservations: SUPPORTED_DETERMINISTIC_OBSERVATIONS,
    cases: document.cases.map(previewCase),
    localPreview: {
      authoritativePrice: false,
      executesTarget: false,
      callsLlm: false
    }
  };
}
