# Billing Stage 2B → main Stage 3A handoff

Owned by `jeffskafi/augmentworks-cli`. Main owns the wire contract. This
repository vendors that contract; it does not change it.

Imported main handoff is saved separately at
`docs/billing/main-source-handoff.md`. Do not treat that file as the CLI-owned
handoff.

## Identity

| Item | Value |
| --- | --- |
| CLI 1B baseline HEAD | `b26927f679e634692b89c6c080a694b30d94b6bd` (`cursor/billing-stage-1b-91a7`) |
| Working branch | `cursor/billing-stage-2b-91a7` |
| Implementation | recorded in `docs/billing/phase-2-completion.md` after the landing commit |
| Vendored main commit | `67749b22f04bbb8d94c0309acd36be3cb3144400` (`cursor/billing-stage-2a-91a7`) |
| Stage | **2B code complete.** Deterministic verification is recorded in the phase-2 completion file. Not npm-published. Not production-verified against a live 2A host. Not live-sales ready. |

## What Stage 2B implemented

Quotes, spending ceilings, quoted create, and original-run status/recovery:

- `augmentworks test --estimate` / `test --estimate --json`
- `augmentworks test --assessment … --max-credits N [--yes]`
- `augmentworks run status <run-id>`
- `augmentworks run wait <run-id>`
- `augmentworks run retry-evaluation <run-id>`

No Checkout, subscriptions, Stripe credentials, Clerk, pack purchase, or a
competing route layout.

`--estimate` compiles the same assessment as admission and calls
`POST /v1/billing/quote`. It does not create a run, reserve credits, grant
credits, call a model, or contact the target. The server `assessmentPlanHash`
is not interchangeable with the local freeze hash.

Quoted create uses `aw-relay/0.3` with `quote_id` (required UUID) and
`max_credits` (optional nonnegative safe integer). Those fields are not sent
through strict `aw-relay/0.1` or `0.2` objects. Legacy `--packet` hosted tests
keep `aw-relay/0.1` and do not quote.

`--max-credits` is a customer-unit ceiling, not provider dollars. Zero rejects
every positive-unit run. `--yes` skips the prompt and is not an unlimited
budget. Noninteractive hosted `--assessment` requires an explicit ceiling
before quoting.

A dropped or ambiguous create retries/reconciles the same create identity.
It does not fetch a fresh quote while the original intent is still ambiguous.
A proven-uncreated expired quote is retired; the next invocation may re-quote.

Pending grading after target completion tells the user evidence is saved and
to `run wait` / `run status` the original run. It does not tell them to
re-run the test command. `retry-evaluation` is opt-in, reuses saved evidence,
and must report `customer_units_debited: 0`.

## Vendored contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `contracts/aw-billing-v1.schema.json` =
  `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901`
- `contracts/aw-billing-v1.fixtures.json` =
  `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1`

Lock: `contracts/aw-billing-v1.lock.json`
Generated bindings: `src/billing/generated/contract.ts`

```bash
node scripts/import-aw-billing-contract.mjs --from <path-to-jeffskafi/augmentworks>
npm run check:billing-contract
```

The check fails when generated bindings or file hashes diverge.

### Routes used by this CLI

Primary only:

- `GET /v1/billing/capabilities`
- `GET /v1/billing/usage`
- `POST /v1/billing/quote`
- `GET /v1/billing/status?runId=<uuid>`
- `POST /v1/relay/runs` (`aw-relay/0.3` quoted create, `0.1` packet-only)
- `GET /v1/relay/runs/{runId}` (strict execution status; unchanged 1B JSON)
- `POST /v1/relay/run-intents:reconcile`
- `POST /v1/relay/runs/{runId}:retry-evaluation`

Server aliases `/api/v1/billing/*` exist and are not called by this CLI.

### Authentication

Existing opaque CLI bearer. Usage/capabilities: `connector:identity`.
Quote, status, create, reconcile, and evaluation retry: `connector:run`.
Refresh-once after HTTP 401. Workspace comes from the validated connector.
A cached `billingAccountId` or email never selects the wallet.

Read permission does not imply billing-management permission.

### Capabilities treated as available

Implemented when advertised: `usage_v1`, `quote_v1`, `status_v1`. Reserved
names `billing_portal_link_v1` and `subscriptions_v1` are ignored if present
and are not advertised by this CLI.

A server without `quote_v1` fails hosted `--assessment` as `UPDATE_REQUIRED`
(exit 13) and does not fall back to `aw-relay/0.2`. A server without
`status_v1` fails `run status` / `run wait` / `run retry-evaluation` as
`UPDATE_REQUIRED`. Missing `usage_v1` remains `USAGE_UNSUPPORTED`.

Consumers tolerate additive optional fields and a later non-null
`subscription` object without treating it as a live sale. Unknown
`accessState` / `evaluationStatus` / pricing versions fail closed.

### Errors (CLI mapping)

Parse typed `error.code` and `error.billingCode`. Do not guess from HTTP
status or message strings alone.

| Stable / wire | CLI code | Exit | Category |
| --- | --- | --- | --- |
| `INSUFFICIENT_CREDITS` / `insufficient_credits` | `INSUFFICIENT_CREDITS` | 13 | billing |
| `QUOTE_EXPIRED` / `quote_expired` | `QUOTE_EXPIRED` | 13 | billing |
| `QUOTE_MISMATCH` / `quote_mismatch` | `QUOTE_MISMATCH` | 13 | billing |
| `BUDGET_EXCEEDED` / `budget_exceeded` | `BUDGET_EXCEEDED` | 13 | billing |
| `UPDATE_REQUIRED` / `update_required` | `UPDATE_REQUIRED` | 13 | billing |
| `WORKSPACE_CLOSING` / `workspace_closing` | `WORKSPACE_CLOSING` | 13 | billing |
| `BILLING_UNAVAILABLE` / `service_unavailable` | `BILLING_UNAVAILABLE` | 13 | billing |
| `MEMBERSHIP_REVOKED` / `membership_revoked` | `MEMBERSHIP_REVOKED` | 3 | auth |

Quote/status HTTP 404/405/501 map to `UPDATE_REQUIRED`, not a zero balance.
Assessment failures remain exit 10. Incomplete grading remains 11. Grading
errors remain 12. Interrupt remains 130. `EXIT.BILLING` stays 13.

## Intent versions

Writes `aw-run-intent/0.3`. Reads `aw-run-intent/0.2` as compatible current.
`aw-run-intent/0.1` remains the legacy migrate path. Admission fingerprints
omit `create_request_id` and, for 0.3, `quote_id`, so a freshly minted quote
id is not treated as a different run.

## Local-mode independence

`demo`, `test --local`, offline `doctor`, and `schema` make no billing calls.
`--estimate`, `--max-credits`, and `--yes` are rejected with `--local`.

## Copyable commands (source 0.3.2)

```bash
node dist/index.js test --assessment ./augmentworks.assessment.yaml --estimate
node dist/index.js test --assessment ./augmentworks.assessment.yaml --estimate --json
node dist/index.js test --assessment ./augmentworks.assessment.yaml --profile quick --max-credits 30 --yes
node dist/index.js run status <run-id>
node dist/index.js run wait <run-id>
node dist/index.js run retry-evaluation <run-id>
```

Do not document `npx @augmentworks/cli@0.3.2`. Published npm remains 0.3.1.

## Stage 3A prerequisites (main repository)

1. Keep `aw-billing/1` usage/quote/status schemas stable (additive optional
   fields only).
2. Do not require this CLI to create Checkout Sessions or Stripe customers.
3. If Stage 3A adds `billing_portal_link_v1`, advertise it only when the
   first-party billing page exists. The CLI will open that URL in 3B.
4. Read this handoff plus `docs/billing/phase-2-completion.md` before 3A.
5. CLI 3B will re-import the exact schema/fixtures after 3A publishes them.

## Live activation

**Not enabled.** This prompt must not publish `@augmentworks/cli`, change
production feature flags, or claim production billing is active.
