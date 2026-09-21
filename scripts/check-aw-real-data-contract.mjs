import { assertVendoredContract } from "./aw-real-data-contract.mjs";

const result = await assertVendoredContract();
const imported = result.imported ? "imported" : "parsers-only (R01 bytes not vendored in this clone)";
process.stdout.write(
  `CLI real-data contract ok: aw-real-data/1 from ${result.lock.source.commit} ${imported} expected schema=${result.lock.expected.schema} fixtures=${result.lock.expected.fixtures} releaseEnabled=false\n`
);
