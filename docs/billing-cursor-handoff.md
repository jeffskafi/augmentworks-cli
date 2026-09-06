# Billing Stage 1B → main Stage 2A handoff

Owned by `jeffskafi/augmentworks-cli`. Main owns the wire contract. This
repository vendors that contract; it does not change it.

Imported main handoff is saved separately at
`docs/billing/main-source-handoff.md`. Do not treat that file as the CLI-owned
handoff.

## Identity

| Item | Value |
| --- | --- |
| CLI baseline HEAD | `d36ec8590b005445dba940d2df3abcb53971cea5` (`origin/main`, source 0.3.2; published npm 0.3.1) |
| Working branch | `cursor/billing-stage-1b-91a7` |
| Implementation commit | Recorded in the identity table of `docs/billing/phase-1-completion.md` / git after this branch is committed |
| Vendored main commit | `e037958ba3c9f38a436b6065cddb5fb8ee3943fa` |
| Stage | **1B code complete and deterministically verified.** Not npm-published. Not production-verified against a live 1A host. Not live-sales ready. |

## What Stage 1B implemented

Authenticated **usage display** and **identity-preserving refresh** only.

- `augmentworks usage`
- `augmentworks usage --json`

No quotes, Checkout, subscriptions, Stripe, Clerk, packs, or a competing
route layout.

Human output identifies the workspace, shows available credits prominently,
then reserved and consumed credits with their ledger meanings, then grant lots
(trial/promotional, purchased, recurring, or unrecognized origin). Nullable
expiry prints as `no expiry` when the server sends `null`; dates are never
invented. Values are a server snapshot at `asOf`, not a guaranteed future
balance. The CLI never recomputes `availableUnits`.

`--json` success: one object on stdout (`ok: true` plus contract fields).
`--json` failure: one `{ ok: false, code, category, safe_message, retryable, exit_code }`
object on stdout. Hints stay on stderr in human mode.

## Vendored contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `contracts/aw-billing-v1.schema.json` =
  `2ea0236b9fa1bac4a7e50dbd5d016c9b9b32a4b7b31298cfc53104308bdace8d`
- `contracts/aw-billing-v1.fixtures.json` =
  `6ef4e83f2dfa5f5ffc22dd97ec35c106ef7d012d7433e107cf551841b0eb7556`

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

Server aliases `/api/v1/billing/*` exist and are not called by this CLI.

### Authentication

Existing opaque CLI bearer. Required read scope: `connector:identity`.
Refresh-once after HTTP 401. Workspace comes from the validated connector.
A cached `billingAccountId` or email never selects the wallet.

Usage does not need target YAML, a target API key, or a target server.

Read permission does not imply billing-management permission. The command is
GET-only: it does not create a trial, grant credits, reserve units, initialize
a paid order, or call the target.

### Capabilities treated as available

Only `usage_v1`. Reserved names `quote_v1`, `status_v1`,
`billing_portal_link_v1`, and `subscriptions_v1` are ignored if present and
are not advertised by this CLI. A server without `usage_v1` fails as
`USAGE_UNSUPPORTED` (exit 13), never as a zero balance, and does not call
`GET /v1/billing/usage`.

Consumers tolerate additive optional fields and a later non-null
`subscription` object without treating it as a live sale. Unknown
`accessState` values fail closed (`BILLING_UNSUPPORTED_STATE`). Unknown
capability strings are ignored.

### Errors (CLI mapping)

| Server `error.code` / HTTP | CLI code | Exit |
| --- | --- | --- |
| 401 / `unauthenticated` | `TOKEN_REVOKED` | 3 |
| 403 / `unauthorized` | `CLOUD_AUTH_REJECTED` | 3 |
| 403 / `insufficient_scope` | `SCOPE_DENIED` | 3 |
| `workspace_mismatch` | `WORKSPACE_MISMATCH` | 3 |
| `billing_unprovisioned` | `BILLING_UNPROVISIONED` | 13 |
| `unsupported_state` | `BILLING_UNSUPPORTED_STATE` | 13 |
| 404 / 405 / 501 | `USAGE_UNSUPPORTED` | 13 |
| 408 / 429 / 5xx / `service_unavailable` | `BILLING_UNAVAILABLE` | 13 (retryable; GET retried once) |
| Missing application profile (auth message) | `PROFILE_RECOVERY_REQUIRED` | 13 |
| Malformed body | `INVALID_CLOUD_RESPONSE` | 4 |
| Unexpected redirect | `RELAY_UNREACHABLE` (redirect not followed) | 4 |

Unprovisioned / missing-profile recovery points at `{apiOrigin}/portal`. The
CLI does not create a replacement account.

`billingPageUrl` must be a trusted first-party origin (`https://augmentworks.ai`
or the current API origin), path `/portal/billing…`, no tokens. Unexpected
redirects are rejected before forwarding credentials.

## Exit codes

Existing codes 0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 130 keep their meanings.
`EXIT.BILLING = 13` is assigned to category `billing` and was unused.

Auth failures from billing (revoked token, missing scope, membership
revocation, workspace mismatch) remain exit 3.

## Local-mode independence

`demo`, `test --local`, offline `doctor`, and `schema` make no billing calls.

## Logout

Unchanged: revokes/removes CLI credentials, preserves run journals, does not
delete a workspace, and does not call a billing mutation. Login refresh, token
rotation, logout, and browser reauthentication do not imply a new trial.

## Verification actually run

```bash
npm run check:billing-contract
# ok: aw-billing/1 from e037958ba3c9f38a436b6065cddb5fb8ee3943fa
# schema=2ea0236b9fa1bac4a7e50dbd5d016c9b9b32a4b7b31298cfc53104308bdace8d
# fixtures=6ef4e83f2dfa5f5ffc22dd97ec35c106ef7d012d7433e107cf551841b0eb7556

npm run typecheck          # pass
npm test                   # 46 files, 360 tests pass
npm run build              # pass
npm run check              # pass
npm run smoke:pack         # pass (20 files, 342396 compressed bytes)
```

Live `GET /v1/billing/usage` against a deployed Stage 1A host was **not run**.
Stripe, production RLS, and model-provider behavior are out of scope and are
not claimed.

## Stage 2A prerequisites (main repository)

1. Keep `aw-billing/1` usage schema stable (additive optional fields only).
2. Add `quote_v1` and `status_v1` only when those handlers exist. Do not
   advertise unfinished endpoints.
3. Do not require this CLI to compute prices or invent quote routes.
4. Read this handoff plus `docs/billing/phase-1-completion.md` before 2A.
5. CLI 2B will re-import the exact schema/fixtures after 2A publishes them.
6. Preserve `connector:identity` usage reads; quote/admission consent is 2B.

## Live activation

**Not enabled.** This prompt must not publish `@augmentworks/cli`, change
production feature flags, or claim production billing is active.
