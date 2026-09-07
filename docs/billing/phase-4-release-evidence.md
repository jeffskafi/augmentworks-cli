# CLI Stage 4B release evidence

Concise evidence for the unpublished `0.3.3` release candidate. Missing
external checks are **BLOCKED** / `not_run`, never counted as passed.

## Identity

| Item | Value |
| --- | --- |
| CLI 3B baseline | `d584f474bc3c043c33c6a5c75ef40d838bebafcb` |
| Branch | `cursor/billing-stage-4b-91a7` |
| Implementation | `c9f079a3fe9b08ba743977115849e594462bbb3d` (packed journey); `7e213781a387292f634ea3df05800ef632e1f184` (rebuild stale packed dist) |
| Main 4A commit vendored | `49806f0f52377bbca0fbe02f160668723c589fa7` |
| Source package | `0.3.3` |
| Published npm (do not replace yet) | `0.3.2` (`gitHead` `d36ec8590b005445dba940d2df3abcb53971cea5`) |
| `aw-billing/1` schema SHA-256 | `e66d87fb48bd91ffbd125f1337b7978e4b60334be838fe46c40fce468cd8cc7b` |
| `aw-billing/1` fixtures SHA-256 | `42da35022b78954ab214fa4e2f9a1bcb903790056f4dfb57cf1dece5e632ec3c` |

Record the Stage 4B packed-journey implementation commit `c9f079a3fe9b08ba743977115849e594462bbb3d`.
Packed tests rebuild stale `dist/` in `7e213781a387292f634ea3df05800ef632e1f184`.
First onboarding implementation remains `82e0c3e615e90ab766a3f55d848e7a39644ce9b9`.

## Tarball

Produced by `npm pack --ignore-scripts` in this checkout after `npm run build`.

| Item | Value |
| --- | --- |
| Filename | `augmentworks-cli-0.3.3.tgz` |
| Files | 31 |
| Compressed size | 371282 bytes |
| Unpacked size | 1960576 bytes |
| SHA-256 | `af2421fdf958810a93b1219609fdb0cd7163db5f8e3311680edef091185d987f` |

Inventory (all `package/` paths):

- `dist/index.js`
- `assets/starters/response-quality/` (yaml, assessment, `.env.example`, four references)
- `assets/starters/workflow/` (yaml, assessment, `.env.example`, refund-policy reference)
- `assets/demo/` (yaml + packet)
- `contracts/aw-billing-v1.schema.json`, `fixtures.json`, `lock.json`
- `contracts/discovery-manifest.json` + schema
- `packets/response-quality/0.1.0/packet.json`
- `packets/support-refunds/0.2.0/packet.json`
- `packets/support-refunds-starter/0.1.0/packet.json`
- `schemas/v1/*`
- `README.md`, `LICENSE`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `package.json`

Not in the tarball: `examples/`, tests, `docs/`, `.env` files, Stripe keys.

## Commands and outcomes

Working directory: `/Users/jeffskafi/Desktop/augmentworks-cli-billing-4b`.

```text
npm run check
# typecheck pass
# vitest 53 files / 468 tests pass
# build dist/index.js 1.68 MB
# discovery ok: @augmentworks/cli@0.3.3 (development)
# billing-contract ok: aw-billing/1 from 49806f0
#   schema=e66d87fb48bd91ffbd125f1337b7978e4b60334be838fe46c40fce468cd8cc7b
#   fixtures=42da35022b78954ab214fa4e2f9a1bcb903790056f4dfb57cf1dece5e632ec3c

AUGMENTWORKS_PACKED_BIN=$PWD/dist/index.js node scripts/packed-billing-fixture.mjs
# passed creates=1 quotes=4 targets=1 polls=3 refreshes=1

npm run smoke:pack
# passed (31 files, 371282 compressed bytes)
# includes packed billing HTTP fixture through the installed binary

npm run test:packed-billing-live
# exit 2 BLOCKED
# Set AW_BILLING_LIVE_API_URL and AW_BILLING_LIVE_TOKEN
```

## Packed HTTP fixture (not RLS proof)

Empty directory → packed `init` (response-quality) → offline doctor →
`usage --json` availableUnits 190 → `--estimate` (one quote, zero create) →
`--max-credits 0 --yes` `BUDGET_EXCEEDED` (zero target) → dropped create
replayed into one admission → process restart while poll is held → token
refresh on first poll → one synthetic `POST /chat` → grading pending (exit 11)
→ `run wait` timeout stays on the original run → grading complete valid FAIL
(exit 10) → last-units `INSUFFICIENT_CREDITS` → exhausted usage 0 → billing
page URL only → pendingCommerce then +300 fulfillment → usage 503
`BILLING_UNAVAILABLE` → missing `quote_v1` `UPDATE_REQUIRED`. Token never
appeared in stdout/stderr.

## Other journey coverage

Packed HTTP fixture (still not the live database gate):

- Dropped create / same identity resume and process restart after admission
- Token refresh on first poll (`AUGMENTWORKS_REFRESH_TOKEN`)
- One synthetic `/chat` target after admission
- Pending grading + `run wait` timeout then complete
- Last-units `INSUFFICIENT_CREDITS` and exhausted billing URL
- Usage 503 `BILLING_UNAVAILABLE`
- Pending pack fulfillment (`pendingCommerce` then +300)
- Missing `quote_v1` `UPDATE_REQUIRED`

Source/integration tests that remain:

- Quote/ceiling/consent: `test/billing/cli-quote.test.ts`
- Billing URL allowlist and no payment writes: `test/billing/cli-billing.test.ts`
- Usage snapshot 190 and JSON purity: `test/billing/cli-usage.test.ts`
- Recovery / intent retirement: `test/recovery/recovery.test.ts`
- Init overwrite and doctor wire bounds: `test/config/commands.test.ts`
- Environment token refresh: `test/auth/auth.test.ts`

## Unresolved blockers

1. **Packed CLI ↔ disposable migrated main API/database** — credentials not
   supplied. `scripts/packed-billing-live.mjs` exits 2. A fixture that returns
   190 available units is not this gate.
2. **Stripe test-mode pack fulfillment** — main repository; missing Stripe
   secrets. CLI must not mint test credits locally.
3. **npm publish of 0.3.3** — not authorized in this session. Website pin
   remains 0.3.2.
4. **Live sales / Checkout flags** — remain off on the server.

## Live activation

**Disabled.**
