# C06 completion record — local mapping and evidence preview

Linear: [AUG-12](https://linear.app/augmentworks/issue/AUG-12/cli-preview-response-mappings-and-the-exact-sanitized-evidence-payload)
Repository: `jeffskafi/augmentworks-cli`
Work package: C06 · Audit coverage: F05, F13

This record is issue-specific. It does not rewrite billing or shared completion
files owned by parallel agents.

## Source identity

| Item | Value |
| --- | --- |
| Audit baseline / default `main` | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working branch | `cursor/aug-12-end-to-end-ticket-c610` |
| Implementation HEAD | Feature `046e82e034555685162d9c94aff36b6cfb1b6c43`; this record `d65caa5fd8a07374480c0ccee25d97448e0ffb08` |
| Consumed predecessors | None. Native blockers: none. Rechecked open CLI PRs: none competing for this command. |
| Counterpart | `jeffskafi/augmentworks` was not modified |
| Schema / migrations | None. No SQL. Billing contract unchanged: `aw-billing/1` from `67749b22f04bbb8d94c0309acd36be3cb3144400` (schema `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901`, fixtures `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1`) |

## Outcome

Offline `doctor` still validates configuration without executing mappings.
`preview-mapping` is the lightweight F13 inspector: it runs the **same**
`selectResponse` / `normalizeConnectorResult` / `redactSecrets` /
`canonicalize` path used by the HTTP connector and relay journal, against a
bounded synthetic JSON fixture.

No target HTTP call, AugmentWorks API call, model call, billing quote, or `.env`
load occurs. Session configuration fields were not added (C05 remains the owner).
`init` templates and generated starter files were not edited (C07 consumes this
module later).

## Interfaces

Pure module: `src/connector/mapping-preview.ts`

```ts
previewMappedEvidence({
  kind: "prepare" | "send" | "observe" | "cleanup",
  config: AugmentWorksConfig,
  response: JsonValue,
  secrets?: readonly string[]
}): MappingPreviewResult
```

CLI: `augmentworks preview-mapping -c <yaml> --fixture <json> [--operation send] [--json]`

JSON schema_version: `AW-MAPPING-PREVIEW-1`

Shared omit helper: `shouldOmitMappedResponseField` in `src/connector/normalize.ts`.
C07 must import this preview module rather than a second sanitizer.

The CLI path uses `secrets: []` so it does not silently read environment secret
values. Credential-shaped strings and sensitive keys are still redacted by the
production redactor. Unit tests pass the same `secrets` array to
`previewMappedEvidence` and `normalizeConnectorResult` and require identical
canonical bytes.

## Examples

Source 0.3.2 (not an unpublished npx pin):

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --fixture fixtures/send-preview.json

node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --fixture fixtures/send-preview.json \
  --json
```

Chat-only starter fixture: `examples/basic-chat/fixtures/send-preview.json`.

Representative successful `--json` (synthetic send fixture; paths abbreviated):

```json
{
  "schema_version": "AW-MAPPING-PREVIEW-1",
  "ok": true,
  "offline": true,
  "operation": "send",
  "fields": [
    { "field": "content", "selector": "$.answer", "status": "extracted", "redacted": false },
    { "field": "tool_events", "selector": "$.events", "status": "omitted" },
    { "field": "finished", "selector": "$.finished", "status": "extracted" },
    { "field": "metadata", "selector": "$.metadata", "status": "omitted" }
  ],
  "evidence": {
    "protocol_version": "aw-target/0.1",
    "turn_id": "preview-turn",
    "message": { "role": "assistant", "content": "The synthetic order is still paid." },
    "events": [],
    "finished": true,
    "metadata": {}
  },
  "disclaimer": "This preview is for the supplied fixture only. It does not guarantee that future target responses are secret-free."
}
```

Missing required field (exit `2`, no hosted run):

```text
ERROR MAPPING_VALUE_MISSING: No value exists at $.answer. (target.operations.send.response.content)
Preview found mapping problems.
```

Malformed selector (exit `2`): `RESPONSE_MAPPING_INVALID` at
`target.operations.send.response.content`.

## Verification actually run

Working directory: `/agent/repos/augmentworks-cli`. Node.js v22.14.0.

| Command | Outcome |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| `npx vitest run test/connector/mapping-preview.test.ts test/connector/mapping.test.ts test/integration/cli-entry.test.ts test/docs/copy-contract.test.ts test/config/commands.test.ts test/docs/agent-resources.test.ts` | Pass. 6 files / 82 tests |
| `npm test` | Pass. Vitest 4.1.11: **48 files / 393 tests** |
| `npm run build` | Pass. tsup ESM `dist/index.js` 1.65 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.2` development |
| `npm run check:billing-contract` | Pass. hashes above |
| `npm run smoke:pack` | Pass. Packed tarball 20 files, 361512 compressed bytes. Installed `preview-mapping --json` succeeded offline; mapped `sk-syntheticpreviewvalue` and unselected `unselected-nested-secret-value` absent from output; ambient `CHATBOT_API_KEY` / `AUGMENTWORKS_TOKEN` unused |
| `node dist/index.js --help` | Lists `preview-mapping` beside existing commands; no `connect` replacement |
| `node dist/index.js preview-mapping --help` | Documents `--fixture`, `--operation`, `--json` |

Negative cases exercised in tests and the built binary: malformed selector,
unsafe `$.__proto__` selector, missing `$.answer`, malformed JSON (position
only, no fixture snippet), oversized content (truncation / evidence-limit
visible, payload not dumped), nested unselected secrets, observe allowlist,
cleanup without a response map, sibling `.env` unread.

## Compatibility

- Additive Commander registration only in `src/cli.ts`. No parallel command
  registry. `test.ts` / `run.ts` untouched.
- Source package remains `0.3.2`. Verified npm remains `0.3.1`. No unpublished
  npx pin.
- Billing initializer and generated starter YAML were not edited.
- Preview is not an automatic secret-detection guarantee and does not ingest
  production transcripts.

## Remaining release requirements

- Keep AUG-12 **In Review** until source integration review. Npm publication and
  live billing remain AUG-7 / billing-policy owned.
- C07 ([AUG-35](https://linear.app/augmentworks/issue/AUG-35/cli-complete-own-target-starter-recipes-and-an-explicit-bounded-connection-probe))
  should call `previewMappedEvidence` from the merged starter rather than
  duplicating sanitization.
- C05 session-mode advertisement stays blocked on its own predecessors; this
  preview uses existing `aw-target/0.1` prepare `target_session_id` only when
  present in a fixture.
