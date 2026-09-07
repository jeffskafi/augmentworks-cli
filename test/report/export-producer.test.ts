import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { classifyRunReportExport, exportHostedRunReport } from "../../src/report/client.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";
import { REPORT_RUN_ID, fixtureResponse } from "./fixtures.js";
import {
  PRODUCER_CLARITY_ID,
  PRODUCER_CRITERION_ID,
  producerFixtureResponse
} from "./producer-fixtures.js";

const TOKEN = "aw_api_test_producer_report_export_token";
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
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

async function exportFrom(server: ListeningServer) {
  return await exportHostedRunReport(REPORT_RUN_ID, {
    apiOrigin: new URL(server.baseUrl),
    credentialSource: "api_key",
    accessTokenProvider: async () => TOKEN,
    sleep: async () => undefined
  });
}

function serveProducer(response: ServerResponse, name: string): void {
  const fixture = producerFixtureResponse(name);
  send(response, fixture.status, fixture.body);
}

function serveReport(response: ServerResponse, name: string, origin: string): void {
  const fixture = fixtureResponse(name, origin);
  send(response, fixture.status, fixture.body);
}

function isCriteriaIndex(url: URL): boolean {
  return url.pathname.endsWith("/criteria");
}

function criterionIdFromPath(pathname: string): string | undefined {
  const match = /\/criteria\/([^/]+)$/u.exec(pathname);
  return match?.[1];
}

describe("hosted report export against producer criterion wire", () => {
  it("exports a producer-shaped one-page pass with retained nested evidence", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method !== "GET") return false;
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveReport(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (isCriteriaIndex(url)) {
        serveProducer(response, "producer_index_one_page_pass");
        return true;
      }
      if (criterionIdFromPath(url.pathname) === PRODUCER_CRITERION_ID) {
        serveProducer(response, "producer_detail_pass");
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.criteria).toHaveLength(1);
    expect(document.criteria?.[0]?.["verdict"]).toBe("pass");
    expect((document.criteria?.[0]?.["evidence"] as { availability?: string }).availability).toBe("available");
    expect((document.criteria?.[0]?.["evidence"] as { text?: string }).text).toContain("30 days");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.OK);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
    expect(paths.some((path) => path.endsWith(`/criteria/${PRODUCER_CRITERION_ID}`))).toBe(true);
    expect(JSON.stringify(document)).not.toContain(TOKEN);
  });

  it("exports a producer-shaped required fail as a complete failed assessment", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveReport(response, "report_required_fail", server.baseUrl);
        return true;
      }
      if (isCriteriaIndex(url)) {
        serveProducer(response, "producer_index_one_page_fail");
        return true;
      }
      if (criterionIdFromPath(url.pathname) === PRODUCER_CRITERION_ID) {
        serveProducer(response, "producer_detail_fail");
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.criteria?.[0]?.["verdict"]).toBe("fail");
    expect((document.criteria?.[0]?.["evidence"] as { text?: string }).text).toContain("365 days");
    const classified = classifyRunReportExport(document);
    expect(classified.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(classified.assessment).toBe("failed");
    expect(paths.every((path) => path.startsWith("GET "))).toBe(true);
  });

  it("follows producer multi-page indexes and nested details under one binding", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveReport(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (isCriteriaIndex(url)) {
        serveProducer(
          response,
          url.searchParams.get("cursor") === "crit-2" ? "producer_index_page_2" : "producer_index_page_1"
        );
        return true;
      }
      if (criterionIdFromPath(url.pathname) === PRODUCER_CRITERION_ID) {
        serveProducer(response, "producer_detail_pass");
        return true;
      }
      if (criterionIdFromPath(url.pathname) === PRODUCER_CLARITY_ID) {
        serveProducer(response, "producer_detail_clarity");
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.criteria).toHaveLength(2);
    expect(document.criteria?.[0]?.["verdict"]).toBe("pass");
    expect(document.criteria?.[1]?.["criterionId"]).toBe(PRODUCER_CLARITY_ID);
    expect(document.criteria?.[1]?.["required"]).toBe(false);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.OK);
  });

  it("does not treat a required null producer verdict as a passing complete export", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveReport(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (isCriteriaIndex(url)) {
        serveProducer(response, "producer_index_one_page_pass");
        return true;
      }
      if (criterionIdFromPath(url.pathname) === PRODUCER_CRITERION_ID) {
        serveProducer(response, "producer_detail_null_verdict");
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.criteria?.[0]?.["verdict"]).toBe("not_judged");
    expect(document.diagnostics.some((item) => item.code === "CRITERION_VERDICT_INCOMPLETE")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("keeps missing required evidence incomplete and does not invent a pass", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveReport(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (isCriteriaIndex(url)) {
        serveProducer(response, "producer_index_one_page_pass");
        return true;
      }
      if (criterionIdFromPath(url.pathname) === PRODUCER_CRITERION_ID) {
        serveProducer(response, "producer_detail_missing_evidence");
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect((document.criteria?.[0]?.["evidence"] as { availability?: string }).availability).toBe("missing");
    expect(document.diagnostics.some((item) => item.code === "CRITERION_EVIDENCE_MISSING")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("rejects a producer index pinned to the wrong snapshot hash", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveReport(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveProducer(response, "producer_index_wrong_hash");
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.complete).toBe(false);
    expect(document.error?.code).toBe("CRITERION_BINDING_MISMATCH");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.RELAY);
  });

  it("rejects an unsupported producer verdict without converting it to pass", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveReport(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (isCriteriaIndex(url)) {
        serveProducer(response, "producer_index_one_page_pass");
        return true;
      }
      if (criterionIdFromPath(url.pathname) === PRODUCER_CRITERION_ID) {
        serveProducer(response, "producer_detail_unsupported_verdict");
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "CRITERION_VERDICT_UNSUPPORTED")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });
});
