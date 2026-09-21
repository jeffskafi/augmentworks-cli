import { AwError } from "../errors.js";

export function dataPolicyError(
  code: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>
): AwError {
  return new AwError({
    code,
    category: code === "DATA_POLICY_BLOCKED" || code === "INSUFFICIENT_EVIDENCE" ? "evidence" : "config",
    message,
    retryable: false,
    ...(details === undefined ? {} : { details })
  });
}
