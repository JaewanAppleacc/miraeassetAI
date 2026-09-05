# Turn FOURARM-INTEGRATION-OWNER-DECISION-AND-EXECUTION-GATE — Handoff

## Purpose / acceptance criteria

1. Import the Owner's ratified adjudication of the 17-packet unresolved
   queue (`resolutions.owner.json`), SHA-verified, unmodified.
2. Separate "can this batch execute" (`official_batch_execution_ready`)
   from "can we pick a winner yet" (`final_selection_ready`) so a
   hard-gate-failed B/D no longer blocks A/C from executing.
3. Never manufacture readiness: no slot-failure relaxation, no automatic
   UNKNOWN resolution, no EQUIVALENT_EVIDENCE restoration, no B/D
   rescoring, no hardcoded `true`.
4. Cover all 10 required test scenarios.
5. Generate (not necessarily run) the exact A/C DEV_TUNE-101 execution
   command.

## What changed

### A. Owner decision import

- `domain/agent-comparison/four-arm-ac/official/resolutions.owner.json` —
  imported byte-for-byte from a prior review session's local scratch
  output (a sibling session's `fourarm_review/resolutions.owner.json`,
  outside this repo/worktree), SHA-256 verified against the pinned
  `90940c7d...` before import.
- The file's own `review.packet_combined_sha256` (`e65cf7f5...`) was
  independently **re-derived** from the real 17 `unresolved/u-*.json`
  packet files (fetched read-only from
  `demo-ai-festival/codex/fourarm-bd-final-handoff-v01` @ `1a7c41f2d3...`,
  never checked out into this branch) — reproduces the pinned value
  exactly, proving the packet set wasn't tampered with.
- `domain/agent-comparison/four-arm-ac/four-arm-owner-resolutions-importer.mjs`
  (new): validates file SHA, packet_combined_sha256, distribution counts,
  classification vocabulary (`COMMON_SOURCE`/`ARM_SPECIFIC`/`UNKNOWN`
  only), critical-only-on-ARM_SPECIFIC, and that `EQUIVALENT_EVIDENCE` is
  explicitly rejected in the review notes. Strips the `adjudicator`
  identity field from every return value (present in the file on disk,
  never repeated in manifests/logs/reports).
- `IMPORT_MANIFEST.json` updated with the new artifact entry and the
  Owner's ratified decisions (kept critical=2, kept UNKNOWN=15,
  re-rejected EQUIVALENT_EVIDENCE).

### B. Execution/selection gate separation

- `four-arm-winner-selection.mjs` (new): `deriveArmSelectionState`,
  `selectWinner`, `deriveLowUnderpowered`. A hard-gate-failed arm's
  `arm_selection_eligible` is `false` (known); a not-yet-executed arm's is
  `null` (pending, structurally distinct from "failed"). `selectWinner`
  filters to eligible arms *before* ever comparing a metric — an
  ineligible arm cannot win even if it somehow carries quality metrics.
- `four-arm-preflight.mjs` (rewritten): now reports
  `official_batch_execution_ready` (pins/ledger/Owner-artifact complete,
  independent of any arm's hard-gate outcome) and `final_selection_ready`
  (false until every arm has a *final*, non-pending hard-gate verdict)
  separately, plus per-arm `arm_execution_state` /
  `arm_hard_gate_state` / `arm_selection_eligible`.
- Real preflight re-run against the live DB. Current state (committed in
  `official/four-arm-preflight-manifest.json`):

  | field | value |
  |---|---|
  | `official_batch_execution_ready` | `true` |
  | `final_selection_ready` | `false` |
  | `blockers` | `[]` |
  | A / C `arm_execution_state` | `NOT_EXECUTED_PENDING_DEVTUNE` |
  | A / C `arm_selection_eligible` | `null` (pending, not blocked) |
  | B / D `arm_hard_gate_state` | `HARD_GATE_FAILED` |
  | B / D `arm_selection_eligible` | `false`, `failure_reason: ARM_SPECIFIC_CRITICAL_2` |
  | `selection.status` | `EXECUTION_PENDING` |

  This matches the Turn's own stated expected state exactly.

### C. Section E — execution readiness re-assessment (not executed)

The prior Turn's assumed blocker ("corp-name resolution needs
unauthorized production wiring") turned out to be **wrong** on closer
inspection this Turn:

- An already Owner-**APPROVED** CompanyResolver decision exists for this
  exact corpus: `work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json`
  (reviewer 최재완, `corpus_04750795e1a2d5c3`, approved 2026-08-14,
  independently verified 70/70). Copied read-only into this worktree's
  gitignored `work/domain-seed/` (never committed — `work/` is `.gitignore`d).
  All three files' SHA-256 re-verified against the values the existing
  `tests/seed-company-resolver.test.mjs` already pinned.
- Every one of the 70 corp names referenced across all 101 real official
  conditions resolves against this directory with **zero** misses.
- `doc_subtype` taxonomy: `exchange_subtypes` and `periodic_subtypes`
  values in the official conditions match the real
  `reference_retrieval_chunks.metadata.doc_subtype` vocabulary **exactly**
  (verified against the live DB). Only `major_labels` (e.g. "자기주식")
  has no corresponding DB field for `doc_group=major` — left unmapped,
  documented, not guessed.
- New: `four-arm-conditions-to-filter-mapper.mjs` (real corp-name ->
  corp_code + doc_group/subtype/year/month/correction mapping, tested) and
  `scripts/p11f0-fourarm-devtune-ac-run.mjs` (real, complete, checkpoint-
  resumable DEV_TUNE-101 runner for either arm — syntax-checked, all
  imports resolve, **not invoked**).

**The one remaining real blocker for arm A**: no live KURE-v1 embedding
server is reachable in this environment (`P11F0_KURE_SERVER_URL` unset) —
an environmental/infrastructure fact, not a policy or authorization gap.
Arm C has no such blocker but was deliberately **not** run alone this
Turn, so both arms execute against the identical `code_sha256` in one
atomic pass (avoids a partial-arm-now/other-arm-later code-drift risk).

Exact commands, once a KURE server is reachable:

```bash
DATABASE_URL=postgresql://... \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm C --batch-id <batch_id_from_preflight_manifest>

DATABASE_URL=postgresql://... P11F0_KURE_SERVER_URL=http://127.0.0.1:<port>/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A --batch-id <batch_id_from_preflight_manifest>
```

Neither was run this Turn. `dev_tune_executed: false` in every manifest.

## Explicitly NOT done (per Turn instructions)

- No DEV_TUNE execution.
- No DEV_CHECK/HOLDOUT access (grepped: zero references anywhere touched).
- No production wiring beyond using an *already*-approved gate for its
  documented purpose (CompanyResolver).
- No slot-failure relaxation for the 2 ARM_SPECIFIC critical packets, no
  automatic UNKNOWN resolution, no EQUIVALENT_EVIDENCE restoration.
- No B/D result/run/scorer file modification, no rescoring.
- No winner declared; no hardcoded `true` anywhere in the gate logic.

## Tests

New: `four-arm-owner-resolutions-importer.test.mjs` (14),
`four-arm-winner-selection.test.mjs` (16),
`four-arm-conditions-to-filter-mapper.test.mjs` (8). Rewritten:
`four-arm-preflight.test.mjs` (14), `four-arm-preflight-manifest-artifact.test.mjs` (12).
See the commit message / final report for full pass counts across the
scoped suite, `schema:validate`, `tsc --noEmit`, `git diff --check`.
