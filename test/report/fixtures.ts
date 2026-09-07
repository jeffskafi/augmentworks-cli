import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesPath = resolve(fileURLToPath(new URL("../../contracts/aw-run-report-v1.fixtures.json", import.meta.url)));

export type ReportFixtureFile = {
  readonly identities: Record<string, Record<string, unknown>>;
  readonly fixtures: Record<
    string,
    { readonly status: number; readonly headers?: Record<string, string>; readonly response: unknown }
  >;
};

export const REPORT_FIXTURES = JSON.parse(readFileSync(fixturesPath, "utf8")) as ReportFixtureFile;
export const REPORT_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CANONICAL_ORIGIN = "https://augmentworks.ai";

export function rewriteOrigin(value: unknown, origin: string): unknown {
  if (typeof value === "string") return value.split(CANONICAL_ORIGIN).join(origin);
  if (Array.isArray(value)) return value.map((item) => rewriteOrigin(item, origin));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        rewriteOrigin(child, origin)
      ])
    );
  }
  return value;
}

export function fixtureResponse(name: string, origin: string): { status: number; headers?: Record<string, string>; body: unknown } {
  const entry = REPORT_FIXTURES.fixtures[name];
  if (entry === undefined) throw new Error(`missing fixture ${name}`);
  return {
    status: entry.status,
    ...(entry.headers === undefined ? {} : { headers: entry.headers }),
    body: rewriteOrigin(entry.response, origin)
  };
}

export function fixtureIdentity(name: string): Record<string, unknown> {
  const identity = REPORT_FIXTURES.identities[name];
  if (identity === undefined) throw new Error(`missing identity ${name}`);
  return identity;
}
