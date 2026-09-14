import { AwError } from "../errors.js";
import { canonicalize } from "../util/canonical.js";
import { computeManifestIntegrityHash } from "./admit.js";
import {
  createsBillableCompileError,
  manifestDeclarationDuplicateError,
  manifestDeclarationIncompleteError,
  manifestEmptyError,
  manifestGateContractUnsupportedError,
  manifestGateResponseMismatchError,
  manifestIntegrityMismatchError,
  manifestNotExecutableError,
  selectionError
} from "./errors.js";
import {
  EvaluateManifestGateRequestSchema,
  MANIFEST_GATE_DOCUMENT_KIND,
  MANIFEST_GATE_FORBIDDEN_REQUEST_KEYS,
  MANIFEST_GATE_MAX_BYTES,
  MANIFEST_GATE_MAX_SHARDS,
  MANIFEST_GATE_MIN_SHARDS,
  MANIFEST_GATE_REQUEST_SCHEMA_VERSION,
  MANIFEST_GATE_RETRY_AFTER_CAP_MS,
  MANIFEST_GATE_SERVER_REASON_CODES,
  MANIFEST_GATE_UNKNOWN_REASON,
  MANIFEST_RELEASE_POLICY_DOCUMENT_KIND,
  MANIFEST_RELEASE_POLICY_SCHEMA_VERSION,
  ManifestGateDeclaredShardSchema,
  ManifestReleasePolicyV2Schema,
  type DeclaredShard,
  type EvaluateManifestGateRequest,
  type ManifestGateDeclaredShard,
  type ManifestReleasePolicyV2,
  type SuiteSelectionManifest
} from "./schema.js";

const GATE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GATE_SHA256 = /^[a-f0-9]{64}$/;
const SERVER_REASON_SET = new Set<string>(MANIFEST_GATE_SERVER_REASON_CODES);

export interface ManifestGateIdentity {
  readonly shardId: string;
  readonly shardIdentityHash: string;
  readonly runId: string;
}

export function encodedGateDocumentBytes(value: unknown): number {
  return Buffer.byteLength(canonicalize(value), "utf8");
}

export function requireGateManifest(manifest: SuiteSelectionManifest): void {
  if (computeManifestIntegrityHash(manifest) !== manifest.manifestHash) {
    throw manifestIntegrityMismatchError();
  }
  if (manifest.createsBillableRun) {
    throw createsBillableCompileError();
  }
  if (manifest.includedCaseCount === 0 || manifest.shards.length === 0) {
    throw manifestEmptyError();
  }
  if (manifest.shards.length < MANIFEST_GATE_MIN_SHARDS || manifest.shards.length > MANIFEST_GATE_MAX_SHARDS) {
    throw manifestEmptyError();
  }
  if (!manifest.executable || manifest.shards.some((shard) => !shard.compileOk)) {
    throw manifestNotExecutableError(manifest.unexecutableReason ?? undefined);
  }
}

export function bindDeclaredShardsForGate(
  manifest: SuiteSelectionManifest,
  declared: readonly DeclaredShard[]
): ManifestGateDeclaredShard[] {
  requireGateManifest(manifest);
  if (declared.length === 0) {
    throw manifestDeclarationIncompleteError("No declarations were supplied.");
  }
  if (declared.length > MANIFEST_GATE_MAX_SHARDS) {
    throw manifestDeclarationIncompleteError("A release gate accepts at most 16 declarations.");
  }

  const shardIds: string[] = [];
  const hashes: string[] = [];
  const runIds: string[] = [];
  for (const [index, entry] of declared.entries()) {
    if (!GATE_SHA256.test(entry.shardIdentityHash ?? "")) {
      throw manifestDeclarationIncompleteError(
        `declaredShards[${String(index)}] needs a 64-character lowercase shardIdentityHash.`
      );
    }
    if (!GATE_UUID.test(entry.runId)) {
      throw manifestDeclarationIncompleteError(`declaredShards[${String(index)}] runId must be a lowercase UUID.`);
    }
    const parsed = ManifestGateDeclaredShardSchema.safeParse({
      shardId: entry.shardId,
      shardIdentityHash: entry.shardIdentityHash,
      runId: entry.runId
    });
    if (!parsed.success) {
      throw manifestDeclarationIncompleteError(`declaredShards[${String(index)}] is not a v2 identity declaration.`);
    }
    shardIds.push(parsed.data.shardId);
    hashes.push(parsed.data.shardIdentityHash);
    runIds.push(parsed.data.runId);
  }
  if (new Set(shardIds).size !== shardIds.length || new Set(hashes).size !== hashes.length || new Set(runIds).size !== runIds.length) {
    throw manifestDeclarationDuplicateError();
  }

  const expected = manifest.shards.map((shard) => ({
    shardId: shard.shardId,
    shardIdentityHash: shard.shardIdentityHash
  }));
  if (declared.length !== expected.length) {
    throw manifestDeclarationIncompleteError(
      `Expected ${String(expected.length)} shard(s); received ${String(declared.length)}.`
    );
  }
  const declaredById = new Map(declared.map((entry) => [entry.shardId, entry]));
  if (declaredById.size !== declared.length) {
    throw manifestDeclarationDuplicateError();
  }
  const bound: ManifestGateDeclaredShard[] = [];
  for (const shard of expected) {
    const match = declaredById.get(shard.shardId);
    if (match === undefined) {
      throw manifestDeclarationIncompleteError(`Missing declaration for shard ${shard.shardId}.`);
    }
    if (match.shardIdentityHash !== shard.shardIdentityHash) {
      throw manifestDeclarationIncompleteError(`Shard ${shard.shardId} identity hash does not match the compiled manifest.`);
    }
    bound.push({
      shardId: shard.shardId,
      shardIdentityHash: shard.shardIdentityHash,
      runId: match.runId
    });
  }
  for (const entry of declared) {
    if (!expected.some((shard) => shard.shardId === entry.shardId)) {
      throw manifestDeclarationIncompleteError(`Declaration ${entry.shardId} is not an expected compiled shard.`);
    }
  }
  return bound;
}

export function buildManifestGateRequest(
  manifest: SuiteSelectionManifest,
  declared: readonly DeclaredShard[]
): EvaluateManifestGateRequest {
  const bound = bindDeclaredShardsForGate(manifest, declared);
  const request = EvaluateManifestGateRequestSchema.parse({
    schemaVersion: MANIFEST_GATE_REQUEST_SCHEMA_VERSION,
    manifestHash: manifest.manifestHash,
    declaredShards: bound
  });
  assertIdentityOnlyRequest(request);
  if (encodedGateDocumentBytes(request) > MANIFEST_GATE_MAX_BYTES) {
    throw manifestGateContractUnsupportedError("The identity-only request exceeds 64 KiB.");
  }
  return request;
}

export function assertIdentityOnlyRequest(request: EvaluateManifestGateRequest): void {
  const keys = Object.keys(request);
  if (keys.length !== 3 || keys.some((key) => key !== "schemaVersion" && key !== "manifestHash" && key !== "declaredShards")) {
    throw manifestGateContractUnsupportedError("The release-gate request is not identity-only.");
  }
  for (const forbidden of MANIFEST_GATE_FORBIDDEN_REQUEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(request, forbidden)) {
      throw manifestGateContractUnsupportedError("The release-gate request included a forbidden field.");
    }
  }
  for (const shard of request.declaredShards) {
    const shardKeys = Object.keys(shard);
    if (
      shardKeys.length !== 3 ||
      !shardKeys.includes("shardId") ||
      !shardKeys.includes("shardIdentityHash") ||
      !shardKeys.includes("runId")
    ) {
      throw manifestGateContractUnsupportedError("A declared shard included a non-identity field.");
    }
  }
}

export function parseManifestGateResponse(
  value: unknown,
  request: EvaluateManifestGateRequest,
  options: { readonly encodedBytes?: number } = {}
): ManifestReleasePolicyV2 {
  if (options.encodedBytes !== undefined && options.encodedBytes > MANIFEST_GATE_MAX_BYTES) {
    throw manifestGateContractUnsupportedError("The receipt exceeds 64 KiB.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw manifestGateContractUnsupportedError();
  }
  const record = value as Record<string, unknown>;
  const documentKind = record["documentKind"];
  const schemaVersion = record["schemaVersion"];
  if (
    documentKind === MANIFEST_RELEASE_POLICY_DOCUMENT_KIND ||
    schemaVersion === MANIFEST_RELEASE_POLICY_SCHEMA_VERSION ||
    documentKind !== MANIFEST_GATE_DOCUMENT_KIND
  ) {
    throw manifestGateContractUnsupportedError();
  }
  if (encodedGateDocumentBytes(value) > MANIFEST_GATE_MAX_BYTES) {
    throw manifestGateContractUnsupportedError("The receipt exceeds 64 KiB.");
  }
  const parsed = ManifestReleasePolicyV2Schema.safeParse(value);
  if (!parsed.success) {
    throw manifestGateContractUnsupportedError();
  }
  const result = parsed.data;
  if (!identitySetsEqual(request.declaredShards, result.resolvedShards) || result.manifestHash !== request.manifestHash) {
    throw manifestGateContractUnsupportedError("The receipt does not prove the submitted manifest and shard identities.");
  }
  assertInternallyConsistent(result);
  return result;
}

export function mapServerReasonCodes(codes: readonly string[]): string[] {
  const mapped = codes.map((code) => (SERVER_REASON_SET.has(code) ? code : MANIFEST_GATE_UNKNOWN_REASON));
  return [...new Set(mapped)];
}

export function nextActionForGate(decision: ManifestReleasePolicyV2["decision"]): string {
  switch (decision) {
    case "pass":
      return "Release is authorized for this exact server-authoritative coverage. No further billed run is required.";
    case "block":
      return "Fix the blocked shards, then re-run the same suite and re-query this gate. Do not start another billed assessment from this receipt.";
    case "incomplete":
      return "Wait for the original shard runs to complete, then re-query this gate with the same declarations. Do not start another billed assessment.";
    case "incompatible":
      return "Recompile the suite or replace mismatched shards. This receipt cannot authorize a release.";
  }
}

export function mapManifestGateNetworkError(error: unknown): AwError {
  if (!(error instanceof AwError)) {
    return selectionError("INTERNAL", "The manifest gate command could not be completed.", {
      category: "local",
      cause: error
    });
  }
  const status = error.details?.["http_status"];
  const cause = error.cause;
  const causeMessage = cause instanceof Error ? cause.message : "";
  const combined = `${error.message} ${causeMessage}`;
  if (/redirect/i.test(combined)) {
    return selectionError(
      "MANIFEST_GATE_UNSAFE_REDIRECT",
      "The release-gate API returned a redirect. The CLI does not follow redirects with the bearer.",
      { category: "protocol", cause: error }
    );
  }
  if (
    /certificate|SSL|TLS|CERT_/i.test(combined) ||
    (typeof (cause as { code?: string } | undefined)?.code === "string" &&
      /CERT_|UNABLE_TO_VERIFY/i.test((cause as { code: string }).code))
  ) {
    return selectionError(
      "MANIFEST_GATE_TLS",
      "The release-gate TLS handshake failed. The CLI will not authorize a release.",
      { category: "relay", cause: error }
    );
  }
  if (error.code === "RELAY_UNREACHABLE" && /timed out|timeout/i.test(combined)) {
    return selectionError(
      "MANIFEST_GATE_TIMEOUT",
      "The release-gate request timed out. Re-query the original declarations. Do not start another billed assessment.",
      { category: "relay", retryable: true, cause: error }
    );
  }
  if (error.code === "RELAY_UNREACHABLE" || error.code === "RELAY_REQUEST_CANCELLED") {
    return error;
  }
  if (error.code === "RELAY_ENVELOPE_TOO_LARGE" || error.code === "INVALID_CLOUD_RESPONSE") {
    return manifestGateContractUnsupportedError();
  }
  if (typeof status !== "number") return error;
  if (status === 401 || status === 403) {
    return selectionError(
      error.code === "API_KEY_REVOKED" || error.code === "TOKEN_REVOKED" || error.code === "SCOPE_DENIED"
        ? error.code
        : "CLOUD_AUTH_REJECTED",
      "AugmentWorks rejected the connector credential for this release gate.",
      { category: "auth", details: { http_status: status } }
    );
  }
  if (status === 404) {
    return selectionError(
      "MANIFEST_GATE_NOT_FOUND",
      "The requested suite coverage was not found for this workspace. The CLI will not disclose whether another workspace owns an identifier.",
      { category: "config", details: { http_status: 404 } }
    );
  }
  if (status === 408) {
    return selectionError(
      "MANIFEST_GATE_TIMEOUT",
      "The release-gate request timed out. Re-query the original declarations. Do not start another billed assessment.",
      { category: "relay", retryable: true, details: { http_status: 408 } }
    );
  }
  if (status === 409) {
    return selectionError(
      "MANIFEST_GATE_IMMUTABLE_CONFLICT",
      "The compiled manifest identity conflicts with stored evidence. Recompile and re-query. This did not start a test or consume credits.",
      { category: "protocol", details: { http_status: 409 } }
    );
  }
  if (status === 426 || status === 400 || status === 422) {
    return manifestGateContractUnsupportedError();
  }
  if (status === 429) {
    return selectionError(
      "MANIFEST_GATE_RATE_LIMITED",
      "The release-gate API rate-limited this request. Retry after the advertised delay. This did not start a test or consume credits.",
      {
        category: "relay",
        retryable: true,
        details: retryDetails(status, error)
      }
    );
  }
  if (status >= 500) {
    return selectionError(
      "MANIFEST_GATE_UNAVAILABLE",
      "The release-gate API is temporarily unavailable. Re-query the original declarations. Do not start another billed assessment.",
      { category: "relay", retryable: true, details: retryDetails(status, error) }
    );
  }
  return error;
}

export function retryAfterMsFromError(error: AwError): number {
  const advertised = error.details?.["retry_after_ms"];
  if (typeof advertised === "number" && Number.isFinite(advertised) && advertised >= 0) {
    return Math.min(Math.ceil(advertised), MANIFEST_GATE_RETRY_AFTER_CAP_MS);
  }
  return 250;
}

function retryDetails(status: number, error: AwError): Record<string, string | number | boolean> {
  const details: Record<string, string | number | boolean> = { http_status: status };
  const advertised = error.details?.["retry_after_ms"];
  if (typeof advertised === "number") details["retry_after_ms"] = advertised;
  return details;
}

function identitySetsEqual(
  declared: readonly ManifestGateIdentity[],
  resolved: readonly ManifestGateIdentity[]
): boolean {
  if (declared.length !== resolved.length || declared.length === 0) return false;
  const left = declared.map(identityKey).sort();
  const right = resolved.map(identityKey).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function identityKey(shard: ManifestGateIdentity): string {
  return `${shard.shardId}\0${shard.shardIdentityHash}\0${shard.runId}`;
}

function assertInternallyConsistent(result: ManifestReleasePolicyV2): void {
  if (result.createsBillableRun) {
    throw createsBillableCompileError();
  }
  const mappedReasons = mapServerReasonCodes(result.reasonCodes);
  const allTerminalPass = result.resolvedShards.every(
    (shard) =>
      shard.executionState === "completed" &&
      shard.evaluationStatus === "completed" &&
      shard.decision === "pass"
  );
  if (result.decision === "pass") {
    if (
      result.coverageComplete !== true ||
      result.evidenceSource !== "server" ||
      result.reasonCodes.length > 0 ||
      mappedReasons.length > 0 ||
      !allTerminalPass
    ) {
      throw manifestGateResponseMismatchError();
    }
    return;
  }
  if (result.coverageComplete === true && allTerminalPass && result.reasonCodes.length === 0) {
    throw manifestGateResponseMismatchError("A non-pass receipt cannot describe exact all-pass coverage.");
  }
}

export function redactGateDiagnostic(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\bBearer[ \t]+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\baw_(?:project|connector|run|api)_[A-Za-z0-9._~-]+/gi, "[REDACTED]")
    .replace(/\b(authorization|cookie|set-cookie)[ \t]*[=:][ \t]*[^\s,;&]+/gi, "$1=[REDACTED]");
}
