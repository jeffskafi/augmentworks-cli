import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadCustomerSuiteFile } from "../../src/suite/load.js";
import { previewCustomerSuite } from "../../src/suite/preview.js";
import { preflightCustomerSuite } from "../../src/suite/preflight.js";
import {
  AuthorizedNativeSuiteSourceSchema,
  nativeSuiteContentHash,
  nativeSuiteSource,
  parseNativeSuiteCreateDocument
} from "../../src/suite/native.js";
import { suitePacketBinding } from "../../src/suite/admit.js";
import { hostedSuiteUnsupportedLocalError } from "../../src/suite/errors.js";
import { loadLocalPacket } from "../../src/local/packet.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const authorizedFixture = resolve(projectRoot, "test/fixtures/customer-suites/authorized.yaml");

describe("authorized aw-suite/3 customer suites", () => {
  it("loads, previews, and maps to aw-customer-suite/3 without mutating v1 native hashes", async () => {
    const loaded = await loadCustomerSuiteFile(authorizedFixture);
    expect(loaded.document.schemaVersion).toBe("aw-suite/3");
    expect(loaded.document).not.toHaveProperty("syntheticOnly");
    expect(loaded.document).not.toHaveProperty("liveTarget");
    const preview = previewCustomerSuite(loaded);
    expect(preview.syntheticOnly).toBe(false);
    expect(preview.packet).toEqual({ key: "aw-customer-suite", version: "3.0.0" });
    expect(preview.executionScope?.scopeId).toBe("66666666-6666-4666-8666-666666666666");
    expect(suitePacketBinding(loaded)).toEqual({ key: "aw-customer-suite", version: "3.0.0" });
    const source = nativeSuiteSource(loaded);
    expect(source).toMatchObject({
      schemaVersion: "aw-customer-suite/3",
      packetOverlay: "aw-packet/authorized-1",
      suiteId: "authorized.records.fixture"
    });
    expect(source).not.toHaveProperty("syntheticOnly");
    expect(AuthorizedNativeSuiteSourceSchema.safeParse(source).success).toBe(true);
    expect(nativeSuiteContentHash(parseNativeSuiteCreateDocument(source))).toBe(nativeSuiteContentHash(source));
  });

  it("preflights as authorized overlay without contacting a target", async () => {
    const loaded = await loadCustomerSuiteFile(authorizedFixture);
    const preflight = await preflightCustomerSuite(loaded);
    expect(preflight.overlay).toBe("aw-packet/authorized-1");
    expect(preflight.syntheticOnly).toBe(false);
    expect(preflight.localPreview.executesTarget).toBe(false);
  });

  it("rejects hosted authorized packets in local mode", async () => {
    await expect(loadLocalPacket({ reference: authorizedFixture })).rejects.toMatchObject({
      code: "HOSTED_SUITE_UNSUPPORTED_LOCAL"
    });
    expect(hostedSuiteUnsupportedLocalError("x.yaml").message).not.toMatch(/syntheticOnly/);
  });
});
