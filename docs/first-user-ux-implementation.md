# First-user UX — CLI repository ledger

This ledger tracks the **`augmentworks-cli`** portion of the September 4, 2026
first-user UX brief. Website/portal work belongs in `jeffskafi/augmentworks`
and is out of scope here.

## Baseline (Phase 00)

| Field | Value |
| --- | --- |
| Evidence baseline commit | `0fea1270de404db0c2a61ea04ab4b0dcc603032e` |
| Working branch | `first-user-ux-cli` |
| Package manager | npm |
| Node requirement | `>=20` |
| Node used for verification | v22.23.2 |
| Source package version | `0.2.0` |
| Verified published package | `@augmentworks/cli@0.1.0` on registry.npmjs.org |
| Hosted protocol | `aw-relay/0.1` |
| Local packet | `support-refunds-starter@0.1.0` (bundled in source/tarball of 0.2.0) |
| Hosted packet | `support-refunds@0.1.0` (catalog lives in the platform, not this repo) |
| Examples in npm tarball | No (`files` omits `examples/`) |

### Subsystems reused

- Commands: `login`, `logout`, `whoami`, `init`, `doctor`, `test`, `test --local`, `schema`
- Auth: PKCE loopback, device flow, native credential stores, refresh lock
- Hosted: run-intent replay, journal, cleanup drain; no `--rerun` flag
- Local: bundled starter packet, JSON/JUnit/HTML reports

### Known baseline failures (recorded, not “fixed” by hiding them)

- README and docs pinned `@augmentworks/cli@0.2.0` while only `0.1.0` is published. **Addressed in this branch** by pinning hosted `npx` to `0.1.0` and routing local mode through a git checkout.
- Local `--local` and `schema --kind local-*` exist only in source `0.2.0`. Still true until `0.2.0` is published.
- Refund-agent example is git-checkout-only. Documented as such.
- CHANGELOG linked an unpublished npm `0.2.0` page. **Addressed** (GitHub compare / package homepage).

## Phase status

| Phase | CLI relevance | Status |
| --- | --- | --- |
| 00 Baseline | Inventory, ledger, published vs source | verified |
| 01 Release metadata and command pins | `src/release.ts`, `schemas/v1/cli-release.json`, docs | verified |
| 02 CLI authorization reliability | Login/device recovery copy, next-step after consent | verified (unit/integration; live Google/email smoke is website + production) |
| 03–04, 06–07, 09–10, 12–14 | Website/portal | not in this repo |
| 05 Guided setup commands | `init`/`doctor`/`test` next-steps; no connect command | verified |
| 08 Rerun guidance | Same `test` command; no invented `--rerun` | verified |
| 11 Local example from git | Clone/build/run path; pack distinction | verified (docs + `smoke:pack` local packet) |
| 15 Publish 0.2.0 | External npm/trusted-publishing | externally blocked |

## Verification

| Command | Result |
| --- | --- |
| `npm run check` | pass: typecheck, 31 files / 261 tests, build |
| `npm run smoke:pack` | pass (packed tarball includes `schemas/v1/cli-release.json`; examples remain excluded) |

Occasional flake observed once under parallel load: `serializes rotating refresh tokens across independent credential managers` (`LOCK` disappeared). Re-run of `test/auth/auth.test.ts` and the following full `npm run check` passed. Treat as pre-existing lock-race flake, not a first-user pin regression.

## CLI-relevant acceptance rows

| ID | Result in this repo |
| --- | --- |
| A09 | Published pin remains `0.1.0`. Source `0.2.0` is not on npm. Tarball smoke passed for this source tree. |
| A10 | Documented clone/`npm ci`/`test --local` path; packed CLI still runs bundled starter packet. Full clean-machine example clone not re-executed in this session. |
| A12 | `doctor` remains offline; copy-contract and doctor unit tests pass. |
| A20 | Existing create-resume integration still passes; docs say re-run the same `test` command. |
| A32 | Copy UX for website CodeBlock is out of scope; CLI docs keep selectable commands. |
| A37 | Local mode still has no AugmentWorks telemetry. |

Website-only rows (A01–A08, A11, A13–A19, A21–A36, A38–A42) are not claimed here.

## Remaining external actions

1. Configure npm trusted publishing for `jeffskafi/augmentworks-cli` / `release.yml` / `npm`.
2. Tag and GitHub-release `v0.2.0` only after `npm run check` and `npm run smoke:pack` on the release commit.
3. After 0.2.0 is on the registry, set `published_package_version` to `0.2.0` in `src/release.ts` and `schemas/v1/cli-release.json` so hosted and local npx pins match source.
4. Website repo must consume `schemas/v1/cli-release.json` (or an equivalent copy) so public commands stay on the verified pin.
