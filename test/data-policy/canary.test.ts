import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { inspectOutbound, PLACEHOLDERS } from "../../src/data-policy/index.js";
import { CANARIES, expectNoCanaries, leakText, makeContext, makePolicy, makeProfile } from "./helpers.js";

const canaryPath = resolve(fileURLToPath(new URL("../fixtures/data-policy/canary-document.json", import.meta.url)));

describe("data-policy canaries", () => {
  it("keeps invented secrets out of a fake HTTP upload, stdout, and errors", async () => {
    const document = JSON.parse(await readFile(canaryPath, "utf8")) as Record<string, unknown>;
    const context = makeContext(
      "public",
      "minimized",
      [
        { id: "mask-email", selector: "/message/content", action: "mask", detector: "email" },
        { id: "mask-phone", selector: "/message/content", action: "mask", detector: "phone" }
      ],
      [],
      [CANARIES.secret, CANARIES.token, CANARIES.password]
    );
    const inspected = inspectOutbound(document, context.policy, context.profile, context.localSecrets);
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    });
    await fetchMock("https://example.test/upload", { body: JSON.stringify(inspected) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoCanaries(inspected);
    expectNoCanaries(bodies);
    expectNoCanaries(inspected.receipt);
    expect(leakText(inspected)).toContain(PLACEHOLDERS.credential);
    expect(inspected.receipt.outcome === "blocked" || inspected.receipt.outcome === "transformed").toBe(true);
  });

  it("supports public, business, and personal modes as declared", () => {
    const document = {
      message: `Hello ${CANARIES.email}`,
      api_key: CANARIES.apiKey,
      status: "passed"
    };
    const publicCtx = makeContext("public", "minimized", [
      { id: "mask-email", selector: "/message", action: "mask", detector: "email" }
    ]);
    const businessCtx = makeContext("business", "minimized", []);
    const personalCtx = makeContext("personal", "verbatim", []);

    const publicOut = inspectOutbound(document, publicCtx.policy, publicCtx.profile, publicCtx.localSecrets);
    const businessOut = inspectOutbound(
      document,
      businessCtx.policy,
      businessCtx.profile,
      businessCtx.localSecrets
    );
    const personalOut = inspectOutbound(
      document,
      personalCtx.policy,
      personalCtx.profile,
      personalCtx.localSecrets
    );

    expect(JSON.stringify(publicOut)).not.toContain(CANARIES.email);
    expect(JSON.stringify(publicOut)).not.toContain(CANARIES.apiKey);
    expect((businessOut.representation as { status: string }).status).toBe("passed");
    expect(JSON.stringify(businessOut)).not.toContain(CANARIES.apiKey);
    expect(JSON.stringify(personalOut)).toContain(CANARIES.email);
    expect(JSON.stringify(personalOut)).not.toContain(CANARIES.apiKey);
    expect(publicOut.receipt.outcome).not.toBe("accepted");
  });

  it("does not issue a request when a pre-upload block fires", () => {
    const profile = makeProfile({
      rules: [{ id: "block-note", selector: "/note", action: "block", detector: "field" }]
    });
    const policy = makePolicy(profile);
    const fetchMock = vi.fn();
    const inspected = inspectOutbound({ note: CANARIES.secret }, policy, profile, []);
    expect(inspected.receipt.outcome).toBe("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoCanaries(inspected);
  });
});
