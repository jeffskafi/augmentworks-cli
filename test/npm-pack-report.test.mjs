import { describe, expect, it } from "vitest";

import { parsePackReport } from "../scripts/npm-pack-report.mjs";

const report = {
  name: "@augmentworks/cli",
  version: "0.1.0",
  filename: "augmentworks-cli-0.1.0.tgz",
  files: [{ path: "dist/index.js", size: 42 }]
};

describe("parsePackReport", () => {
  it("extracts npm's JSON report after lifecycle-script output", () => {
    const stdout = [
      "> @augmentworks/cli@0.1.0 prepack",
      "> npm run build",
      "CLI Building entry: src/index.ts",
      "CLI Build success in 41ms",
      JSON.stringify([report], null, 2),
      ""
    ].join("\n");

    expect(parsePackReport(stdout)).toEqual(report);
  });

  it("ignores bracketed and JSON-shaped lifecycle log noise", () => {
    const stdout = [
      "[tsup] starting build",
      JSON.stringify({ level: "info", message: "built" }),
      JSON.stringify([{ path: "not-a-pack-report" }]),
      JSON.stringify([report])
    ].join("\n");

    expect(parsePackReport(stdout)).toEqual(report);
  });

  it("preserves report validation after extracting prefixed JSON", () => {
    expect(() =>
      parsePackReport(`build complete\n${JSON.stringify([{ files: [] }])}`)
    ).toThrow("npm pack report is missing its filename");
  });

  it("includes command output when no report can be recovered", () => {
    expect(() => parsePackReport("prepack failed before npm emitted JSON")).toThrow(
      "prepack failed before npm emitted JSON"
    );
  });
});
