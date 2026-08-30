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

Use the pinned @augmentworks/cli@0.1.0 package. Generate augmentworks.yaml and
.env.example, and add only the minimum synthetic prepare/send/observe/cleanup
hooks needed for the selected packet. Use test or staging data only. Never put a
secret value in YAML, source code, a command argument, chat, or a diff.

Run the local doctor command, show me the resulting diff, and explain the
telemetry allowlist and cleanup behavior. Stop when browser authentication,
device authorization, secret insertion, or human approval is required. Do not
start an assessment, consume a free credit, or run a paid assessment without
asking me first.
```

## Expected assistant workflow

1. Confirm the approved repository root and test/staging target.
2. Inspect application routes or an OpenAPI description inside that root.
3. Identify the application endpoint—not merely its model-provider endpoint.
4. Run `init --agent` and generate `augmentworks.yaml` plus `.env.example`.
5. Add narrowly scoped, authenticated synthetic lifecycle hooks only if needed.
6. Make cleanup idempotent and give fixtures a server-side TTL.
7. Configure the smallest useful telemetry allowlist.
8. Run `doctor`, which is always offline in v0.1, and report any missing local
   environment variables to the human without reading their values.
9. Show the diff and remaining risks.
10. Stop before authentication or `test` unless the human explicitly approves.

## Human-only steps

- Sign in and approve the connector in a browser.
- Insert target credentials into a local `.env` or secret manager.
- Decide whether synthetic target side effects are acceptable.
- Start an assessment and authorize any paid use.
- Review findings before publishing or sharing evidence.

Once setup is complete, the AI assistant leaves the evidence path. Every scored
run is executed by the same version-pinned, deterministic CLI.
