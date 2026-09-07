import { AwError } from "../errors.js";

export const SUITE_CHANGED_AFTER_QUOTE_CODE = "SUITE_CHANGED_AFTER_QUOTE";
export const HOSTED_SUITE_UNSUPPORTED_LOCAL_CODE = "HOSTED_SUITE_UNSUPPORTED_LOCAL";

export function suiteError(
  code: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
  cause?: unknown
): AwError {
  return new AwError({
    code,
    category: "config",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause })
  });
}

export function suiteChangedAfterQuoteError(): AwError {
  return suiteError(
    SUITE_CHANGED_AFTER_QUOTE_CODE,
    "The customer suite file changed after the quote was issued. Re-run estimate or test so admission uses the same server-accepted revision; the CLI will not silently re-pin mutable content."
  );
}

export function hostedSuiteUnsupportedLocalError(path: string): AwError {
  return suiteError(
    HOSTED_SUITE_UNSUPPORTED_LOCAL_CODE,
    `Local deterministic execution cannot run customer-owned hosted suites (${path}). Validate and preview with \`augmentworks suite validate\` / \`suite preview\`, or run hosted with \`augmentworks test --suite\`.`
  );
}
