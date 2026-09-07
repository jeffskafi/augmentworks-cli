# C01 completion: unfinished run observation must not return success

Issue: [AUG-11](https://linear.app/augmentworks/issue/AUG-11/cli-prevent-unfinished-run-observation-from-returning-success)

Repository: `jeffskafi/augmentworks-cli`. One isolated branch and one PR.

## Identity

| Item | Value |
| --- | --- |
| Audit baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` (`main` after Stage 2B/1B merges) |
| Working branch | `cursor/aug-11-end-to-end-ticket-d3df` |
| Vendored billing contract | `aw-billing/1` from main `67749b22f04bbb8d94c0309acd36be3cb3144400` |
| Schema SHA-256 | `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901` |
| Fixtures SHA-256 | `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1` |
| Migrations | None. This repository does not own SQL. |

## Dependency reconciliation

- CLI billing 2B (`cursor/billing-stage-2b-91a7`, PR #15) and 1B (PR #16) are already on `main` at the audit baseline. No open competing CLI PR owned `src/commands/run.ts`.
- Main Stage 2A status SQL (`cli_billing_status_v1`) defaults `evaluationStatus` to `absent` when there is no evaluation group and the run is not hybrid. It does not currently emit `outcome`. CLI classification treats that combination as deterministic-only after **completed** execution, not while execution is still running.
- Contract JSON was not hand-edited. Proposed fixture additions for main are below.

## Interfaces

Classifier: `src/billing/status-classification.ts`

Three layers, never interchangeable:

1. **Observation** — `GET /v1/billing/status` parsed. JSON `ok: true` / `observation: "success"` means the query worked.
2. **Work** — known terminal relay execution (`completed` / `failed` / `cancelled`) versus nonterminal (`queued` / `connected` / `running` / `cancel_requested`) versus unknown.
3. **Assessment** — release success only when the classified result is an applicable pass.

Commands:

```bash
node dist/index.js run status <run-id> --json
node dist/index.js run wait <run-id> --json --timeout-ms 5000
```

`--json` now includes `observation`, `work`, `assessment`, `wait_terminal`, `release_success`, and `exit_code`. Unattended gates must use the process exit code or `release_success`, not `ok`.

## Classification (examples)

| execution | evaluation | extra | wait | exit |
| --- | --- | --- | --- | --- |
| running | absent | 0/10 attempts, null outcome (AUG-11) | continue | 11 |
| completed | absent | plannedJudgeJobs=0, outcome omitted or `passed` (2A deterministic-only) | stop | 0 |
| completed | absent | plannedJudgeJobs>0 | continue | 11 |
| completed | pending / partial | hybrid grading incomplete | continue | 11 |
| completed | complete | `passed` | stop | 0 |
| completed | complete | `failed` / `inconclusive` / `error` / null | stop | 10 |
| completed | error / unsupported | evaluator or unsupported grading | stop | 12 |
| cancelled | any | interruption | stop | 130 |
| failed | pending | still grading | continue | 11 |
| failed | absent, plannedJudgeJobs=0 | terminal failed work | stop | 10 |
| unknown (`expired`, etc.) | any | fail closed | continue | 11 |

Wait timeouts throw `EVALUATION_INCOMPLETE` (exit 11) naming the **original run id**. The loop only `GET`s capabilities and billing status. It does not quote, reserve, create, reconcile, retry-evaluate, or call a target.

## Proposed main fixture additions (contract owner)

Do not vendor these until main publishes them. Suggested `docs/contracts/aw-billing-v1.fixtures.json` keys:

- `status_running_absent_unfinished` — `executionStatus: running`, `evaluationStatus: absent`, `completedAttempts: 0`, `plannedAttempts: 10`, `outcome: null`
- `status_deterministic_completed` — `executionStatus: completed`, `evaluationStatus: absent`, `plannedJudgeJobs: 0`, optional `outcome: "passed"`
- `status_complete_passed` / `status_complete_failed` — graded terminals
- `status_evaluation_error` / `status_evaluation_unsupported` / `status_cancelled`

Optional producer change (not done here): emit `outcome` on billing status when packet assertions have resolved, so hybrid `complete` without an outcome is distinguishable from 2A deterministic omission.

## Tests and verification

See the PR description for commands and real outcomes recorded in this checkout.

## Remaining release requirements

- Not npm-published. Source integration is not deployment.
- No live paid target calls. Synthetic fixtures only.
- AUG-7 / billing policy still gates merge and publication.
- Main 2A host still unverified live.
