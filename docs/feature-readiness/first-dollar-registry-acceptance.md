# First-dollar registry acceptance (AUG-73)

Issue: [AUG-73](https://linear.app/augmentworks/issue/AUG-73/cli-publish-a-verified-customer-owned-assessment-release)
Schema: `aw-first-dollar-release/1`
Machine record: `docs/feature-readiness/first-dollar-registry-acceptance.json`

This is the CLI (`jeffskafi/augmentworks-cli`) first-dollar publication handoff.
It certifies **candidate** 0.3.4 package identity and bounded local/contract
behavior. It does **not** claim live purchases, full regression-CI completion,
or hosted browser QA ([AUG-58](https://linear.app/augmentworks/issue/AUG-58/main-verify-deployed-api-key-password-and-published-cli-qa-integration)).

## Recheck (2026-09-07)

| Item | Observed value |
| --- | --- |
| Default branch | `main` |
| `origin/main` | `b8c3e7c3d71d9bef2cb07ddf3771c0822934208d` (merge of CLI PR #32 / AUG-35) |
| Open PRs at start | None |
| AUG-35 | Done. Handoff `docs/feature-readiness/c07-completion.md`. Consumed, not reimplemented. |
| npm `latest` / 0.3.3 | Published 2026-09-07T16:21:14Z, `gitHead` `4a08ea0d352f2515e725cb9ca946807112422436`. Lacks suite validate/preview and `test --suite`. No GitHub tag `v0.3.3`. |
| npm 0.3.4 | Unused (registry 404) |
| Last independently verified GitHub release | `v0.3.2` |
| Last independently verified npm | `@augmentworks/cli@0.3.2` (`gitHead` `d36ec8590b005445dba940d2df3abcb53971cea5`) |

Selected candidate: current default main plus this 0.3.4 metadata PR. Compatible own suites, starter/probe, session, mapping preview, quoted billing, API-key auth, and complete report fixes are on that head.

## Candidate versus verified evidence

| Layer | Owner | 0.3.4 state |
| --- | --- | --- |
| `package.json` / `src/version.ts` | This ticket | `0.3.4` |
| Generated `init --agent` / documented npx pin | This ticket | `@augmentworks/cli@0.3.4` |
| `CLI_RELEASE.published_package_verified` | This ticket | `false` until registry inspection |
| Committed discovery `schemaVersion: 1` | Existing contract | `releaseStatus: development` |
| Last verified published discovery snapshot | Existing contract | still `0.3.2` |
| This JSON `cli.gitHead` / `cli.integrity` | This ticket | `null` until the registry tarball is downloaded |

Do not overwrite npm 0.3.3 or relabel its provenance.

## Candidate verification (not registry)

Tested head: PR https://github.com/jeffskafi/augmentworks-cli/pull/33 on branch `cursor/cli-verified-customer-release-f205`. Base `main` `b8c3e7c3d71d9bef2cb07ddf3771c0822934208d`.

| Command | Result |
| --- | --- |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npm ci` | Pass |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npm run check` | Pass. typecheck; **71 files / 677 tests**; discovery `@augmentworks/cli@0.3.4 (development)` |
| `npm run audit:ci` | Pass. 0 vulnerabilities |
| `npm run smoke:pack` | Pass. Local tarball **53 files, 429540 bytes**, SHA-256 `46a7f4d653cf1e29a38ac0b47adf0c4117bba2daefcc54c6fd1fc35cd910d5f4`. examples/ absent. Starters and customer suites present. |
| `AUGMENTWORKS_PACKED_BIN=<local installed dist> npm run test:packed-billing-fixture` | Pass. `creates=1 quotes=4 targets=1 polls=3 refreshes=1` |
| `AUGMENTWORKS_PACKED_BIN=<local installed dist> npm run test:packed-report-fixture` | Pass. `requests=8` |
| Packed `init --agent` | Writes `npx --yes @augmentworks/cli@0.3.4`, not 0.3.2/0.3.3 |
| `node scripts/verify-published-discovery.mjs --version 0.3.4` | **404**. npm 0.3.4 is not on the registry. |

A local pack is QA only. It is not npm publication.

## Publication path (maintainer)

Inspected `.github/workflows/release.yml`: `on.release.types: [published]`,
`if: prerelease == false && draft == false`, `environment: npm`, tag must equal
`v` + `package.json` version, `npm publish` with provenance, no
`NODE_AUTH_TOKEN`.

Required after merge and CI:

1. Create a non-draft, non-prerelease GitHub release tagged exactly `v0.3.4`.
2. Let the protected workflow publish.
3. `npm view @augmentworks/cli@0.3.4 --json` and download that tarball.
4. Install it and set `AUGMENTWORKS_PACKED_BIN` to that installed binary.
5. Re-run packed fixtures and `node scripts/verify-published-discovery.mjs --version 0.3.4`.
6. Fill `cli.gitHead`, `cli.integrity`, `verifiedAt`, and flip registry checks
   to `pass` only from those observed artifacts.

A missing GitHub/npm permission is an external blocker. Do not bypass the
workflow or invent credentials.

## External lanes not run

- Protected GitHub release `v0.3.4` and npm provenance publish
- Registry tarball download / integrity / gitHead inspection
- Hosted positive/fault/browser QA (AUG-58)
- Live purchases, production provider calls, customer-target contact
- AUG-47/48 baseline/regression/CI journey
