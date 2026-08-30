import { canonicalize, sha256 } from "../util/canonical.js";
import type { ResolvedConfig } from "./types.js";

const OPERATION_ORDER = ["prepare", "send", "observe", "cleanup"] as const;

export function targetBoundarySha256(resolved: ResolvedConfig): string {
  const baseUrl = new URL(resolved.baseUrl);
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "") || "/";
  baseUrl.search = "";
  baseUrl.hash = "";
  const operations = OPERATION_ORDER.flatMap((kind) => {
    const operation = resolved.config.target.operations[kind];
    return operation === undefined
      ? []
      : [{ kind, method: operation.method, path: operation.path }];
  });
  return sha256(
    canonicalize({
      connector: resolved.config.target.connector,
      base_url: baseUrl.toString(),
      operations
    })
  );
}
