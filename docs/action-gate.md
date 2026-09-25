# Controlled-action customer wrapper

The installed package exports `runCustomerBoundary` for a customer's own side-effecting tool. Public controlled actions stay unavailable (`controlledActions.available` remains false) until the operator gate in AUG-199. This module does not publish the package or enable the capability.

The wrapper consumes the frozen `aw-action-permit/1` and `aw-action-receipt/1` documents.

## Permit before dispatch

The intent stays `prepared` while the wrapper requests a hosted permit. The idempotency key is the deterministic intent id. A thrown request, a timeout, or a response that is not a permit document leaves that prepared record in place, so the same input can obtain a permit later. The wrapper validates the permit, then claims `dispatching` with it. Only the winning claim invokes the tool.

## Durable receipt delivery

1. The intent is stored before the tool runs.
2. The tool runs at most once for that intent.
3. The exact signed receipt is stored before it is submitted.
4. If submission is rejected, times out, or the acknowledgement is unreadable, the result is `evidenceStatus: "indeterminate"`. It is not a verified receipt.
5. A later call retries those same receipt bytes. It does not request another permit and it does not run the tool again.
6. A duplicate delivery of that receipt converges on the accepted ledger state.

`action recover --state-dir <path>` retries pending receipts. Without `--origin` it makes no hosted call.

## Local-offline

`mode: "local-offline"` does not take a permit client. The receipt issuer key is a receiver-local key. The result reports `platformSignature: false` and `evidenceStatus: "reported"`. It does not claim a platform signature.

## Fail closed

Wrong workspace or receiver, forged, tampered, or expired permits, secret-bearing payloads, disallowed resource, amount, or currency, and revocation are denied without claiming dispatch and do not run the tool. Concurrent callers still invoke the tool once. A crash after the dispatch record is committed does not run the tool on restart, and that outcome stays indeterminate.
