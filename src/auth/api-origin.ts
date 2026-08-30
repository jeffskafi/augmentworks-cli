import { AwError } from "../errors.js";
import { isLoopbackUrl } from "../system/browser.js";

export const DEFAULT_API_ORIGIN = "https://augmentworks.ai";
export const API_ORIGIN_ENV = "AUGMENTWORKS_API_URL";

export function isTrustedApiOrigin(url: URL): boolean {
  return (
    url.origin === DEFAULT_API_ORIGIN ||
    (isLoopbackUrl(url) && (url.protocol === "http:" || url.protocol === "https:"))
  );
}

export function getApiOrigin(env: NodeJS.ProcessEnv = process.env): URL {
  const configured = env[API_ORIGIN_ENV]?.trim();
  let parsed: URL;
  try {
    parsed = new URL(configured === undefined || configured === "" ? DEFAULT_API_ORIGIN : configured);
  } catch (cause) {
    throw new AwError({
      code: "UNSAFE_CLOUD_URL",
      category: "auth",
      message: `${API_ORIGIN_ENV} must be a valid AugmentWorks API origin.`,
      cause
    });
  }

  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new AwError({
      code: "UNSAFE_CLOUD_URL",
      category: "auth",
      message: `${API_ORIGIN_ENV} must be an origin without credentials, query parameters, or a fragment.`
    });
  }

  const hasOnlyRootPath = parsed.pathname === "/" || parsed.pathname === "";
  if (!hasOnlyRootPath || !isTrustedApiOrigin(parsed)) {
    throw new AwError({
      code: "UNSAFE_CLOUD_URL",
      category: "auth",
      message: `${API_ORIGIN_ENV} may only select ${DEFAULT_API_ORIGIN} or a loopback development server.`
    });
  }

  return new URL(`${parsed.origin}/`);
}
