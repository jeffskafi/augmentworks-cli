import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getApiOrigin } from "../auth/api-origin.js";
import { CLI_VERSION } from "../version.js";
import { AwError } from "../errors.js";
import { assertJsonLimits, LIMITS } from "../util/limits.js";
import { getStateDirectory } from "../relay/state-dir.js";
import { catalogError, catalogStaleError } from "./errors.js";
import {
  CATALOG_PATHS,
  CatalogCacheRecordSchema,
  CoverageCatalogErrorSchema,
  CoverageCatalogSchema,
  type CatalogCacheRecord,
  type CoverageCatalog
} from "./schema.js";

export interface CatalogLoadOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDirectory?: string;
  readonly catalogVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface LoadedCatalog {
  readonly catalog: CoverageCatalog;
  readonly fresh: boolean;
  readonly stale: boolean;
  readonly etag: string;
}

export async function loadCoverageCatalog(options: CatalogLoadOptions = {}): Promise<LoadedCatalog> {
  const env = options.env ?? process.env;
  const origin = getApiOrigin(env);
  const now = options.now ?? Date.now;
  const stateDirectory = options.stateDirectory ?? getStateDirectory(env);
  const cachePath = catalogCachePath(stateDirectory);
  const cached = await readCache(cachePath);
  const requestedVersion = options.catalogVersion?.trim();
  if (
    requestedVersion === undefined &&
    cached !== undefined &&
    cached.origin === origin.origin &&
    now() - cached.fetchedAtMs < cached.maxAgeSeconds * 1000
  ) {
    return {
      catalog: cached.document,
      fresh: true,
      stale: false,
      etag: cached.etag
    };
  }

  try {
    return await fetchAndStore({
      origin,
      cachePath,
      cached,
      requestedVersion,
      fetchImpl: options.fetch ?? globalThis.fetch,
      now: now(),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  } catch (error) {
    if (
      cached !== undefined &&
      cached.origin === origin.origin &&
      requestedVersion === undefined &&
      now() - cached.fetchedAtMs < cached.staleIfErrorSeconds * 1000 &&
      isNetworkFailure(error)
    ) {
      return {
        catalog: cached.document,
        fresh: false,
        stale: true,
        etag: cached.etag
      };
    }
    throw error;
  }
}

async function fetchAndStore(options: {
  readonly origin: URL;
  readonly cachePath: string;
  readonly cached: CatalogCacheRecord | undefined;
  readonly requestedVersion: string | undefined;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly now: number;
  readonly signal?: AbortSignal;
}): Promise<LoadedCatalog> {
  const url = new URL(CATALOG_PATHS.coverage, `${options.origin.origin}/`);
  if (options.requestedVersion !== undefined && options.requestedVersion !== "") {
    url.searchParams.set("catalogVersion", options.requestedVersion);
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-AugmentWorks-CLI-Version": CLI_VERSION
  };
  if (
    options.cached !== undefined &&
    options.cached.origin === options.origin.origin &&
    options.requestedVersion === undefined
  ) {
    headers["If-None-Match"] = options.cached.etag;
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), 30_000);
  timer.unref?.();
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers
    });
  } catch (error) {
    throw catalogError(
      "CATALOG_UNREACHABLE",
      "Could not reach the AugmentWorks coverage catalog.",
      { retryable: true, cause: error }
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (response.status === 304) {
    if (options.cached === undefined || options.cached.origin !== options.origin.origin) {
      throw catalogError("CATALOG_NOT_MODIFIED_WITHOUT_CACHE", "Catalog returned 304 without a usable cache.");
    }
    const refreshed: CatalogCacheRecord = { ...options.cached, fetchedAtMs: options.now };
    await writeCache(options.cachePath, refreshed);
    return {
      catalog: options.cached.document,
      fresh: true,
      stale: false,
      etag: options.cached.etag
    };
  }

  const text = await readBoundedBody(response);
  let value: unknown;
  try {
    value = text === "" ? undefined : JSON.parse(text);
  } catch (cause) {
    throw catalogError("INVALID_CATALOG_RESPONSE", "AugmentWorks returned an invalid catalog JSON response.", {
      cause
    });
  }
  if (value !== undefined) assertJsonLimits(value, "coverage catalog");

  if (response.status === 409) {
    const parsed = CoverageCatalogErrorSchema.safeParse(value);
    if (!parsed.success) {
      throw catalogError("INVALID_CATALOG_RESPONSE", "AugmentWorks returned an invalid stale-catalog error.");
    }
    if (parsed.data.error.code !== "catalog_stale") {
      throw catalogError(
        "CATALOG_REQUEST_FAILED",
        parsed.data.error.message,
        { details: { http_status: 409 } }
      );
    }
    const current = parsed.data.catalog;
    if (current === undefined) {
      throw catalogError("CATALOG_STALE", parsed.data.error.message, { category: "config" });
    }
    await persistCatalog(options.cachePath, options.origin.origin, current, response, options.now);
    throw catalogStaleError(current.catalogChecksum, current.catalogVersion);
  }

  if (!response.ok) {
    throw catalogError(
      response.status === 401 || response.status === 403 ? "CLOUD_AUTH_REJECTED" : "CATALOG_REQUEST_FAILED",
      `Coverage catalog request failed (${String(response.status)}).`,
      {
        category: response.status === 401 || response.status === 403 ? "auth" : "protocol",
        details: { http_status: response.status }
      }
    );
  }

  const parsed = CoverageCatalogSchema.safeParse(value);
  if (!parsed.success) {
    throw catalogError("INVALID_CATALOG_RESPONSE", "AugmentWorks returned an invalid coverage catalog.");
  }
  if (parsed.data.createsBillableRun) {
    throw catalogError(
      "CREATES_BILLABLE_RUN",
      "The coverage catalog advertised createsBillableRun. Observation of catalog metadata must not start, reserve, or charge a run."
    );
  }
  await persistCatalog(options.cachePath, options.origin.origin, parsed.data, response, options.now);
  return {
    catalog: parsed.data,
    fresh: true,
    stale: false,
    etag: parsed.data.cache.etag
  };
}

async function persistCatalog(
  cachePath: string,
  origin: string,
  catalog: CoverageCatalog,
  response: Response,
  now: number
): Promise<void> {
  const etag = response.headers.get("etag") ?? catalog.cache.etag;
  const record: CatalogCacheRecord = {
    schemaVersion: "aw-catalog-cache/1",
    origin,
    etag,
    checksum: catalog.catalogChecksum,
    catalogVersion: catalog.catalogVersion,
    fetchedAtMs: now,
    maxAgeSeconds: catalog.cache.maxAgeSeconds,
    staleIfErrorSeconds: catalog.cache.staleIfErrorSeconds,
    document: catalog
  };
  await writeCache(cachePath, record);
}

function catalogCachePath(stateDirectory: string): string {
  return join(stateDirectory, "catalog", "coverage-v1.json");
}

async function readCache(path: string): Promise<CatalogCacheRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    const parsed = CatalogCacheRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, record: CatalogCacheRecord): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf("/"));
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  await rename(temporary, path);
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > LIMITS.envelopeBytes) {
    throw catalogError("RELAY_ENVELOPE_TOO_LARGE", "The coverage catalog exceeds the relay envelope limit.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.envelopeBytes) {
      await reader.cancel();
      throw catalogError("RELAY_ENVELOPE_TOO_LARGE", "The coverage catalog exceeds the relay envelope limit.");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof AwError && (error.code === "CATALOG_UNREACHABLE" || error.retryable);
}

export function findCatalogTarget(
  catalog: CoverageCatalog,
  query: string
): { kind: "case" | "packet" | "profile"; value: CoverageCatalog["cases"][number] | CoverageCatalog["publishedPackets"][number] | CoverageCatalog["profiles"][number] } {
  const trimmed = query.trim();
  if (trimmed === "") {
    throw catalogError("CATALOG_TARGET_REQUIRED", "Provide a case id, profile id, or packet@version.", {
      category: "config"
    });
  }
  const catalogCase = catalog.cases.find((entry) => entry.caseId === trimmed);
  if (catalogCase !== undefined) return { kind: "case", value: catalogCase };
  const profile = catalog.profiles.find((entry) => entry.profileId === trimmed);
  if (profile !== undefined) return { kind: "profile", value: profile };
  const packet = catalog.publishedPackets.find(
    (entry) => `${entry.packetKey}@${entry.version}` === trimmed || entry.packetKey === trimmed
  );
  if (packet !== undefined) return { kind: "packet", value: packet };
  throw catalogError(
    "CATALOG_TARGET_NOT_FOUND",
    `No catalog case, profile, or packet named ${trimmed}.`,
    { category: "config" }
  );
}
