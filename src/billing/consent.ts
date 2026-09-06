import { createInterface } from "node:readline";

import { AwError } from "../errors.js";
import { stableBillingError } from "./errors.js";
import type { BillingQuote } from "./protocol.js";

const SAFE_INTEGER = String(Number.MAX_SAFE_INTEGER);

export function parseMaxCreditsFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/u.test(trimmed)) {
    throw new AwError({
      code: "INVALID_MAX_CREDITS",
      category: "config",
      message:
        "--max-credits must be a finite nonnegative integer. Fractions, signs, NaN, Infinity, and exponential notation are rejected."
    });
  }
  if (trimmed.length > SAFE_INTEGER.length || (trimmed.length === SAFE_INTEGER.length && trimmed > SAFE_INTEGER)) {
    throw new AwError({
      code: "INVALID_MAX_CREDITS",
      category: "config",
      message: "--max-credits exceeds the maximum safe integer."
    });
  }
  return Number(trimmed);
}

export function assertCeilingCoversQuote(maxCredits: number, quote: BillingQuote): void {
  if (quote.executionUnits > maxCredits) {
    throw stableBillingError(
      "BUDGET_EXCEEDED",
      `This quoted assessment costs ${String(quote.executionUnits)} credits, which exceeds --max-credits ${String(maxCredits)}. Raise the ceiling explicitly or reduce the assessment. --yes is not an unlimited budget. No target work started.`,
      false,
      {
        execution_units: quote.executionUnits,
        max_credits: maxCredits
      }
    );
  }
  if (maxCredits === 0 && quote.executionUnits > 0) {
    throw stableBillingError(
      "BUDGET_EXCEEDED",
      "A --max-credits ceiling of 0 rejects every positive-unit hosted run. It does not create a free hosted test.",
      false,
      { execution_units: quote.executionUnits, max_credits: 0 }
    );
  }
}

export function resolveSpendingCeiling(options: {
  readonly quote: BillingQuote;
  readonly maxCredits: number | undefined;
  readonly yes: boolean;
  readonly interactive: boolean;
}): number {
  const { quote, maxCredits, yes, interactive } = options;
  if (maxCredits !== undefined) {
    assertCeilingCoversQuote(maxCredits, quote);
    return maxCredits;
  }
  if (yes) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRED",
      category: "config",
      message:
        "--yes is not an unlimited spending budget. Pass --max-credits N with a finite nonnegative integer before a hosted assessment."
    });
  }
  if (!interactive) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRED",
      category: "config",
      message:
        "Noninteractive hosted tests require --max-credits N. The CLI will not start billed work without an explicit ceiling."
    });
  }
  return quote.executionUnits;
}

export async function confirmSpending(options: {
  readonly prompt: string;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
}): Promise<boolean> {
  const rl = createInterface({ input: options.stdin, output: options.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(options.prompt, resolve);
    });
    return /^(y|yes)$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}
