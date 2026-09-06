import { assertVendoredContract } from "./aw-billing-contract.mjs";

const result = await assertVendoredContract();
process.stdout.write(
  `CLI billing contract ok: aw-billing/1 from ${result.lock.source.commit} schema=${result.schemaHash} fixtures=${result.fixturesHash}\n`
);
