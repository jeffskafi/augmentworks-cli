import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rewriteOrigin } from "./fixtures.js";

const producerPath = resolve(
  fileURLToPath(new URL("../../contracts/aw-criterion-detail-read-v1.producer.fixtures.json", import.meta.url))
);

export type ProducerFixtureFile = {
  readonly schemaVersion: string;
  readonly source: {
    readonly producerCommit: string;
    readonly note: string;
  };
  readonly identities: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly evaluationId: string;
    readonly evaluationRevision: number;
    readonly snapshotHash: string;
    readonly attemptId: string;
    readonly criterionId: string;
    readonly clarityCriterionId: string;
  };
  readonly fixtures: Record<
    string,
    { readonly status: number; readonly headers?: Record<string, string>; readonly response: unknown }
  >;
};

export const PRODUCER_CRITERION_FIXTURES = JSON.parse(readFileSync(producerPath, "utf8")) as ProducerFixtureFile;

export const PRODUCER_COMMIT = PRODUCER_CRITERION_FIXTURES.source.producerCommit;
export const PRODUCER_RUN_ID = String(PRODUCER_CRITERION_FIXTURES.identities.runId);
export const PRODUCER_WORKSPACE_ID = String(PRODUCER_CRITERION_FIXTURES.identities.workspaceId);
export const PRODUCER_ATTEMPT_ID = String(PRODUCER_CRITERION_FIXTURES.identities.attemptId);
export const PRODUCER_CRITERION_ID = String(PRODUCER_CRITERION_FIXTURES.identities.criterionId);
export const PRODUCER_CLARITY_ID = String(PRODUCER_CRITERION_FIXTURES.identities.clarityCriterionId);

export function producerFixtureResponse(
  name: string,
  origin?: string
): { status: number; headers?: Record<string, string>; body: unknown } {
  const entry = PRODUCER_CRITERION_FIXTURES.fixtures[name];
  if (entry === undefined) throw new Error(`missing producer fixture ${name}`);
  return {
    status: entry.status,
    ...(entry.headers === undefined ? {} : { headers: entry.headers }),
    body: origin === undefined ? entry.response : rewriteOrigin(entry.response, origin)
  };
}
