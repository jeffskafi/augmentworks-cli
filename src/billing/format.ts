import { sanitizeTerminal } from "../errors.js";
import { grantOriginKind, type BillingGrantBalance, type BillingUsage } from "./protocol.js";
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
