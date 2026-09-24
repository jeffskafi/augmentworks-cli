import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject
} from "node:crypto";

import { canonicalize, sha256 } from "../util/canonical.js";

const JWS_HEADER = { alg: "EdDSA", typ: "AW-JWS" } as const;

export function argumentRepresentationHash(value: unknown): string {
  return sha256(canonicalize(value));
}

export function argumentCommitment(options: {
  readonly rawArguments: unknown;
  readonly key: Uint8Array | string;
  readonly keyId: string;
}): { algorithm: "hmac-sha256"; value: string; keyId: string } {
  const secret = typeof options.key === "string" ? options.key : Buffer.from(options.key);
  const value = createHmac("sha256", secret).update(canonicalize(options.rawArguments)).digest("hex");
  return { algorithm: "hmac-sha256", value, keyId: options.keyId };
}

export function commitmentsMatch(
  left: { readonly algorithm: string; readonly value: string; readonly keyId: string },
  right: { readonly algorithm: string; readonly value: string; readonly keyId: string }
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.value === right.value &&
    left.keyId === right.keyId
  );
}

function base64url(bytes: Buffer | string): string {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return buffer.toString("base64url");
}

export function signDocument(document: Record<string, unknown>, privateKey: KeyObject, keyId: string): string {
  if (keyId.startsWith("aw-")) {
    throw new Error("Receiver signatures must not use a platform key id.");
  }
  const header = base64url(JSON.stringify({ ...JWS_HEADER, kid: keyId }));
  const payload = base64url(canonicalize(document));
  const input = Buffer.from(`${header}.${payload}`);
  const signature = sign(null, input, privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

export function verifyDocumentSignature(
  document: Record<string, unknown>,
  compact: string,
  publicKey: KeyObject
): boolean {
  const parts = compact.split(".");
  if (parts.length !== 3) return false;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) return false;
  let header: { alg?: string; typ?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as {
      alg?: string;
      typ?: string;
      kid?: string;
    };
  } catch {
    return false;
  }
  if (header.alg !== "EdDSA" || header.typ !== "AW-JWS" || header.kid === undefined) return false;
  const expectedPayload = base64url(canonicalize(document));
  if (payloadPart !== expectedPayload) return false;
  try {
    return verify(null, Buffer.from(`${headerPart}.${payloadPart}`), publicKey, Buffer.from(signaturePart, "base64url"));
  } catch {
    return false;
  }
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function isPlatformKeyId(keyId: string): boolean {
  return keyId.startsWith("aw-");
}
