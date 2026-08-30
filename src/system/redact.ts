const BEARER_PATTERN = /\bBearer[ \t]+[^\s,;]+/gi;
const AUGMENTWORKS_TOKEN_PATTERN = /\baw_(?:project|connector|run)_[A-Za-z0-9._~-]+/gi;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const NPM_TOKEN_PATTERN = /\bnpm_[A-Za-z0-9]{20,}\b/g;
const PROVIDER_KEY_PATTERN = /\b(?:sk|rk|sess)-[A-Za-z0-9_-]{12,}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const ASSIGNED_SECRET_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|token)[ \t]*([=:])[ \t]*[^\s,;&]+/gi;

const SENSITIVE_KEYS = new Set([
  "api_key",
  "authorization",
  "auth_token",
  "client_secret",
  "cookie",
  "credential",
  "credentials",
  "id_token",
  "password",
  "passwd",
  "passphrase",
  "private_key",
  "proxy_authorization",
  "refresh_token",
  "secret",
  "session_secret",
  "session_token",
  "set_cookie",
  "token",
  "access_token"
]);
const SENSITIVE_KEY_SUFFIXES = [
  "_api_key",
  "_credential",
  "_password",
  "_passwd",
  "_private_key",
  "_secret",
  "_token"
] as const;

function escapedPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

export class SecretRedactor {
  readonly #patterns: readonly RegExp[];

  constructor(secrets: readonly string[] = []) {
    this.#patterns = secrets
      .filter((secret) => secret.length > 0)
      .sort((left, right) => right.length - left.length)
      .map(escapedPattern);
  }

  redact(value: string): string {
    let redacted = value
      .replace(BEARER_PATTERN, "Bearer [REDACTED]")
      .replace(AUGMENTWORKS_TOKEN_PATTERN, "[REDACTED]")
      .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]")
      .replace(NPM_TOKEN_PATTERN, "[REDACTED]")
      .replace(PROVIDER_KEY_PATTERN, "[REDACTED]")
      .replace(JWT_PATTERN, "[REDACTED]")
      .replace(
        ASSIGNED_SECRET_PATTERN,
        (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`
      );
    for (const pattern of this.#patterns) {
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    return redacted;
  }
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  return new SecretRedactor(secrets).redact(value);
}
