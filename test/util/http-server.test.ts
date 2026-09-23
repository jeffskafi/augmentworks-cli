import { describe, expect, it } from "vitest";

import { withoutEphemeralLoopbackPort } from "./http-server.js";

describe("withoutEphemeralLoopbackPort", () => {
  it("keeps a catalog-price check from matching the loopback port", () => {
    const stdout = [
      "Workspace: Test Workspace (11111111-1111-4111-8111-111111111111)",
      "API origin: http://127.0.0.1:51492",
      "Available credits: 300",
      "Subscription: none. Purchased packs remain usable without a monthly plan."
    ].join("\n");

    expect(stdout).toContain("149");
    expect(withoutEphemeralLoopbackPort(stdout)).not.toContain("149");
    expect(withoutEphemeralLoopbackPort(`${stdout}\n$149`)).toContain("149");
    expect(withoutEphemeralLoopbackPort("http://127.0.0.1:49152")).not.toContain("49");
  });
});
