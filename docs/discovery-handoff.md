# CLI discovery handoff

This repository owns `contracts/discovery-manifest.json` and
`contracts/discovery-manifest.schema.json` (`schemaVersion: 1`).
`src/discovery.ts` is the generator. Do not maintain a second set of release
constants.

## Current source artifact

| Field | Value |
| --- | --- |
| Package | `@augmentworks/cli@0.3.4` |
| `releaseStatus` | `development` |
| `capabilities.localDemo` | `true` |
| Demo invocation | `node dist/index.js demo` |
| Provenance | `sourceCommit: null` (gap until a release commit is recorded), `verifiedAt: null` |
| Last independently verified npm | `@augmentworks/cli@0.3.2` (`localDemo: true`, gitHead `d36ec8590b005445dba940d2df3abcb53971cea5`) |
| Immutable npm artifact (not this release) | `@augmentworks/cli@0.3.3` (gitHead `4a08ea0d352f2515e725cb9ca946807112422436`) |

The committed discovery manifest stays `development` until a registry tarball
is downloaded and inspected. A locally packed tarball may carry this
development-status manifest. That is QA, not npm publication. After
publication, generate a **separate** published-status manifest from the
**downloaded** registry tarball without rewriting that tarball:

```bash
npm run generate:discovery
npm run check:discovery
node scripts/verify-published-discovery.mjs --version 0.3.4
```

`verify-published-discovery` emits metadata and does not replace executable
inspection. Record registry evidence in
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

This package's executable npx pin is `0.3.4`:

```bash
npx --yes @augmentworks/cli@0.3.4 demo
```

## Website adoption

Website maintainers must independently review and adopt a **pinned** published
manifest. Never fetch `latest` into the live website at runtime.

Until `docs/feature-readiness/first-dollar-registry-acceptance.json` records a
registry pass for 0.3.4, keep the website snapshot on last independently
verified `@augmentworks/cli@0.3.2`. Do not pin immutable npm `0.3.3`.

Command arrays are data for reviewed rendering and tests. The website must not
execute imported command arrays.

Regenerate and validate this contract without hosted accounts:

```bash
npm run generate:discovery
npm run check:discovery
npm test
```

## Changed resources in this source revision

- Candidate package identity `0.3.4` with matching generated npx pins
- `docs/feature-readiness/first-dollar-registry-acceptance.json` handoff schema
- discovery contract files
- `agent-resources/` wrappers regenerated from `guidance.md`

## Next publish/release step

1. Land this source on `main`.
2. Run `npm run check && npm run audit:ci && npm run smoke:pack`.
3. Create a protected `v0.3.4` GitHub release (maintainers only; existing
   `.github/workflows/release.yml`, non-draft, non-prerelease, `npm` environment).
4. Download the npm tarball and run `scripts/verify-published-discovery.mjs --version 0.3.4`.
5. Fill registry fields in `docs/feature-readiness/first-dollar-registry-acceptance.json`.
6. Hand the published manifest to website maintainers. Do not self-adopt.
