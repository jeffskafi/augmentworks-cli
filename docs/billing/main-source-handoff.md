# Billing Stage 1A → CLI Stage 1B handoff

Owned by `jeffskafi/augmentworks`. Do not implement Stage 1B in this
repository. The CLI counterpart must vendor this contract as published here.

## Identity

| Item | Value |
| --- | --- |
| Docs/contracts baseline HEAD | `bc1bac16ee88aeece7cd7c58793abc0d611aa4bc` (`origin/main`) |
| Working branch | `cursor/billing-stage-1a-91a7` |
| Implementation commit | `fe892a1307e182a3ab34255b3ab1f3db961b3d29` (first commit containing the aw-billing/1 contract). Follow-up commits on this branch repair CI prerequisites and copy tests. |
| Stage | **1A code complete.** Not production-verified. Not live-sales ready. |

## What Stage 1B may do

Authenticated **usage display** and **identity-preserving refresh** only.

Do not add quote APIs, checkout, subscriptions, Stripe, Clerk, pack purchase,
or a competing route layout. Use the aliases below.

## Wire contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `docs/contracts/aw-billing-v1.schema.json` =
  `2ea0236b9fa1bac4a7e50dbd5d016c9b9b32a4b7b31298cfc53104308bdace8d`
- `docs/contracts/aw-billing-v1.fixtures.json` =
  `6ef4e83f2dfa5f5ffc22dd97ec35c106ef7d012d7433e107cf551841b0eb7556`

Canonical files:

- `docs/contracts/aw-billing-v1.schema.json`
- `docs/contracts/aw-billing-v1.fixtures.json`
- `docs/contracts/aw-billing-v1.checksums.json`

### Routes and aliases

| Role | Path |
| --- | --- |
| Primary capabilities | `GET /v1/billing/capabilities` |
| Primary usage | `GET /v1/billing/usage` |
| Alias capabilities | `GET /api/v1/billing/capabilities` |
| Alias usage | `GET /api/v1/billing/usage` |

These follow the existing relay (`/v1/...`) plus CLI-auth (`/api/v1/...`)
alias convention. Do not add a third path merely to match an illustrative
prompt.

### Authentication and scope

- Credential: existing opaque CLI bearer (`aw_connector_...`).
- Required read scope: **`connector:identity`** (already issued; no new scope).
- Refresh behavior: unchanged.
- Workspace is resolved from the validated connector grant.
- Query `workspaceId` / `billingAccountId` must not switch tenants
  (`workspace_mismatch`).
- Responses are private: `Cache-Control: private, no-store`.

### Capabilities

Advertised now: `["usage_v1"]`.

Reserved, **do not advertise**: `quote_v1`, `status_v1`,
`billing_portal_link_v1`, `subscriptions_v1`.

Consumers ignore unknown capability strings. Producers must not advertise
unimplemented names.

### Usage payload (producer)

Required: `schemaVersion`, `workspaceId`, `billingAccountId`, `asOf`,
`ledgerRevision`, `accessState`, `availableUnits`, `reservedUnits`,
`consumedUnits`, `grantBalances[]`, `subscription`, `billingPageUrl`,
`capabilities`.

- Integers are bounded (`0…1_000_000` for unit counts).
- Timestamps are UTC RFC 3339 with `Z`.
- `subscription` is **null in Stage 1**. Consumers must tolerate a later
  non-null object and ignore unsupported details. Do not freeze the field as
  literal null.
- `billingPageUrl` uses `NEXT_PUBLIC_SITE_URL` or `https://augmentworks.ai`
  and contains no token.
- `consumedUnits` is **net** after approved compensation. Gross evidence remains
  in the ledger (`grossConsumedUnits` / `compensatedUnits` optional).
- Unknown `accessState` values must not be guessed active; fail closed with
  `unsupported_state`.
- Invariant: `available = usable granted − net consumed − outstanding reserved`.
  `grantBalances` allocation totals match account totals from one snapshot.
- Duplicate idempotent replays must not change `ledgerRevision`.

### Errors

| HTTP | `error.code` | When |
| --- | --- | --- |
| 401 | `unauthenticated` | Missing/invalid/revoked token |
| 403 | `insufficient_scope` | Token lacks `connector:identity` |
| 403 | `unauthorized` | Connector cannot read that account |
| 403 | `workspace_mismatch` | Supplied workspace/account id switches tenant |
| 400 | `invalid_request` | Malformed query identifiers |
| 409 | `billing_unprovisioned` | Missing billing state (not unlimited access) |
| 409 | `unsupported_state` | Access/financial state cannot be interpreted |
| 409 | `conflict` | Reserved for conflicting writes |
| 503 | `service_unavailable` | Retryable infrastructure |

Shape: `{ schemaVersion, error: { code, message, retryable } }`.

### Polling / cache

Private responses. No shared caches. Poll usage on an interval appropriate for
a ledger revision; treat `ledgerRevision` + `asOf` as the consistency token.

### Fixtures

See `docs/contracts/aw-billing-v1.fixtures.json`: eligible trial, partial
consume (190/0/10), active reservation (190/7/3), exhausted, closed/suspended
readable, no subscription, unknown capability + later subscription (consumer),
absent reserved capabilities, malformed producer reject, structured authz/authn
and service errors.

## Migrations and cutover

Order (forward only):

1. `20260907120001_billing_accounts_and_ledger.sql`
2. `20260907120002_billing_provisioning_admission_cutover.sql`
3. `20260907120003_billing_cli_admission_and_closure.sql`

Cutover marker: `aw-billing/1-cutover`.

```bash
pnpm billing:cutover              # dry-run, all orgs
pnpm billing:cutover:apply        # apply; ambiguous rows are isolated
node scripts/billing-cutover.mjs --rollback <organization-uuid>
```

Requires `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### Dry-run report format

Each account object includes:

- `organizationId`, `billingAccountId`, `accountMode`, `treatment`
- `oldDisplayedBalance` (`hybridBuggyFormula`, `hybridCorrectedFormula`, cycle
  credit counts)
- `provedGrants` vs inferred remaining cycle promise
- `actualConsumption` (`firstLeases`, `startedAttempts`, `authoritative`)
- `activeHolds`, `correctedBalance`, `anomalies`
- `hasTrialClaim`, `hasPilotGrant`, `alreadyCutover`
- apply wrapper fields: `dryRun`, `applied`, `replayed`, `isolated`

Treatments: `new_trial` (200 once), `convert_pilot_200` (proved 200 minus
first-leases and holds), `legacy_cycle_compatibility` (unused credits × packet
commitment, not a silent 200), `returning_no_trial`, `managed_exempt`,
`already_cutover`, `ambiguous` (isolated; do not void or inflate).

Shadow comparison may read both systems. After cutover, old writers skip the
hybrid ledger so both systems never charge.

### Rollback

`--rollback` sets `admissions_disabled`. New-ledger rows stay. Legacy displayed
balances are not restored.

### Draining

Active runs keep their reservations. Closure/terminalization releases leftover
holds. Resume cutover with the same apply RPC; already-cut-over orgs replay as
`already_cutover`.

## Trial and identity

- Newly eligible self-service signup: 200 trial units once, HMAC claim
  `augmentworks-self-service-trial-email-hmac-v1` (do not rotate).
- Returning user whose workspace was purged: new empty workspace, **no** second
  trial.
- Profile repair: `reconcile_authenticated_user_profile` from `auth.users`
  only. Query errors stay retriable and must not mint another account.
- Repeated login, OAuth linking, refresh, logout, and profile repair never mint
  credits.
- Existing membership return path ensures a billing account **without** silent
  cutover; existing grants follow the conversion command.

## Admission

See `docs/billing/admission-inventory.md`. After cutover, every chargeable
`packet_runs` insert reserves from the new ledger in the same transaction.
Insufficient units fail before target work. Managed workspaces are the explicit
unit exemption.

## Commands and verification

```bash
pnpm billing:contract-hashes
pnpm lint
pnpm typecheck
SKIP_ENV_VALIDATION=true pnpm test
SKIP_ENV_VALIDATION=true pnpm test:integration
SKIP_ENV_VALIDATION=true NEXT_PUBLIC_SITE_URL=https://augmentworks.ai pnpm build
pnpm exec supabase start
pnpm test:billing-db
```

`pnpm test:billing-db` exit **2** means Postgres/Supabase/psql is missing — that
is a blocked external prerequisite, not a passing test.

Unit coverage includes the 190/197 invariant, fixtures, HTTP tenant-switch
rejection, and SQL-string contracts. SQL-string tests are **not** integration
evidence. Real function/trigger/RLS evidence is `supabase/tests/billing-stage-1a.sql`
plus PostgREST checks in `scripts/billing-acceptance.mjs`.

### Local command outcomes (this checkout)

| Command | Outcome |
| --- | --- |
| `pnpm lint` | 0 errors, 9 pre-existing warnings |
| `pnpm typecheck` | passed |
| `SKIP_ENV_VALIDATION=true pnpm test` | 558 passed |
| `SKIP_ENV_VALIDATION=true pnpm test:integration` | 90 passed |
| `SKIP_ENV_VALIDATION=true NEXT_PUBLIC_SITE_URL=https://augmentworks.ai pnpm build` | passed |
| `pnpm test:billing-db` | **Passed** locally against disposable Supabase/Postgres/PostgREST (see phase-1-completion.md). |
| GitHub CI | **Passed** on `596a2ab8504de8095ffbbe3ec50d0071f49b8b17`: `build` and `billing-postgres-rls` ([run 34051317327](https://github.com/jeffskafi/augmentworks/actions/runs/34051317327)). |

## Unresolved limitations

- CLI usage after workspace **closure** requires a still-valid connector.
  Closure revokes connectors; portal members can still read usage via
  `billing_usage_for_organization` while retention applies.
- Purchases, packs ($49 / 300), subscriptions ($149 / 1,000), Stripe, and
  Clerk are not implemented and must not be advertised.
- Production Stripe, hosted RLS, and model-provider behavior are not proved by
  this stage.
- Ambiguous historical accounts stay isolated until explicit treatment.

## Live activation

Not enabled. No production deploy, no live sales, no real charges from this
prompt.
