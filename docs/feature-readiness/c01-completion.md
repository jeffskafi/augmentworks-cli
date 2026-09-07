# C01 completion record — unfinished run observation

Issue: [AUG-11](https://linear.app/augmentworks/issue/AUG-11/cli-prevent-unfinished-run-observation-from-returning-success)

Owned repository: `jeffskafi/augmentworks-cli`. Main remains read-only.

## Identity

| Item | Value |
| --- | --- |
| Audit baseline / default main | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working branch | `cursor/prevent-unfinished-run-observation-5ddb` |
| Consumed billing 2B | already merged on main (`dc35d9e` / PR #15), vendored main `67749b22f04bbb8d94c0309acd36be3cb3144400` |
| Schema version | `aw-billing/1` |
| Schema SHA-256 | `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901` |
| Fixtures SHA-256 | `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1` |
| Migrations | none (CLI does not own SQL) |
| Competing PRs on write paths | none open at start |

## Problem

`isWaitTerminal` treated `evaluationStatus === "absent"` as terminal regardless of execution. `billingStatusExitCode` fell through to exit `0`. A constructed `running` + `absent` + `0/10` attempts + `null` outcome therefore ended wait as success even though only the HTTP query succeeded. Production emission of that combination is unverified; the helper behavior made unattended release gates unsafe.

## Interfaces

Classifier: `classifyBillingRunStatus` in `src/billing/classify.ts`.

A successfully parsed status is **observation success**. That is not a passing assessment.

| Field | Meaning |
| --- | --- |
| `observation: "succeeded"` | GET `/v1/billing/status` parsed. JSON `ok: true`. |
| `work: "in_progress" \| "terminal"` | Relay execution still active vs finished/unknown. |
| `waitTerminal` | Wait may return. False while execution is nonterminal or grading is `pending`/`partial`. |
| `assessment` | Release-gate class: `passed`, `failed`, `incomplete`, `evaluator_error`, `interrupted`, `unsupported`, `unknown`. |
| `exit_code` | Documented CLI exit. `0` only for an explicit resolved `passed` outcome. |

`run status` / `run wait --json` now include `observation`, `work`, `assessment`, and `exit_code`. Process exit follows `assessment`, so a release gate cannot treat query success as a pass.

Wait timeout and poll exhaustion throw `EVALUATION_INCOMPLETE` (exit `11`) naming the original run: `augmentworks run wait <run-id>`. They only GET capabilities + status. No quote, reservation, create, target call, or evaluation retry.

### Execution × evaluation combinations

Known execution values are the relay statuses: `queued`, `connected`, `running`, `cancel_requested`, `cancelled`, `completed`, `failed`. The main billing schema leaves `executionStatus` unconstrained; unknown strings still parse.

| execution | evaluation | outcome | wait | assessment | exit |
| --- | --- | --- | --- | --- | --- |
| queued / connected / running / cancel_requested | absent | null | continue | incomplete | 11 |
| **running** | **absent** | **0/10, null** | **continue** | **incomplete** | **11** |
| completed | absent | passed | terminal | passed (deterministic-only) | 0 |
| completed | absent | failed / inconclusive / error | terminal | failed | 10 |
| completed | absent | null | terminal | incomplete | 11 |
| completed | pending / partial | any | continue | incomplete | 11 |
| completed | complete | passed | terminal | passed | 0 |
| completed | complete | failed / inconclusive / error | terminal | failed | 10 |
| completed | complete | null | terminal | incomplete | 11 |
| completed | error | any | terminal | evaluator_error | 12 |
| completed | unsupported | any | terminal | unsupported | 11 |
| failed | not pending/partial | any | terminal | failed | 10 |
| cancelled | not pending/partial | any | terminal | interrupted | 130 |
| failed / cancelled | error | any | terminal | evaluator_error | 12 |
| unknown | not pending/partial | any | terminal | unknown | 11 |

Ambiguous combinations (running + complete + passed, complete + null outcome, unknown execution, unknown outcome, unsupported even with `passed`) never silently pass. Evaluator `error` keeps exit `12` over execution failure.

## Proposed main fixture additions

Do **not** hand-edit vendored contract checksums in this CLI. Ask the contract owner (`jeffskafi/augmentworks`) to add additive fixtures, then re-import:

- `status_running_absent_zero_attempts` — the reproduction (`running`, `absent`, `0/10`, `outcome: null`)
- `status_completed_deterministic_passed` — terminal deterministic-only success (`completed`, `absent`, `outcome: "passed"`)
- `status_completed_evaluation_unsupported`
- `status_execution_cancelled_absent`
- `status_execution_failed_absent`

Until those exist, CLI tests compose overlays on vendored `status_pending_grading` (`cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1`).

## Examples

```bash
node dist/index.js run status <run-id> --json
# unfinished: ok=true, assessment=incomplete, process exit 11

node dist/index.js run wait <run-id>
# continues while execution is nonterminal; timeout remains read-only
```

## Verification

Recorded after the commands below. Fill exact counts from the checkout that produced this PR.

| Command | Outcome |
| --- | --- |
| `npm run check:billing-contract` | pending in this draft |
| `npm run typecheck` | pending |
| targeted vitest (`run-status-classification`, `cli-run-wait`, `cli-quote`, `contract`) | pending |
| `npm test` | pending |
| `npm run build` | pending |
| packed `dist/index.js run wait` against the fixture API | pending (covered by `test/billing/cli-run-wait.test.ts`) |
| `npm run smoke:pack` | pending |
| Live paid target / Stage 2A host | **not run** (scope exclusion) |

## Compatibility

- Numeric exits `10`, `11`, `12`, `13`, `130` unchanged in meaning.
- JSON `ok: true` remains query success; additive `assessment` / `exit_code` expose the gate.
- Vendored `aw-billing/1` hashes unchanged.
- Observation never creates a billable run.

## Remaining release requirements

- Source integration of this PR is not npm publication. AUG-7 / release-acceptance tickets verify published artifacts.
- Do not activate live billing.
- Re-import main fixtures if the contract owner adds the proposed status cases.
