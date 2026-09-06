# Billing Stage 2A → CLI Stage 2B handoff

Owned by `jeffskafi/augmentworks`. Do not implement Stage 2B in this
repository. The CLI counterpart must vendor this contract as published here.

## Identity

| Item | Value |
| --- | --- |
| Docs/contracts research baseline | `bc1bac16ee88aeece7cd7c58793abc0d611aa4bc` (`origin/main`) |
| Stage 1A implementation HEAD | `e037958ba3c9f38a436b6065cddb5fb8ee3943fa` (`cursor/billing-stage-1a-91a7`) |
| CLI Stage 1B implementation | `3d2bdfa32a727ac35c1b0ea49a9dfd376151b895` (`cursor/billing-stage-1b-91a7`) |
| Working branch | `cursor/billing-stage-2a-91a7` |
| Feature commit | `3e81b35f3d96cbfdcc763f26bbcf27de309b07de` |
| Verification record | `f560aa3f1978411638f001f55a22bc920afba89d` |
| Vendor pin | Tip of `cursor/billing-stage-2a-91a7` (hashes frozen since `3e81b35`) |
| Pull request | https://github.com/jeffskafi/augmentworks/pull/28 (base `cursor/billing-stage-1a-91a7`) |
| Stage | **2A code complete.** Deterministic unit/integration/Postgres/RLS checks in this checkout **passed**. Live OpenAI calibration **UNVERIFIED**. Not live-sales ready. |

## What Stage 2B may do

Quotes, spending ceilings, quoted create (`aw-relay/0.3`), run-specific
status/wait, and explicit evaluation-only retry.

Do not add Checkout, subscriptions, Stripe credentials, Clerk, pack purchase,
or a competing route layout. Use the aliases below. Transport today is
`src/cloud/client.ts`.

Do **not** send `quote_id` / `max_credits` through an unchanged `aw-relay/0.1`
or `aw-relay/0.2` strict object. Those versions remain strict. Older clients
attempting new paid work after cutover receive `UPDATE_REQUIRED` without
reservation or execution. Authorized read/status access is preserved.

CLI Stage 1B already assigned **`EXIT.BILLING = 13`**. Keep 13. Do not collide
with evaluation-incomplete **11**, evaluation-error **12**, or interrupted
**130**.

## Wire contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `docs/contracts/aw-billing-v1.schema.json` =
  `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901`
- `docs/contracts/aw-billing-v1.fixtures.json` =
  `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1`

Canonical files:

- `docs/contracts/aw-billing-v1.schema.json`
- `docs/contracts/aw-billing-v1.fixtures.json`
- `docs/contracts/aw-billing-v1.checksums.json`

Stage 1 usage fields are unchanged. Additive quote/status objects and error
codes are in the same schema. Consumers still tolerate a later non-null
`subscription` object. Unknown capability strings are ignored. Unknown
financial/access states fail closed.

### Routes and aliases

| Role | Path | Scope |
| --- | --- | --- |
| Primary capabilities | `GET /v1/billing/capabilities` | `connector:identity` |
| Primary usage | `GET /v1/billing/usage` | `connector:identity` |
| Primary quote | `POST /v1/billing/quote` | `connector:run` |
| Primary status | `GET /v1/billing/status?runId=<uuid>` | `connector:run` |
| Alias capabilities | `GET /api/v1/billing/capabilities` | same |
| Alias usage | `GET /api/v1/billing/usage` | same |
| Alias quote | `POST /api/v1/billing/quote` | same |
| Alias status | `GET /api/v1/billing/status?runId=<uuid>` | same |
| Canonical execution status | `GET /v1/relay/runs/{runId}` | `connector:run` |
| Evaluation-only retry | `POST /v1/relay/runs/{runId}:retry-evaluation` | `connector:run` |
| Ambiguous create lookup | `POST /v1/relay/run-intents/reconcile` | `connector:run` |

Workspace is always resolved from the validated connector. Query
`workspaceId` / `billingAccountId` must not switch tenants
(`workspace_mismatch`). Responses: `Cache-Control: private, no-store`.

### Capabilities

Advertised now: `["usage_v1", "quote_v1", "status_v1"]`.

Reserved, **do not advertise**: `billing_portal_link_v1`, `subscriptions_v1`.

### Quote

Quote creation **must not** reserve or consume credits, create a run, hydrate
jobs, call a model, or contact the target. It persists bounded expiring quote
metadata. Return quotes even when `availableUnitsAtQuote < executionUnits`.

TTL: `BILLING_QUOTE_TTL_SECONDS`, default **600**, min 60, max 1800.

Pricing version: `aw-pricing/execution-unit/1`. One customer unit is one
scenario repetition against one target. Provider-dollar estimates are private
and must not be shown as the customer bill.

`assessmentPlanHash` is the **server** compiled plan hash. It is not the CLI
local freeze hash (`assessment.plan_hash` / `clientFreezeSha256`). Quote and
later create must compile the same bindings; plan identity is derived from
packet + config + target + assessment, not from `create_request_id`.

Client-supplied `executionUnits` or `assessmentPlanHash` are not proof.
Bindings hashes are computed in SQL with `canonicalize_runner_jsonb`.

Successful response (required fields):

```json
{
  "schemaVersion": "aw-billing/1",
  "quoteId": "<uuid>",
  "workspaceId": "<workspace-uuid>",
  "assessmentPlanHash": "<64-hex>",
  "pricingVersion": "aw-pricing/execution-unit/1",
  "executionUnits": 30,
  "expiresAt": "<UTC-ISO-8601-Z>",
  "availableUnitsAtQuote": 120,
  "estimateOnly": true
}
```

Optional additive: `scenarioCount`, `repetitions`, `remainingUnitsEstimate`.
`remainingUnitsEstimate` is `max(0, available − executionUnits)` and is **not**
a reservation.

Request reuses the canonical assessment envelope (snake_case packet/target
fields plus `schemaVersion: "aw-billing/1"`). Example:

```http
POST /v1/billing/quote
Authorization: Bearer aw_connector_...
Content-Type: application/json

{
  "schemaVersion": "aw-billing/1",
  "packet": { "key": "support-refunds", "version": "0.2.0" },
  "config_sha256": "<64-hex>",
  "target": {
    "name": "synthetic",
    "boundary_sha256": "<64-hex>",
    "capabilities": {
      "prepare": true,
      "observation": true,
      "cleanup": true,
      "tool_events": true,
      "observation_keys": []
    }
  },
  "assessment": { "...canonical envelope..." }
}
```

### Quoted create (`aw-relay/0.3`)

Relay JSON is **snake_case**. Billing JSON is camelCase.

| Billing | Wire create field |
| --- | --- |
| `quoteId` | `quote_id` (required UUID) |
| `maxCredits` | `max_credits` (optional nonnegative safe integer) |

`max_credits` caps **customer execution units**, not provider dollars. A quote
whose `executionUnits` exceed the ceiling is `BUDGET_EXCEEDED` before
reservation. **Zero** rejects every positive-unit run and does not grant a
free hosted run. A first-party client must **not** treat a missing ceiling as
unlimited consent. Noninteractive hosted execution should send an explicit
ceiling.

Create is still `POST /v1/relay/runs` with `Idempotency-Key` equal to
`create_request_id`. The server re-validates the quote, compiled plan, and
spendable units in one database transaction, then reserves, consumes the
quote, and inserts the run. Failure leaves no hold, consumed quote, or orphan
run.

Identical replay of `create_request_id` returns the original run without
another reservation, **even after the original quote expires**. Reusing the id
with a different body is `RELAY_CONFLICT`. A second distinct request cannot
reuse a consumed quote (`QUOTE_MISMATCH`).

A quoted `availableUnitsAtQuote` is a snapshot, never a capacity guarantee.

After an ambiguous create (timeout with no response), call
`POST /v1/relay/run-intents/reconcile` with the same `create_request_id` and
canonical SHA-256. Do not get a fresh quote and create a new request while the
original intent is still ambiguous.

### Status

`GET /v1/billing/status?runId=<uuid>` is the billing/evaluation projection
for CLI `run status` / `run wait`. It never starts execution, consumes units,
calls a provider, or retries grading.

Canonical execution JSON for existing 1B parsers remains
`GET /v1/relay/runs/{runId}` and stays compatible with the CLI's **strict**
run-status schema. Do not add extra keys there.

Billing status includes `executionStatus`, `evaluationStatus`, credit
reserved/consumed/released/compensated, progress counts, `savedEvidence`,
`retryEligible` / `retryReason`, `originalRunId`, `nextActions`, and a
token-free `dashboardUrl`.

`nextActions`: `wait`, `inspect`, `retry_evaluation`, `open_dashboard`, `none`.

When grading is pending after target completion, tell the user evidence is
saved and to wait/status the **original run**. Do not instruct them to re-run
the test command.

### Evaluation retry

`POST /v1/relay/runs/{runId}:retry-evaluation` is the explicit opt-in.
It reuses saved target evidence, does not replay the target, and debits **0**
customer units. Recovery revisions are bounded (at most two beyond the
original; three evaluation groups total). SQL rejects retries once that cap
or a terminal complete evaluation is reached.

Response:

```json
{
  "protocol_version": "aw-relay/0.1",
  "run_id": "<uuid>",
  "evaluation_id": "<uuid>",
  "reused_target_evidence": true,
  "customer_units_debited": 0
}
```

### Stable error mapping

Wire `error.code` is snake_case. `error.billingCode` repeats the stable name.
Main and CLI must consume this mapping; do not rename independently.

| Stable | Wire `error.code` | Typical HTTP |
| --- | --- | --- |
| `BILLING_UNAVAILABLE` | `service_unavailable` | 503 |
| `INSUFFICIENT_CREDITS` | `insufficient_credits` | 409 |
| `QUOTE_EXPIRED` | `quote_expired` | 409 |
| `QUOTE_MISMATCH` | `quote_mismatch` | 409 |
| `BUDGET_EXCEEDED` | `budget_exceeded` | 409 |
| `UPDATE_REQUIRED` | `update_required` | 409 |
| `WORKSPACE_CLOSING` | `workspace_closing` | 409 |
| `MEMBERSHIP_REVOKED` | `membership_revoked` | 403 |

Relay create also emits these as `RelayHttpError.code` equal to the stable
name (for example `UPDATE_REQUIRED`) plus `billingCode`. Admission conflicts
that are not billing-specific remain `RELAY_CONFLICT` / `RELAY_BINDING` and
are not billing codes.

`BUDGET_EXCEEDED` covers both a customer `max_credits` ceiling and a private
grading cost budget. Private budgets never debit an extra customer unit.

### Usage payload

Unchanged from Stage 1, with advertised capabilities now including
`quote_v1` and `status_v1`. Optional additive totals:
`grossConsumedUnits`, `compensatedUnits`, `releasedUnits`.

Invariant: `available = usable granted − net consumed − outstanding reserved`.

### Fixtures

See `docs/contracts/aw-billing-v1.fixtures.json`. Stage 1 cases remain.
Stage 2 adds quote success (including insufficient balance), pending-grading
status, and structured quote/admission errors.

## Migrations

Forward only. Stage 1 order, then:

4. `20260907140001_billing_quotes_and_quoted_admission.sql`
5. `20260907140002_provider_cost_ledger_and_dispatch.sql`
6. `20260907140003_hydration_finalization_compensation.sql`

Cutover marker is still `aw-billing/1-cutover`. After cutover, self-service
chargeable creates require `aw-relay/0.3`. Pre-cutover and managed paths are
documented in `docs/billing/admission-inventory.md`.

## Copyable CLI 2B examples

Estimate (no reservation):

```text
POST /v1/billing/quote
```

Quoted create (illustrative; exact envelope comes from the compiled
assessment, not this prompt):

```json
{
  "protocol_version": "aw-relay/0.3",
  "create_request_id": "crq_...",
  "packet": { "key": "support-refunds", "version": "0.2.0" },
  "config_sha256": "<64-hex>",
  "target": { "name": "synthetic", "boundary_sha256": "<64-hex>", "capabilities": {} },
  "assessment": {},
  "quote_id": "<uuid>",
  "max_credits": 30
}
```

Status:

```text
GET /v1/billing/status?runId=<run-uuid>
GET /v1/relay/runs/<run-uuid>
```

Reconcile:

```text
POST /v1/relay/run-intents/reconcile
```

Retry grading only:

```text
POST /v1/relay/runs/<run-uuid>:retry-evaluation
```

Published website hosted command pin remains the 0.3.2 `test` invocation
without `--max-credits` until 2B ships. Portal copy already explains estimate
+ ceiling + `UPDATE_REQUIRED`.

## Provider cost (private)

Admitted model: `gpt-5.6-terra`. Rate card
`openai-gpt-5.6-terra/standard/2026-09-06`. USD nanos. Reasoning tokens that
are already inside `output_tokens` are not added again. Timeouts/lost
responses are **unknown** expense, not zero. Dispatch defaults: 8 global / 2
per workspace slots; 3 attempts per job; at most 2 recovery revisions;
conservative reserve includes 2_000 prompt-overhead tokens.

Aborting HTTP does **not** prove OpenAI stopped billing. Budget exhaustion
fails the job with `budget_exceeded` and does not auto-compensate; operators
use `billing_compensate_consumption`.

## Commands and verification

Recorded 2026-09-06 from `/Users/jeffskafi/Desktop/augmentworks-billing-2a`.
Exact outcomes are in `docs/billing/phase-2-completion.md`.

```bash
pnpm billing:contract-hashes
pnpm lint
pnpm typecheck
SKIP_ENV_VALIDATION=true pnpm test
SKIP_ENV_VALIDATION=true pnpm test:integration
SKIP_ENV_VALIDATION=true NEXT_PUBLIC_SITE_URL=https://augmentworks.ai pnpm build
pnpm exec supabase start
pnpm exec supabase migration up
pnpm test:billing-db
```

Passed in this checkout: typecheck, lint (0 errors), 573 unit tests, 92
integration tests, production build, and `pnpm test:billing-db` against local
Postgres/PostgREST after applying the three Stage 2A migrations.

`pnpm test:billing-db` exit **2** means Postgres/Supabase/psql is missing —
blocked external prerequisite, not a passing test. Do not treat this file as
evidence that live OpenAI calibration ran.

## Unresolved limitations

- Live OpenAI calibration and measured grading cost: **UNVERIFIED** without
  credentials and a bounded budget. Human review of calibration labels is
  required; generated labels stay `provisional`.
- Quote compile still requires judge configuration at **create** time
  (`requireJudgeConfiguration: true`); quote itself compiles with
  `requireJudgeConfiguration: false`.
- JS `canonicalize` and SQL `canonicalize_runner_jsonb` are not interchangeable
  as proof. The server stores and binds the SQL digest.
- Purchases, packs ($49 / 300), subscriptions ($149 / 1,000), Stripe, and
  Clerk are not implemented and must not be advertised.
- Published CLI 0.3.2 cannot send `aw-relay/0.3`. After cutover, that package
  receives `UPDATE_REQUIRED` for new billed work.

## Live activation

Not enabled. No production deploy, no live sales, no real charges, no paid
inference activation from this prompt. Dispatch remains gated by
`AW_JUDGE_DISPATCH_ENABLED` and hosted judge configuration.
