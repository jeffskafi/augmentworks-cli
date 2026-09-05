# Coding-assistant setup

An AI coding assistant may inspect an approved repository and help generate the
configuration, a local data-only packet, and synthetic lifecycle hooks. It must
not receive secrets, connect production systems, or start any side-effecting
assessment without human approval. It is never the runtime test agent: the
version-pinned CLI executes both local and hosted assessments deterministically.

## Canonical setup prompt

Copy the following prompt into Claude Code, Codex, Cursor, Windsurf, or another
repository-aware coding assistant:

```text
Read https://augmentworks.ai/docs/agent-setup.md and integrate
AugmentWorks into this repository.

You may inspect the current repository, but do not read, print, move, or expose
secrets. Do not inspect outside the repository unless I explicitly approve it.

Use the pinned @augmentworks/cli@0.2.1 package. Run:

npx --yes @augmentworks/cli@0.2.1 init --agent

Then configure the generic YAML HTTP connector. Do not require a Python adapter
or AugmentWorks target SDK; implement only missing synthetic hooks in this
application's existing framework.

Generate augmentworks.yaml and .env.example, and add only the minimum synthetic
prepare/send/observe/cleanup hooks needed for the selected packet. Use only an
authorized, isolated synthetic target in a test or staging environment and
synthetic test data. Do not connect production systems or use production or
regulated data. Never put a secret value in YAML, source code, a command
argument, chat, or a diff.

Run:

npx --yes @augmentworks/cli@0.2.1 doctor -c augmentworks.yaml

Show me the resulting diff, and explain the telemetry allowlist and cleanup
behavior. Stop and ask before running either a customer-executed local
assessment or a hosted assessment. Local mode needs no AugmentWorks login but
still calls the configured target and may create synthetic state. Stop when
browser authentication, device authorization, secret insertion, target access,
or any paid action requires human approval.
```

## Expected assistant workflow

1. Confirm the approved repository root and an authorized, isolated synthetic
   target in a test or staging environment.
2. Inspect application routes or an OpenAPI description inside that root.
3. Identify the application endpoint—not merely its model-provider endpoint.
4. Run `npx --yes @augmentworks/cli@0.2.1 init --agent` to generate
   `augmentworks.yaml`, `.env.example`, a local `.env`, and repository guidance.
5. Use the generic YAML HTTP connector. Add narrowly scoped, authenticated
   synthetic lifecycle hooks in the application's native framework only if
   needed.
6. Make cleanup idempotent, give fixtures a server-side TTL, and account for the
   fact that a hard process or machine failure cannot guarantee cleanup.
7. Configure the smallest useful telemetry allowlist.
8. Run `doctor -c augmentworks.yaml`. It makes no network request and reports
   missing local environment-variable names without opening or printing `.env`
   values.
9. If authoring a local packet, create strict JSON using `aw-packet/0.1`; do not
   add JavaScript, modules, shell instructions, remote URLs, or secret values.
   Validate its contract with
   `npx --yes @augmentworks/cli@0.2.1 schema --kind local-packet`.
10. Show the diff, explain which target operations will run, and stop for human
    approval before `test`.

## Human-only decisions

- Insert target credentials into a local `.env` or secret manager. These are
  separate from any AugmentWorks connector credential.
- Decide whether every synthetic target side effect is acceptable and whether
  an independent fixture TTL is in place.
- Approve a local run, which contacts only the configured target and does not
  require an AugmentWorks account:

  ```bash
  npx --yes @augmentworks/cli@0.2.1 test \
    --local \
    -c augmentworks.yaml \
    --packet support-refunds-starter@0.1.0 \
    --open
  ```

  Local `--local` uses the published package and the bundled
  `support-refunds-starter@0.1.0` packet. Clone this repository only if you need
  the refund-agent example server; `examples/` is not in the npm tarball.

- Or sign in, approve the connector, and separately authorize a hosted run.
  Browser approval does not start an assessment. Keep the terminal open for
  `test`; there is no separate `connect` command and no `--rerun` flag.
  Re-running the same hosted `test` command resumes an active bound intent or
  follows the workspace's remaining baseline/remediation allowance:

  ```bash
  npx --yes @augmentworks/cli@0.2.1 login
  npx --yes @augmentworks/cli@0.2.1 test \
    -c augmentworks.yaml \
    --packet support-refunds@0.1.0 \
    --open
  ```

- Review findings before publishing or sharing evidence. A local report is
  unsigned, customer-executed, not received or independently verified by
  AugmentWorks, and not a certification, audit, or hosted evidence record.

Once setup is complete, the AI assistant leaves the evidence path. Every scored
run is executed by the same version-pinned, deterministic CLI.
