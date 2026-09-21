import { describe, expect, it } from "vitest";

import {
  evaluateRetainedEvidence,
  findCodePointSpan,
  representationContainsFact
} from "../../src/data-policy/index.js";
import { PLACEHOLDERS } from "../../src/data-policy/types.js";

describe("retained evidence spans", () => {
  it("counts Unicode code points rather than UTF-16 units", () => {
    const text = "ok 日本語 café";
    const span = findCodePointSpan(text, "日本語");
    expect(span).toEqual({ start: 3, end: 6 });
    expect([...text].slice(span!.start, span!.end).join("")).toBe("日本語");
  });

  it("fails a criterion when masking removed the decisive fact", () => {
    const representation = {
      message: { content: `Eligible ${PLACEHOLDERS.field}` }
    };
    const evaluation = evaluateRetainedEvidence(representation, ["14-day window"]);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.outcome).toBe("insufficient_evidence");
    expect(evaluation.missingFacts).toEqual(["14-day window"]);
  });

  it("does not let a placeholder earn a pass", () => {
    expect(representationContainsFact({ note: PLACEHOLDERS.credential }, "sk-secret")).toBe(false);
    expect(representationContainsFact({ note: PLACEHOLDERS.field }, PLACEHOLDERS.field)).toBe(false);
    const evaluation = evaluateRetainedEvidence({ note: "Keep the 14-day window" }, ["14-day window"]);
    expect(evaluation).toEqual({ ok: true, outcome: "accepted", missingFacts: [] });
  });
});
