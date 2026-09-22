import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_PATH = resolve(root, "contracts/aw-real-data-1.lock.json");
export const GENERATED_PATH = resolve(root, "src/real-data/generated/contract.ts");
export const SCHEMA_PATH = resolve(root, "contracts/aw-real-data-1.schema.json");
export const FIXTURES_PATH = resolve(root, "contracts/aw-real-data-1.fixtures.json");
export const CHECKSUMS_PATH = resolve(root, "contracts/aw-real-data-1.checksums.json");

export const EXPECTED_SCHEMA_SHA256 =
  "6a53d04f297eb4db275bb7074bf7705a08137d932be823a3f4087d84cfdf7121";
export const EXPECTED_FIXTURES_SHA256 =
  "26033843d55dcb9b49ccf68fa96f7de9ec34aa6c299e8ab28b605cad37572230";
export const EXPECTED_CHECKSUMS_SHA256 =
  "df6c3be22fcf22efd5ac540dee83ac63a3a1e72e335d0f728dd55fcddd9fb20d";
export const SOURCE_COMMIT = "b198906188bab2dac9ae2a1ad539405807e46e1e";

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

export async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function generatedContractSource(lock) {
  return `/* Generated from contracts/aw-real-data-1.lock.json. Do not invent successor versions. */

export const AW_REAL_DATA_CONTRACT = ${JSON.stringify(lock, null, 2)} as const;

export type AwRealDataContract = typeof AW_REAL_DATA_CONTRACT;
`;
}

export async function readLock() {
  return JSON.parse(await readFile(LOCK_PATH, "utf8"));
}

export async function writeGenerated(lock) {
  await writeFile(GENERATED_PATH, generatedContractSource(lock), "utf8");
}

export async function assertVendoredContract() {
  const lock = await readLock();
  const errors = [];
  if (lock.schemaVersion !== "aw-real-data/1") {
    errors.push(`lock schemaVersion is ${lock.schemaVersion}, expected aw-real-data/1`);
  }
  if (lock.source.commit !== SOURCE_COMMIT) {
    errors.push(`lock source commit is ${lock.source.commit}, expected ${SOURCE_COMMIT}`);
  }
  if (lock.expected?.schema !== EXPECTED_SCHEMA_SHA256) {
    errors.push(`lock expected schema hash mismatch`);
  }
  if (lock.expected?.fixtures !== EXPECTED_FIXTURES_SHA256) {
    errors.push(`lock expected fixtures hash mismatch`);
  }
  if (lock.releaseEnabled === true || lock.runtimeEnforced === true) {
    errors.push("lock must keep releaseEnabled and runtimeEnforced false until R14/R15 verify hosted enablement");
  }
  const generated = generatedContractSource(lock);
  const committed = canonicalLfText(await readFile(GENERATED_PATH, "utf8"));
  if (committed !== generated) {
    errors.push("src/real-data/generated/contract.ts is out of date. Re-run the real-data contract import or rewrite the lock.");
  }

  const schemaPresent = await fileExists(SCHEMA_PATH);
  const fixturesPresent = await fileExists(FIXTURES_PATH);
  const checksumsPresent = await fileExists(CHECKSUMS_PATH);
  if (lock.imported === true) {
    if (!schemaPresent || !fixturesPresent) {
      errors.push("lock.imported is true but contracts/aw-real-data-1.schema.json or fixtures are missing");
    } else {
      const schemaHash = await hashFile(SCHEMA_PATH);
      const fixturesHash = await hashFile(FIXTURES_PATH);
      if (schemaHash !== EXPECTED_SCHEMA_SHA256) {
        errors.push(`imported schema hash ${schemaHash} expected ${EXPECTED_SCHEMA_SHA256}`);
      }
      if (fixturesHash !== EXPECTED_FIXTURES_SHA256) {
        errors.push(`imported fixtures hash ${fixturesHash} expected ${EXPECTED_FIXTURES_SHA256}`);
      }
      if (lock.files?.["contracts/aw-real-data-1.schema.json"] !== schemaHash) {
        errors.push("lock files schema hash diverges from the imported file");
      }
      if (lock.files?.["contracts/aw-real-data-1.fixtures.json"] !== fixturesHash) {
        errors.push("lock files fixtures hash diverges from the imported file");
      }
    }
    if (!checksumsPresent) {
      errors.push("lock.imported is true but contracts/aw-real-data-1.checksums.json is missing");
    } else {
      const checksumsHash = await hashFile(CHECKSUMS_PATH);
      if (checksumsHash !== EXPECTED_CHECKSUMS_SHA256) {
        errors.push(`imported checksums hash ${checksumsHash} expected ${EXPECTED_CHECKSUMS_SHA256}`);
      }
    }
  } else if (schemaPresent || fixturesPresent || checksumsPresent) {
    errors.push(
      "R01 schema/fixture bytes are present but lock.imported is false. Re-run node scripts/import-aw-real-data-contract.mjs --from <main-repo>"
    );
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return {
    lock,
    imported: lock.imported === true,
    schemaHash: schemaPresent ? await hashFile(SCHEMA_PATH) : null,
    fixturesHash: fixturesPresent ? await hashFile(FIXTURES_PATH) : null
  };
}
