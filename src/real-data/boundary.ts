import { isIP } from "node:net";

import type { RelayCommand } from "../cloud/protocol.js";
import type { OperationKind } from "../errors.js";
import type { ResolvedConfig } from "../config/types.js";
import { isLocalOrPrivateHost } from "../config/resolve.js";
import { targetBoundarySha256 } from "../config/boundary.js";
import { canonicalHttpsOrigin } from "../suite/live-target.js";
import type { LocalExecutionScope, TargetBoundary } from "./documents.js";
import { realDataError } from "./errors.js";

export type AssessedOriginMode = "public_https" | "customer_private";

export function canonicalAssessedOrigin(
  value: string,
  options: { readonly allowPrivate: boolean }
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw realDataError("TARGET_SCOPE_MISMATCH", "Target origin must be an absolute URL.");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "Target origin cannot contain credentials, query, or fragment."
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw realDataError("TARGET_SCOPE_MISMATCH", "Target origin cannot contain a path.");
  }
  const hostname = url.hostname.replace(/\.$/u, "").toLowerCase();
  const privateHost = isIP(hostname) !== 0 || isLocalOrPrivateHost(hostname);
  if (privateHost && !options.allowPrivate) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "Hosted and browser discovery cannot use loopback, private, or raw IP origins. Register private targets through the local connector mapping only."
    );
  }
  if (!privateHost) {
    return canonicalHttpsOrigin(`https://${hostname}${url.port && url.port !== "443" ? `:${url.port}` : ""}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw realDataError("TARGET_SCOPE_MISMATCH", "Private local targets must use http or https.");
  }
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port === "" || url.port === defaultPort ? "" : `:${url.port}`;
  return `${url.protocol}//${hostname}${port}`;
}

export function assertBoundaryMatchesConfig(
  boundary: TargetBoundary,
  resolved: ResolvedConfig
): void {
  const allowPrivate = boundary.allowPrivateEndpoints === true;
  const assessed = canonicalAssessedOrigin(boundary.assessedOrigin, { allowPrivate });
  if (assessed !== canonicalAssessedOrigin(resolved.baseUrl.origin, { allowPrivate })) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      `Configured target origin ${resolved.baseUrl.origin} is not the assessed origin ${assessed}. Loopback is transport only.`
    );
  }
  if (targetBoundarySha256(resolved) !== boundary.boundaryHash && !operationsMatch(boundary, resolved)) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "Configured target methods and paths are not the admitted operation boundary."
    );
  }
  for (const kind of ["prepare", "observe", "cleanup"] as const) {
    const configured = resolved.config.target.operations[kind] !== undefined;
    const allowed = boundary.allowedOperations.includes(kind);
    if (configured && !allowed) {
      throw realDataError(
        "ACTION_NOT_ALLOWED",
        `Operation ${kind} is configured locally but is not in the admitted allowed-operation boundary.`
      );
    }
  }
}

function operationsMatch(boundary: TargetBoundary, resolved: ResolvedConfig): boolean {
  return boundary.allowedOperations.every((kind) => {
    const operation = resolved.config.target.operations[kind];
    if (operation === undefined) return kind === "send" ? false : true;
    return boundary.endpoints.some(
      (endpoint) =>
        endpoint.method === operation.method &&
        pathsEqual(endpoint.path, operation.path) &&
        canonicalAssessedOrigin(endpoint.origin, { allowPrivate: boundary.allowPrivateEndpoints }) ===
          canonicalAssessedOrigin(resolved.baseUrl.origin, { allowPrivate: boundary.allowPrivateEndpoints })
    );
  });
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string) => (value.startsWith("/") ? value : `/${value}`).replace(/\/+$/u, "") || "/";
  return normalize(left) === normalize(right);
}

export function assertCommandWithinBoundary(
  command: RelayCommand,
  boundary: TargetBoundary
): void {
  const kind = command.kind as OperationKind;
  if (!boundary.allowedOperations.includes(kind)) {
    throw realDataError(
      kind === "cleanup" ? "ACTION_NOT_ALLOWED" : "ACTION_NOT_ALLOWED",
      `Admitted scope does not permit ${kind} operations.`
    );
  }
}

export function assertLocalScopeNotRevoked(scope: LocalExecutionScope, revokedIds: ReadonlySet<string>): void {
  if (revokedIds.has(scope.scopeId)) {
    throw realDataError(
      "LOCAL_SCOPE_REVOKED",
      `Local execution scope ${scope.scopeId} was revoked on this machine.`
    );
  }
}

export function assertScopeNotExpired(expiresAt: string, now = Date.now()): void {
  const milliseconds = Date.parse(expiresAt);
  if (!Number.isFinite(milliseconds)) {
    throw realDataError("INVALID_EXECUTION_SCOPE", "Scope expiry is not a valid absolute timestamp.");
  }
  if (milliseconds <= now) {
    throw realDataError("TARGET_AUTHORITY_EXPIRED", `Execution scope expired at ${expiresAt}.`);
  }
}

export function loopbackIsTransportOnly(assessedOrigin: string, transportOrigin: string): boolean {
  try {
    const assessed = new URL(assessedOrigin);
    const transport = new URL(transportOrigin);
    return isLocalOrPrivateHost(transport.hostname) && !isLocalOrPrivateHost(assessed.hostname);
  } catch {
    return false;
  }
}
