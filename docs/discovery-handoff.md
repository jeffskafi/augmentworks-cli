# CLI discovery handoff

This repository owns `contracts/discovery-manifest.json` and
`contracts/discovery-manifest.schema.json` (`schemaVersion: 1`).
`src/discovery.ts` is the generator. Do not maintain a second set of release
constants.

## Current source artifact

| Field | Value |
| --- | --- |
| Package | `@augmentworks/cli@0.3.2` |
| `releaseStatus` | `development` |
| `capabilities.localDemo` | `true` |
| Demo invocation | `node dist/index.js demo` |
| Provenance | `sourceCommit: null` (gap until a release commit is recorded), `verifiedAt: null` |
| Last verified npm | `@augmentworks/cli@0.3.1` (`localDemo: false`) |

The immutable locally packed tarball may carry this development-status
manifest. That is QA, not npm publication. After publication, generate a
**separate** published-status manifest from the **downloaded** registry
tarball without rewriting that tarball:

```bash
npm run generate:discovery
npm run check:discovery
node scripts/verify-published-discovery.mjs --version 0.3.2
```

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

## Website adoption

Website maintainers must independently review and adopt a **pinned** published
manifest. Never fetch `latest` into the live website at runtime.

Until 0.3.2 is published and verified, keep the website snapshot on 0.3.1 with
`localDemo: false` / `commands.localDemo: null`. After that verification, the
published command vector is `npx`, `--yes`, the exact `@augmentworks/cli`
version that was inspected, and `demo`. Do not write an unpublished pin into
executable docs.

Command arrays are data for reviewed rendering and tests. The website must not
execute imported command arrays.

Regenerate and validate this contract without hosted accounts:

```bash
npm run generate:discovery
npm run check:discovery
npm test
```

## Changed resources in this source revision

- `augmentworks demo` command and `assets/demo/` runtime assets
- `docs/agent-setup.md` plus `agent-resources/` wrappers
- discovery contract files
- sample reports under `docs/examples/`
- GitHub Actions example distinct from this repo's development CI

## Next publish/release step

1. Land this source on `main`.
2. Run `npm run check && npm run audit:ci && npm run smoke:pack`.
3. Create a protected `v0.3.2` GitHub release (maintainers only).
4. Download the npm tarball and run `scripts/verify-published-discovery.mjs`.
5. Hand the published manifest to website maintainers. Do not self-adopt.
