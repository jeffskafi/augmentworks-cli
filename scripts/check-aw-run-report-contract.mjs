import { assertVendoredReportContract } from "./aw-run-report-contract.mjs";

const result = await assertVendoredReportContract();
process.stdout.write(
  `CLI run-report contract ok: aw-run-report/1 schema=${result.schemaHash} fixtures=${result.fixturesHash} source=${result.lock.source.contract}\n`
);
