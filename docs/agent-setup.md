# Coding-assistant setup

An AI coding assistant may inspect an approved repository and help generate the
configuration and synthetic lifecycle hooks. It must not act as the runtime
test agent, receive secrets, complete human authentication, or start an
assessment without approval.

## Canonical setup prompt

Copy the following prompt into Claude Code, Codex, Cursor, Windsurf, or another
repository-aware coding assistant:

```text
Read https://augmentworks.ai/docs/agent-setup.md and integrate
AugmentWorks into this repository.

You may inspect the current repository, but do not read, print, move, or expose
secrets. Do not inspect outside the repository unless I explicitly approve it.

Use the pinned @augmentworks/cli@0.1.0 package. Run:

npx --yes @augmentworks/cli@0.1.0 init --agent

Then configure the generic YAML HTTP connector. Do not require a Python adapter or AugmentWorks target SDK; implement
only missing synthetic hooks in this application's existing framework.

Generate augmentworks.yaml and .env.example, and add only the minimum synthetic
prepare/send/observe/cleanup hooks needed for the selected packet. Use only an
authorized, isolated synthetic target in a test or staging environment and
synthetic test data. Do not connect production systems or use production or
regulated data. Never put a secret value in YAML, source code, a command
argument, chat, or a diff.

Run:

npx --yes @augmentworks/cli@0.1.0 doctor -c augmentworks.yaml

Show me the resulting diff, and explain the telemetry allowlist and cleanup
behavior. Stop when browser authentication, device authorization, secret
insertion, or human approval is required. Do not
start an assessment, consume a free credit, or run a paid assessment without
asking me first.
```

## Expected assistant workflow

1. Confirm the approved repository root and an authorized, isolated synthetic
   target in a test or staging environment.
2. Inspect application routes or an OpenAPI description inside that root.
3. Identify the application endpoint—not merely its model-provider endpoint.
4. Run `npx --yes @augmentworks/cli@0.1.0 init --agent` to generate
   `augmentworks.yaml`, `.env.example`, a local `.env`, and repository guidance.
5. Use the generic YAML HTTP connector. Add narrowly scoped, authenticated
   synthetic lifecycle hooks in the application's native framework only if
   needed.
6. Make cleanup idempotent and give fixtures a server-side TTL.
7. Configure the smallest useful telemetry allowlist.
8. Run `doctor -c augmentworks.yaml`, which is always offline in v0.1, and
   report missing local environment-variable names without opening or printing
   `.env` values.
9. Show the diff and remaining risks.
10. Stop before authentication or `test` unless the human explicitly approves.

## Human-only steps

- Sign in and approve the connector:
  `npx --yes @augmentworks/cli@0.1.0 login`.
- Insert target credentials into a local `.env` or secret manager. These are
  separate from the AugmentWorks connector credential.
- Decide whether synthetic target side effects are acceptable.
- Start the assessment and authorize any paid use:
  `npx --yes @augmentworks/cli@0.1.0 test -c augmentworks.yaml --packet
  support-refunds@0.1.0 --open`.
- Review findings before publishing or sharing evidence.

Once setup is complete, the AI assistant leaves the evidence path. Every scored
run is executed by the same version-pinned, deterministic CLI.
