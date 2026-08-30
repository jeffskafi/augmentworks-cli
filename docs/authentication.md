# Authentication

Authentication authorizes a local connector to an AugmentWorks workspace. It
does not grant the relay access to the local filesystem, shell, environment, or
network beyond the capabilities represented by the selected configuration.

## Interactive login

```bash
npx --yes @augmentworks/cli@0.1.0 login
```

The default flow uses browser Authorization Code with PKCE and a temporary
loopback callback. The browser shows the workspace and target authorization;
the human signs in and approves it. The verifier remains local, the code is
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
owner tokens. The CLI uses the operating-system credential store when it is
available. If no supported store is available, first-time login fails safely by
default. The user may explicitly opt into the local fallback with
`--allow-file-credentials`; the CLI emits a warning, refuses symlinks, and on
POSIX systems enforces mode `0600` for the credential file.

Use:

```bash
npx --yes @augmentworks/cli@0.1.0 whoami
npx --yes @augmentworks/cli@0.1.0 logout
```

`logout` removes local credential material. Revoke a lost machine or connector
from the AugmentWorks workspace as well.

## CI

CI uses a separately issued, least-privilege project token supplied by the CI
secret manager:

```bash
AUGMENTWORKS_TOKEN="$AUGMENTWORKS_TOKEN" \
npx --yes @augmentworks/cli@0.1.0 test \
  -c augmentworks.yaml \
  --packet support-refunds@0.1.0
```

Never pass a token as a command-line argument, commit it to YAML, print it in a
build log, or paste it into an AI assistant. Rotate CI credentials on exposure
and scope them to one workspace and the minimum required target actions.

## Production availability

The production authorization endpoints are not deployed yet. Until they are,
authentication behavior is exercised only by local integration tests and mock
services in this repository.
