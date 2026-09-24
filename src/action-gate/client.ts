import { ACTION_PERMITS_PATH, ACTION_RECEIPTS_PATH, ActionPermitSchema, ActionReceiptSchema } from "./documents.js";
import type { ActionPermit, ActionPermitRequest, ActionReceipt } from "./documents.js";
import type { ActionPermitService, ActionReceiptResult } from "./boundary.js";

export interface HostedActionClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export function createHostedActionClient(options: HostedActionClientOptions): ActionPermitService {
  const fetchImpl = options.fetch ?? fetch;
  const origin = options.origin.replace(/\/+$/, "");
  return {
    async issuePermit(request: ActionPermitRequest): Promise<ActionPermit> {
      const response = await fetchImpl(`${origin}${ACTION_PERMITS_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      if (!response.ok) {
        throw new Error(`Permit request failed with HTTP ${response.status}.`);
      }
      return ActionPermitSchema.parse(await response.json());
    },
    async acceptReceipt(receipt: ActionReceipt, raw: string): Promise<ActionReceiptResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${origin}${ACTION_RECEIPTS_PATH}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json"
          },
          body: raw
        });
      } catch {
        return {
          ok: false,
          code: "ACTION_OUTCOME_INDETERMINATE",
          message: "Receipt delivery ended before an acknowledgement.",
          unknown: true
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          code: "ACTION_OUTCOME_INDETERMINATE",
          message: `Receipt delivery was rejected with HTTP ${response.status}.`,
          unknown: response.status >= 500 || response.status === 408 || response.status === 429
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          ok: false,
          code: "ACTION_OUTCOME_INDETERMINATE",
          message: "Receipt delivery returned an unreadable acknowledgement.",
          unknown: true
        };
      }
      const accepted = body !== null && typeof body === "object" && (body as { accepted?: unknown }).accepted === true;
      if (!accepted) {
        return {
          ok: false,
          code: "ACTION_OUTCOME_INDETERMINATE",
          message: "The receipt ledger did not accept this receipt.",
          unknown: false
        };
      }
      ActionReceiptSchema.parse(receipt);
      return { ok: true, accepted: true };
    }
  };
}
