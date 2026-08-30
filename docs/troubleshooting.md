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

The production connector-auth and relay endpoints are not deployed yet. In a
development build, point the client only at the repository's mock service. When
production is available, retry browser authorization or use `login --device`
for a headless machine.

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

Re-run the exact same `test` command as the same OS user on the same machine.
The CLI retains one active intent per AugmentWorks API origin, replays the same
create ID and request, and resumes the same run and command journal. A different
packet or configuration is refused with `ACTIVE_RUN_EXISTS` until an
authoritative terminal status clears the intent. Changing the resolved target
base URL or an operation method/path also changes the boundary checksum and is
refused for that active run. There is no force-new option.

Recovery proceeds only if secure lock ownership can be positively established.
The CLI refuses a live or foreign owner, unknown process liveness, an ambiguous
or reused PID, a different system boot, unsafe permissions or symlinks, or a
lock that changes during inspection. Do not delete such a lock to force a run;
investigate the owning process and preserve recovery state.

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
charges again. Once the hosted service is deployed, its response and dashboard
are authoritative; the CLI does not meter credits locally.

When reporting a bug, include CLI version, Node.js version, operating system,
safe error code, and a redacted configuration. Never attach `.env`, credential
headers, raw target responses, or a local command journal.
