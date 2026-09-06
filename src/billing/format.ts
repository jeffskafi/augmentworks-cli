import { sanitizeTerminal } from "../errors.js";
import { grantOriginKind, type BillingGrantBalance, type BillingQuote, type BillingRunStatus, type BillingUsage } from "./protocol.js";
import { assertSafeBillingPageUrl } from "./validate.js";

const ORIGIN_LABEL: Record<ReturnType<typeof grantOriginKind>, string> = {
  trial_promotional: "Trial/promotional",
  purchased: "Purchased",
  recurring: "Recurring",
  unrecognized: "Unrecognized origin"
};

export function formatUsageHuman(input: {
  readonly usage: BillingUsage;
  readonly workspaceLabel: string;
  readonly apiOrigin: URL;
}): string {
  const { usage, apiOrigin } = input;
  const workspace = sanitizeTerminal(input.workspaceLabel);
  const lines: string[] = [];
  lines.push(`Workspace: ${workspace}`);
  lines.push(`Available credits: ${String(usage.availableUnits)}`);
  lines.push("");
  lines.push(`Reserved credits: ${String(usage.reservedUnits)}`);
  lines.push(
    "Reserved credits are held for in-progress scenario attempts and are not yet consumed."
  );
  lines.push("");
  lines.push(`Consumed credits: ${String(usage.consumedUnits)}`);
  lines.push(
    "Consumed credits are the net units charged at the first durable target-command lease, after any approved compensation."
  );
  lines.push("");
  lines.push("Grant lots:");
  if (usage.grantBalances.length === 0) {
    lines.push("  (none)");
  } else {
    for (const lot of usage.grantBalances) {
      lines.push(`  ${formatGrantLot(lot)}`);
    }
  }
  lines.push("");
  lines.push(
    `These values are a server snapshot at ${sanitizeTerminal(usage.asOf)} (ledger revision ${String(usage.ledgerRevision)}), not a guaranteed future balance.`
  );
  lines.push(`Workspace access: ${sanitizeTerminal(usage.accessState)}.`);
  if (usage.accessState !== "active") {
    lines.push("New hosted tests are rejected in this access state. This snapshot remains readable.");
  }
  lines.push(
    "This command is read-only. It does not grant credits, reserve units, open checkout, or manage billing. Billing changes require a signed-in browser session with billing permission."
  );
  try {
    const billingUrl = assertSafeBillingPageUrl(usage.billingPageUrl, apiOrigin);
    lines.push(`Billing page: ${sanitizeTerminal(billingUrl.toString())}`);
  } catch {
    lines.push("Billing page: (omitted; the server URL was not a trusted first-party billing path.)");
  }
  return `${lines.join("\n")}\n`;
}

function formatGrantLot(lot: BillingGrantBalance): string {
  const kind = ORIGIN_LABEL[grantOriginKind(lot.origin)];
  const expiry =
    lot.expiresAt === null ? "no expiry" : `expires ${sanitizeTerminal(lot.expiresAt)}`;
  return `${kind}: ${String(lot.availableUnits)} available of ${String(lot.grantedUnits)} granted (${expiry})`;
}

export function usageSuccessJson(usage: BillingUsage): string {
  return `${JSON.stringify({
    ok: true,
    schemaVersion: usage.schemaVersion,
    workspaceId: usage.workspaceId,
    billingAccountId: usage.billingAccountId,
    asOf: usage.asOf,
    ledgerRevision: usage.ledgerRevision,
    accessState: usage.accessState,
    availableUnits: usage.availableUnits,
    reservedUnits: usage.reservedUnits,
    consumedUnits: usage.consumedUnits,
    grantBalances: usage.grantBalances,
    subscription: usage.subscription,
    billingPageUrl: usage.billingPageUrl,
    capabilities: usage.capabilities,
    ...(usage.grossConsumedUnits === undefined ? {} : { grossConsumedUnits: usage.grossConsumedUnits }),
    ...(usage.compensatedUnits === undefined ? {} : { compensatedUnits: usage.compensatedUnits }),
    ...(usage.cutoverVersion === undefined ? {} : { cutoverVersion: usage.cutoverVersion })
  })}\n`;
}

export function formatEstimateHuman(input: {
  readonly quote: BillingQuote;
  readonly workspaceLabel: string;
  readonly localPlanHash: string;
}): string {
  const quote = input.quote;
  const lines: string[] = [];
  lines.push(`Workspace: ${sanitizeTerminal(input.workspaceLabel)}`);
  lines.push(`Quoted credits: ${String(quote.executionUnits)}`);
  const breakdown = formatQuoteBreakdown(quote);
  if (breakdown !== undefined) lines.push(breakdown);
  lines.push(`Available credits at quote: ${String(quote.availableUnitsAtQuote)} (server snapshot)`);
  if (quote.remainingUnitsEstimate !== undefined) {
    lines.push(
      `Estimated remaining after this run: ${String(quote.remainingUnitsEstimate)} (estimate only; not a reservation)`
    );
  }
  lines.push(
    "This quote is not a credit hold. Another run may use credits before this assessment starts."
  );
  lines.push(
    "AugmentWorks grading is included in standard credits. Your target provider may have separate costs."
  );
  lines.push(`Server assessment plan hash: ${quote.assessmentPlanHash}`);
  lines.push(
    `Local freeze hash: ${input.localPlanHash} (not interchangeable with the server assessmentPlanHash)`
  );
  lines.push(`Quote expires: ${sanitizeTerminal(quote.expiresAt)}`);
  lines.push(`Pricing version: ${sanitizeTerminal(quote.pricingVersion)}`);
  return `${lines.join("\n")}\n`;
}

export function formatQuoteBreakdown(quote: BillingQuote): string | undefined {
  if (quote.scenarioCount === undefined || quote.repetitions === undefined) return undefined;
  return `  ${String(quote.scenarioCount)} scenarios × ${String(quote.repetitions)} repetitions = ${String(quote.executionUnits)} credits`;
}

export function estimateSuccessJson(input: {
  readonly quote: BillingQuote;
  readonly localPlanHash: string;
}): string {
  const { quote } = input;
  return `${JSON.stringify({
    ok: true,
    schemaVersion: quote.schemaVersion,
    quoteId: quote.quoteId,
    workspaceId: quote.workspaceId,
    assessmentPlanHash: quote.assessmentPlanHash,
    localPlanHash: input.localPlanHash,
    pricingVersion: quote.pricingVersion,
    executionUnits: quote.executionUnits,
    expiresAt: quote.expiresAt,
    availableUnitsAtQuote: quote.availableUnitsAtQuote,
    estimateOnly: true,
    ...(quote.scenarioCount === undefined ? {} : { scenarioCount: quote.scenarioCount }),
    ...(quote.repetitions === undefined ? {} : { repetitions: quote.repetitions }),
    ...(quote.remainingUnitsEstimate === undefined
      ? {}
      : { remainingUnitsEstimate: quote.remainingUnitsEstimate })
  })}\n`;
}

export function formatRunStatusHuman(status: BillingRunStatus): string {
  const lines: string[] = [];
  lines.push(`Original run: ${sanitizeTerminal(status.originalRunId)}`);
  if (status.runId !== status.originalRunId) {
    lines.push(`Status run: ${sanitizeTerminal(status.runId)}`);
  }
  lines.push(`Target execution: ${sanitizeTerminal(status.executionStatus)}`);
  lines.push(`Grading: ${sanitizeTerminal(status.evaluationStatus)}`);
  lines.push(
    `Credits: reserved ${String(status.credit.reservedUnits)}, consumed ${String(status.credit.consumedUnits)}, released ${String(status.credit.releasedUnits)}, compensated ${String(status.credit.compensatedUnits)}`
  );
  lines.push(
    `Progress: ${String(status.progress.completedAttempts)}/${String(status.progress.plannedAttempts)} attempts, ${String(status.progress.completedJudgeJobs)}/${String(status.progress.plannedJudgeJobs)} grading jobs`
  );
  if (status.savedEvidence) {
    lines.push("Your test evidence is saved.");
  }
  if (status.evaluationStatus === "pending" || status.evaluationStatus === "partial") {
    lines.push(
      `Grading is pending on the original run. Wait with: augmentworks run wait ${status.originalRunId}`
    );
    lines.push(`Inspect with: augmentworks run status ${status.originalRunId}`);
  }
  if (status.retryEligible) {
    lines.push(
      `Server-approved grading retry is available without another test credit. Use: augmentworks run retry-evaluation ${status.originalRunId}`
    );
    if (status.retryReason !== null) {
      lines.push(`Retry reason: ${sanitizeTerminal(status.retryReason)}`);
    }
  }
  lines.push(`Next actions: ${status.nextActions.map((action) => sanitizeTerminal(action)).join(", ")}`);
  lines.push(`Dashboard: ${sanitizeTerminal(status.dashboardUrl)}`);
  lines.push(`Snapshot at ${sanitizeTerminal(status.asOf)}`);
  return `${lines.join("\n")}\n`;
}

export function runStatusSuccessJson(status: BillingRunStatus): string {
  return `${JSON.stringify({
    ok: true,
    schemaVersion: status.schemaVersion,
    runId: status.runId,
    workspaceId: status.workspaceId,
    originalRunId: status.originalRunId,
    executionStatus: status.executionStatus,
    evaluationStatus: status.evaluationStatus,
    credit: status.credit,
    progress: status.progress,
    savedEvidence: status.savedEvidence,
    retryEligible: status.retryEligible,
    retryReason: status.retryReason,
    nextActions: status.nextActions,
    dashboardUrl: status.dashboardUrl,
    asOf: status.asOf,
    ...(status.outcome === undefined ? {} : { outcome: status.outcome })
  })}\n`;
}

export function retryEvaluationSuccessJson(result: {
  readonly protocolVersion: string;
  readonly runId: string;
  readonly evaluationId: string;
}): string {
  return `${JSON.stringify({
    ok: true,
    protocol_version: result.protocolVersion,
    run_id: result.runId,
    evaluation_id: result.evaluationId,
    reused_target_evidence: true,
    customer_units_debited: 0
  })}\n`;
}
