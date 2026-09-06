# A4-A3-PLUS-QA-FINAL-INTEGRATION-V1 — Final Report

## 1. Pins

```text
qa_base_branch:        codex/a-plus-qa-full-index-smoke-v01
qa_base_commit:         61aad1652e3d943f0efb32aea2b7f088cbf6de64
freeze_commit:          0c5cd6e (docs: freeze ... before any result) — separate commit, before any
                        ARM_A4_A3_LIVE search/result was viewed
a4_a3_source_branch:    codex/fourarm-a4-a3-devtune-v01
a4_a3_source_commit:    3ee4462026126a0dd8fc5c99a6d83df510a84058
new worktree:           agent-a4-a3-plus-qa-final-v01
new branch:             codex/a4-a3-plus-qa-final-v01
selected reranker:      R4_wide_rrf_centric
```

All four source refs (qa base, wide pool `c9b4cb0`, reranker `0e4acf0`, A3 guard `9358e20`, and
the a4_a3_source_commit `3ee4462`) were verified present at the exact pinned commit on both
`origin` and `demo-ai-festival` before this turn started.

### Imported source blob SHAs (never copied — dynamically imported at runtime)

| file (inside `a4_a3_source_commit`) | blob sha1 |
|---|---|
| `a4-wide-candidate-pool.mjs` | `fedcfcbbafca5cdc873b5c32ec691419b144d4d7` |
| `a4-reranker-engine.mjs` | `bb7e735d6444fe79fdc22b2e1a6d3ad97684b317` |
| `a3-evidence-contradiction-guard.mjs` | `7dc7ce510e8c399c2de206870fb479ca1e9a506a` |
| `a4-reranker-configs.v1.json` | `ded8ac0535f2958fb1357b336f0348a32dada03a` |
| `a4-a3-retrieval-pipeline.mjs` | `a0fa3c8a30321677c6769ef3e9f3aed741cbcf7a` |
| `locator-provenance.mjs` | `5a313e5932fc934cad182883811ce63c48eeed84` |
| `four-arm-conditions-to-filter-mapper.mjs` | `91cb4749d7093b6d6fa4b7a16f6aa1248ac7908e` |
| `conditions-fixture.mjs` | `31acad25f5b4944dc4c07efc3af786e6e3c7c7c1` |

`reranker_config_sha256` (full `R4_wide_rrf_centric` config object) = `1af2f55c88629542d7118becfd84f6cf598a7df2734c3718bfb01570917ea495`, matching the freeze doc.

## 2. Backend architecture

No A4/A3 production module was copied into this repository and no four-arm-ac commit history
was merged. `scripts/arm_a4_a3_live_worker.mjs` is a NEW persistent stdin/stdout Node worker
(mirroring `scripts/arm_a_live_worker.mjs`'s architecture exactly: no HTTP server, one Postgres
client + one loaded BM25 index + one embedding adapter per process lifetime) that dynamically
`import()`s the pinned, unmodified four-arm-ac modules straight from
`agent-fourarm-a4-a3-devtune-v01` at the path given by `ARM_A4_A3_LIVE_IMPL_ROOT`.

Per question, the worker: does one KURE query embedding call, BM25 top-100 + dense top-100,
computes the original-A-compatible top-20 (fail-closed cross-checked by `buildWideCandidatePool`
itself), `buildWideCandidatePool()` (≤200), hydrates + SHA-verifies all candidate text,
`rankCandidatePool()` with the single, pinned `R4_wide_rrf_centric` config (full ranking, never
pre-truncated), recomputes A3's per-item decision via the SAME exported, pure functions the
pipeline itself uses internally (`extractQuestionConditions`/`extractEvidenceFacts`/
`detectEvidenceContradictions` — redundant computation on the already-pinned frozen pipeline
module, not a second implementation, done because `runQuestionPipeline()` itself does not surface
per-item decisions), `selectWithStableRefill()`, then renumbers the final list `rank` 1..20 while
preserving the original full-ranking position as `reranker_rank`.

`src/dart_detective/arm_a4_a3_live_worker_client.py` (subprocess/stdin-stdout transport, one
request in flight, transparent respawn on crash/timeout) and
`src/dart_detective/arm_a4_a3_live_adapter.py` (`ArmA4A3LiveRetriever` /
`ArmA4A3LiveServingRetriever` / `build_arm_a4_a3_live_serving_retriever`) mirror
`arm_a_live_worker_client.py` / `arm_a_live_adapter.py` 1:1 in shape, duplicated rather than
parameterized (different env vars, different worker script, different typed error codes; the
turn's own prohibitions forbid touching the existing `ARM_A_LIVE` files).

`arm_a_serving_bridge.py` gained one new constant (`RETRIEVAL_BACKEND_ARM_A4_A3_LIVE =
"ARM_A4_A3_LIVE"`) appended to `RETRIEVAL_BACKENDS`; `answer_api._build_retriever()` gained one
new `elif`-equivalent branch dispatching to it. `DEFAULT`, `ARM_A_FIXED_RRF`/
`ARM_A_FROZEN_REPLAY`, and `ARM_A_LIVE` are byte-for-byte behavior-unchanged (see §5). There is
no automatic fallback between backends — each is invoked explicitly, and a worker-side failure
surfaces as a typed error, never a silent retry against another backend.

## 3. Full-index verification

Confirmed directly against the running local infra before any search:

```text
retrieval_index_id:       fixed_kure_index_8fe191342205848d1d6a6123f38a54e7
index_status:             READY
record_count:             442549
unique_embedding_count:   441879
embedding_dimension:      1024
corpus_snapshot_id:       corpus_04750795e1a2d5c3
kure:                     nlpai-lab/KURE-v1 @ 4ed4540949c70b7da2c74004a915e1f2d5e46e4f, dim 1024
                          (confirmed live via /health, /info on http://127.0.0.1:58411)
```

## 4. Section G/H — full-index non-Gold smoke (real run)

10 real, Gold-unrelated questions (each a real, already-materialized chunk's own text, selected
by category-matching SQL against the full index — never from any Gold/DEV_TUNE/DEV_CHECK/HOLDOUT
fixture), spanning all 7 required categories, run through BOTH `ARM_A_LIVE` and `ARM_A4_A3_LIVE`
separately (no auto-fallback). Script: `scripts/a4_a3_full_index_smoke.mjs` (raw per-question
detail written to gitignored `work/`, never committed).

| category | A n | A4A3 n | pool | a3_reject | refill |
|---|---|---|---|---|---|
| multi_node_result | 20 | 20 | 156 | 58 | 6 |
| single_numeric_evidence | 20 | 20 | 170 | 0 | 0 |
| table_evidence | 20 | 20 | 105 | 0 | 0 |
| multiple_metrics | 20 | 20 | 117 | 11 | 0 |
| non_numeric_disclosure | 20 | 20 | 142 | 0 | 0 |
| scope_language_consolidated | 20 | 20 | 190 | 4 | 0 |
| scope_language_separate | 20 | 20 | 113 | 6 | 0 |
| period_language | 20 | 20 | 143 | 0 | 0 |
| period_language_table | 20 | 20 | 155 | 0 | 0 |
| table_evidence_2 | 20 | 20 | 178 | 0 | 0 |

All 10/10 succeeded on both backends (0 errors), all 10/10 self-hit (the probe's own chunk
appears in its own top-20), all final result counts = 20 (0 shortfall), all final `rank` sequences
1..20 contiguous, all `chunk_text_sha256` verified against freshly hydrated text, all `a3_decision`
values are `PASS`/`KEEP_UNKNOWN` only (never `REJECT` — verified structurally, `selectWithStableRefill`
drops REJECT before this point), 0 worker restarts on either backend across all 10 questions, 0 DB
writes (both workers issue only `SELECT`, verified by source grep). The `multi_node_result`
question is the one that exercised the REJECT+refill path for real: 58 of 156 pool candidates were
rejected (scope/period/unit contradiction against the question's own conditions) and 6 slots were
stably backfilled from later-ranked survivors — the final top-20 stayed at exactly 20 with no
shortfall.

## 5. Section H — performance

| metric | ARM_A_LIVE | ARM_A4_A3_LIVE |
|---|---|---|
| p50 latency | 22,003 ms | 2,133 ms |
| p95 latency | 31,672 ms | 4,343 ms |
| max latency | 31,672 ms | 4,343 ms |
| worker peak RSS | 2,609 MB | 3,179 MB |
| worker restarts | 0 | 0 |

Additional `ARM_A4_A3_LIVE`-only aggregates: average pool size 146.9, total A3 REJECT 79, total
A3 KEEP_UNKNOWN 363, total stable refills 6, shortfall question count 0, DB write count 0. No new
latency threshold is used to fail this result — per the governing turn's instructions, only
OOM/crash/repeated-timeout/insufficient-results would be blockers, and none occurred.
`ARM_A4_A3_LIVE` was, in this run, markedly *faster* than `ARM_A_LIVE` per question — plausibly
because its BM25/dense candidate generation and RRF/rerank stages reuse one shared per-question
computation path more efficiently than the frozen `arm-retriever-adapter.mjs` search does, but
this was not investigated further as it is outside this turn's scope (not a blocker either way).

Determinism check (separate from the 10-question smoke, same running worker, same question run
twice back-to-back): byte-identical `results` array both times.

## 6. Section F — 24 contract tests

- **#1–3 (pinned module blob identity)**: `tests/agents/test_arm_a4_a3_live_adapter.py::test_pinned_module_blob_matches_frozen_commit` (parametrized over wide-pool/reranker/A3-guard/config-file blob SHAs against `a4_a3_source_commit` via `git rev-parse <commit>:<path>`) — 4/4 pass.
- **#4 (R4 config SHA matches freeze doc)**: `test_r4_config_sha256_matches_freeze_doc` — pass.
- **#5–13, #16 (full-ranking/no-truncation/REJECT-only-removal/refill-order/rank-contiguity/original-rank-preservation/pool-ceiling)**: already exhaustively proven, byte-identical, by the pinned `a4-a3-integration.test.mjs` (15 D-tests) and `a4-reranker-engine` test suite (52 tests) inside the frozen `a4_a3_source_commit` — re-implementing them here would be redundant, not additional coverage; this turn instead re-asserts, at the worker/adapter layer, that nothing is lost/corrupted in transport (`test_reranker_rank_preserved_distinct_from_final_rank`, `test_multi_node_indices_fully_preserved`, `test_rank_order_preserved`, `test_reranker_config_tag_present`), and the real Section G smoke independently exercised the REJECT+refill path live (58 rejects / 6 refills, final count still 20).
- **#14/#15 (text-SHA / document-ID mismatch fail-closed)**: `test_sha_mismatch_fails_closed`, `test_empty_text_fails_closed`, `test_missing_document_id_fails_closed` — pass.
- **#7 (only REJECT removed)**: `test_reject_decision_reaching_adapter_fails_closed` (a REJECT decision reaching this layer is a fail-closed internal-inconsistency error, both in the worker's own throw and the adapter's `_verify_item` check) — pass.
- **#17 (identical input → byte-identical output)**: `test_conversion_is_deterministic` (unit) + the live worker determinism check above (real infra) — pass.
- **#18 (worker initializes once, serves multiple questions)**: proven live — 1 `worker_started` event, 10 successful searches, 0 restarts (§4/§5).
- **#19 (zero `A.results.jsonl` access)**: `test_module_never_reads_frozen_replay_or_gold_paths` (source-scans the adapter's code, excluding its own docstring, for `A.results.jsonl`/`ARM_A_RESULTS_PATH`/`DEV_TUNE`/`DEV_CHECK`/`HOLDOUT`/`gold`) — pass.
- **#20 (zero B/D fallback)**: `test_search_failure_raises_not_falls_back`, `test_not_ready_refuses_to_search_at_all` — pass; also structurally true (`_build_retriever()`'s new branch returns directly, no `except`-and-fallback wrapper).
- **#21 (zero DB writes)**: `test_worker_source_never_issues_a_write_statement` (source-grep for `INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`ALTER`) — pass; live smoke also recorded `db_write_count: 0`.
- **#22 (existing `ARM_A_LIVE` regression tests still pass)**: full `tests/agents/test_arm_a_live_adapter.py` suite (part of the 848-pass full run, §7) — pass; `test_arm_a_live_backend_still_selectable_after_arm_a4_a3_live_added` and `test_backend_registry_is_additive` re-assert this at the new adapter's own test layer.
- **#23 (existing QA core logic unchanged)**: `qa_agent.py`, `validator.py`, `corpus_retriever.py`, `retriever_adapter.py` are byte-identical to their pinned hashes (verified directly via `shasum -a 256`, §7); only `answer_api.py` was intentionally, additively changed (one import, one dispatch branch) — its pin in `tests/agents/test_arm_a_adapter.py` was updated to the new byte hash, exactly the same discipline the prior `ARM_A_LIVE` turn already used for the same file.
- **#24 (zero DEV_TUNE/DEV_CHECK/HOLDOUT/Gold access)**: same source-scan as #19, plus manual review — no such path, file, or import appears anywhere in the new code.

26/26 tests in `tests/agents/test_arm_a4_a3_live_adapter.py` pass (24 required + 2 incidental
coverage tests written along the way).

## 7. Verification run

```text
node --check scripts/arm_a4_a3_live_worker.mjs         -> OK
node --check scripts/a4_a3_full_index_smoke.mjs         -> OK
python3 -m pytest tests/agents/test_arm_a4_a3_live_adapter.py -q   -> 26 passed
python3 -m pytest tests/ -q --ignore=tests/contract --ignore=tests/parsing
    -> 848 passed, 7 skipped, 0 failed
git diff --check                                        -> clean
```

`tests/contract/*` and `tests/parsing/*` (26 errors, pre-existing, unrelated to this turn) fail
fixture setup because this environment has no local raw corpus directory
(`data/3.공시/corpus`) checked out — confirmed by reading the actual error
(`AssertionError: corpus root not found: .../data/3.공시/corpus`), not something this turn's
changes could have caused (nothing this turn touched imports or exercises that fixture).

Personal-path/secret/DB-URL scan: the freeze doc's local Postgres connection string
(`postgresql://jaewan@127.0.0.1:55329/p11f0_scratch`, no password, peer-auth localhost-only)
matches this same repository's own already-committed convention in
`docs/reports/A_PLUS_QA_FULL_INDEX_SMOKE_V1.md`; the one hardcoded personal worktree path in the
new test file (`IMPL_ROOT_CANDIDATE`, used only to skip a test when that worktree is absent)
matches the identical, already-committed convention in `tests/agents/test_arm_a_live_full_index_smoke.py`.
No API key, password, or other credential appears anywhere in the new/modified files. No
`pyright`/`mypy` is configured for this project (`pyproject.toml` has no such tool); this is
reported explicitly rather than silently skipped.

No linked npm/`package.json` exists in this Python repository, so "Node scoped tests" here means
`node --check` on the two new `.mjs` files plus the real, live subprocess runs already performed
(§4/§5) — there is no Node test runner configured in this repo to invoke separately.

## 8. Section I — QA/judge34-equivalent comparison

`CLOVA_API_KEY` is not set in this environment (confirmed before any search was run — recorded in
the freeze doc at freeze time, §"infra pins ... verified at freeze time"). `get_llm()` therefore
returns `None`, and no HyperCLOVA X call can be made. Per this turn's own instructions, no mock/
fabricated QA result is produced. Retrieval-only integration results (§3–§7) stand on their own;
the judge34-equivalent comparison against existing A+QA is `BLOCKED_EXTERNAL_QA_PROVIDER`.

## 9. Verdict

```text
A4_A3_LIVE_READY_QA_PROVIDER_CHECK_PENDING
```

Retrieval integration is fully GREEN: all pinned component blobs verified, all 24 Section F
contract checks pass, the 10-question Section G full-index smoke succeeds with zero errors/OOM/
crashes/restarts/shortfalls across all 7 required categories, determinism is confirmed live, and
the existing `ARM_A_LIVE`/`ARM_A_FIXED_RRF`/`DEFAULT` paths remain byte-unchanged and fully
passing (848/848 in the applicable suite). The only missing piece is Section I's judge34-
equivalent QA/E2E comparison, blocked purely by the absence of a configured `CLOVA_API_KEY` in
this environment — not by any retrieval-side defect. Per Section J, `DEV_CHECK` was NOT opened
this turn under any circumstance, and will not be until a separate future approval explicitly
authorizes exactly one run following a `READY_FOR_FINAL_CHECK`-class verdict — which this is not.

## 10. Confirmations

```text
db_write_count:                 0
existing_arm_a_live_fallback:   preserved, unmodified, fully passing
dev_check_accessed:             false
holdout_accessed:                false
gold_accessed:                   false (this worker/adapter never imports or opens any Gold/
                                  DEV_TUNE/DEV_CHECK/HOLDOUT file; the smoke questions are real
                                  chunks' own text, not Gold fixtures)
pr_created:                      false
force_amend_rebase_reset_used:   false
```
