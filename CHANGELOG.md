# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.2.1]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.1.0
