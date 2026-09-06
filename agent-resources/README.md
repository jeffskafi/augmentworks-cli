# Agent resource bundle

Canonical operational rules live in `guidance.md`. Wrappers are generated:

```bash
npm run generate:agent-resources
```

| File | Host | Install |
| --- | --- | --- |
| `augmentworks/SKILL.md` | Claude Code / Agent Skills | Copy to the host skill directory. Not auto-discovered. |
| `cursor/augmentworks.mdc` | Cursor project rules | Copy to `.cursor/rules/augmentworks.mdc`. `alwaysApply` is false. |
| `codex/AGENTS.snippet.md` | Codex `AGENTS.md` | Append only in repos that use AugmentWorks. |

These files are **not** included in the npm tarball. `npm install`, `demo`,
`doctor`, and `init` do not copy them. `init --agent` still only writes
`augmentworks.agent.md` when requested.
