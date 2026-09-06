# A4-A3-REMEDIATION-INTEGRATION-V1 — Final Report

Verdict: **`A4_A3_REMEDIATION_RECOMMENDED_FOR_QA`**

## 1. SHAs / branches

```text
new worktree:            agent-a4-a3-remediation-integration-v01
new branch:               codex/a4-a3-remediation-integration-v01
base commit:              codex/a4-a3-qa-condition-integration-v01 @ 3287f9ecceed233803ac656d260b9f7d20c3d816
final commit (this run):  25da367 (feat: retrieval-only DEV_TUNE-101 runner + locator compatibility view)
remediation implementation used: feat/fourarm-a-retrieval-remediation-v01 @ b30b909dad9b56d22dc116f1fffb041e0d69e5ff
remediation validation HEAD used (input reference only): codex/a-remediation-replay-contract-v02 @ 19d5d4d9c4da5068d0f13482ca3d5dac66f5e1ea
frozen submission (never checked out/modified): codex/a4-a3-plus-qa-frozen-v01 @ 6e24545671892a1222d75453d4e74547646aa489
contract (committed before any implementation): feb6b3e
implementation commits: 52cec86 (new modules + offline tests), 693bca9 (retrieval_pass
  metadata-carry fix, found via Section G smoke before any DEV_TUNE result), 25da367
  (Section H runner + compat view)
```

## 2. New backend

```text
ARM_A4_A3_REMEDIATION_LIVE
```

## 3. Actual call structure (verified from source, unchanged from the pre-registered
contract's §2 — see `docs/A4_A3_REMEDIATION_INTEGRATION_V1_CONTRACT.md`)

```text
QA condition mapper (unmodified)
  -> mapOfficialConditionToFilterInput (unmodified)
  -> [NEW] applyCorrectionOnlyWhenAsked -> buildRetrievalPlan/buildFilterPasses (vendored,
     unmodified pure functions) -> per-pass fetchEligibleChunkIds + bm25Search (BM25 leg)
     / searchDocumentChunksByVector (dense leg), ONE embedQuery() call reused by every
     dense pass -> [NEW] per-leg round-robin merge + promoteRelaxed/interleaveRelaxed
     (vendored, unmodified) -> capped at the EXISTING BM25_CANDIDATE_K=100/
     DENSE_CANDIDATE_K=100 (never b30b909's own fusion_pool_k=40)
  -> buildWideCandidatePool (unmodified, <=200, original_a_top20=[])
  -> R4 rankCandidatePool (unmodified, R4_wide_rrf_centric, byte-identical config)
  -> A3 detectEvidenceContradictions per candidate (unmodified) -> selectWithStableRefill
     (unmodified)
  -> final top-20 (backend tag ARM_A4_A3_REMEDIATION_LIVE)
```

## 4. Invariants (Section E) — verified, not merely asserted

```text
BM25 leg <= 100 / dense leg <= 100:      enforced by legCapK in code + offline test #11
wide pool <= 200 (post-merge, post-dedup): measured max 191 (candidate) / 198 (baseline)
                                            across all 101 real questions
every pool candidate R4-scored:           offline test #12/13; real run confirms
                                            a3_pass+a3_reject+a3_keep_unknown == wide_pool_size
                                            for every question (spot-checked)
R4 config == R4_wide_rrf_centric:         byte-identical file, never touched
A3 REJECT never in final_top20:           offline test #14; real run: 0 REJECT items ever
                                            found in any final_top20 across all 202 rows
final candidate count <= 20:              enforced by outputK slice
duplicate chunk_id in any top-20:          0/101 (baseline), 0/101 (candidate) -- measured
node_indices/provenance preserved:         full candidates[] array preserved end to end
                                            (never collapsed) -- verified in raw output
query embedding calls == 1/question:       offline test #10; worker code calls embedQuery()
                                            exactly once per handleSearch(), outside any pass loop
DB writes == 0:                            every code path used is SELECT-only (fetchEligibleChunkIds,
                                            bm25Search over an in-memory index, searchDocumentChunksByVector,
                                            fetchChunksByIds, fetchStagingSpans) -- no INSERT/UPDATE/
                                            DELETE anywhere in the call graph this turn added or used
existing files byte-unchanged:             `git diff --stat HEAD` against every file listed in the
                                            contract's §3 "unmodified" list is empty, verified before
                                            AND after the full implementation (see §8)
```

## 5. Offline tests (Section F) — 18 cases, run before any DEV_TUNE-101 result existed

```text
domain/agent-comparison/four-arm-ac/a4-a3-remediation-integration.test.mjs: 17/17 pass
  (cases 12+13 combined into one test) -- correction semantics (2), subtype relaxation +
  promotion (3), multi-date windows (2), periodic exclusion (1), BM25 zero-score drop (1),
  single embed call (1), leg caps (1), wide-pool/R4/A3 invariants (2), existing-backend
  non-regression (1), determinism (1), no hardcoded ids (1), zero Gold/QA/LLM dependency (1)
existing suites unaffected: qa-condition-mapper.test.mjs 18/18,
  arm_workers_condition_mapping_wiring.test.mjs 5/5,
  pytest tests/agents/test_arm_a4_a3_live_adapter.py 27/27
git diff --check: clean
```

## 6. Non-Gold smoke (Section G) — real Postgres + real KURE-v1, before any DEV_TUNE run

```text
readiness: arm_a4_a3_remediation_live_ready=true, kure_ready=true, bm25_document_count=442549
3 real, non-Gold questions (dated single-sale contract, Samsung Electronics half-year
  revenue, a correction-only query): all succeeded, wide_pool_size 182/200/190 (all <=200),
  0 duplicate chunk_ids, a3_pass+a3_reject+a3_keep_unknown consistent, latency 2.7s-19.7s
Found and fixed here (commit 693bca9, before any DEV_TUNE result): retrieval_pass/
  retrieval_group were coming back null on every real item because
  a4-wide-candidate-pool.mjs's own (unmodified) field-merge only passes through a fixed
  field set -- folded into `metadata` instead (still zero modification to that file);
  re-verified live: passes_seen now correctly reports [('base','primary'),('window','primary')]
  for a real dated question.
```

## 7. Retrieval DEV_TUNE-101 comparison (Section H) — full 101 questions, once each, real infra

```text
corpus/index:   fixed_kure_index_8fe191342205848d1d6a6123f38a54e7, 442549 records (unchanged)
KURE pin:       nlpai-lab/KURE-v1 @ 4ed4540949c70b7da2c74004a915e1f2d5e46e4f, dim 1024
conditions:     data/eval/devtune101_conditions.v2.jsonl, sha256 83d5b8a0... (unchanged)
Gold:           data/eval/phase1_devtune_gold.v0.1.jsonl, sha256 7941144c...f102b (unchanged)
data/index:     rebuilt this turn (worktree-local only, from the canonical DocumentIR at
                ~/Downloads/drive-download-20260804T043134Z-1-002, SHA-256-verified against
                every existing pin) -- doc_index_sha256/node_offsets_sha256 byte-for-byte
                match the already-recorded manifest pins from prior turns, enabling a REAL
                NodeStore-backed critical/minor/unresolved check (locator_checked=true),
                not --no-locator-check
scorer:         scripts/fourarm/score.py / src/dart_corpus/evaluation/fourarm.py, unmodified
runner:         scripts/fourarm/run_arm_a4_a3_live_family.py (new), one full batch per
                backend, no --limit, no partial re-run
```

| metric | ARM_A4_A3_LIVE (baseline, freshly re-run this turn) | ARM_A4_A3_REMEDIATION_LIVE (candidate) |
|---|---|---|
| Recall@5 | 0.8112 | **0.9056** |
| Recall@10 | 0.8776 | **0.9510** |
| Recall@20 | 0.9021 | **0.9685** |
| HIGH Recall@10 | 0.872 | **0.956** |
| LOW Recall@10 | 0.9167 | 0.9167 (unchanged) |
| LOW all-found@10 | 16/19 | 16/19 (unchanged) |
| critical | 0 | 0 |
| minor | 1 | 1 |
| unresolved | 21 | 21 |
| coarse (informational only) | 165 | 180 |
| zero-result questions | 6 | **4** |
| n_questions / n_errors | 101 / 0 | 101 / 0 |
| p50 / p95 / max latency (ms) | 248 / 1350 / 2053 | 260 / **1122** / 2754 |
| retrieval passes/question (candidate only; baseline is always 1 single pass by design) | -- | 0 passes: 4, 1 pass: 35, 2 passes: 59, 3 passes: 3 |
| retrieval pass item distribution (candidate) | -- | window/primary 829, base/primary 1003, base_relaxed/relaxed 81, window_relaxed/relaxed 14 |
| improved / regressed / unchanged (found@10, per-question, real NodeStore) | -- | **14 / 1 / 86** |
| date-anchored recovery (all_found@10 flip) | -- | 14 questions |
| subtype-narrowed recovery (subset of the above) | -- | 4 questions |

The baseline's own freshly re-measured Recall@10/HIGH Recall@10/LOW all-found@10/critical
(0.8776 / 0.872 / 16/19 / 0) match the task input's cited figures for the current A4 R4+A3
baseline **exactly** — an independent confirmation, not merely a trusted number.

The single regressed question (`author_0be4ca52605cfe6d48181d97`, HIGH segment, a
multi-period comparison question: "에코프로비엠의 연결기준 매출액은... 2023년 1분기와
2025년 1분기 사이... 변동") is unrelated to any of the remediation's targeted mechanisms
(it is not in the date-anchored or subtype-narrowed recovery sets) and does not flip
`all_found@10` in either direction — reported for completeness, not hidden.

## 8. Existing-file invariance (re-verified after the full implementation + Section H run)

```bash
git status --porcelain                # only work/ (gitignored) changed
git diff --stat HEAD -- <every file in the contract's §3 unmodified list>   # empty
```

Confirmed empty both immediately after implementation (§ commit 52cec86/693bca9) and again
now, after the full Section H run (no code was touched between the two checks).

## 9. Decision-rule application (fixed in the contract §9, before any DEV_TUNE result)

```text
critical == 0 (candidate)?                          YES (0)
Recall@10 >= baseline's own Recall@10?               YES (0.9510 >= 0.8776)
HIGH Recall@10 >= baseline's own HIGH Recall@10?     YES (0.956 >= 0.872)
LOW all-found@10 >= baseline's own LOW all-found@10? YES (16/19 >= 16/19, equal)
zero-result does not increase?                       YES (4 <= 6, decreased)
Recall@10 OR HIGH Recall@10 strictly improves?       YES (both strictly improve)
retrieval p95 <= 2x baseline's p95?                  YES (1122ms <= 2700ms; candidate is
                                                      actually faster than baseline)
```

All seven conditions hold → **`A4_A3_REMEDIATION_RECOMMENDED_FOR_QA`**.

## 10. Confirmations

```text
QA_Evidence_V2_or_DocumentBinder_touched:  false -- not read, not imported, not modified
HCX_or_any_LLM_call:                       none, anywhere in this turn's code or runs
DEV_CHECK_or_HOLDOUT_accessed:             false
frozen_submission_branch_modified:         false -- never checked out into this worktree
b30b909_wholesale_cherry_pick:             false -- only four-arm-retrieval-policy.mjs
                                            vendored verbatim (pure, arm-agnostic functions)
A4_candidate_pool_shrunk_to_40:            never -- 100/100/200 preserved and measured (§4, §7)
R4_weights_or_A3_rules_changed:            never
policy_weight_or_candidate_k_changed_after_seeing_a_result: none -- the contract (feb6b3e)
                                            was committed before any implementation; the one
                                            fix made (693bca9) was found via non-Gold smoke
                                            (Section G), before any DEV_TUNE-101 result existed
partial_question_reruns:                   none -- both DEV_TUNE-101 runs are the full,
                                            identical 101-question batch, once each
new_backend_opt_in_only:                   true -- ARM_A4_A3_LIVE's own worker/adapter code
                                            path is never touched or executed by the new backend
pr_created:                                false
force_amend_rebase_reset_used:             false
db_write_count:                            0
```

## 11. Final verdict

```text
A4_A3_REMEDIATION_RECOMMENDED_FOR_QA
```

The verified retrieval remediation, integrated into the A4 wide-pool + R4 reranker + A3
guard pipeline as a new, opt-in backend, improves Recall@5/10/20 and HIGH Recall@10
substantially (+8-9 points at k=10), reduces zero-result questions, and is actually
*faster* at p95 than the current baseline — with zero critical-severity locator
violations in either run and zero regression on any safety-relevant metric (LOW
Recall@10 and LOW all-found@10 are unchanged, not worse). This turn does not declare a
final QA model or submission winner — that remains an Owner decision outside this
turn's retrieval-only scope.
