# Troubleshooting

Start with:

```bash
npx --yes @augmentworks/cli@0.2.0 doctor \
  -c augmentworks.yaml
```

`doctor` makes no target or cloud request and does
not check AugmentWorks authentication. Example successful output (illustrative):

```text
OK OFFLINE_CHECK_COMPLETE: No target hooks or cloud operations were invoked.
Doctor passed.
```

## Common failures

### Config or `.env` is not found

Pass the config path explicitly. `.env` must be beside that file, not
necessarily in the current directory.

```bash
npx --yes @augmentworks/cli@0.2.0 doctor \
  -c ./config/augmentworks.yaml
```

### An environment variable is missing

Copy `.env.example` to `.env`, insert the value locally, and keep `.env` out of
source control. Do not replace an `_env` field in YAML with the secret itself.

### Plain HTTP is refused

Use HTTPS whenever possible. Loopback hosts and literal private IP targets may
use HTTP without an extra setting. A public HTTP target is refused unless the
configuration explicitly accepts the risk:

```yaml
allow_insecure_http: true
```

The CLI emits a warning even with this setting. Do not use it to normalize
sending credentials over an untrusted network.

### A response mapping is missing

Confirm that the target returns JSON and that selectors use the supported
`$.field.nested` subset. `doctor` does not execute lifecycle hooks, so use the
mock example or a separately approved synthetic run to inspect application
behavior.

### A local packet is not found or is refused

`test --local` accepts exactly one of:

- the bundled `support-refunds-starter@0.1.0` reference
- a local JSON file
- a local directory containing `packet.json`

It does not download packet references or accept URLs, YAML, JavaScript,
modules, symlinks, or executable instructions. Validate the expected data shape
with:

```bash
npx --yes @augmentworks/cli@0.2.0 schema --kind local-packet
```

An `aw-packet/0.1` packet must declare `synthetic_only: true`, remain within the
fixed attempt and operation limits, and use only capabilities and observation
keys available in `augmentworks.yaml`.

### `LOCAL_PACKET_INCOMPATIBLE`

The packet requires a lifecycle capability that the target configuration does
not provide. Add only the required synthetic `prepare`, `observe`, or `cleanup`
mapping, enable structured tool events if required, and add every requested
observation alias to `telemetry.allow_observations`. Run `doctor` again before
starting the assessment.

### `LOCAL_OUTPUT_EXISTS`

Local artifacts are never merged into or written over an existing directory.
Omit `--output-dir` to use a new `.augmentworks/runs/<run_id>` leaf, or select a
different path. `--output-dir` identifies the exact fresh leaf, not a parent in
which the CLI chooses another subdirectory.

### Does local mode require login or internet access?

No AugmentWorks login or control-plane access is used by `test --local`. The
configured target may still be an HTTP network service and may call a model or
other dependency. Local mode is independent of the AugmentWorks website; it is
not necessarily air-gapped.

### `login` cannot connect

Confirm outbound HTTPS access to `https://augmentworks.ai`, verify the system
clock, and retry browser authorization. Use `login --device` for an SSH or
headless machine, or `--no-open` to print the browser URL. Do not set
`AUGMENTWORKS_API_URL` to another hosted origin; hosted authentication accepts the production
origin or an explicit loopback development origin only.

### `CREDENTIAL_STORE_UNAVAILABLE`

On macOS, confirm that `/usr/bin/security` is present and the login Keychain is
available. On Windows, confirm that the built-in
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` is present and
that the current user owns the AugmentWorks directory under `%LOCALAPPDATA%`.
The Windows store refuses reparse points, foreign ownership, and broad or
inherited credential-file ACLs; move an old untrusted path aside and retry only
after investigating it. The CLI will not downgrade Windows credentials to a
plaintext file. On Linux or macOS without native storage, an explicit
`--allow-file-credentials` enables the warned mode-`0600` POSIX fallback.

### Login works, but the target returns 401 or 403

The AugmentWorks connector credential authenticates CLI-to-cloud requests only.
Check the target credential named by `bearer_env` or `headers_env` in the local
process environment or the `.env` file beside the selected YAML. Do not copy an
AugmentWorks access token into a target credential field.

### A target operation timed out

If the request may have reached the target and the operation is not declared
idempotent, the CLI records an indeterminate outcome rather than retrying. It
does not blindly repeat it. In hosted mode the relay may dispatch an appropriate
typed follow-up. In local mode the fixed lifecycle attempts observation after an
ambiguous send and cleanup whenever a fixture may exist. Check the target using
its synthetic attempt or fixture identifier.

### Cleanup failed

The assessment reports cleanup separately from requirement scoring. There is no
standalone hosted cleanup-recovery command; confirm whether the relay dispatched
cleanup, preserve the synthetic identifier for investigation, and rely on a
target-side fixture TTL as the final safeguard. Never silently treat a cleanup
failure as success.

In local mode cleanup failure has exit code `6`, takes precedence over assertion
status, and stops new attempts. A hard process or machine failure can prevent
the `finally` path from running, so a server-side fixture TTL is required even
when cleanup is idempotent.

### Local `test --local` was interrupted

The first Ctrl+C aborts the active non-cleanup operation, stops new attempts,
and drains cleanup before exiting with `130`. A second Ctrl+C exits immediately
and can leave a fixture behind. Local mode has no cloud run or restart journal;
inspect the target using the synthetic identifier and rely on its fixture TTL
if cleanup was not confirmed.

### Hosted `test` was interrupted

Re-run the exact same `test` command as the same OS user, authenticated connector,
and workspace on the same machine. The CLI retains one tenant-bound active intent
per AugmentWorks API origin, replays the same create ID and request, and resumes
the same run and command journal. A different connector or workspace is refused
with `ACTIVE_RUN_TENANT_MISMATCH` before create. A different packet or
configuration is refused with `ACTIVE_RUN_EXISTS` until the existing assessment
is recovered. Changing the resolved target base URL or an operation
method/path also changes the boundary checksum and is refused for that active run.
There is no `--rerun` flag and no force-new option.

Inspect the existing assessment without creating another run:

```text
augmentworks recover
augmentworks recover --json
```

`--retire` retires a create only after the server proves it never became a run,
or retires local execution state after target execution is terminal and cleanup
is reconciled. It never cancels an active run. `--resume` continues the recorded
assessment after verifying the original configuration. `--cancel` requests
cancellation and drains cleanup. Those three flags are mutually exclusive. Do
not delete journal files, and there is no `--force-delete`.

If the hosted service does not yet support reconciliation, `recover` keeps local
state and reports that limitation. Re-running the same `test` command remains
the resume path while the create-replay window is open.

Recovery proceeds only if secure lock ownership can be positively established.
A same-host lock is reclaimable when its process is positively dead, including
on macOS or Windows where Linux boot/process metadata is unavailable. A
verifiable earlier boot or different process-start identity can also prove PID
reuse. The CLI refuses a verified live or foreign-host owner, unknown process
liveness/identity, unsafe permissions or symlinks, or a lock that changes during
inspection. Do not delete such a lock to force a run; investigate the owning
process and preserve recovery state.

Do not delete the active intent or journal to work around an ambiguous target
operation or incomplete cleanup. If local recovery state was lost or corrupted,
stop and reconcile the run and synthetic fixture through the dashboard or
support before attempting another assessment.

### A hosted run cannot start

Check authentication, egress to the AugmentWorks API, packet availability, and
workspace credit. Local configuration errors fail before the CLI requests a
run, and the hosted service preflights the packet, capabilities, and observation
aliases before credit reservation. An accepted create reports `reserved`; the
first real command lease changes it to `consumed`; cancellation or expiry before
that lease changes it to `released`. Replaying the same create request never
charges again. The hosted response and dashboard are authoritative for run and
credit status; the CLI does not meter credits locally.

### Understanding a local result

Local mode always attempts to write `report.json`, `junit.xml`, and
`report.html` to a fresh private directory. `--open` opens only the static HTML
file; it does not open or create an AugmentWorks dashboard run.

The result is intentionally labeled: “Local, customer-executed result.
AugmentWorks did not receive or independently verify this run. This artifact is
unsigned and is not a certification, audit, or hosted evidence record.” The
JSON checksum detects change; it is not a signature.

Local exit codes are `0` for pass, `1` for an internal/report failure, `2` for
configuration/packet/output preflight, `5` for target or evidence execution
error, `6` for cleanup failure, `10` for failed or inconclusive assertions, and
`130` for interruption after cleanup draining. Hosted-only auth and relay codes
`3` and `4` are unreachable from `--local`.

When reporting a bug, include CLI version, Node.js version, operating system,
safe error code, and a redacted configuration. Never attach `.env`, credential
headers, raw target responses, or a local command journal.
