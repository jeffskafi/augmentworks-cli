# Billing Stage 4B → main Stage 5A handoff

Owned by `jeffskafi/augmentworks-cli`. Main owns the wire contract. This
repository vendors that contract; it does not change it.

Imported main 4A handoff is saved separately at
`docs/billing/main-source-handoff.md`. Do not treat that file as the CLI-owned
handoff.

## Identity

| Item | Value |
| --- | --- |
| CLI 3B baseline HEAD | `d584f474bc3c043c33c6a5c75ef40d838bebafcb` (`cursor/billing-stage-3b-91a7`) |
| Working branch | `cursor/billing-stage-4b-91a7` |
| Implementation | `82e0c3e615e90ab766a3f55d848e7a39644ce9b9` |
| Vendored main commit | `49806f0f52377bbca0fbe02f160668723c589fa7` (`origin/main` Stage 4A merge) |
| Source package | `0.3.3` (unpublished) |
| Website / npx pin | published `@augmentworks/cli@0.3.2` (`gitHead` `d36ec8590b005445dba940d2df3abcb53971cea5`) |
| Stage | **4B code complete.** Packed-binary HTTP fixture passed. Live disposable main API/database **BLOCKED**. Not npm-published. Not live-sales ready. |

## What Stage 4B implemented

A release-candidate CLI whose **actual npm tarball** completes the documented
prepaid onboarding path, including recovery commands, without a second billing
implementation.

- Packaged starters under `assets/starters/`: default `response-quality` and
  `workflow`. `init` / `init --starter workflow` write complete
  `augmentworks.yaml`, `augmentworks.assessment.yaml`, references, and
  `.env.example`. Empty `CHATBOT_API_KEY`. Refuse overwrite without `--force`.
  `--force` never replaces an existing `.env`.
- Offline `doctor` validates the sibling assessment, wire bounds, profile,
  required files, and packet/capability match. It does not call billing.
- Packed smoke installs the tarball into a clean consumer directory and runs
  that installed binary. Secrets and development fixtures stay out of the
  pack.
- `scripts/packed-billing-fixture.mjs` drives the packed binary over loopback
  HTTP for auth refresh, capabilities, usage, quote, dropped-create replay,
  process restart after admission, one synthetic `/chat` target, pending
  grading `run wait`, last-units `INSUFFICIENT_CREDITS`, usage 503,
  pending-commerce fulfillment, and `UPDATE_REQUIRED` when `quote_v1` is
  absent. This is **not** PostgreSQL/RLS proof.
- `scripts/packed-billing-live.mjs` is the disposable main API/database gate.
  Missing credentials exit `2` (`not_run` / **BLOCKED**). Production API hosts
  are refused. When a loopback API URL and connector token are supplied, the
  packed binary runs usage, estimate, and `--max-credits 0`. Quoted create is
  opt-in (`AW_BILLING_LIVE_ALLOW_CREATE=1`). Ledger/RLS inspection stays
  `not_run` without a disposable migrated database observer.
- Hosted `test --json` writes one structured error object on stdout for
  billing/admission rejection.

No Checkout, subscriptions, Stripe credentials, Clerk, CLI wallet, or
order-status API. The CLI still only opens the first-party billing page.

## Vendored contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `contracts/aw-billing-v1.schema.json` =
  `e66d87fb48bd91ffbd125f1337b7978e4b60334be838fe46c40fce468cd8cc7b`
- `contracts/aw-billing-v1.fixtures.json` =
  `42da35022b78954ab214fa4e2f9a1bcb903790056f4dfb57cf1dece5e632ec3c`

Lock: `contracts/aw-billing-v1.lock.json`
Generated bindings: `src/billing/generated/contract.ts`

```bash
node scripts/import-aw-billing-contract.mjs --from <path-to-jeffskafi/augmentworks>
npm run check:billing-contract
```

The check fails when generated bindings or file hashes diverge.

Additive 4A quote fields consumed when present: `retentionPolicyVersion`,
`retainUntil`. Stage 1 consumers still tolerate a later non-null
`subscription` object. Unknown financial/access states fail closed.

### Routes used by this CLI

Primary only:

- `GET /v1/billing/capabilities`
- `GET /v1/billing/usage`
- `POST /v1/billing/quote`
- `GET /v1/billing/status?runId=<uuid>`
- `POST /v1/relay/runs` (`aw-relay/0.3` quoted create, `0.1` packet-only)
- `GET /v1/relay/runs/{runId}`
- `POST /v1/relay/run-intents:reconcile`
- `POST /v1/relay/runs/{runId}:retry-evaluation`

Server aliases `/api/v1/billing/*` exist and are not called by this CLI.

There is **no** CLI order-status route. Purchase history stays on the website.
`billing` links to the page; `usage` shows credit fulfillment including
optional `pendingCommerce`.

### Authentication

Existing opaque CLI bearer. Usage/capabilities/billing navigation:
`connector:identity`. Quote, status, create, reconcile, and evaluation retry:
`connector:run`. Refresh-once after HTTP 401. Workspace comes from the
validated connector. A cached `billingAccountId` or email never selects the
wallet.

Read permission does not imply billing-management permission.

### Capabilities treated as available

Implemented when advertised: `usage_v1`, `quote_v1`, `status_v1`,
`billing_portal_link_v1`. Reserved name `subscriptions_v1` is ignored if
present and is not advertised by this CLI.

A server without `quote_v1` fails new billed `--assessment` work as
`UPDATE_REQUIRED` (exit 13) with zero reservation. Missing
`billing_portal_link_v1` fails `billing` as `UPDATE_REQUIRED`. Missing
`usage_v1` remains `USAGE_UNSUPPORTED`.

### Billing URL allowlist

Reject: userinfo, non-https in production, protocol-relative URLs, lookalike
hosts, off-origin redirects, unexpected ports, injected fragments, and
sensitive/unapproved query parameters. Path must be `/portal/billing`. Query
may contain only `workspace=<authenticated uuid>`. Loopback HTTP(S) is allowed
only when it matches the configured test/development API origin.

Example:

```text
https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111
```

### Errors (CLI mapping)

Unchanged from 2B/3B. Parse typed `error.code` and `error.billingCode`.

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

Assessment failures remain exit 10. Incomplete grading remains 11. Grading
errors remain 12. Interrupt remains 130. `EXIT.BILLING` stays 13. Config
errors including `INIT_FILE_EXISTS` remain 2.

## Intent versions

Writes `aw-run-intent/0.3`. Reads `aw-run-intent/0.2` as compatible current.
`aw-run-intent/0.1` remains the legacy migrate path.

## Local-mode independence

`demo`, `test --local`, offline `doctor`, `init`, and `schema` make no billing
calls. `--estimate`, `--max-credits`, `--yes`, and `billing` are hosted-only.
`npx --yes` is the npm installer flag and is not a spending ceiling.

## Copyable commands (source 0.3.3)

After `npm ci && npm run build`:

```bash
node dist/index.js init
node dist/index.js init --starter workflow
node dist/index.js doctor --offline --json
node dist/index.js usage
node dist/index.js usage --json
node dist/index.js billing --print
node dist/index.js billing --json
node dist/index.js test --assessment ./augmentworks.assessment.yaml --estimate --json
node dist/index.js test --assessment ./augmentworks.assessment.yaml --profile quick --max-credits 30 --yes
node dist/index.js run status <run-id>
node dist/index.js run wait <run-id>
```

Do **not** document `npx @augmentworks/cli@0.3.3` until that tarball is
published and independently verified. Website examples stay on **0.3.2**.

CI example (no browser, explicit ceiling, preserve the original run):

```bash
node dist/index.js test \
  --assessment ./augmentworks.assessment.yaml \
  --max-credits 30 \
  --yes \
  --json
# If grading is pending, wait on the same run_id. Do not start another test.
node dist/index.js run wait <run-id> --json --timeout-ms 60000
```

If create is interrupted or the response is dropped, recover the same create
identity. Do not delete journals or blindly rerun while admission is unknown.

## Packed tarball (this checkout)

| Item | Value |
| --- | --- |
| Filename | `augmentworks-cli-0.3.3.tgz` |
| Files | 31 |
| Compressed size | 362910 bytes |
| SHA-256 | `ee2a0eed812e77969288771ae24a63beedd8d9772c8d3e03a6ae8607304a8303` |

Includes `dist/index.js`, packets, schemas, contracts, demo assets, and both
starters. Excludes `examples/`, tests, `.env` secrets, and billing docs.

## Verification actually run

See `docs/billing/phase-4-completion.md` and
`docs/billing/phase-4-release-evidence.md`.

Summary:

- `npm run check` — pass (typecheck, vitest **49 files / 420 tests**, build,
  discovery, billing-contract)
- `npm run smoke:pack` — pass, including packed billing HTTP fixture through
  the installed binary (`creates=1 quotes=4 targets=1 polls=3 refreshes=1`)
- `npm run test:packed-billing-live` — **BLOCKED** exit 2 (no disposable
  main API/token)

The HTTP fixture is not evidence of atomic credit accounting or tenant RLS.
Stripe test-mode remains main's external gate.

## Stage 5A prerequisites (main repository)

1. Keep `aw-billing/1` usage/quote/status/billing-portal fields stable.
   Subscription support is additive (`subscriptions_v1` plus a non-null
   `subscription` projection). Do not break Stage 1–4 consumers.
2. Do not require this CLI to create, cancel, or modify subscriptions.
   The CLI continues to open the first-party billing page only.
3. Read this handoff plus `docs/billing/phase-4-completion.md` before 5A.
4. Website install commands must stay pinned to a **published** CLI version.
   Source `0.3.3` is not an npx pin until independently verified on the
   registry.
5. Deploy server support for this package before enabling new paid admission,
   then point the website at the published package. Do not roll the server
   back to a revision that cannot understand live paid reservations or minted
   grants; use feature flags to pause new Checkout/admission.

## Live activation

**Not enabled.** This prompt must not publish `@augmentworks/cli`, change
production feature flags, send customer messages, or create real charges.
Kill switches and live-sales flags stay on the main server.
