import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalize, sha256 } from "../../src/util/canonical.js";

describe("canonicalize", () => {
  it("produces the same bytes regardless of object insertion order", () => {
    const left = {
      target: { name: "refunds", connector: "http" },
      version: 1,
      enabled: true
    };
    const right = {
      enabled: true,
      version: 1,
      target: { connector: "http", name: "refunds" }
    };

    expect(canonicalize(left)).toBe(canonicalize(right));
    expect(sha256(canonicalize(left))).toBe(sha256(canonicalize(right)));
  });

  it("sorts keys by code unit rather than the host locale", () => {
    const value = { "ä": 4, z: 3, A: 2, "💡": 5, a: 1 };

    expect(canonicalize(value)).toBe('{"A":2,"a":1,"z":3,"ä":4,"💡":5}');
  });

  it("omits undefined object members and preserves array order", () => {
    expect(canonicalize({ omitted: undefined, kept: [3, 2, 1] })).toBe('{"kept":[3,2,1]}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite number %s",
    (value) => {
      expect(() => canonicalize(value)).toThrow(/non-finite/i);
    }
  );

  it("rejects values outside the JSON data model", () => {
    expect(() => canonicalize(1n)).toThrow(TypeError);
    expect(() => canonicalize(Symbol("not-json"))).toThrow(TypeError);
    expect(() => canonicalize(() => undefined)).toThrow(TypeError);
  });
});

describe("sha256", () => {
  it("matches the platform SHA-256 implementation for strings and bytes", () => {
    const text = '{"connector":"http","version":1}';
    const expected = createHash("sha256").update(text).digest("hex");

    expect(sha256(text)).toBe(expected);
    expect(sha256(Buffer.from(text))).toBe(expected);
  });
});
