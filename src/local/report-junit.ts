import type { LocalRunResult } from "./types.js";
import { LOCAL_TRUST_NOTICE } from "./report-html.js";

type UnknownRecord = Readonly<Record<string, unknown>>;

export function renderLocalReportJunit(result: LocalRunResult, resultSha256: string): string {
  const root = asRecord(result);
  const packet = asRecord(root["packet"]);
  const target = asRecord(root["target"]);
  const attempts = asArray(root["attempts"]).map(asRecord);
  const packetId = displayString(
    packet["packet_id"] ?? packet["key"] ?? packet["id"],
    "local-packet"
  );
  const packetVersion = displayString(packet["version"], "unversioned");
  const failures = attempts.filter((attempt) => attemptStatus(attempt) === "failed").length;
  const errors = attempts.filter((attempt) => attemptStatus(attempt) === "error").length;
  const skipped = attempts.filter((attempt) => {
    const status = attemptStatus(attempt);
    return status === "inconclusive" || status === "interrupted";
  }).length;
  const duration = attempts.reduce((total, attempt) => total + durationSeconds(attempt), 0);
  const properties: ReadonlyArray<readonly [string, string]> = [
    ["augmentworks.execution_mode", "local"],
    ["augmentworks.customer_executed", "true"],
    ["augmentworks.verified", "false"],
    ["augmentworks.signed", "false"],
    ["augmentworks.reviewed", "false"],
    ["augmentworks.uploaded", "false"],
    ["augmentworks.notice", LOCAL_TRUST_NOTICE],
    ["augmentworks.result_sha256", resultSha256],
    ["augmentworks.packet_sha256", displayString(packet["sha256"], "")],
    ["augmentworks.config_sha256", displayString(target["config_sha256"], "")]
  ];
  const testcases = attempts.map((attempt, index) => renderTestcase(attempt, index, packetId)).join("");
  const suiteName = `LOCAL UNVERIFIED — ${packetId}@${packetVersion}`;

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${escapeXml(suiteName)}" tests="${attempts.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${formatSeconds(duration)}">\n  <testsuite name="${escapeXml(suiteName)}" tests="${attempts.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${formatSeconds(duration)}">\n    <properties>\n${properties.map(([name, value]) => `      <property name="${escapeXml(name)}" value="${escapeXml(value)}"/>`).join("\n")}\n    </properties>\n${testcases}  </testsuite>\n</testsuites>\n`;
}

function renderTestcase(attempt: UnknownRecord, index: number, packetId: string): string {
  const scenario = displayString(attempt["scenario_key"], `scenario-${index + 1}`);
  const repetitionIndex = finiteNumber(attempt["repetition_index"]);
  const repetition = String((repetitionIndex ?? index) + 1);
  const status = attemptStatus(attempt);
  const duration = formatSeconds(durationSeconds(attempt));
  const name = `${scenario} [repetition ${repetition}]`;
  let child = "";
  if (status === "failed") {
    const failures = asArray(attempt["assertions"])
      .map(asRecord)
      .filter((assertion) => assertion["passed"] !== true)
      .map((assertion) => {
        const key = displayString(assertion["key"], "assertion");
        const description = displayString(assertion["description"], "Requirement was not met.");
        return `${key}: ${description}`;
      });
    const message = failures.length === 0 ? "One or more local assertions failed." : failures.join("; ");
    child = `<failure type="ASSERTION_FAILED" message="${escapeXml(message)}">${escapeXml(message)}</failure>`;
  } else if (status === "error") {
    const safeErrors = asArray(attempt["errors"])
      .map(asRecord)
      .map((error) => {
        const code = displayString(error["code"], "LOCAL_ATTEMPT_ERROR");
        const message = displayString(error["safe_message"] ?? error["message"], "The local attempt did not complete.");
        return `${code}: ${message}`;
      });
    const message = safeErrors.length === 0 ? "The local attempt did not complete." : safeErrors.join("; ");
    child = `<error type="LOCAL_ATTEMPT_ERROR" message="${escapeXml(message)}">${escapeXml(message)}</error>`;
  } else if (status === "inconclusive" || status === "interrupted") {
    child = `<skipped message="${escapeXml(status === "interrupted" ? "Local assessment interrupted." : "Local assessment inconclusive.")}"/>`;
  }
  return `    <testcase classname="${escapeXml(packetId)}" name="${escapeXml(name)}" time="${duration}">${child}</testcase>\n`;
}

function attemptStatus(attempt: UnknownRecord): string {
  const status = displayString(attempt["status"] ?? attempt["outcome"], "error").toLowerCase();
  if (["passed", "failed", "error", "inconclusive", "interrupted"].includes(status)) return status;
  return "error";
}

function durationSeconds(attempt: UnknownRecord): number {
  const started = timestamp(attempt["started_at"]);
  const completed = timestamp(attempt["completed_at"]);
  if (started === undefined || completed === undefined || completed < started) return 0;
  return (completed - started) / 1_000;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatSeconds(value: number): string {
  return (Number.isFinite(value) && value >= 0 ? value : 0).toFixed(3);
}

export function escapeXml(value: string): string {
  return xmlSafe(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function xmlSafe(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      output += character;
    } else {
      output += "\uFFFD";
    }
  }
  return output;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function displayString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
