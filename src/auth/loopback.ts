import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";

import { AwError } from "../errors.js";
import type { BrowserOpener } from "../system/browser.js";
import type { CloudAuthClient } from "./client.js";
import { createPkcePair, randomUrlSafeString } from "./pkce.js";
import { DEFAULT_AUTH_SCOPES, type StoredCredential } from "./types.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;

export interface LoopbackLoginOptions {
  readonly openBrowser: BrowserOpener;
  readonly scopes?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onAuthorizationUrl?: (url: URL) => void;
}

export async function loginWithLoopback(
  client: CloudAuthClient,
  options: LoopbackLoginOptions
): Promise<StoredCredential> {
  const state = randomUrlSafeString();
  const callbackPath = `/oauth/callback/${randomUrlSafeString(16)}`;
  const pkce = createPkcePair();
  const callback = deferredCallback(state, callbackPath, options.signal);
  const server = createServer(callback.handler);
  const redirectUri = await listen(server, callbackPath);

  try {
    const authorizationUrl = client.buildAuthorizationUrl({
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
      scopes: options.scopes ?? DEFAULT_AUTH_SCOPES
    });
    options.onAuthorizationUrl?.(authorizationUrl);
    const codePromise = withTimeout(
      callback.promise,
      options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
      options.signal
    );
    // A browser callback can arrive before an injected/test opener resolves.
    // Attach a rejection handler immediately, then await the same promise below.
    void codePromise.catch(() => undefined);
    await options.openBrowser(authorizationUrl);
    const code = await codePromise;
    return await client.exchangeAuthorizationCode({
      code,
      redirectUri,
      codeVerifier: pkce.verifier
    });
  } finally {
    await close(server);
  }
}

function deferredCallback(
  expectedState: string,
  callbackPath: string,
  signal?: AbortSignal
): {
  readonly promise: Promise<string>;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
} {
  let resolvePromise: (code: string) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  let completed = false;
  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const rejectOnce = (error: Error): void => {
    if (completed) return;
    completed = true;
    rejectPromise(error);
  };
  signal?.addEventListener(
    "abort",
    () =>
      rejectOnce(
        new AwError({
          code: "INTERRUPTED",
          category: "local",
          message: "Authentication was interrupted."
        })
      ),
    { once: true }
  );
  if (signal?.aborted === true) {
    rejectOnce(
      new AwError({
        code: "INTERRUPTED",
        category: "local",
        message: "Authentication was interrupted."
      })
    );
  }

  return {
    promise,
    handler: (request, response) => {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        response.end("Method not allowed");
        return;
      }
      const requestUrl = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (requestUrl.pathname !== callbackPath) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (completed) {
        response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization callback already used");
        return;
      }
      const returnedState = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      if (returnedState !== expectedState) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid authorization state");
        rejectOnce(
          new AwError({
            code: "AUTH_STATE_MISMATCH",
            category: "auth",
            message: "The OAuth callback state did not match. Login was stopped."
          })
        );
        return;
      }
      if (error !== null) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization denied");
        rejectOnce(
          new AwError({
            code: error === "access_denied" ? "AUTH_DENIED" : "AUTH_RESPONSE_ERROR",
            category: "auth",
            message: "AugmentWorks authorization was denied."
          })
        );
        return;
      }
      if (code === null || code === "" || code.length > 8_192 || /[\r\n\0]/.test(code)) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing authorization code");
        rejectOnce(
          new AwError({
            code: "AUTH_RESPONSE_INVALID",
            category: "auth",
            message: "The OAuth callback did not contain a valid authorization code."
          })
        );
        return;
      }

      completed = true;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff"
      });
      response.end(
        "<!doctype html><meta charset=utf-8><title>AugmentWorks connected</title>" +
          "<style>body{font:16px system-ui;margin:4rem;max-width:42rem}h1{font-size:1.5rem}</style>" +
          "<h1>AugmentWorks is connected</h1><p>You can close this tab and return to your terminal.</p>"
      );
      resolvePromise(code);
    }
  };
}

async function listen(server: Server, callbackPath: string): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch((cause: unknown) => {
    throw new AwError({
      code: "AUTH_CALLBACK_UNAVAILABLE",
      category: "auth",
      message: "Could not start the 127.0.0.1 OAuth callback listener.",
      cause
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    throw new AwError({
      code: "AUTH_CALLBACK_UNAVAILABLE",
      category: "auth",
      message: "Could not determine the OAuth callback address."
    });
  }
  return new URL(`http://${LOOPBACK_HOST}:${address.port}${callbackPath}`);
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AwError({
          code: "AUTH_EXPIRED",
          category: "auth",
          message: "Browser authorization timed out. Run login again."
        })
      );
    }, timeoutMs);
    const onAbort = (): void => {
      reject(
        new AwError({
          code: "INTERRUPTED",
          category: "local",
          message: "Authentication was interrupted."
        })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}
