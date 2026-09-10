# CLI discovery handoff

This repository owns `contracts/discovery-manifest.json` and
`contracts/discovery-manifest.schema.json` (`schemaVersion: 1`).
`src/discovery.ts` is the generator. Do not maintain a second set of release
constants. Packaged identity versus post-publication inspection is defined in
`docs/feature-readiness/release-state.md`.

## Current source artifact

| Field | Value |
| --- | --- |
| Package | `@augmentworks/cli@0.3.6` |
| `releaseStatus` | `development` (this git checkout; not a live registry probe) |
| `capabilities.localDemo` | `true` |
| Demo invocation | `node dist/index.js demo` |
| Provenance | `sourceCommit: null`, `verifiedAt: null` |
| Last independently inspected npm | Packaged `LAST_VERIFIED_*` remains `@augmentworks/cli@0.3.5` (`localDemo: true`, gitHead `11570f6cf883ec6e6743e010c35134bb485234dd`, published 2026-09-09T02:56:49.964Z). That tarball omits suite-selection `capabilities` (AUG-82). `thisPackageIdentity` for independently inspected `@augmentworks/cli@0.3.6` is gitHead `a9b927a2413305003f817c20e9c5df277512f83e`, published 2026-09-10T16:26:29.450Z, tarball SHA-256 `cf589a8998b6c7a947e6e91260a1a8e03082bb7d9ab6bc9e1ffc6740863d75b3`. |
| Immutable prior npm | `@augmentworks/cli@0.3.5`, `@augmentworks/cli@0.3.4`, and `@augmentworks/cli@0.3.3` (gitHead `4a08ea0d352f2515e725cb9ca946807112422436`). Do not overwrite or relabel. |

The committed discovery manifest stays `development` for a source checkout. A
locally packed tarball may carry this development-status manifest. That is QA,
not a rewrite of published npm 0.3.6. `scripts/verify-published-discovery.mjs --version 0.3.6`
was run against the downloaded registry tarball without rewriting that tarball
or relabeling 0.3.5:

```bash
npm run generate:discovery
npm run check:discovery
node scripts/verify-published-discovery.mjs --version 0.3.6
```

`verify-published-discovery` emits metadata and does not replace executable
inspection. Independently inspected 0.3.6 registry evidence is recorded as
`thisPackageIdentity` in `docs/feature-readiness/published-registry-evidence.json`.
Independently inspected 0.3.5 remains `lastIndependentlyInspected` (the prior
tarball packaged `LAST_VERIFIED_*` points at). Independently inspected 0.3.4
evidence remains in that file and in
`docs/feature-readiness/first-dollar-registry-acceptance.json`.

Published status requires registry metadata plus unpacked inventory and an
executable smoke of that exact tarball, including `demo` if advertised and
the AUG-82 capability-bearing compile request.

## Implemented demo

```bash
npm ci
npm run build
node dist/index.js demo
node dist/index.js demo --json
```

`--mode faulty` preserves underlying assertion exit `10`. `--mode full` exits
`0` only when the faulty run fails as expected, the corrected run passes, and
cleanup succeeds.

This package's executable npx pin is `0.3.6`:

```bash
npx --yes @augmentworks/cli@0.3.6 demo
```

## Website adoption

Website maintainers must independently review and adopt a **pinned** published
manifest. Never fetch `latest` into the live website at runtime.

Independently inspected `@augmentworks/cli@0.3.6` is ready for a deliberate
website pin (`gitHead` `a9b927a2413305003f817c20e9c5df277512f83e`,
`verifiedAt` `2026-09-10T16:26:29.450Z`, tarball SHA-256
`cf589a8998b6c7a947e6e91260a1a8e03082bb7d9ab6bc9e1ffc6740863d75b3`).
Independently inspected `@augmentworks/cli@0.3.5` is **not** the
catalog/selection pin. That tarball omits `capabilities` on
`selection compile` (AUG-82). Do not pin immutable npm `0.3.5`, `0.3.4`, or
`0.3.3`. Do not fetch `latest`.

Command arrays are data for reviewed rendering and tests. The website must not
execute imported command arrays.

Regenerate and validate this contract without hosted accounts:

```bash
npm run generate:discovery
npm run check:discovery
npm test
```

## Changed resources in this source revision

- Independently inspected npm `@augmentworks/cli@0.3.6` recorded as
  `thisPackageIdentity` (`independently-inspected`)
- `lastIndependentlyInspected` remains immutable 0.3.5 (packaged
  `LAST_VERIFIED_*`; omits suite-selection `capabilities`)
- Non-circular release-state contract (`docs/feature-readiness/release-state.md`)

## Next publish/release step

1. Land this source on `main`. **Done** (`a9b927a`, CLI PR #45).
2. Run `npm run check && npm run audit:ci && npm run smoke:pack`. **Done** (merge CI green).
3. Create a protected `v0.3.6` GitHub release. **Done** 2026-09-10T16:20:33Z.
   Do not overwrite `v0.3.5`.
4. Download the npm tarball and run `scripts/verify-published-discovery.mjs --version 0.3.6`.
   **Done.** Registry `gitHead` `a9b927a2413305003f817c20e9c5df277512f83e`,
   integrity `sha512-idDM/kYfDCzDu+iaSqzZjEchyui9I8r1krUFdZ8BmVtZIye2D5WbHFpbYaNzuwjPvV7gCk1XixLwu1kuROXfwA==`,
   published `2026-09-10T16:26:29.450Z`. Packed `--version` `0.3.6`;
   `published_package_verified: true`; tarball SHA-256
   `cf589a8998b6c7a947e6e91260a1a8e03082bb7d9ab6bc9e1ffc6740863d75b3`; 64 files;
   `demo --json` ok.
5. Independently inspect the registry tarball. **Done.** Direct and
   assessment-driven `selection compile` POST the full capabilities snapshot;
   removing a required capability still yields the matching incompatibility;
   no quote or run.
6. Fill `thisPackageIdentity` in `docs/feature-readiness/published-registry-evidence.json`.
   **Done** in this follow-up (status `independently-inspected`).
7. Hand the published 0.3.6 manifest to website maintainers. Website maintainers
   may now adopt the pinned 0.3.6 snapshot. Do not fetch `latest` at runtime.
   Keep 0.3.5 as immutable historical evidence.
