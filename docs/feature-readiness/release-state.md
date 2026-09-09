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
| Website pin | Main repository discovery snapshot | Adopted only after independent review. This CLI does not self-adopt. Independently inspected 0.3.5 is ready for a deliberate website pin. Do not fetch `latest`. |

## `published_package_verified` (`aw-cli-release/0.1`)

`true` means this packaged identity is a published release line, not a
candidate. It is **not** proof that this exact tarball was downloaded from npm
and inspected.

Independent inspection of `@augmentworks/cli@0.3.4` remains
`lastIndependentlyInspected` (the prior tarball packaged `LAST_VERIFIED_*`
points at). `thisPackageIdentity` for 0.3.5 is filled after the protected
`v0.3.5` publish (`gitHead` `11570f6cf883ec6e6743e010c35134bb485234dd`,
integrity `sha512-WyS9d2lSPhX26ONyxISbN9ncsDoR3JBQjkr6DLaJPl6IrksBg8zxpxawABb4iLZ4ugqlu7TA9J623nqua9dlwQ==`,
published `2026-09-09T02:56:49.964Z`).

Do not overwrite or relabel existing npm versions.

## Help and documented pins

`test --help` `--assessment` copy is `HOSTED_ASSESSMENT_OPTION_HELP` from
`src/version.ts`. Documented `npx` pins must equal `CLI_VERSION`.
