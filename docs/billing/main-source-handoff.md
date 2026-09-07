# Billing Stage 4A → CLI Stage 4B handoff

Owned by `jeffskafi/augmentworks`. Do not implement Stage 4B in this
repository. The CLI counterpart must vendor this contract as published here.

## Identity

| Item | Value |
| --- | --- |
| Docs/contracts research baseline | `bc1bac16ee88aeece7cd7c58793abc0d611aa4bc` (`origin/main`) |
| Stage 3A vendor pin | `931838f29ee04fc018ef6359c22abd8d3e8da4c8` (`cursor/billing-stage-3a-91a7`; feature hashes frozen since `926ae72`) |
| CLI Stage 3B counterpart | `d584f474bc3c043c33c6a5c75ef40d838bebafcb` (`cursor/billing-stage-3b-91a7`; implementation `7fef4e9`) |
| Working branch | `cursor/billing-stage-4a-91a7` |
| Stage | **4A code complete and locally verified.** Live purchases **not enabled**. Real Stripe **BLOCKED** without credentials. Subscriptions **not sold**. |
| First implementation commit | `7faa85f5d69cd405aaed090fcb7fb25d73848fdd` |

Exact current commit is the git SHA that contains this file.

## What Stage 4B may do

Build a release-ready CLI whose **actual npm tarball** completes the documented
first-customer prepaid journey, including recovery. Import this schema,
fixtures, and handoff. Keep `docs/billing/main-source-handoff.md` separate
from the CLI-owned handoff.

Use `docs/billing/phase-4a-cli-4b-scenario.md` for expected balances, safe
URLs, error fixtures, and the website pin vs unpublished 3B distinction.
Main 4A fixture YAML under `docs/billing/phase-4a-fixture-setup/` is **not**
proof that `augmentworks init` generates those files.

Do **not** create Stripe customers, Checkout Sessions, purchases, refunds, or
subscriptions from the CLI. Do **not** invent a CLI order-status endpoint.
Do **not** advertise `$149` / `subscriptions_v1` as purchasable. Do **not**
publish the npm package or enable live billing unless separately authorized.

Keep **`EXIT.BILLING = 13`**. Keep evaluation-incomplete **11**,
evaluation-error **12**, and interrupted **130**.

## Wire contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `docs/contracts/aw-billing-v1.schema.json` =
  `e66d87fb48bd91ffbd125f1337b7978e4b60334be838fe46c40fce468cd8cc7b`
- `docs/contracts/aw-billing-v1.fixtures.json` =
  `42da35022b78954ab214fa4e2f9a1bcb903790056f4dfb57cf1dece5e632ec3c`

Canonical files:

- `docs/contracts/aw-billing-v1.schema.json`
- `docs/contracts/aw-billing-v1.fixtures.json`
- `docs/contracts/aw-billing-v1.checksums.json`

Stage 1–3 fields remain. Additive optional quote fields:
`retentionPolicyVersion`, `retainUntil`. Purchased-credit validity (no expiry)
is distinct from run-detail retention. Consumers tolerate additive optional
fields, `pendingCommerce`, `frozenUnits`, and a later non-null `subscription`
object without treating it as a live sale. Unknown capability strings are
ignored. Unknown financial/access states fail closed.

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
| Quoted create | `POST /v1/relay/runs` (`aw-relay/0.3`) | `connector:run` |

Workspace is always resolved from the validated connector. Query
`workspaceId` / `billingAccountId` must not switch tenants
(`workspace_mismatch`). Responses: `Cache-Control: private, no-store`.

There is **no** CLI order-status API. Order state is on
`/portal/billing/orders/<orderId>` after browser auth.

### Capabilities

Advertised now: `["usage_v1", "quote_v1", "status_v1", "billing_portal_link_v1"]`.

Reserved, **do not advertise**: `subscriptions_v1`.

### Billing page URL (`billing_portal_link_v1`)

```text
https://augmentworks.ai/portal/billing?workspace=<workspace-uuid>
```

Local/dev may use the configured `NEXT_PUBLIC_SITE_URL` origin with the same
path and query. The URL contains **no** access token, refresh token, device
code, Stripe customer ID, or Checkout Session ID. Opening it does not
authorize payment. Ineligible cohort members must not see a live purchase
promise.

A pending pack purchase is **not** spendable credit. Fixture
`pending_pack_purchase` has availableUnits 200 with
`pendingCommerce.state = paid_unfulfilled`.

### Quote (unchanged required fields; retention optional)

Quote creation **must not** reserve or consume credits, create a run, hydrate
jobs, call a model, or contact the target. Return quotes even when
`availableUnitsAtQuote < executionUnits`.

TTL: `BILLING_QUOTE_TTL_SECONDS`, default **600**, min 60, max 1800.

Pricing version: `aw-pricing/execution-unit/1`. One customer unit is one
scenario repetition against one target.

Optional additive:

```json
{
  "retentionPolicyVersion": "aw-retention/pack-90d-v1",
  "retainUntil": "2026-12-05T17:00:00.000Z"
}
```

Pack-funded new run details default to **90 days** unless a longer existing
promise applies. Trial uses the disclosed workspace `share_link_days`
(self-service trial is **7**). Subscription 365-day policy exists in schema
only; Pro is not sold. `NULL retain_until` is grandfathered and is not given
the new pack default. Mixed lots take the longest committed window; tie-break
legacy > pack > pro > trial.

Fixture: `quote_pack_retention`.

### Quoted create (`aw-relay/0.3`)

| Billing | Wire create field |
| --- | --- |
| `quoteId` | `quote_id` (required UUID) |
| `maxCredits` | `max_credits` (optional nonnegative safe integer) |

`max_credits` caps **customer execution units**. Zero rejects every
positive-unit run. A first-party client must **not** treat a missing ceiling
as unlimited consent. Identical replay of `create_request_id` returns the
original run without another reservation, **even after the original quote
expires**, and **even while new chargeable admission is paused**.

After an ambiguous create, `POST /v1/relay/run-intents/reconcile` with the
same id. Do not get a fresh quote while the original intent is still
ambiguous.

When new chargeable admission is paused, an unbound create is
`BILLING_UNAVAILABLE` (HTTP 503, `error.code` / `billingCode`
`BILLING_UNAVAILABLE` on the relay). Status, cleanup, and saved results
remain.

Old clients without `aw-relay/0.3` receive `UPDATE_REQUIRED` for new billed
work.

### Status and evaluation retry

Unchanged from Stage 2A/3A. Status never starts execution, consumes units,
calls a provider, or retries grading. Evaluation retry reuses saved evidence
and debits **0** customer units.

### Stable error mapping

| Stable | Wire `error.code` | Typical HTTP |
| --- | --- | --- |
| `BILLING_UNAVAILABLE` | `service_unavailable` (billing JSON) / `BILLING_UNAVAILABLE` (relay) | 503 |
| `INSUFFICIENT_CREDITS` | `insufficient_credits` | 409 |
| `QUOTE_EXPIRED` | `quote_expired` | 409 |
| `QUOTE_MISMATCH` | `quote_mismatch` | 409 |
| `BUDGET_EXCEEDED` | `budget_exceeded` | 409 |
| `UPDATE_REQUIRED` | `update_required` | 409 |
| `WORKSPACE_CLOSING` | `workspace_closing` | 409 |
| `MEMBERSHIP_REVOKED` | `membership_revoked` | 403 |

### Catalog (server-owned)

- Internal trial: `trial_200_v1` — 200 units once
- Sellable pack: `test_pack_300_v1` — 300 units, USD 4,900 cents, no expiry
- Reserved unsellable: `pro_monthly_1000_v1`

CLI must not hard-code prices. If only billing-page + usage are exposed,
omit CLI price marketing. Website pin: published CLI **0.3.2**.

## Migrations

Forward only. After Stage 3A:

9. `20260909120001_billing_paid_cohort_readiness.sql`

Cutover marker is still `aw-billing/1-cutover`.

## Copyable CLI examples (3B / 4B)

Billing page (no secrets):

```text
https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111
```

Estimate:

```text
POST /v1/billing/quote
```

Quoted create:

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

Status / wait / retry / reconcile remain as Stage 2B/3B.

Published website hosted command pin remains the **0.3.2** `test` invocation
until a newer package is actually in the registry. Describe 3B/4B commands
as unpublished counterparts.

## Independent switches (server)

See `docs/billing/launch-runbook.md`. Pausing Checkout does not stop
fulfillment. Pausing admission does not stop cleanup or bound create replay.
Pausing judge dispatch does not stop target cleanup.

## 4B artifacts

- Clean-dir scenario: `docs/billing/phase-4a-cli-4b-scenario.md`
- Fixture setup (not 4B proof): `docs/billing/phase-4a-fixture-setup/`
- Readiness: `pnpm check:billing-readiness` / `--json`
- Launch: `docs/billing/launch-runbook.md`
- Completion: `docs/billing/phase-4-completion.md`

## Unresolved limitations

- Live OpenAI calibration and measured grading cost: **UNVERIFIED**
- Real Stripe test-mode Checkout/webhook/3DS: **BLOCKED** until
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
  `STRIPE_PRICE_TEST_PACK_300_V1` are supplied
- Automatic tax: flag exists; off until accepted policy
- Subscriptions reserved and not sold
- Published CLI 0.3.2 cannot send `aw-relay/0.3` or open `billing`
- Retention email adapter is implemented; sending is **not configured**
- Production worker heartbeats: `not_run` until a deployed schedule records rows
- Browser UX walkthrough: **not run** in this session (no browser tools)
- Joint DB-backed 4A journeys: `not_run` when the process env points at a
  production `*.supabase.co` URL; local `pnpm test:billing-db` is the
  disposable Postgres evidence instead

## Live activation

Not enabled. No production deploy, no live sales, no real charges/refunds,
no customer messages, no npm publish. Kill switch
`AW_BILLING_PURCHASES_ENABLED` defaults off. Live sales additionally require
`AW_BILLING_LIVE_PURCHASES_ENABLED=true` after merchant/tax/cost review.
Production pack rollout defaults to **allowlist** when unset.
