# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Source `0.3.3` Stage 5B subscription usage display: recurring vs
  purchased vs trial lots, cancel-at-period-end, processing and failed
  renewal, expired monthly grants, and pack-only servers without
  `subscriptions_v1`. Vendors `aw-billing/1` from main
  `650472d91442a6866a7b6ef18e6dacc23a2a9260`. The CLI remains a read-only
  billing client. Live $149 sales stay gated. Not npm-published.
- Source `0.3.3` Stage 4B packaged empty-directory starters
  (`response-quality` default and `workflow`), offline doctor wire-bound
  checks, packed-tarball billing HTTP fixture (target execution, token
  refresh, dropped-create replay, pending grading wait), and prepaid-journey
  recovery docs. Initially vendored 4A `49806f0`; Stage 5B re-imported 5A
  `650472d`. Not npm-published. Live sales remain disabled.
- CI/environment token refresh via `AUGMENTWORKS_REFRESH_TOKEN` without
  writing the OS credential store. Token-only `AUGMENTWORKS_TOKEN` remains
  static.
- Packaged `augmentworks demo` command: isolated loopback refund target, real
  local runner/scorer, fail-then-pass policy story, `AW-DEMO-SUMMARY-1` JSON.
- `contracts/discovery-manifest.json` generated from the existing release
  machinery (`schemaVersion: 1`, source `development` until npm verification).
- Opt-in `agent-resources/` wrappers generated from one canonical guidance
  file. `init --agent` behavior is unchanged.
- Copyable GitHub Actions example and synthetic sample reports under
  `docs/examples/`.
- Authenticated `augmentworks usage` / `usage --json` for Stage 1B billing
  snapshots. Exit `13` is the billing category. Does not publish npm or enable
  live sales.
- Source Stage 2B hosted `test --estimate`, `--max-credits`, quoted
  `aw-relay/0.3` create, and `run status` / `run wait` /
  `run retry-evaluation`. Quotes do not reserve credits.
- Source Stage 3B `augmentworks billing` / `billing --json` /
  `billing --print` for first-party billing-page navigation. The CLI does not
  create Checkout Sessions or Stripe customers.
- Offline `preview-mapping` inspects response mappings and the exact
  canonical sanitized evidence payload from a local synthetic JSON fixture.
  It uses the production extraction, allowlist, redaction, and
  `canonicalize` pipeline. No target, cloud, or model call. Not in published
  `0.3.2`.

### Fixed

- Packed-tarball smoke invokes npm/npx as `node *-cli.js` so Windows Node 22
  does not fail with `spawnSync npm.cmd EINVAL`.
- Packed billing HTTP fixture uses async `spawn` so the in-process loopback
  server can accept CLI requests (`spawnSync` deadlocked the event loop).
- Packed CLI tests rebuild `dist/index.js` when TypeScript sources are newer,
  so `npm test` before `npm run build` still exercises current `run wait`
  classification.
- Hosted `test --json` writes one structured error object on stdout for
  billing/admission rejection, matching estimate/usage/billing.
- `run wait` / `run status` no longer treat a successful status query of
  unfinished work as a passing assessment. Wait continues while target
  execution is nonterminal even when evaluation is `absent`. Exit `0` requires
  an explicit resolved `passed` outcome. JSON `ok: true` remains observation
  success; `assessment` and `exit_code` are the release gate.
- `preview-mapping` JSON parse failures report a numeric position only and
  never echo fixture text.

### Changed

- Source package version is `0.3.3`. Verified npm remains `0.3.2`
  (`gitHead` `d36ec8590b005445dba940d2df3abcb53971cea5`). Hosted npx examples
  pin `@augmentworks/cli@0.3.2`. Do not document unpublished npx pins.
  `npm --yes` is not a spending ceiling; hosted consent is `--max-credits N`.

## [0.3.1] - 2026-09-05

### Fixed

- Hosted hybrid `--assessment` now sends `aw-judge-disclosure/2`, matching the
  OpenAI judging disclosure recorded in the portal.
- `test --help` describes `--assessment` as published in this package.

### Changed

- Source and published package version is `0.3.1`. Hosted and local npx
  examples pin `@augmentworks/cli@0.3.1`.

## [0.3.0] - 2026-09-05

### Added

- Source-only hosted `--assessment` / `--profile` compiler for
  `augmentworks.assessment.yaml` (`aw-assessment-file/1`), including local
  reference file freeze hashes and `doctor --assessment` validation without
  target or credit use.
- Relay protocol `aw-relay/0.2` create-run assessment metadata, optional
  `multi_turn` capability, command sequences up to 512, and optional hosted
  `evaluation_status` (`pending` / `complete` / `partial` / `error`).
- Distinguishable hosted grading exit codes `11` (incomplete) and `12`
  (evaluation error). Behavioral failures remain `10`.
- Local-mode rejection of `aw-packet/0.2`, `evaluation_mode: hybrid`, and
  `llm_rubric` packets before any target call.
- Hosted `test` uses the 0.2.1 recover/reconcile path, so interrupted creates
  can be rebound or retired instead of treating a corrected command as a
  second active run.

### Changed

- Source and published package version is `0.3.0`. Hosted and local npx
  examples pin `@augmentworks/cli@0.3.0`, including `--assessment`.

## [0.2.1] - 2026-09-05

### Added

- `recover` inspects a hosted assessment without creating a new run. `--retire`,
  `--resume`, and `--cancel` are mutually exclusive; default recovery is
  inspection only.
- Client support for `POST /v1/relay/run-intents:reconcile`
  (`aw-run-intent-reconcile/0.1`) so a definitive rejected create can be
  retired and an interrupted run can be rebound after the create-replay window.

### Changed

- Hosted `test` reconciles an existing intent before treating a corrected
  command as `ACTIVE_RUN_EXISTS`. Generic create HTTP errors no longer clear
  pending state.
- Terminal local execution retirement now checks the relay journal for
  outstanding cleanup, and pending grading no longer keeps the local execution
  intent active.
- Browser login callback responses send `cache-control: no-store` and
  `referrer-policy: no-referrer`.
- Hosted and local `npx` examples pin `@augmentworks/cli@0.2.1`.

### Fixed

- Credential refresh no longer fails with `CREDENTIAL_REFRESH_LOCK_CHANGED` when
  the lock directory disappears during reclaim (Windows waiter `EEXIST` then
  holder `release()` race). Acquire retries `mkdir` instead of treating
  disappearance as a fatal identity change.

## [0.2.0] - 2026-09-04

### Added

- Customer-executed `test --local` mode that branches before authentication and
  cloud setup, loads strict data-only JSON packets, executes the synthetic
  lifecycle directly, and scores results without contacting AugmentWorks.
- Bundled Apache-2.0 `support-refunds-starter@0.1.0` packet plus local packet and
  local result JSON Schemas.
- Private JSON, JUnit, and static HTML local reports with explicit unsigned,
  unverified provenance; fresh-output enforcement; change-detection checksum;
  redaction; and cleanup-aware exit codes.
- `schema --kind config|local-packet|local-result` and local report
  `--output-dir`/`--open` support.

### Changed

- Pinned v0.2 setup examples and documented the separate hosted and local
  security, evidence, authentication, packet, cleanup, and networking
  boundaries.
- Hosted and local `npx` examples pin `@augmentworks/cli@0.2.0`. The refund-agent
  example remains git-checkout-only because the npm tarball omits `examples/`.
- Login, init, and hosted `test` print the next first-user action without a
  `connect` or `--rerun` command.

## [0.1.0] - 2026-08-31

### Added

- Initial deterministic HTTP connector and v1 YAML configuration.
- Browser PKCE and headless device authorization client contracts.
- `init`, `doctor`, `test`, `login`, `logout`, `whoami`, and `schema` command
  surface.
- Outbound `aw-relay/0.1` long-poll client with typed lifecycle operations,
  fencing, expiry, deduplication, bounded evidence, and cleanup semantics.
- Durable idempotent run creation, same-machine restart recovery, target-boundary
  drift binding, explicit credit states, and sorted observation-alias preflight.
- Refund-agent mock target, public documentation, schema, tests, packed-package
  smoke test, CI, and npm trusted-publishing workflow.

[0.3.1]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.0
[0.2.1]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.1.0
