import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { exportHostedRunReport, classifyRunReportExport } from "../../src/report/client.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";
import {
  CANONICAL_ORIGIN,
  REPORT_RUN_ID,
  fixtureIdentity,
  fixtureResponse,
  rewriteOrigin
} from "./fixtures.js";

const TOKEN = "aw_api_test_report_export_token";

const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

async function startMock(
  handler: (request: IncomingMessage, response: ServerResponse, url: URL) => boolean
): Promise<{ server: ListeningServer; paths: string[] }> {
  const paths: string[] = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    paths.push(`${request.method ?? "GET"} ${url.pathname}`);
    if (!handler(request, response, url) && !response.writableEnded) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
    }
  });
  const server = await listenLoopback(httpServer);
  servers.push(server);
  return { server, paths };
}

async function exportFrom(server: ListeningServer): Promise<ReturnType<typeof exportHostedRunReport>> {
  return await exportHostedRunReport(REPORT_RUN_ID, {
    apiOrigin: new URL(server.baseUrl),
    credentialSource: "api_key",
    accessTokenProvider: async () => TOKEN,
    sleep: async () => undefined
  });
}

function serveFixture(response: ServerResponse, name: string, origin: string): void {
  const fixture = fixtureResponse(name, origin);
  send(response, fixture.status, fixture.body, fixture.headers ?? {});
}

describe("hosted report HTTP contract", () => {
  it("exports a one-page passed report with criterion evidence", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method !== "GET") return false;
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.outcome).toBe("passed");
    expect(document.criteria).toHaveLength(1);
    expect(document.criteria?.[0]?.["verdict"]).toBe("pass");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.OK);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
    expect(JSON.stringify(document)).not.toContain(TOKEN);
  });

  it("exports a complete failed assessment with exit 10, never pass", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_required_fail", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_fail", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.outcome).toBe("failed");
    expect(document.report?.attempts[0]?.mappedResponse.text).toContain("365 days");
    expect(document.criteria?.[0]?.["verdict"]).toBe("fail");
    const classified = classifyRunReportExport(document);
    expect(classified.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(classified.assessment).toBe("failed");
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("follows multi-page reports and criterion pagination under one binding", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(
          response,
          url.searchParams.get("cursor") === "page-2" ? "report_page_2" : "report_page_1",
          server.baseUrl
        );
        return true;
      }
      if (url.pathname.endsWith("/criteria")) {
        if (url.pathname.includes("/attempts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/")) {
          if (url.searchParams.get("cursor") === "crit-2") {
            serveFixture(response, "criterion_index_page_2", server.baseUrl);
            return true;
          }
          serveFixture(response, "criterion_index_page_1", server.baseUrl);
          return true;
        }
        if (url.pathname.includes("/attempts/cececece-cece-4cec-8cec-cececececece/")) {
          serveFixture(response, "criterion_index_r04_pass", server.baseUrl);
          return true;
        }
      }
      if (url.pathname.endsWith("/dddddddd-dddd-4ddd-8ddd-dddddddddddd")) {
        serveFixture(response, "criterion_detail_r01_pass", server.baseUrl);
        return true;
      }
      if (url.pathname.endsWith("/dfdfdfdf-dfdf-4dfd-8dfd-dfdfdfdfdfdf")) {
        serveFixture(response, "criterion_detail_r01_clarity", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.attempts).toHaveLength(2);
    expect(document.criteria).toHaveLength(3);
  });

  it("rejects a report whose runId does not match the request", async () => {
    const { server } = await startMock((_request, response) => {
      const fixture = fixtureResponse("report_all_pass_one_page", server.baseUrl);
      const body = fixture.body as { runId: string };
      send(response, 200, { ...body, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.complete).toBe(false);
    expect(document.error?.code).toBe("REPORT_ID_MISMATCH");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.RELAY);
  });

  it("maps missing report scope to auth exit 3", async () => {
    const { server } = await startMock((_request, response) => {
      send(response, 403, { error: "insufficient_scope" });
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("SCOPE_DENIED");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.AUTH);
  });

  it("does not treat reportReady false as a passing assessment", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        const fixture = fixtureResponse("report_all_pass_one_page", server.baseUrl);
        send(response, 200, { ...(fixture.body as object), reportReady: false });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.outcome).toBe("passed");
    expect(document.report?.reportReady).toBe(false);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("fails when evaluation binding changes during pagination", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(
          response,
          url.searchParams.get("cursor") === "page-2"
            ? "report_binding_changed_page_2"
            : "report_page_1",
          server.baseUrl
        );
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.complete).toBe(false);
    expect(document.error?.code).toBe("REPORT_BINDING_CHANGED");
  });

  it("refuses hostile off-origin criterion links with the bearer", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "report_off_origin_link", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("UNSAFE_REPORT_LINK");
  });

  it("refuses cursor cycles", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "report_cursor_cycle", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "REPORT_CURSOR_CYCLE")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("retries 429 then succeeds", async () => {
    let hits = 0;
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        hits += 1;
        if (hits === 1) {
          serveFixture(response, "error_429", server.baseUrl);
          return true;
        }
        serveFixture(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(hits).toBe(2);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
  });

  it("returns typed 410 purge failures", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "error_410", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_PURGED");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.RELAY);
  });

  it("returns typed 503 failures after the retry budget", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "error_503", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_UNAVAILABLE");
    expect(document.error?.retryable).toBe(true);
  });

  it("rejects malformed schemas", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "report_malformed", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_SCHEMA_INVALID");
  });

  it("marks missing required evidence incomplete, not a pass", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_missing_evidence", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("detects mappedResponse hash mismatches", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_bad_hash", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "MAPPED_RESPONSE_HASH_MISMATCH")).toBe(
      true
    );
  });

  it("maps invalid API keys to retrieved false without following CANONICAL_ORIGIN", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "error_401", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("API_KEY_REVOKED");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.AUTH);
    expect(CANONICAL_ORIGIN).toContain("augmentworks.ai");
  });

  it("rewrites fixture origins for loopback tests without changing wire field names", () => {
    const rewritten = rewriteOrigin({ dashboardUrl: `${CANONICAL_ORIGIN}/portal/runs/x` }, "http://127.0.0.1:9");
    expect(rewritten).toEqual({ dashboardUrl: "http://127.0.0.1:9/portal/runs/x" });
    expect(fixtureIdentity("machine_report_only")["email"]).toBeUndefined();
    expect(fixtureIdentity("machine_report_only")["principal_kind"]).toBe("machine");
  });
});
