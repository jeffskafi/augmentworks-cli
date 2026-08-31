# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Reconciled the package documentation with the published v0.1 command surface,
  outbound relay, generic YAML HTTP connector, and current trust boundaries.

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

[Unreleased]: https://github.com/jeffskafi/augmentworks-cli/commits/main
[0.1.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.1.0
