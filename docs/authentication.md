# Authentication

Authentication authorizes a local CLI to call AugmentWorks on behalf of one
workspace. That connector credential is used only for CLI-to-AugmentWorks API
requests. It does not authenticate requests to the customer application or
grant the hosted relay access to the local filesystem, shell, environment, or
network.

Authentication is not used by `test --local`. Local mode does not read an
AugmentWorks connector credential or contact the AugmentWorks control plane; it
resolves only the target credentials named by the selected configuration.

## Interactive login

```bash
npx --yes @augmentworks/cli@0.1.0 login
```

The default flow uses browser Authorization Code with PKCE and a temporary
loopback callback. The browser shows the connector authorization and selected
workspace; the human signs in and approves it. Browser approval authorizes this
terminal; it does not start an assessment. The verifier remains local, the code is
single-use and short-lived, and the callback listener closes after completion.

For SSH and other headless environments:

```bash
npx --yes @augmentworks/cli@0.1.0 login --device
```

The CLI displays a short user code and verification URL. Entering the code in a
separately authenticated browser authorizes the waiting CLI. The CLI does not
ask for a password.

## v0.1 endpoint contract

The CLI permits the production `https://augmentworks.ai` origin or an explicit
loopback development origin through `AUGMENTWORKS_API_URL`. Other origins and
origins containing credentials, paths, queries, or fragments are refused.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/cli/auth/authorize` | Begin browser authorization with PKCE |
| `POST /api/v1/cli/auth/device` | Create a device/user code pair |
| `POST /api/v1/cli/auth/token` | Exchange authorization-code, device-code, or refresh-token grants |
| `POST /api/v1/cli/auth/revoke` | Revoke the active connector credential |
| `GET /api/v1/cli/auth/me` | Resolve workspace and connector identity |

Browser authorization uses `client_id=augmentworks-cli`,
`response_type=code`, exact loopback `redirect_uri`, `state`, `scope`,
`code_challenge`, and `code_challenge_method=S256`. The CLI verifies state and
never sends the PKCE verifier to the authorization endpoint.

## Credential storage

Interactive credentials are revocable connector credentials, not workspace
owner tokens. Native storage is selected by platform:

- macOS stores one API-origin-scoped generic password in the login Keychain via
  the fixed `/usr/bin/security` helper. Save data is hex-encoded for the
  helper's interactive parser and delivered over its private stdin pipe, not a
  command-line argument; the CLI reads the item back before reporting success.
- Windows encrypts an API-origin-scoped file with CurrentUser DPAPI through the
  fixed built-in Windows PowerShell path. The helper protects the directory and
  file ACL for the current SID and Local System, refuses reparse points,
  inherited/broad ACLs, foreign ownership, and invalid ciphertext, and binds
  DPAPI entropy to the API origin.
- Linux uses the Secret Service through `secret-tool` when a session bus and
  helper are available.

If no supported store is available, first-time login fails safely by default.
On POSIX systems the user may explicitly opt into the local fallback with
`--allow-file-credentials`; the CLI emits a warning, refuses symlinks, and
enforces mode `0600`. Plaintext fallback is disabled on Windows because a POSIX
mode cannot prove a safe Windows ACL. No native Node add-on is required.

A long-running hosted `test` process resolves a current access token
before every cloud request. Interactive credentials refresh shortly before
expiry and once after an HTTP 401. Refresh-token rotation is serialized with a
secure, API-origin-scoped process lock; a waiting command re-loads and reuses
the credential written by the process that won the refresh. A same-host stale
lock is reclaimed when its process is positively known dead, including on
systems without Linux boot metadata. A verifiable previous boot or mismatched
process-start identity also proves that a live reused PID is not the recorded
owner. The CLI rechecks the unchanged directory, owner-file identity, and nonce
before removal; unknown identity remains fail-closed.

Use:

```bash
npx --yes @augmentworks/cli@0.1.0 whoami
npx --yes @augmentworks/cli@0.1.0 logout
```

`logout` requests server-side revocation and removes local credential material.
A workspace owner can also revoke a lost machine or connector from the
AugmentWorks portal.

## Target authentication is separate

The connector credential above authenticates the CLI to AugmentWorks. Target
authentication is configured independently in `augmentworks.yaml`, for example
with `bearer_env` or `headers_env`, and resolved from the local process
environment or the `.env` file beside the selected configuration. Target
credential values are not put in YAML, sent during login, or uploaded during
run creation.

## Future automation credentials

`AUGMENTWORKS_TOKEN` is a static, non-refreshing injection point reserved for
future project tokens and integration harnesses. `login`, `whoami`, and hosted
`test` give it precedence and do not load or write the interactive credential
store. `logout` still attempts to revoke the environment token and any stored
connector credential, removes local stored credential material when accessible,
and warns that the environment variable remains set. Project-token issuance is
intentionally separate from the interactive connector-auth endpoints and
is not implemented by this release. Do not use the
one-hour interactive access token as an unattended CI credential.

Never pass a token as a command-line argument, commit it to YAML, print it in a
build log, or paste it into an AI assistant. Rotate CI credentials on exposure
and scope them to one workspace and the minimum required target actions.
