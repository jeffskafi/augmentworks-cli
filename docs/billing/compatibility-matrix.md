# Billing compatibility matrix (CLI Stage 5B)

| Surface | Source 0.3.3 | Published npm 0.3.2 | Older 0.3.1 | Notes |
| --- | --- | --- | --- | --- |
| `aw-billing/1` schema | Vendored from main `650472d` | Not in tarball | Not in tarball | SHA-256 `3097c7aa…b645` / `a4b9234b…cb84` |
| Capabilities | `usage_v1` `quote_v1` `status_v1` `billing_portal_link_v1` `subscriptions_v1` | none | none | Pack-only servers omit `subscriptions_v1`; CLI then omits recurring CTAs |
| Relay create | `aw-relay/0.3` quoted | `aw-relay/0.2` assessment | `aw-relay/0.1`/`0.2` | Old clients receive `UPDATE_REQUIRED` after paid cutover |
| `init` starters | `response-quality` (default), `workflow` | YAML/env only | YAML/env only | Never overwrite edited assessment without `--force` |
| `usage` / `billing` | yes, including monthly vs pack lots | no | no | Read-only; no Checkout, subscribe, cancel, or Customer Portal session |
| `test --estimate` / `--max-credits` | yes | no | no | `--yes` is not a spending ceiling. Monthly status does not bypass it |
| `run status` / `wait` | yes | no | no | Zero target/reservation calls. Reservations may finish after monthly expiry |
| `demo` / `--assessment` | yes | yes | `--assessment` only in 0.3.1; demo in 0.3.2 | Account-free local/demo stay off billing |
| Website npx pin | Do not pin 0.3.3 | `@augmentworks/cli@0.3.2` | historical | Server must understand paid reservations before enabling new paid admission |
| Unpublished tarball (this branch) | recorded after `npm run smoke:pack` | n/a | n/a | Not on the registry. Packed HTTP fixture is not RLS proof |

## Rollout order

1. Deploy main with ledger, quotes, Checkout (sales flag off), subscriptions
   (`subscriptions_v1` advertised, live Pro sales flag off unless separately
   authorized), and paid-cohort readiness.
2. Publish this CLI only after independent npm verification.
3. Point the website at the **published** package version.
4. Enable new paid admission / Checkout / live subscriptions with the intended
   flags. `subscriptions_v1` on the wire is not live $149 activation.

## Rollback restrictions

Do not roll the server back to a version that cannot understand live paid
reservations, minted credit grants, or funded-period monthly allocations.
Disable new paid admissions, Checkout, or new subscription sales through
feature flags while allowing status, recovery, fulfillment, cancellation of
existing subscribers, and existing results to remain accessible. Do not
restore the double-subtraction ledger.

## Older server

A server without `quote_v1` returns `UPDATE_REQUIRED` for new billed
`--assessment` work. A server without `subscriptions_v1` is pack-only: usage
still works, recurring CTAs are omitted, and purchased credits remain usable.
Authorized read/status/usage may continue. Packet-only legacy create is not
used as a paid fallback.
