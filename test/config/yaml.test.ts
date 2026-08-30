import { describe, expect, it } from "vitest";

import { parseYamlStrict, StrictYamlError } from "../../src/config/yaml.js";

describe("parseYamlStrict", () => {
  it("parses YAML core values", () => {
    expect(parseYamlStrict("version: 1\nenabled: true\nname: target\n")).toEqual({
      version: 1,
      enabled: true,
      name: "target"
    });
  });

  it.each([
    ["duplicate keys", "name: one\nname: two\n", "YAML_DUPLICATE_KEY"],
    ["aliases", "first: &value hello\nsecond: *value\n", "YAML_ALIAS_FORBIDDEN"],
    ["merge keys", "base: &base\n  value: one\nchild:\n  <<: *base\n", "YAML_MERGE_FORBIDDEN"],
    ["custom tags", "value: !execute command\n", "YAML_CUSTOM_TAG_FORBIDDEN"]
  ])("rejects %s", (_label, source, expectedCode) => {
    try {
      parseYamlStrict(source);
      expect.fail("expected strict YAML parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StrictYamlError);
      expect((error as StrictYamlError).code).toBe(expectedCode);
    }
  });
});
