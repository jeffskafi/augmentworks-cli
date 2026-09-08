import { AwError } from "../errors.js";
import { createsBillableRunError } from "./errors.js";
import {
  ApplicationsResponseSchema,
  normalizeRecord,
  type ApplicationsResponse
} from "./protocol.js";

export interface NormalizedApplications {
  readonly createsBillableRun: boolean;
  readonly schemaVersion: string | undefined;
  readonly applications: readonly unknown[];
  readonly baselines: readonly unknown[];
  readonly raw: ApplicationsResponse;
}

export function normalizeApplicationsResponse(value: unknown): NormalizedApplications {
  const record = normalizeRecord(value) ?? {};
  const parsed = ApplicationsResponseSchema.safeParse({
    ...record,
    schemaVersion: record["schemaVersion"] ?? record["schema_version"],
    createsBillableRun: record["createsBillableRun"] ?? record["creates_billable_run"]
  });
  if (!parsed.success) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned an invalid applications document."
    });
  }
  const createsBillableRun =
    parsed.data.createsBillableRun === true || record["creates_billable_run"] === true;
  if (createsBillableRun) throw createsBillableRunError();
  return {
    createsBillableRun: false,
    schemaVersion: parsed.data.schemaVersion,
    applications: Array.isArray(parsed.data.applications) ? parsed.data.applications : [],
    baselines: Array.isArray(parsed.data.baselines) ? parsed.data.baselines : [],
    raw: parsed.data
  };
}

export function collectBaselineIds(value: unknown): string[] {
  const ids: string[] = [];
  walk(value, ids);
  return [...new Set(ids)];
}

function walk(value: unknown, ids: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, ids);
    return;
  }
  const record = normalizeRecord(value);
  if (record === undefined) return;
  const baselineId = record["baselineId"] ?? record["baseline_id"];
  if (typeof baselineId === "string" && baselineId.trim() !== "") ids.push(baselineId);
  for (const nested of Object.values(record)) walk(nested, ids);
}
