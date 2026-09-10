# CLI release-state contract

This document defines the non-circular contract for packaged CLI identity
versus post-publication registry inspection. It exists because npm tarballs
are immutable: a field that can only become true after `npm publish` cannot
honestly live inside that same tarball.

## Layers

| Layer | Where | What it may claim |
| --- | --- | --- |
| Package identity | `package.json`, `src/version.ts`, `CLI_RELEASE` / `schemas/v1/cli-release.json` | This artifact's version, protocol, and whether it is a **published-line release** versus a candidate snapshot. |
| Source discovery | `contracts/discovery-manifest.json` | This git checkout. Stays `releaseStatus: development` with `node dist/index.js` commands. Not a live registry status. |
| Independently inspected tarball | `LAST_VERIFIED_*` and `docs/feature-readiness/published-registry-evidence.json` | A **prior** (or separately inspected) registry version, keyed by version, gitHead, integrity, and `verifiedAt`. |
| Website pin | Main repository discovery snapshot | Adopted only after independent review of **this** patch. This CLI does not self-adopt. Independently inspected 0.3.6 is ready for a deliberate website pin. Independently inspected 0.3.5 remains historical; it omits suite-selection `capabilities`. Do not fetch `latest`. |

## `published_package_verified` (`aw-cli-release/0.1`)

`true` means this packaged identity is a published release line, not a
candidate. It is **not** proof that this exact tarball was downloaded from npm
and inspected.

Independent inspection of `@augmentworks/cli@0.3.5` remains
`lastIndependentlyInspected` (the prior tarball packaged `LAST_VERIFIED_*`
points at). `thisPackageIdentity` for 0.3.6 is filled after the protected
`v0.3.6` publish (`gitHead` `a9b927a2413305003f817c20e9c5df277512f83e`,
integrity `sha512-idDM/kYfDCzDu+iaSqzZjEchyui9I8r1krUFdZ8BmVtZIye2D5WbHFpbYaNzuwjPvV7gCk1XixLwu1kuROXfwA==`,
published `2026-09-10T16:26:29.450Z`).

Do not overwrite or relabel existing npm versions, including 0.3.5.

## Help and documented pins

`test --help` `--assessment` copy is `HOSTED_ASSESSMENT_OPTION_HELP` from
`src/version.ts`. Documented `npx` pins must equal `CLI_VERSION`.
