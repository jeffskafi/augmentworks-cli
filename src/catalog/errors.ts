import { AwError } from "../errors.js";

export function catalogError(
  code: string,
  message: string,
  options: {
    readonly category?: AwError["category"];
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, string | number | boolean>>;
    readonly cause?: unknown;
  } = {}
): AwError {
  return new AwError({
    code,
    category: options.category ?? "protocol",
    message,
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.cause === undefined ? {} : { cause: options.cause })
  });
}

export function catalogStaleError(currentChecksum: string, currentVersion: string): AwError {
  return catalogError(
    "CATALOG_STALE",
    "The supplied catalog version is stale. Replace the cached catalog with the current document before selecting coverage. Do not quote from the old checksum.",
    {
      category: "config",
      details: {
        current_catalog_checksum: currentChecksum,
        current_catalog_version: currentVersion
      }
    }
  );
}
