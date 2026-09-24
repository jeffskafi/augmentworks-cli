import { Command } from "commander";

import { AwError } from "../errors.js";
import { CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE } from "../action-gate/documents.js";
import { ActionIntentLedger } from "../action-gate/ledger.js";
import { createHostedActionClient } from "../action-gate/client.js";
import { retryReceiptDelivery } from "../action-gate/boundary.js";

export interface ActionCommandIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
}

export function createActionCommand(io: ActionCommandIo): Command {
  const action = new Command("action")
    .description(
      "Recover a customer-side controlled-action receipt. Public controlled actions stay unavailable."
    );

  action
    .command("recover")
    .description("Retry durable receipt delivery without rerunning the customer tool")
    .option("--state-dir <path>", "action intent ledger directory")
    .option("--origin <url>", "hosted API origin; omit to stay offline")
    .option("--token <token>", "bearer token used only when --origin is set")
    .option("--json", "print the recovery report as JSON")
    .action(async (options: { stateDir?: string; origin?: string; token?: string; json?: boolean }) => {
      if (CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE) {
        throw new AwError({
          code: "INTERNAL",
          category: "config",
          message: "Public controlled actions must stay disabled in this release."
        });
      }
      if (options.stateDir === undefined) {
        throw new AwError({
          code: "ACTION_BOUNDARY_REQUIRED",
          category: "config",
          message: "Pass --state-dir for the local action intent ledger. This command does not enable controlled actions."
        });
      }
      const ledger = new ActionIntentLedger(options.stateDir);
      const intents = await ledger.list();
      const pending = intents.filter((intent) => intent.state === "receipt_pending" && intent.receiptBytes !== null);
      const service =
        options.origin === undefined
          ? undefined
          : createHostedActionClient({
              origin: options.origin,
              token: options.token ?? ""
            });
      const results = [];
      for (const intent of pending) {
        if (intent.mode === "local-offline" || service === undefined) {
          results.push({
            intentId: intent.intentId,
            evidenceStatus: "reported" as const,
            receiptAccepted: false,
            toolInvocations: intent.toolInvocations,
            platformSignature: false as const
          });
          continue;
        }
        const delivered = await retryReceiptDelivery(
          { mode: "hosted", service, ledger },
          intent
        );
        results.push({
          intentId: intent.intentId,
          evidenceStatus: delivered.evidenceStatus,
          receiptAccepted: delivered.receiptAccepted,
          toolInvocations: delivered.intent.toolInvocations,
          platformSignature: false as const
        });
      }
      const report = {
        controlledActionsAvailable: CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE,
        retried: results.length,
        results
      };
      io.stdout(options.json ? JSON.stringify(report) : `Retried ${results.length} pending receipt(s). Controlled actions remain unavailable.`);
    });

  return action;
}
