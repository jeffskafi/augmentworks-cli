import { LOCAL_TRUST_LABEL, type LocalRunResult } from "./types.js";

export const LOCAL_TRUST_NOTICE = LOCAL_TRUST_LABEL;

type UnknownRecord = Readonly<Record<string, unknown>>;

export function renderLocalReportHtml(result: LocalRunResult, resultSha256: string): string {
  const root = asRecord(result);
  const packet = asRecord(root["packet"]);
  const target = asRecord(root["target"]);
  const counts = asRecord(root["counts"]);
  const attempts = asArray(root["attempts"]);
  const scenarios = asArray(root["scenarios"]);
  const packetId = displayString(
    packet["packet_id"] ?? packet["key"] ?? packet["id"],
    "local-packet"
  );
  const packetVersion = displayString(packet["version"], "unversioned");
  const packetName = displayString(packet["name"], packetId);
  const targetName = displayString(target["target_name"] ?? target["name"], "local target");
  const runId = displayString(root["run_id"] ?? asRecord(root["run"])["id"], "local run");
  const outcome = displayString(root["outcome"] ?? root["status"], "unknown");

  const scenarioRows = scenarios
    .map((value) => {
      const scenario = asRecord(value);
      const key = displayString(scenario["scenario_key"] ?? scenario["key"], "scenario");
      const name = displayString(scenario["name"] ?? scenario["title"], key);
      const status = displayString(scenario["outcome"] ?? scenario["status"], "unknown");
      const passed = numberString(scenario["passed"]);
      const total = numberString(scenario["repetitions"] ?? scenario["total"]);
      return `<tr><td><code>${escapeHtml(key)}</code></td><td>${escapeHtml(name)}</td><td><span class="status status-${statusClass(status)}">${escapeHtml(status)}</span></td><td>${escapeHtml(passed)}${total === "—" ? "" : ` / ${escapeHtml(total)}`}</td></tr>`;
    })
    .join("");

  const attemptSections = attempts
    .map((value, index) => renderAttempt(asRecord(value), index))
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <title>${escapeHtml(packetName)} — local assessment</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17201d; background: #f4f6f4; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px 20px 64px; }
    main { max-width: 1040px; margin: 0 auto; }
    h1, h2, h3 { line-height: 1.2; }
    h1 { margin: 10px 0 6px; font-size: 2rem; }
    h2 { margin-top: 32px; }
    .eyebrow { color: #52625c; font-size: .78rem; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
    .notice { margin: 20px 0; padding: 16px 18px; border: 2px solid #8b5d17; border-radius: 10px; background: #fff8e8; color: #593b11; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .card, .attempt { padding: 16px; border: 1px solid #d3dad6; border-radius: 10px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    .label { color: #5b6863; font-size: .75rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .value { margin-top: 6px; font-size: 1.05rem; font-weight: 700; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; border: 1px solid #d3dad6; background: #fff; }
    th, td { padding: 11px 12px; border-bottom: 1px solid #e3e7e5; text-align: left; vertical-align: top; }
    th { background: #eef2ef; font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; }
    .attempt { margin: 12px 0; }
    .attempt-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; align-items: baseline; }
    .status { display: inline-block; padding: 3px 8px; border-radius: 999px; background: #e9eeeb; font-size: .78rem; font-weight: 800; text-transform: uppercase; }
    .status-passed { background: #dff4e8; color: #185a37; }
    .status-failed, .status-error { background: #fde5e2; color: #8a281e; }
    .status-inconclusive, .status-unknown, .status-interrupted { background: #fff0cd; color: #704c0e; }
    ul { padding-left: 22px; }
    li { margin: 6px 0; }
    pre { max-height: 280px; overflow: auto; padding: 12px; border-radius: 7px; background: #f1f3f2; white-space: pre-wrap; overflow-wrap: anywhere; }
    code { overflow-wrap: anywhere; }
    .muted { color: #64716c; }
    footer { margin-top: 36px; color: #64716c; font-size: .82rem; overflow-wrap: anywhere; }
    @media print { body { padding: 0; background: #fff; } .card, .attempt { box-shadow: none; break-inside: avoid; } }
  </style>
</head>
<body>
<main>
  <div class="eyebrow">Local report · customer executed · unverified</div>
  <h1>${escapeHtml(packetName)}</h1>
  <p class="muted">${escapeHtml(packetId)}@${escapeHtml(packetVersion)}</p>
  <div class="notice">${escapeHtml(LOCAL_TRUST_NOTICE)}</div>

  <section class="grid" aria-label="Assessment summary">
    ${summaryCard("Outcome", outcome)}
    ${summaryCard("Target", targetName)}
    ${summaryCard("Run", runId)}
    ${summaryCard("Attempts", numberString(counts["attempts"] ?? attempts.length))}
    ${summaryCard("Passed", numberString(counts["passed"]))}
    ${summaryCard("Failed", numberString(counts["failed"]))}
    ${summaryCard("Inconclusive", numberString(counts["inconclusive"] ?? counts["uncertain"]))}
    ${summaryCard("Errors", numberString(counts["errors"]))}
  </section>

  <section>
    <h2>Scenario results</h2>
    ${scenarioRows === "" ? '<p class="muted">No scenario summary was recorded.</p>' : `<table><thead><tr><th>Scenario</th><th>Name</th><th>Outcome</th><th>Passed</th></tr></thead><tbody>${scenarioRows}</tbody></table>`}
  </section>

  <section>
    <h2>Attempts</h2>
    ${attemptSections === "" ? '<p class="muted">No attempts were recorded.</p>' : attemptSections}
  </section>

  <footer>
    <div>Result checksum (SHA-256): <code>${escapeHtml(resultSha256)}</code></div>
    <div>This checksum detects accidental change to this local result; it is not a signature or proof of provenance.</div>
  </footer>
</main>
</body>
</html>
`;
}

function renderAttempt(attempt: UnknownRecord, index: number): string {
  const id = displayString(attempt["attempt_id"], `attempt-${index + 1}`);
  const scenario = displayString(attempt["scenario_key"], "scenario");
  const repetitionIndex = finiteNumber(attempt["repetition_index"]);
  const repetition = String((repetitionIndex ?? index) + 1);
  const status = displayString(attempt["status"] ?? attempt["outcome"], "unknown");
  const cleanup = displayString(attempt["cleanup_status"], "unknown");
  const assertions = asArray(attempt["assertions"]);
  const errors = asArray(attempt["errors"]);

  const assertionItems = assertions
    .map((value) => {
      const assertion = asRecord(value);
      const passed = assertion["passed"] === true;
      const key = displayString(assertion["key"], "assertion");
      const description = displayString(assertion["description"], "");
      const actual = Object.hasOwn(assertion, "actual")
        ? `<pre>${escapeHtml(safeJson(assertion["actual"]))}</pre>`
        : "";
      return `<li><strong>${passed ? "PASS" : "FAIL"}</strong> · <code>${escapeHtml(key)}</code>${description === "" ? "" : ` — ${escapeHtml(description)}`}${actual}</li>`;
    })
    .join("");
  const errorItems = errors
    .map((value) => {
      const error = asRecord(value);
      const code = displayString(error["code"], "LOCAL_ATTEMPT_ERROR");
      const message = displayString(error["safe_message"] ?? error["message"], "The attempt did not complete.");
      return `<li><code>${escapeHtml(code)}</code> — ${escapeHtml(message)}</li>`;
    })
    .join("");

  return `<article class="attempt">
    <div class="attempt-head"><h3>${escapeHtml(scenario)} · repetition ${escapeHtml(repetition)}</h3><span class="status status-${statusClass(status)}">${escapeHtml(status)}</span></div>
    <p class="muted"><code>${escapeHtml(id)}</code> · cleanup: ${escapeHtml(cleanup)}</p>
    ${assertionItems === "" ? "" : `<h4>Assertions</h4><ul>${assertionItems}</ul>`}
    ${errorItems === "" ? "" : `<h4>Safe errors</h4><ul>${errorItems}</ul>`}
  </article>`;
}

function summaryCard(label: string, value: string): string {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

export function escapeHtml(value: string): string {
  return htmlSafe(value).replace(/[&<>"']/g, (character) => {
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
        return "&#39;";
    }
  });
}

function htmlSafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "\uFFFD");
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

function numberString(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function statusClass(value: string): string {
  const normalized = value.toLowerCase();
  return ["passed", "failed", "error", "inconclusive", "interrupted"].includes(normalized)
    ? normalized
    : "unknown";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "[unavailable]";
  }
}
