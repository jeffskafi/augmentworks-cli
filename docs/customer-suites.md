# Customer-owned hosted suites

Git-friendly `aw-suite/1` files let you define hosted semantic cases without
editing AugmentWorks source. Local `suite validate` / `suite preview` never
quote, never execute a target, and never call an LLM. A hosted
`test --suite` pins an immutable server revision, then uses the existing
quote / `--max-credits` / `--yes` consent path.

This command is in the `0.3.6` package. From a clone after `npm ci` and
`npm run build`, use `node dist/index.js`. Installed npx pins match this
package version. Do not pin immutable npm `0.3.3`.

## Commands

```bash
node dist/index.js suite validate examples/customer-suites/faq-non-commerce.yaml
node dist/index.js suite preview examples/customer-suites/returns-14-day.yaml
node dist/index.js suite preview examples/customer-suites/faq-non-commerce.yaml --json
node dist/index.js schema --kind customer-suite
node dist/index.js test --suite examples/customer-suites/faq-non-commerce.yaml --estimate
node dist/index.js test --suite examples/customer-suites/faq-non-commerce.yaml --max-credits 30 --yes
```

`--estimate` creates a suite revision and requests a quote. It does not
create a run, reserve credits, or execute a target. Local preview counts are
not an authoritative price.

Noninteractive admission still requires a finite `--max-credits` ceiling.
`--yes` is not an unlimited budget. The CLI does not prompt, open a browser,
or raise limits silently.

## Authoring format

YAML or JSON. Snake_case keys (`schema_version`, `suite_id`, `case_id`) are
rewritten to the camelCase canonical document (`schemaVersion: aw-suite/1`).
Unsupported schema versions, duplicate case IDs, missing references,
credential-like keys, executable scripts, and `history_array_v1` fail
**before** any network call.

Limits match hosted admission: 64 KiB suite file, 64 KiB / 16 references,
20 cases, 20 turns, 3 repetitions, 16 criteria/tags/facts/observations.

Supported deterministic observations in this CLI: `policy.window_days`,
`policy.permitted_refusal`. Other observation keys are rejected locally.

Conversation capability is **not** inferred from a multi-turn case. Hosted
`multi_turn` is advertised only when `augmentworks.yaml` declares
`target.conversation.strategy: explicit_session_v1` (see the C05 session
mode). A multi-turn suite against a single-turn connector fails with
`CONVERSATION_CAPABILITY_INCOMPATIBLE` before authenticate or quote.

## Samples

| File | What it covers |
| --- | --- |
| `examples/customer-suites/faq-non-commerce.yaml` | Five synthetic FAQ cases (status page, hours, password reset, data export, accessibility). No commerce or return-window facts. |
| `examples/customer-suites/returns-14-day.yaml` | 14-day return window, including a follow-up that must not switch to the curated 30-day pack. Requires session mode at run time. |

Packed installs include the same files under `assets/customer-suites/`.

## Local versus hosted

| Capability | Local `test --local --packet` | Hosted `test --suite` |
| --- | --- | --- |
| Format | `aw-packet/0.1` JSON | `aw-suite/1` YAML/JSON |
| Offline validate/preview | Packet parse only | `suite validate` / `suite preview` |
| LLM rubric / hybrid | Rejected (`UNSUPPORTED_LOCAL_GRADER`) | Quoted hosted judging |
| Customer-owned cases | Private deterministic packet | Immutable suite revision |
| Quote / `--max-credits` | Not used | Required for admission |
| File change after quote | N/A | `SUITE_CHANGED_AFTER_QUOTE`; the CLI will not re-pin mutable content |
| Multi-turn | Packet `required_capabilities.multi_turn` | Config `explicit_session_v1`, not the suite file |

`--suite` cannot be combined with `--local`, `--assessment`, or `--packet`.

## Migrating from a private local packet

1. Keep the existing packet for account-free `test --local`.
2. Author an `aw-suite/1` file for hosted semantic cases (inputs, expected
   facts, references, required/advisory criteria).
3. Validate and preview offline.
4. Run hosted `test --suite` against the same connector YAML, with a finite
   `--max-credits` ceiling.
5. Do not paste judging credentials into the suite file. Do not expand to a
   hundred default scenarios. Do not import production transcripts.

Case order is file order for `test --suite`. Larger owned suites use the
server compiler:

```bash
node dist/index.js catalog list --json
node dist/index.js selection compile \
  -c augmentworks.yaml \
  --assessment ./augmentworks.assessment.yaml \
  --out ./suite-selection.manifest.json
node dist/index.js test \
  --manifest ./suite-selection.manifest.json \
  --shard shard-000 \
  --max-credits 30 \
  --yes
node dist/index.js gate --manifest-file ./suite-selection.manifest.json --declared-shards ./suite-selection.declared-shards.json --json
```

Optional assessment YAML `selection` fields (`profile: smoke|release`,
`suite_version`, tags, `include_catalog`, requested/excluded case ids) are
compiled by the server. Local `test --local` still uses deterministic packets
only. Catalog counts are not a quote. `--all-shards` requires a finite
aggregate `--max-credits` and stops before exceeding consent. An incomplete
declared shard set cannot make a whole-suite gate green.
