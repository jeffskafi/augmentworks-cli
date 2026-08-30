# Security model

This document defines the v0.1 security boundary. The central rule is simple:
the cloud selects a bounded semantic operation; the user's configuration alone
selects how that operation reaches the local application.

## Assets

- AugmentWorks connector and optional static automation credentials
- Customer application credentials in the local environment
- Synthetic fixture identifiers and state
- Scenario messages, tool events, observations, and scored evidence
- Private packet branches, assertions, and scorer implementation
- Local active-run intent, command journal, and configuration

## Trust boundaries

| Component | Trust assumption | May control |
| --- | --- | --- |
| Hosted control plane and relay | Delivers authenticated, versioned operation envelopes | Packet selection, typed input, order, deadline, cancellation |
| Local CLI | Customer-operated trusted computing boundary | Config resolution, credentials, URLs, mappings, target calls, allowlisting |
| Customer target | Potentially buggy or adversarial | Its responses and observed state |
| Hosted scorer | Trusted for packet logic and scoring | Assertions, findings, dashboard result |

The hosted relay must never choose a URL, HTTP method, header, environment
variable, file, module, or shell command. Unknown fields and operation kinds are
refused.

## Transport and command safety

- All cloud communication is outbound HTTPS. No inbound listener, public target
  URL, or tunnel is required.
- The only runtime capabilities are `prepare`, `send`, `observe`, and `cleanup`.
- Envelopes are authenticated and include protocol version, command ID,
  sequence, lease/fencing epoch, issue/expiry time, and idempotency key.
- At-least-once delivery is handled by an owner-only local journal. A duplicate
  command with a durable terminal result returns that result; a conflicting
  replay fails. An unfinished operation executes again only when explicitly
  declared idempotent.
- Run creation has a durable idempotency key. Before the create POST, the CLI
  resolves `/api/v1/cli/auth/me` and writes one active intent per API origin,
  bound to that workspace and connector. It replays the exact request after a
  restart and refuses a different tenant or active request before create. There
  is no force-new bypass.
- Commands received after their expiry or under an old fencing epoch are not
  executed.
- Cancellation fences new work but permits cleanup for a fixture that may have
  been created.
- An ambiguous outcome for any operation that is not explicitly idempotent is
  marked indeterminate rather than blindly retried. Observation or cleanup runs
  only if the relay dispatches those typed follow-ups.

## Target request controls

- `base_url`, fixed operation paths, methods, and credential sources come only
  from the local YAML.
- Run creation sends an unkeyed checksum of the resolved connector/base-URL and
  operation method/path boundary. The raw URL and paths remain local, and
  credentials, environment-variable names, selectors, bodies, limits,
  telemetry, and target state are excluded. The checksum binds restart drift;
  it is not target identity, ownership, code, state, or execution proof.
- v0.1 uses a data-only mapping language. There is no JavaScript, eval, shell,
  plugin/module loading, or full JSONPath engine.
- All target redirects are refused. Response size, request size, nesting, event
  count, and operation duration are bounded.
- Plain HTTP is accepted automatically only for loopback and literal private IP
  targets. A public plain-HTTP target requires explicit `allow_insecure_http`
  and emits a warning; HTTPS remains strongly recommended.
- Target errors are converted to stable safe codes. Response bodies and headers
  are not copied into diagnostics without redaction and bounds.

The connector deliberately permits localhost and private addresses because
that is the product capability. This means the configuration author is a
trusted local principal. A cloud command cannot alter the configured endpoint.

## Credentials

- AugmentWorks interactive credentials use the macOS login Keychain, Windows
  CurrentUser DPAPI, or Linux Secret Service when supported. macOS and Windows
  save secrets to native helpers through stdin rather than command-line
  arguments. The
  Windows DPAPI file has an origin-bound entropy value and a protected
  current-user/Local-System ACL; foreign ownership, reparse points, inherited
  or broad ACLs, and invalid ciphertext fail closed.
- A POSIX file fallback requires explicit `--allow-file-credentials`, emits a
  warning, refuses symlinks, and enforces mode `0600`. Plaintext fallback is
  disabled on Windows because POSIX modes do not establish Windows ACL safety.
- `AUGMENTWORKS_TOKEN` is reserved for future project tokens and local
  integration harnesses; the v0.1 interactive auth service does not issue a
  long-lived CI credential.
- Customer target credentials are named, not embedded, in YAML and are resolved
  from the local environment.
- Tokens are never accepted as command-line flags, included in config digests,
  written to the command journal, or intentionally returned as evidence.
- Redaction covers exact configured secret values and common credential header
  names. It is defense in depth, not permission to send arbitrary logs.

## Data minimization

Only mapped content, allowed structured tool events, and explicitly allowlisted
observation fields can leave the local connector. Run preflight also sends the
sorted public observation-key aliases, but not their values, local selectors,
environment-variable names, target URL or paths. It sends a boundary checksum,
not the raw boundary fields. The CLI does not upload raw environment variables,
complete HTTP headers, arbitrary target responses, filesystem contents, or
application logs.

Executed scenario prompts and fixture inputs necessarily reach the local CLI
and target. Therefore the complete assessment packet cannot be considered
secret from a connector that executes it. The hosted service can retain
undispatched branches, assertions, scorer logic, and comparative data.

Use synthetic, non-personal test data. Logs and evidence should be treated as
sensitive even after allowlisting.

## Evidence integrity and truth

The CLI uses unkeyed SHA-256 digests as replay checksums. Comparing them with an
already-durable local or relay record detects a conflicting command or result;
it does not prove evidence provenance or make the evidence independently
tamper-evident. HTTPS authenticates the transport endpoint, not a later evidence
artifact. The production hosted relay/evidence source implements authenticated,
server-side bindings across the packet, scorer, orchestrator, CLI connector,
configuration boundary, target declaration, and ordered results. It remains
release-gated until its migration and Vercel deployment are smoke-tested.

Even a separately authenticated evidence record would **not** turn
customer-operated code into an independent observer. A target or observation
hook can be buggy or dishonest. Such a record could bind what that connector
reported, but could not prove that it matches production or an external system
of record. Missing or failed authoritative observation produces `unknown`,
never an inferred success from chatbot text.

## Operational safeguards

- v0.1 supports synthetic fixtures in test or staging environments only.
- `doctor` performs no lifecycle operation and consumes no assessment credit.
- `test` is an explicit local action. While `connect` is online, a workspace
  owner may authorize the fixed support/refunds assessment from the dashboard;
  the dashboard cannot send arbitrary work, URLs, or shell instructions.
- Cleanup should be idempotent, and target fixtures should have a server-side
  TTL as a final orphan safeguard.
- Active intents and command journals are bounded regular files with mode
  `0600` where POSIX permissions apply. They contain secret-free run bindings
  and normalized, redacted operation evidence rather than connector
  credentials.
- After an authoritative terminal status, the CLI removes the active intent and
  purges the journal only when every command is acknowledged and no prepared
  fixture remains. Interruption, an unavailable terminal status, unacknowledged
  evidence, or incomplete cleanup intentionally retains recovery state. There
  is no time-based retention job; protect these files and do not remove them
  until the run and any synthetic fixture are resolved.
- Recovery is same-machine and state-directory scoped. Losing that state can
  make a prior create or target side effect impossible to distinguish safely;
  v0.1 will not invent a new run to bypass the ambiguity.
- Recovery also requires positive lock ownership. On the same host, the CLI
  reclaims a lock after its recorded process is positively dead even when Linux
  boot/process metadata is unavailable. A verifiable prior boot or different
  process-start identity also proves that a reused live PID is not the owner.
  The CLI then rechecks the unchanged directory, owner-file identity, and nonce.
  A verified live owner, unknown liveness/identity, foreign host, symlink,
  permission-unsafe path, or changed lock is refused rather than guessed stale.

## Known limitations

- A compromised local machine can read local configuration, credentials, and
  test inputs.
- A malicious configuration author can intentionally target an internal
  service available to that machine.
- Telemetry mapping cannot make an untrustworthy target truthful.
- Redaction cannot reliably sanitize an arbitrary unbounded log stream, which
  is why arbitrary logs are not accepted.
- Availability of a private target depends on the customer network and process.

Report vulnerabilities using [SECURITY.md](../SECURITY.md).
