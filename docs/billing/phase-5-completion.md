# Stage 5B completion record

Repository: `jeffskafi/augmentworks-cli`
Stage: **5B** monthly usage, renewal states, and finite CI
Date: 2026-09-07

## Code completion vs integration vs release

| Layer | State |
| --- | --- |
| Code completion (this repository) | **Complete.** Vendored Stage 5A schema/fixtures, subscription usage/billing display, pack-only fallback, `--max-credits` still required, first-party billing URL only |
| Deterministic tests | Recorded after the verification commands in this file |
| Live disposable main API / Stripe test-mode | **BLOCKED** / `not_run` without credentials. Not counted as passed |
| npm publish | **Not done.** Source remains `0.3.3` unpublished |
| Live pack or Pro sales | **Disabled.** `subscriptions_v1` is a wire capability, not live $149 activation |

## Source identity

| Item | Value |
| --- | --- |
| CLI 4B baseline | `7d8cb08170b162d8c2dc66343df9499986742779` |
| Working branch | `cursor/billing-stage-5b-91a7` |
| Vendored main 5A | `650472d91442a6866a7b6ef18e6dacc23a2a9260` |
| Schema SHA-256 | `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645` |
| Fixtures SHA-256 | `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Source package | `0.3.3` unpublished |
| Website pin | published `@augmentworks/cli@0.3.2` |

Imported main handoff: `docs/billing/main-source-handoff.md` (not the CLI-owned handoff).

## What changed

- `scripts/import-aw-billing-contract.mjs` re-ran from the 5A worktree.
- `src/billing/subscription.ts` interprets the nullable subscription
  projection without guessing unknown enums as active.
- `src/billing/format.ts` prints recurring / purchased / trial lots, period
  bounds, cancel-at-period-end, processing, past_due with remaining pack
  credits, canceled retained results, expired monthly grants, and pack-only
  omission of recurring CTAs.
- `usage --json` / `billing --json` include `subscription`,
  `subscriptionAdvertised`, `subscriptionInterpretable`, and
  `creditCategories`. They never emit Customer Portal bearer URLs.
- Packed HTTP fixture capabilities include `subscriptions_v1` and assert the
  190-available trial snapshot still has `subscription: null`.
- README, troubleshooting, compatibility matrix, agent guidance, changelog,
  and a source-only hosted CI example.

The CLI does not subscribe, cancel, reactivate, refund, or modify payment
methods. Quote and admission remain server-authoritative. Monthly status does
not bypass `--max-credits`.

## Tests that actually passed

Commands run on this checkout after the copy-contract fix:

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | pass, **54 files / 491 tests** |
| `npm run build` | pass |
| `npm run check:discovery` | pass, `@augmentworks/cli@0.3.3 (development)` |
| `npm run check:billing-contract` | pass, main `650472d`, schema `3097c7aa…b645`, fixtures `a4b9234b…cb84` |
| `npm run check` | pass (the above together) |
| `npm run smoke:pack` | pass, 31 files, 377224 compressed bytes. Packed billing HTTP fixture `creates=1 quotes=4 targets=1 polls=3 refreshes=1` |
| `npm run test:packed-billing-live` | **BLOCKED** exit 2 (`not_run`). Missing `AW_BILLING_LIVE_API_URL` / `AW_BILLING_LIVE_TOKEN` |

Unpublished tarball SHA-256: `93cd64b84acf9acdc19b399e644a396f87aae72d6fbd5d3531109f59a81f256a`

The HTTP fixture is not evidence of atomic monthly allocation or tenant RLS.
Stripe Test Clocks belong to main. This CLI uses fixtures plus packed HTTP.

## External checks not run (BLOCKED, not passed)

| Check | Reason |
| --- | --- |
| Real Stripe test-mode / Test Clocks | CLI does not drive Stripe. Main 5A recorded this as BLOCKED without credentials |
| Disposable migrated main API + RLS | `npm run test:packed-billing-live` exits 2 without `AW_BILLING_LIVE_API_URL` / token |
| npm publish / live Pro sales | Not authorized by this prompt |

## Configuration still required

Same as main 5A launch runbook: Stripe test/live keys, webhook secrets,
`pro_monthly_1000_v1` price, Customer Portal configuration, live-sales flags
off until the operational gate passes. CLI needs no Stripe credentials.

## Live activation state

**Disabled.** Completing 5B does not enable live subscriptions. Remaining
main gate: measured all-in grading costs, repeat customer use, verified
subscription pricing/terms, and successful test-mode lifecycle checks.

## Counterpart compatibility

Stage 1–4 pack-only servers still work. `subscription_unavailable` omits
recurring CTAs. Additive optional subscription fields are ignored when
unsupported. Unknown `accessState` still fails closed. Unknown subscription
status preserves usage reads.

## Defects resolved in this stage

- Stage 4B treated every non-`active` `accessState` as “new tests rejected”.
  Workspace `past_due` is no longer guessed as a hard local reject; quote and
  admission stay on the server. Subscription `past_due` with workspace
  `accessState: active` keeps purchased credits visible.
- Pack-only `$149` marketing remains omitted. Subscription-capable servers may
  show the server `planCode` without a hard-coded price.

## Next step

None in the ten-prompt sequence. Release review can use this handoff plus
main `docs/billing/phase-5-completion.md`. Do not publish npm or turn on live
sales from this record.
