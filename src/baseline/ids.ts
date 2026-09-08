import { AwError } from "../errors.js";
import { IDENTIFIER_PATTERN } from "./schema.js";

export function parseBoundIdentifier(
  value: string | undefined,
  field: "run" | "baseline"
): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    throw new AwError({
      code: "AMBIGUOUS_IDENTITY",
      category: "config",
      message: `Provide exactly one --${field} identifier. Comparison does not select a baseline or run automatically.`
    });
  }
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    throw new AwError({
      code: field === "run" ? "INVALID_RUN_ID" : "INVALID_BASELINE_ID",
      category: "config",
      message: `${field === "run" ? "Run" : "Baseline"} ID must be a bounded identifier without spaces.`
    });
  }
  return trimmed;
}

export function parseExpectedRevision(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    throw new AwError({
      code: "AMBIGUOUS_IDENTITY",
      category: "config",
      message:
        "Provide --expected-revision from the current pin. Promotion is never automatic and refuses a stale concurrent update."
    });
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new AwError({
      code: "INVALID_PROMOTION_REVISION",
      category: "config",
      message: "--expected-revision must be an integer between 0 and 1000000."
    });
  }
  return parsed;
}
