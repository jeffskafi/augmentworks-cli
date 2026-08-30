# Refund-agent example

This loopback server demonstrates the full synthetic lifecycle without a model,
database, or production side effect. It creates an in-memory order, sends a
refund-related message to a deterministic policy boundary, observes allowlisted
state, and removes the fixture.

The example intentionally refuses policy-override refund requests and leaves
the order unrefunded. It is a connector demonstration, not a realistic support
agent or a substitute for the hosted packet/scorer.

## Run the target

From this directory:

```bash
cp .env.example .env
node --env-file=.env server.mjs
```

The target listens on `http://127.0.0.1:8000` by default and exposes a
side-effect-free `GET /health` endpoint. In another terminal, validate the
configuration from the repository root:

```bash
npm run build
node dist/index.js doctor \
  -c examples/refund-agent/augmentworks.yaml
```

The hosted quickstart is:

```bash
npx --yes @augmentworks/cli@0.1.0 test \
  -c augmentworks.yaml \
  --packet support-refunds@0.1.0 \
  --open
```

That hosted command cannot complete until the production AugmentWorks relay is
deployed. Repository integration tests use a loopback mock relay instead.

## API shape

| Endpoint | Synthetic behavior |
| --- | --- |
| `POST /__augmentworks/prepare` | Creates one in-memory order keyed by attempt ID |
| `POST /chat` | Refuses refund-policy overrides and emits a structured handoff event |
| `POST /__augmentworks/observe` | Returns only status and refunded amount |
| `POST /__augmentworks/cleanup` | Deletes the in-memory fixture; safe to repeat |

The YAML shows how a simple application response (`answer`, `events`, `order`)
is normalized into the strict `aw-target/0.1` evidence contract. The target does
not need to know the relay protocol or return `protocol_version`.

In a real integration, authenticate these lifecycle routes, restrict them to a
test environment, make fixture operations idempotent, and enforce a server-side
fixture TTL.

