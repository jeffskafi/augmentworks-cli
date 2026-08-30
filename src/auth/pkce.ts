import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function randomUrlSafeString(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function createPkcePair(): PkcePair {
  const verifier = randomUrlSafeString(32);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}
