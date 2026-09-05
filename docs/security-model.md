# Security model

This document defines the v0.2 security boundary. Hosted and local execution
share the same deterministic connector but have different trust claims. In
hosted mode the cloud selects a bounded semantic operation and the user's
configuration alone selects how it reaches the application. In local mode a
strict customer-supplied JSON packet selects the bounded operation sequence and
no AugmentWorks service is contacted.

## Assets

- Revocable AugmentWorks connector credentials
- Customer application credentials in the local environment
- Synthetic fixture identifiers and state
- Scenario messages, tool events, observations, and scored evidence
- Hosted private packet branches, assertions, and scorer implementation
- Customer-visible local packets and unsigned local reports
- Hosted active-run intent, command journal, and local configuration

## Trust boundaries

| Component | Trust assumption | May control |
| --- | --- | --- |
| Hosted control plane and relay | Delivers authenticated, versioned operation envelopes | Packet selection, typed input, order, deadline, cancellation |
| Local CLI | Customer-operated trusted computing boundary | Config resolution, credentials, URLs, mappings, target calls, allowlisting |
| Customer target | Potentially buggy or adversarial | Its responses and observed state |
| Hosted scorer | Trusted for packet logic and scoring | Assertions, findings, dashboard result |
| Local packet and scorer | Customer-controlled execution boundary | Visible scenarios, deterministic assertions, unsigned reports |

The hosted relay must never choose a URL, HTTP method, header, environment
variable, file, module, or shell command. Unknown fields and operation kinds are
refused.

## Hosted transport and command safety

- During assessment execution, the CLI initiates all cloud communication over
  outbound HTTPS. No inbound access to the target, public target URL, or tunnel
  is required. The default browser login separately uses a temporary
  `127.0.0.1` callback listener; `login --device` avoids that callback.
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

## Customer-executed local mode

`test --local` branches before AugmentWorks API-origin resolution,
authentication, cloud client creation, active-run intent state, relay polling,
command journals, and dashboard handling. It requires no AugmentWorks account
and contacts no AugmentWorks control-plane endpoint. The configured target may
still be remote and may itself call models or other network dependencies, so
“local” is not a promise of an air-gapped assessment.

Local packets are strict bounded JSON with `schema_version: "aw-packet/0.1"`.
The CLI accepts the bundled `support-refunds-starter@0.1.0`, a local JSON file,
or a local directory containing `packet.json`. It refuses packet URLs,
downloads, symbolic-link traversal, executable code, modules, shell
instructions, unknown fields, excessive nesting, and packets whose attempt or
operation counts exceed fixed limits.

Attempts execute serially. Cleanup runs in a `finally` path whenever a fixture
may exist, and a cleanup failure stops subsequent attempts. The first Ctrl+C
requests cancellation, aborts non-cleanup work, and drains cleanup; a second
interrupt exits immediately. A process crash, machine failure, `SIGKILL`, or
second interrupt can prevent cleanup. Lifecycle hooks must therefore be scoped
to isolated synthetic data, cleanup must be idempotent, and fixtures need a
server-side TTL independent of the CLI. The CLI stops new target work at a
30-minute local run deadline while still allowing bounded cleanup to drain.

Local mode writes `report.json`, `junit.xml`, and a script-free static
`report.html` to a fresh exact output directory. It refuses to merge into or
overwrite an existing leaf. POSIX output directories use mode `0700` and files
use mode `0600`. Artifact generation re-applies secret redaction and strips
target-boundary fields, but reports still contain prompts, mapped evidence, and
observations and must be treated as sensitive.

Every local artifact carries this trust label:

> Local, customer-executed result. AugmentWorks did not receive or independently verify this run. This artifact is unsigned and is not a certification, audit, or hosted evidence record.

The `AW-LOCAL-RESULT-1` JSON checksum detects a changed result when compared
with the original; it is unkeyed, is not a signature, and does not establish
provenance. Importing the JUnit file into another system cannot upgrade that
trust claim.

## Target request controls

- `base_url`, fixed operation paths, methods, and credential sources come only
  from the local YAML.
- Hosted run creation sends an unkeyed checksum of the resolved connector/base-URL and
  operation method/path boundary. The raw URL and paths remain local, and
  credentials, environment-variable names, selectors, bodies, limits,
  telemetry, and target state are excluded. The checksum binds restart drift;
  it is not target identity, ownership, code, state, or execution proof.
- The v1 connector uses a data-only mapping language. There is no JavaScript,
  eval, shell, plugin/module loading, or full JSONPath engine.
- All target redirects are refused. Response size, request size, nesting, event
  count, and operation duration are bounded.
- Plain HTTP is accepted automatically only for loopback and literal private IP
  targets. A public plain-HTTP target requires explicit `allow_insecure_http`
  and emits a warning; HTTPS remains strongly recommended.
- Target errors are converted to stable safe codes. Response bodies and headers
  are not copied into diagnostics without redaction and bounds.

The connector deliberately permits localhost and private addresses because
that is the product capability. This means the configuration author is a
trusted local principal. Neither a cloud command nor a local packet can alter
the configured endpoint.

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
- `AUGMENTWORKS_TOKEN` is reserved for future project tokens and development
  integration harnesses; the v0.1 interactive auth service does not issue a
  long-lived CI credential.
- Customer target credentials are named, not embedded, in YAML and are resolved
  from the local environment.
- Tokens are never accepted as command-line flags, included in config digests,
  written to the command journal, or intentionally returned as evidence.
- Redaction covers exact configured secret values and common credential header
  names. It is defense in depth, not permission to send arbitrary logs.

## Data minimization

In hosted mode, only mapped content, allowed structured tool events, and
explicitly allowlisted observation fields can leave the local connector. Run
preflight also sends the
target display name, secret-free configuration and boundary checksums, declared
capabilities, and sorted public observation-key aliases. It does not send raw
target URLs or paths, local selectors, environment-variable names or values,
complete HTTP headers, arbitrary target responses, filesystem contents, or
application logs.

In local mode no evidence leaves for AugmentWorks. The same mappings and
allowlists bound what the deterministic scorer can consume and what local
reports can contain. The configured target remains a separate network boundary.

The following table describes hosted mode:

| Stays in the customer environment | Exchanged with AugmentWorks |
| --- | --- |
| Raw target URL and operation paths, mapping selectors, environment-variable names and values, target credentials, application code and logs, full fixture state, and unmapped responses | Packet inputs, target display name, secret-free checksums, declared capabilities, observation-key aliases, mapped assistant content, opted-in tool events, allowlisted observations, safe errors, and lifecycle status/timing |

A checksum can detect configuration drift or a conflicting replay. It does not
identify the target, reveal its raw boundary, or establish that returned
evidence is true.

Executed scenario prompts and fixture inputs necessarily reach the local CLI
and target. Therefore the complete assessment packet cannot be considered
secret from a connector that executes it. The hosted service can retain
undispatched branches, assertions, scorer logic, and comparative data; a local
packet and all of its assertions are necessarily visible to the customer.

Use only an authorized, isolated synthetic target and synthetic test data. Do
not connect production systems or use production or regulated data. Logs and
evidence should be treated as sensitive even after allowlisting.

## Evidence integrity and truth

The CLI uses unkeyed SHA-256 digests as replay checksums. Comparing them with an
already-durable local or relay record detects a conflicting command or result;
it does not prove evidence provenance or make the evidence independently
tamper-evident. HTTPS authenticates the transport endpoint, not a later evidence
artifact. The hosted relay associates accepted results with the authenticated connector,
session, run, packet, configuration boundary, and command order. That
server-side association records what the connector reported; it is not a target
signature and does not independently verify the underlying observation.

Even a separately authenticated evidence record would **not** turn
customer-operated code into an independent observer. A target or observation
hook can be buggy or dishonest. Such a record could bind what that connector
reported, but could not prove that it matches production or an external system
of record. Missing or failed configured state observation produces `unknown`, never an
inferred success from chatbot text.

A local result has a separate `AW-LOCAL-RESULT-1` schema and explicit
customer-executed provenance fields. It is never a hosted evidence record and
must not be relabeled as one. Local scoring can be reproducible without being
independent: the customer controls the packet, target, observer, process, and
result files.

## Operational safeguards

- v0.2 supports authorized, isolated synthetic targets in test or staging
  environments and synthetic test data only.
- `doctor` performs no lifecycle operation and consumes no assessment credit.
- Hosted `test` is the explicit action that starts a hosted assessment and
  keeps the connector online for that run. The dashboard can observe or request
  cancellation, but cannot start an assessment. There is no v0.2 `connect`
  command, and the dashboard cannot send arbitrary work, URLs, or shell
  instructions.
- `test --local` is a separate explicit action. It creates no cloud run, uses no
  interactive connector credential or credit, and produces only customer-held
  artifacts.
- Cleanup should be idempotent, and target fixtures should have a server-side
  TTL as a final orphan safeguard.
- Hosted active intents and command journals are bounded regular files with mode
  `0600` where POSIX permissions apply. They contain secret-free run bindings
  and normalized, redacted operation evidence rather than connector
  credentials.
- After an authoritative terminal **target execution** status, the CLI removes the active intent and
  purges the journal only when every command is acknowledged and no prepared
  fixture remains. Pending grading is not an active target slot. Interruption, an unavailable terminal status, unacknowledged
  evidence, or incomplete cleanup intentionally retains recovery state. There
  is no time-based retention job; protect these files and do not remove them
  until the run and any synthetic fixture are resolved. Use `recover` rather
  than deleting the journal.
- Recovery is same-machine and state-directory scoped. Losing that state can
  make a prior create or target side effect impossible to distinguish safely;
  the hosted runner will not invent a new run to bypass the ambiguity.
- Recovery also requires positive lock ownership. On the same host, the CLI
  reclaims a lock after its recorded process is positively dead even when Linux
  boot/process metadata is unavailable. A verifiable prior boot or different
  process-start identity also proves that a reused live PID is not the owner.
  The current process's own live PID remains a verified owner when the platform
  cannot provide process-start metadata; it is never guessed stale or treated
  as ambiguous merely because `/proc` is unavailable.
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
