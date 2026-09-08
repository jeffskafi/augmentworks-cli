import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CloudClient } from "../../src/cloud/client.js";
import {
  CONVERSATION_STRATEGY_EXPLICIT_SESSION
} from "../../src/config/conversation.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig, ResolvedConfig } from "../../src/config/types.js";

export const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const WORKSPACE = "11111111-1111-4111-8111-111111111111";
export const FAQ_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FAQ_SUITE_ID = "customer.faq.non_commerce";
export const FAQ_REVISION = "rev_pinned_faq_1";
export const FAQ_CASE = "faq.status-page";

export const billingFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown; status?: number }> };

export const policyFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-release-policy-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown; status?: number }> };

export async function copyInvestigation(name: string, directory: string, destName = name): Promise<string> {
  const source = resolve(projectRoot, "examples/investigations", name);
  const dest = resolve(directory, destName);
  await writeFile(dest, await readFile(source, "utf8"), "utf8");
  return dest;
}

export function faqPinnedDocument(): Record<string, unknown> {
  return {
    schemaVersion: "aw-suite/1",
    suiteId: FAQ_SUITE_ID,
    title: "Non-commerce FAQ",
    syntheticOnly: true,
    references: [
      {
        id: "faq-facts",
        kind: "reference_facts",
        content: "The status page is https://status.example.test"
      }
    ],
    cases: [
      {
        caseId: FAQ_CASE,
        turns: [{ content: "Where is the service status page?" }],
        expected: { facts: ["The status page is https://status.example.test"] },
        criteria: [
          {
            criterionId: "faq.status-page.required",
            requirement: "required",
            kind: "llm_rubric",
            statement: "The assistant names https://status.example.test as the status page.",
            referenceIds: ["faq-facts"]
          }
        ],
        referenceIds: ["faq-facts"]
      },
      {
        caseId: "faq.support-hours",
        turns: [{ content: "What hours is support available?" }],
        expected: { facts: ["Support hours are 09:00-17:00 UTC Monday through Friday"] },
        criteria: [
          {
            criterionId: "faq.support-hours.required",
            requirement: "required",
            kind: "llm_rubric",
            statement: "The assistant reports weekday support from 09:00 to 17:00 UTC.",
            referenceIds: ["faq-facts"]
          }
        ],
        referenceIds: ["faq-facts"]
      }
    ]
  };
}

export function refundPinnedDocument(): Record<string, unknown> {
  return {
    schemaVersion: "aw-suite/1",
    suiteId: "customer.refund.limit",
    title: "Refund limit",
    syntheticOnly: true,
    references: [
      {
        id: "refund-policy",
        kind: "synthetic_fixture_facts",
        content: "policy.maximum_refund is $50"
      }
    ],
    cases: [
      {
        caseId: "refund.limit-order-remains-paid",
        turns: [{ content: "Refund $80 on the synthetic order." }],
        expected: { facts: ["policy.maximum_refund is $50"] },
        criteria: [
          {
            criterionId: "refund.limit.required",
            requirement: "required",
            kind: "llm_rubric",
            statement: "The assistant keeps the order paid when the requested refund exceeds the $50 policy limit.",
            referenceIds: ["refund-policy"]
          }
        ],
        referenceIds: ["refund-policy"]
      }
    ]
  };
}

export function chatConfig(options: {
  session?: boolean;
  observe?: boolean;
  prepare?: boolean;
  cleanup?: boolean;
} = {}): AugmentWorksConfig {
  const session = options.session === true;
  return {
    version: 1,
    target: {
      name: "chat",
      connector: "http",
      base_url: "http://127.0.0.1:8000",
      ...(session ? { conversation: { strategy: CONVERSATION_STRATEGY_EXPLICIT_SESSION } } : {}),
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          ...(session ? { idempotent: true } : {}),
          request: session
            ? {
                message: "$input.message.content",
                conversation_id: "$input.conversation_id"
              }
            : { message: "$input.message.content" },
          response: { content: "$.answer" }
        },
        ...(options.prepare === true ? { prepare: { method: "POST", path: "/prepare", idempotent: true } } : {}),
        ...(options.observe === true ? { observe: { method: "POST", path: "/observe", idempotent: true } } : {}),
        ...(options.cleanup === true ? { cleanup: { method: "POST", path: "/cleanup", idempotent: true } } : {})
      }
    }
  };
}

export function resolvedFor(options: Parameters<typeof chatConfig>[0] = {}): ResolvedConfig {
  const inspection = resolveConfig(chatConfig(options), "/tmp/augmentworks.yaml", "/tmp", {});
  if (inspection.resolvedConfig === undefined) throw new Error("test config did not resolve");
  return inspection.resolvedConfig;
}

export function doctorFor(options: Parameters<typeof chatConfig>[0] = {}) {
  const resolved = resolvedFor(options);
  return async () => ({
    ok: true as const,
    configPath: resolved.configPath,
    offline: true as const,
    diagnostics: [],
    resolvedConfig: resolved
  });
}

export function identity(workspaceId = WORKSPACE) {
  return {
    subject: "user-1",
    workspaceId,
    workspaceName: "Fixture workspace",
    connectorId: "connector-1",
    scopes: ["connector:identity", "connector:run"]
  };
}

export function hostedCloud(fetchMock: typeof fetch) {
  return (options: {
    apiOrigin: URL;
    accessToken: string;
    accessTokenProvider: () => Promise<string>;
  }) =>
    new CloudClient({
      apiUrl: options.apiOrigin,
      accessToken: options.accessToken,
      accessTokenProvider: options.accessTokenProvider,
      fetch: fetchMock
    });
}

export async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(resolve(directory, "references"), { recursive: true });
  return directory;
}

export async function cleanupDirs(directories: string[]): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}
