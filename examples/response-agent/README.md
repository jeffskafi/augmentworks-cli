# Synthetic response-agent example

This directory is a **synthetic** FAQ assessment fixture for CLI 0.3.2.
It is not a production knowledge base, not a real customer policy, and not
included in the npm tarball. Clone this repository for the example server.

Published `@augmentworks/cli@0.3.2` includes `--assessment`. Copy or write
`augmentworks.assessment.yaml`, then run hosted test against this isolated
synthetic target only. Source `0.3.3` `init` can generate a packaged
response-quality starter instead of copying this example.

From a source 0.3.2 build, preview the chat-only send mapping before an
assessment. This does not call the target or consume credits:

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation send \
  --fixture ./fixtures/send-response.json
```

```yaml
# augmentworks.assessment.yaml is synthetic test data only.
```

Default `augmentworks.yaml` is **single-turn**. Hosted `multi_turn` is not
advertised from the presence of an assessment file. Correlation IDs
(`attempt_id`, `run_id`, `turn_id`) are not conversation memory.

To opt into the one supported session mode, copy the mapping in
`augmentworks.session.yaml` and run the stateful fixture:

```bash
cp .env.example .env
node --env-file=.env session-server.mjs
```

```yaml
target:
  conversation:
    strategy: explicit_session_v1
  operations:
    send:
      idempotent: true
      request:
        message: $input.message.content
        conversation_id: $input.conversation_id
        turn_id: $input.turn_id
```

`explicit_session_v1` maps the attempt-scoped conversation identifier
(`conversation_id === attempt_id`) into a target field. The target owns and
isolates that server-side context. Mapping is not a claim that a chatbot
remembered prior turns.

Set `idempotent: true` only when repeating the same `AW-Idempotency-Key`,
conversation identifier, and `turn_id` cannot append a second accepted user
message. This fixture does that; arbitrary endpoints are not assumed
idempotent.

From a source 0.3.3 build, validate the session mapping offline:

```bash
node dist/index.js doctor -c augmentworks.session.yaml --offline
```
