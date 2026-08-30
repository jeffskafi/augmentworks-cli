import { describe, expect, it } from "vitest";

import { AwError } from "../../src/errors.js";
import {
  mapRequestTemplate,
  redactSecrets,
  selectResponse
} from "../../src/connector/index.js";

describe("connector mapping", () => {
  it("maps only exact safe $input property and index references", () => {
    expect(
      mapRequestTemplate(
        {
          message: "$input.turns[0].content",
          attempt: "$input.attempt_id",
          literal: "prefix $input.message"
        },
        {
          attempt_id: "attempt_1",
          turns: [{ content: "Refund it" }]
        }
      )
    ).toEqual({
      message: "Refund it",
      attempt: "attempt_1",
      literal: "prefix $input.message"
    });
  });

  it.each(["$input.__proto__.x", "$input.constructor.name", "$input.a[-1]"])(
    "rejects unsafe or unsupported input reference %s",
    (reference) => {
      expect(() => mapRequestTemplate({ value: reference }, { a: [] })).toThrow(AwError);
    }
  );

  it("selects own response properties without traversing prototypes", () => {
    expect(selectResponse({ answer: { choices: [{ text: "Done" }] } }, "$.answer.choices[0].text")).toBe(
      "Done"
    );
    expect(() => selectResponse({}, "$.constructor.name")).toThrow(AwError);
    expect(() => selectResponse({}, "$.__proto__.polluted")).toThrow(AwError);
  });

  it("redacts configured secret values recursively", () => {
    expect(
      redactSecrets(
        { message: "token=secret-value", nested: ["secret-value"] },
        ["secret-value"]
      )
    ).toEqual({ message: "token=[REDACTED]", nested: ["[REDACTED]"] });
  });

  it("redacts sensitive keys and common token shapes recursively", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature123456";
    const result = redactSecrets(
      {
        password: "unconfigured-password",
        nested: {
          apiKey: "unconfigured-api-key",
          vendorSecret: "unconfigured-vendor-secret",
          xApiKey: "unconfigured-x-api-key",
          safe: `Authorization: Bearer remote-token-value and ${jwt}`
        },
        token_count: 42
      },
      []
    );
    expect(result).toEqual({
      password: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        vendorSecret: "[REDACTED]",
        xApiKey: "[REDACTED]",
        safe: "Authorization: Bearer [REDACTED] and [REDACTED]"
      },
      token_count: 42
    });
    expect(JSON.stringify(result)).not.toContain("remote-token-value");
    expect(JSON.stringify(result)).not.toContain("unconfigured-api-key");
    expect(JSON.stringify(result)).not.toContain("unconfigured-vendor-secret");
    expect(JSON.stringify(result)).not.toContain("unconfigured-x-api-key");
    expect(JSON.stringify(result)).not.toContain(jwt);
  });
});
