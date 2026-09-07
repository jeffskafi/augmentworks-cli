# Billing compatibility matrix (CLI Stage 4B)

| Surface | Source 0.3.3 | Published npm 0.3.2 | Older 0.3.1 | Notes |
| --- | --- | --- | --- | --- |
| `aw-billing/1` schema | Vendored from main `49806f0` | Not in tarball | Not in tarball | SHA-256 `e66d87fb…cc7b` / `42da3502…ec3c` |
| Capabilities | `usage_v1` `quote_v1` `status_v1` `billing_portal_link_v1` | none | none | `subscriptions_v1` reserved, not available |
| Relay create | `aw-relay/0.3` quoted | `aw-relay/0.2` assessment | `aw-relay/0.1`/`0.2` | Old clients receive `UPDATE_REQUIRED` after paid cutover |
| `init` starters | `response-quality` (default), `workflow` | YAML/env only | YAML/env only | Never overwrite edited assessment without `--force` |
| `usage` / `billing` | yes | no | no | Read-only; no Checkout |
| `test --estimate` / `--max-credits` | yes | no | no | `--yes` is not a spending ceiling |
| `run status` / `wait` | yes | no | no | Zero target/reservation calls |
| `demo` / `--assessment` | yes | yes | `--assessment` only in 0.3.1; demo in 0.3.2 | Account-free local/demo stay off billing |
| Website npx pin | Do not pin 0.3.3 | `@augmentworks/cli@0.3.2` | historical | Server must understand paid reservations before enabling new paid admission |
| Unpublished tarball (this branch) | `augmentworks-cli-0.3.3.tgz` 31 files, SHA-256 `d6d37d9b5932f6197044b7719bf08be812fc23bff1fc62508d6c5264d76e8586` | n/a | n/a | Not on the registry. Packed HTTP fixture is not RLS proof |

## Rollout order

1. Deploy main with ledger, quotes, Checkout (sales flag off), and
   `20260909120001_billing_paid_cohort_readiness.sql`.
2. Publish this CLI only after independent npm verification.
3. Point the website at the **published** package version.
4. Enable new paid admission / Checkout with the intended flags.

## Rollback restrictions

Do not roll the server back to a version that cannot understand live paid
reservations or minted credit grants. Disable new paid admissions or Checkout
through feature flags while allowing status, recovery, fulfillment, and
existing results to remain accessible. Do not restore the double-subtraction
ledger.

## Older server

A server without `quote_v1` returns `UPDATE_REQUIRED` for new billed
`--assessment` work. Authorized read/status/usage may continue. Packet-only
legacy create is not used as a paid fallback.
