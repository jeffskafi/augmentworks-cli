# CLI discovery handoff

This repository owns `contracts/discovery-manifest.json` and
`contracts/discovery-manifest.schema.json` (`schemaVersion: 1`).
`src/discovery.ts` is the generator. Do not maintain a second set of release
constants. Packaged identity versus post-publication inspection is defined in
`docs/feature-readiness/release-state.md`.

## Current source artifact

| Field | Value |
| --- | --- |
| Package | `@augmentworks/cli@0.3.5` |
| `releaseStatus` | `development` (this git checkout; not a live registry probe) |
| `capabilities.localDemo` | `true` |
| Demo invocation | `node dist/index.js demo` |
| Provenance | `sourceCommit: null`, `verifiedAt: null` |
| Last independently inspected npm | `@augmentworks/cli@0.3.4` (`localDemo: true`, gitHead `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f`, published 2026-09-08T06:38:24.847Z) |
| Immutable prior npm | `@augmentworks/cli@0.3.4` and `@augmentworks/cli@0.3.3` (gitHead `4a08ea0d352f2515e725cb9ca946807112422436`). Do not overwrite or relabel. |

The committed discovery manifest stays `development` for a source checkout. A
locally packed tarball may carry this development-status manifest. That is QA,
not npm publication of 0.3.5. After the protected 0.3.5 publish, generate a
**separate** published-status manifest from the **downloaded** registry tarball
without rewriting that tarball or relabeling 0.3.4:

```bash
npm run generate:discovery
npm run check:discovery
node scripts/verify-published-discovery.mjs --version 0.3.5
```

`verify-published-discovery` emits metadata and does not replace executable
inspection. Record 0.3.5 registry evidence in
`docs/feature-readiness/published-registry-evidence.json`. Independently
inspected 0.3.4 evidence is already recorded there and in
`docs/feature-readiness/first-dollar-registry-acceptance.json`.

Published status requires registry metadata plus unpacked inventory and an
executable smoke of that exact tarball, including `demo` if advertised.

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

This package's executable npx pin is `0.3.5`:

```bash
npx --yes @augmentworks/cli@0.3.5 demo
```

## Website adoption

Website maintainers must independently review and adopt a **pinned** published
manifest. Never fetch `latest` into the live website at runtime.

Keep the live website snapshot on independently inspected
`@augmentworks/cli@0.3.4` until website maintainers deliberately adopt 0.3.5.
Do not pin immutable npm `0.3.3`. Do not overwrite 0.3.4.

Command arrays are data for reviewed rendering and tests. The website must not
execute imported command arrays.

Regenerate and validate this contract without hosted accounts:

```bash
npm run generate:discovery
npm run check:discovery
npm test
```

## Changed resources in this source revision

- Published-line package identity `0.3.5` with matching generated npx pins
- Non-circular release-state contract (`docs/feature-readiness/release-state.md`)
- Independently inspected 0.3.4 registry evidence
- discovery contract files
- `agent-resources/` wrappers regenerated from `guidance.md`

## Next publish/release step

1. Land this source on `main`.
2. Run `npm run check && npm run audit:ci && npm run smoke:pack`.
3. Create a protected `v0.3.5` GitHub release (maintainers only; existing
   `.github/workflows/release.yml`, non-draft, non-prerelease, `npm` environment).
   Do not overwrite `v0.3.4`.
4. Download the npm tarball and run `scripts/verify-published-discovery.mjs --version 0.3.5`.
5. Fill `thisPackageIdentity` in `docs/feature-readiness/published-registry-evidence.json`.
6. Hand the published 0.3.5 manifest to website maintainers. Do not self-adopt.
