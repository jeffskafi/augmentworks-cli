import open from "open";

import { AwError } from "../errors.js";

export type BrowserOpener = (url: URL) => Promise<void>;

export function assertAllowedBrowserUrl(url: URL, allowedOrigins: readonly string[]): void {
  if (!allowedOrigins.includes(url.origin) || (url.protocol !== "https:" && !isLoopbackUrl(url))) {
    throw new AwError({
      code: "UNSAFE_CLOUD_URL",
      category: "auth",
      message: "Refusing to open an untrusted authentication URL."
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new AwError({
      code: "UNSAFE_CLOUD_URL",
      category: "auth",
      message: "Refusing to open an authentication URL containing credentials."
    });
  }
}

export function isLoopbackUrl(url: URL): boolean {
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]"
  );
}

export async function openBrowserUrl(url: URL, allowedOrigins: readonly string[]): Promise<void> {
  assertAllowedBrowserUrl(url, allowedOrigins);
  try {
    await open(url.toString(), { wait: false });
  } catch (cause) {
    throw new AwError({
      code: "BROWSER_OPEN_FAILED",
      category: "auth",
      message: "Could not open the browser. Open the displayed URL manually.",
      cause
    });
  }
}
