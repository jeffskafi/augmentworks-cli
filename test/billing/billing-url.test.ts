import { describe, expect, it } from "vitest";

import { firstPartyBillingPageUrl, assertSafeBillingPageUrl } from "../../src/billing/validate.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const production = new URL("https://augmentworks.ai/");
const loopback = new URL("http://127.0.0.1:8787/");

describe("first-party billing page URL allowlist", () => {
  it("accepts the documented production billing path and workspace query", () => {
    const url = assertSafeBillingPageUrl(
      `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`,
      production,
      WORKSPACE
    );
    expect(url.toString()).toBe(`https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`);
  });

  it("accepts a loopback development origin that matches the API origin", () => {
    const url = firstPartyBillingPageUrl(loopback, WORKSPACE);
    expect(url.origin).toBe(loopback.origin);
    expect(url.pathname).toBe("/portal/billing");
    expect(url.searchParams.get("workspace")).toBe(WORKSPACE);
  });

  it.each([
    ["userinfo", `https://user:pass@augmentworks.ai/portal/billing?workspace=${WORKSPACE}`],
    ["protocol-relative", `//augmentworks.ai/portal/billing?workspace=${WORKSPACE}`],
    ["lookalike host", `https://augmentworks.ai.evil.example/portal/billing?workspace=${WORKSPACE}`],
    ["unexpected port", `https://augmentworks.ai:8443/portal/billing?workspace=${WORKSPACE}`],
    ["injected fragment", `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}#token=secret`],
    ["access token query", `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}&access_token=aw_secret`],
    ["checkout session query", `https://augmentworks.ai/portal/billing?workspace=${WORKSPACE}&session_id=cs_test`],
    ["stripe customer query", `https://augmentworks.ai/portal/billing?customer=cus_123&workspace=${WORKSPACE}`],
    ["off-path checkout", `https://checkout.stripe.com/c/pay/cs_test`],
    ["orders subpath", `https://augmentworks.ai/portal/billing/orders/${WORKSPACE}?workspace=${WORKSPACE}`],
    ["http production", `http://augmentworks.ai/portal/billing?workspace=${WORKSPACE}`]
  ])("rejects %s", (_label, value) => {
    expect(() => assertSafeBillingPageUrl(value, production, WORKSPACE)).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/INVALID_CLOUD_RESPONSE|WORKSPACE_MISMATCH/u) })
    );
  });

  it("rejects a workspace query that does not match the authenticated workspace", () => {
    expect(() =>
      assertSafeBillingPageUrl(
        `https://augmentworks.ai/portal/billing?workspace=${OTHER}`,
        production,
        WORKSPACE
      )
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_MISMATCH" }));
  });

  it("does not treat a loopback API origin as permission to open an off-origin redirect", () => {
    expect(() =>
      assertSafeBillingPageUrl(
        `https://evil.example/portal/billing?workspace=${WORKSPACE}`,
        loopback,
        WORKSPACE
      )
    ).toThrow(expect.objectContaining({ code: "INVALID_CLOUD_RESPONSE" }));
  });
});
