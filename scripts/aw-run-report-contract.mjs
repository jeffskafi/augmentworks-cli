import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_PATH = resolve(root, "contracts/aw-run-report-v1.lock.json");
export const SCHEMA_PATH = resolve(root, "contracts/aw-run-report-v1.schema.json");
export const FIXTURES_PATH = resolve(root, "contracts/aw-run-report-v1.fixtures.json");

export function canonicalLfText(value) {
  return String(value).replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export function sha256Bytes(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  return createHash("sha256").update(Buffer.from(canonicalLfText(text), "utf8")).digest("hex");
}

export async function hashFile(path) {
  return sha256Bytes(await readFile(path));
}

export async function assertVendoredReportContract() {
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
  const schemaHash = await hashFile(SCHEMA_PATH);
  const fixturesHash = await hashFile(FIXTURES_PATH);
  const errors = [];
  if (lock.schemaVersion !== "aw-run-report/1") {
    errors.push(`lock schemaVersion is ${lock.schemaVersion}, expected aw-run-report/1`);
  }
  if (lock.files["contracts/aw-run-report-v1.schema.json"] !== schemaHash) {
    errors.push(
      `schema hash mismatch: lock ${lock.files["contracts/aw-run-report-v1.schema.json"]} file ${schemaHash}`
    );
  }
  if (lock.files["contracts/aw-run-report-v1.fixtures.json"] !== fixturesHash) {
    errors.push(
      `fixtures hash mismatch: lock ${lock.files["contracts/aw-run-report-v1.fixtures.json"]} file ${fixturesHash}`
    );
  }
  if (lock.contract.exportSchemaVersion !== "aw-run-report-export/1") {
    errors.push("lock exportSchemaVersion must be aw-run-report-export/1");
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { lock, schemaHash, fixturesHash };
}
