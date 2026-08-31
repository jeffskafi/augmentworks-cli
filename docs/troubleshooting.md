# Troubleshooting

Start with:

```bash
npx --yes @augmentworks/cli@0.1.0 doctor \
  -c augmentworks.yaml
```

`doctor` is always offline in v0.1: it makes no target or cloud request and does
not check AugmentWorks authentication.

## Common failures

### Config or `.env` is not found

Pass the config path explicitly. `.env` must be beside that file, not
necessarily in the current directory.

```bash
npx --yes @augmentworks/cli@0.1.0 doctor \
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

### `login` cannot connect

Confirm outbound HTTPS access to `https://augmentworks.ai`, verify the system
clock, and retry browser authorization. Use `login --device` for an SSH or
headless machine, or `--no-open` to print the browser URL. Do not set
`AUGMENTWORKS_API_URL` to another hosted origin; v0.1 accepts the production
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
does not invent the next operation: the relay should dispatch the appropriate
typed follow-up when configured capabilities permit it, such as `observe` or
`cleanup` when a fixture may exist. Check the target using its synthetic attempt
or fixture identifier.

### Cleanup failed

The assessment reports cleanup separately from requirement scoring. There is no
standalone cleanup-recovery command in v0.1; confirm whether the relay dispatched
cleanup, preserve the synthetic identifier for investigation, and rely on a
target-side fixture TTL as the final safeguard. Never silently treat a cleanup
failure as success.

### `test` was interrupted

Re-run the exact same `test` command as the same OS user, authenticated connector,
and workspace on the same machine. The CLI retains one tenant-bound active intent
per AugmentWorks API origin, replays the same create ID and request, and resumes
the same run and command journal. A different connector or workspace is refused
with `ACTIVE_RUN_TENANT_MISMATCH` before create. A different packet or
configuration is refused with `ACTIVE_RUN_EXISTS` until an authoritative terminal
status clears the intent. Changing the resolved target base URL or an operation
method/path also changes the boundary checksum and is refused for that active run.
There is no force-new option.

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

When reporting a bug, include CLI version, Node.js version, operating system,
safe error code, and a redacted configuration. Never attach `.env`, credential
headers, raw target responses, or a local command journal.
