import { createHash, randomBytes } from "node:crypto";

/**
 * Run-local stable aliases. Reversal maps and raw-content hashes stay on this
 * machine and are never copied into receipts, journals, or report metadata.
 */
export function createLocalPseudonymizer(nonce = randomBytes(16).toString("hex")): {
  readonly nonce: string;
  alias(kind: "email" | "phone" | "identifier", value: string): string;
  reversalMap(): ReadonlyMap<string, string>;
} {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  return {
    nonce,
    alias(kind, value) {
      const existing = forward.get(value);
      if (existing !== undefined) return existing;
      const digest = createHash("sha256").update(`${nonce}:${kind}:${value}`).digest("hex").slice(0, 12);
      const alias = `[PSEUDONYM:${kind}:${digest}]`;
      forward.set(value, alias);
      reverse.set(alias, value);
      return alias;
    },
    reversalMap() {
      return new Map(reverse);
    }
  };
}
