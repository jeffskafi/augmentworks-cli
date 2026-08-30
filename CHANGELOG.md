# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Deployment dependency

- The production connector-auth and relay services are not deployed. Hosted
  login and test commands remain unavailable until that service ships.

[Unreleased]: https://github.com/jeffskafi/augmentworks-cli/commits/main
