# Billing Stage 3B → main Stage 4A handoff

Owned by `jeffskafi/augmentworks-cli`. Main owns the wire contract. This
repository vendors that contract; it does not change it.

Imported main handoff is saved separately at
`docs/billing/main-source-handoff.md`. Do not treat that file as the CLI-owned
handoff.

## Identity

| Item | Value |
| --- | --- |
| CLI 2B baseline HEAD | `a442527e3e95826c4a474cbe5b8769f66e4e1237` (`cursor/billing-stage-2b-91a7`) |
| Working branch | `cursor/billing-stage-3b-91a7` |
| Implementation | `7fef4e9463a7c7baaf5f2f5873c0a95b0f37a45c` (billing command `4b0f06a49c158feaef152473cd78013a5d5064ef`) |
| Vendored main commit | `931838f29ee04fc018ef6359c22abd8d3e8da4c8` (`cursor/billing-stage-3a-91a7`) |
| Main 3A feature commit (hashes frozen) | `926ae72f1e8bba959cd2d5e54c3996236960b8c6` |
| Stage | **3B code complete.** Deterministic verification is recorded in the phase-3 completion file. Not npm-published. Not production-verified against a live 3A host. Not live-sales ready. |

## What Stage 3B implemented

Secure browser billing from the terminal:

- `augmentworks billing`
- `augmentworks billing --json` (machine-readable, no browser)
- `augmentworks billing --print` (URL only, no GUI)
- `augmentworks billing --open` (force a browser open after URL allowlist)

No Checkout, subscriptions, Stripe credentials, Clerk, pack purchase, order
status API, or a competing route layout.

The command retrieves `GET /v1/billing/capabilities` and `GET /v1/billing/usage`
under `billing_portal_link_v1` and the current workspace identity. After usage
it re-authenticates; a changed workspace or connector is `WORKSPACE_MISMATCH`.
Owner-like and member-like identities share the same URL. It opens or
prints the server `billingPageUrl`, for example:

```text
https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111
```

The URL contains no access token, refresh token, device code, Stripe customer
ID, or Checkout Session ID. Opening it does not authorize payment. The browser
session must sign in; only owner/admin billing role can start Checkout. A
connector token is not billing-management permission. The workspace id is a
navigation hint.

`--json` writes one documented object on stdout. Human hints stay on stderr for
`--print`. `--print` is the agent/CI print-only option (do not add Commander
`--no-open`; that would default `--open` to true). Default `billing` is
print-only in CI and when stderr is not a TTY. GUI opener failure still
prints the safe URL and does not invalidate credentials or claim a purchased
pack. The opener receives only the allowlisted URL.

## Vendored contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `contracts/aw-billing-v1.schema.json` =
  `e08fd3ee7766e615b64024f416d72ac012fb829610a3a9f5efcdd1ec4b3c0f6a`
- `contracts/aw-billing-v1.fixtures.json` =
  `3513887cc25d404d695ce1ca4e5f5b6cc60b138438ccfb24b9f9a3d0f5e4794a`

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

There is **no** CLI order-status route. Stage 3A confined purchase history to
browser billing roles. `billing` links to the page; `usage` shows credit
fulfillment including optional `pendingCommerce`.

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

A server without `billing_portal_link_v1` fails `billing` as `UPDATE_REQUIRED`
(exit 13) and does not invent a catalog or Checkout client. Missing `quote_v1`
still fails hosted `--assessment` as `UPDATE_REQUIRED`. Missing `usage_v1`
remains `USAGE_UNSUPPORTED`.

Consumers tolerate additive optional fields, `pendingCommerce`, `frozenUnits`,
and a later non-null `subscription` object without treating it as a live sale.
Unknown `accessState` / `evaluationStatus` / pricing versions fail closed.

### Billing URL allowlist

Reject: userinfo, non-https in production, protocol-relative URLs, lookalike
hosts, off-origin redirects, unexpected ports, injected fragments, and
sensitive/unapproved query parameters. Path must be `/portal/billing`. Query
may contain only `workspace=<authenticated uuid>`. Loopback HTTP(S) is allowed
only when it matches the configured test/development API origin.

### Errors (CLI mapping)

Unchanged from 2B. Parse typed `error.code` and `error.billingCode`.

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

Insufficient credits report required vs available units when supplied, keep the
uncreated intent, and point at the first-party billing page. The CLI does not
wait for a purchase or silently restart a billable run. After fulfillment, the
user runs `usage` then starts a new test with `--max-credits`.

Assessment failures remain exit 10. Incomplete grading remains 11. Grading
errors remain 12. Interrupt remains 130. `EXIT.BILLING` stays 13.

## Intent versions

Writes `aw-run-intent/0.3`. Reads `aw-run-intent/0.2` as compatible current.
`aw-run-intent/0.1` remains the legacy migrate path. Unchanged from 2B.

## Local-mode independence

`demo`, `test --local`, offline `doctor`, and `schema` make no billing calls.
`--estimate`, `--max-credits`, `--yes`, and `billing` are hosted-only.

## Copyable commands (source 0.3.2)

```bash
node dist/index.js billing
node dist/index.js billing --json
node dist/index.js billing --print
node dist/index.js usage
node dist/index.js usage --json
node dist/index.js test --assessment ./augmentworks.assessment.yaml --estimate
node dist/index.js test --assessment ./augmentworks.assessment.yaml --profile quick --max-credits 30 --yes
node dist/index.js run status <run-id>
node dist/index.js run wait <run-id>
```

Do not document `npx @augmentworks/cli@0.3.2`. Published npm remains 0.3.1.

## Verification actually run

```bash
npm run check
# typecheck, vitest, build, discovery, billing-contract all pass
# ok: aw-billing/1 from 931838f29ee04fc018ef6359c22abd8d3e8da4c8
# schema=e08fd3ee7766e615b64024f416d72ac012fb829610a3a9f5efcdd1ec4b3c0f6a
# fixtures=3513887cc25d404d695ce1ca4e5f5b6cc60b138438ccfb24b9f9a3d0f5e4794a
# vitest: 49 files, 414 tests pass

node scripts/smoke-pack.mjs  # pass (20 files, 357981 compressed bytes)
```

Live billing/Checkout against a deployed Stage 3A host was **not run**. Stripe,
production RLS, and model-provider behavior are out of scope and are not
claimed. Main 3A Stripe test-mode remains **BLOCKED** (missing credentials).

## Stage 4A prerequisites (main repository)

1. Keep `aw-billing/1` usage/quote/status/billing-portal schemas stable
   (additive optional fields only).
2. Do not require this CLI to create Checkout Sessions or Stripe customers.
3. Read this handoff plus `docs/billing/phase-3-completion.md` before 4A.
4. 4A may write declared assessment/config/reference fixtures in its harness;
   label that as fixture setup. 4B owns packaged starter generation.
5. Website install commands must stay pinned to a published compatible CLI
   version. Source 0.3.2 `billing` is not an npx pin until published.

## Live activation

**Not enabled.** This prompt must not publish `@augmentworks/cli`, change
production feature flags, or claim production billing is active.
