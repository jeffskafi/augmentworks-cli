# MCP / plugin distribution (future)

Status: future. Not implemented in this change.

A real MCP server, registry listing, remote execution service, or new
authentication system is out of scope until the CLI has real adoption.

If a later design is warranted, start with **read-only** resources:

- Bundled JSON schemas (`config`, `local-packet`, `local-result`)
- Discovery manifest (reviewed snapshot, never live `latest`)
- Pointers to local `AW-LOCAL-RESULT-1` files the user already generated
- Explicitly authorized, locally scoped `doctor --offline` or `demo --json`

Keep authentication, hosted `test`, and any target side effects human-gated.
Publish from this public CLI repository, not the private website. Follow
https://modelcontextprotocol.io/registry/about before any registry submission.
