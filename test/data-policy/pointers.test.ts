import { describe, expect, it } from "vitest";

import {
  expandSelector,
  formatPointer,
  parseSelector
} from "../../src/data-policy/pointers.js";

describe("JSON pointer subset", () => {
  it("expands one-segment wildcards across objects and arrays", () => {
    const document = {
      items: [
        { email: "a@example.test" },
        { email: "b@example.test" }
      ]
    };
    expect(expandSelector("/items/*/email", document)).toEqual(["/items/0/email", "/items/1/email"]);
    expect(expandSelector("/items/1/email", document)).toEqual(["/items/1/email"]);
    expect(formatPointer(["a/b", "c"])).toBe("/a~1b/c");
  });

  it("rejects executable expressions and prototype segments", () => {
    expect(() => parseSelector("$.email")).toThrowError(
      expect.objectContaining({ code: "REDACTION_PROFILE_MISMATCH" })
    );
    expect(() => parseSelector("/__proto__/x")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_SELECTOR" })
    );
  });
});
