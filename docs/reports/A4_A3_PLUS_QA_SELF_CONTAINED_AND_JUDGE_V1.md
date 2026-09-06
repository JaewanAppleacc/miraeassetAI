# A4-A3-PLUS-QA-SELF-CONTAINED-AND-JUDGE-V1 — Final Report

## 1. Pins

```text
worktree:                agent-a4-a3-plus-qa-final-v01
branch:                  codex/a4-a3-plus-qa-final-v01
base (start of this turn): c03b4d7faa2eaf2167bb77acc342d573bfff17df
amendment commit:        1e39bbb (docs: pre-register judge34 comparison spec ...)
self-contained commit:   c23640b (feat: make ARM_A4_A3_LIVE self-contained ...)
final commit:            (this report's own commit, see §9)
a4_a3_source_commit:     3ee4462026126a0dd8fc5c99a6d83df510a84058 (codex/fourarm-a4-a3-devtune-v01)
```

Start-of-turn verification (Section A): local/origin/demo-ai-festival all at `c03b4d7`, working
tree clean, freeze commit (`0c5cd6e`) and full-index smoke results present, existing A backend
tests GREEN, A4+A3 smoke tests GREEN, no other writer on this worktree.

## 2. Self-contained packaging (Section C-E)

Traced the worker's dynamic-import graph mechanically (`node` script following every relative
`import` from `a4-a3-retrieval-pipeline.mjs`, `four-arm-conditions-to-filter-mapper.mjs`,
`a3-evidence-contradiction-guard.mjs`, `arm-retriever-adapter.mjs`, `embedding-adapter.mjs`,
`fixed-kure-bm25-index.mjs`), then vendored every reachable production file byte-identical into
this repository under `domain/`. One additional runtime dependency was found only after actually
*running* the vendored code (a `readFileSync` of a JSON schema file, not an ESM `import`, so the
mechanical import-graph trace could not see it): `domain/agent-comparison/retrieval/embedding-adapter.mjs`
→ `contracts.mjs` reads `interfaces/embedding-config.schema.json` at load time. This was found and
fixed BEFORE any Section F/G result was produced (same "wiring bug found via non-Gold check, fixed
pre-result" discipline this project has used before) — the pre-registered amendment says 22 files;
the actual, complete, working set is **23 files** (22 code modules + 1 JSON schema), all recorded
in `config/a4-a3-runtime-source-manifest.v1.json` with `byte_identical: true` for all 23.

`pg`, `ajv`, and `ajv-formats` (external npm packages two of the vendored files need) are now
declared in this repository's own `package.json`/`package-lock.json`, pinned to the exact versions
the source worktree uses (`pg@8.23.0`, `ajv@8.20.0`, `ajv-formats@3.0.1`), installed via a normal
`npm install` — not borrowed from another worktree's `node_modules`.

`scripts/arm_a4_a3_live_worker.mjs` no longer reads `ARM_A4_A3_LIVE_IMPL_ROOT` at all. Every module
path is resolved via `path.dirname(fileURLToPath(import.meta.url))`, and `pg` is resolved via
`createRequire(import.meta.url)` — both independent of `process.cwd()` and of any other Codex
worktree existing on the machine.

Excluded by design: no test file, no Gold/DEV_TUNE/DEV_CHECK/HOLDOUT fixture, no raw corpus/
DocumentIR artifact, and `domain/agent-comparison/retrieval/interfaces/examples/` (a fixture
directory `contracts.mjs` never reads at runtime) — see the manifest's `excluded_by_design` list.

## 3. Included production files and blob SHAs

All 23 vendored files, their source commit (`3ee4462026126a0dd8fc5c99a6d83df510a84058` — the
already-verified branch head containing the earlier wide-pool/reranker/A3-guard component
commits merged in), and `byte_identical: true` for every one are recorded in
`config/a4-a3-runtime-source-manifest.v1.json`. Summary:

```text
domain/agent-comparison/chunking-comparison/bm25.mjs
domain/agent-comparison/chunking-comparison/rrf.mjs
domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs
domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs
domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs
domain/agent-comparison/four-arm-ac/a4-reranker-features.mjs
domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json
domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs
domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs
domain/agent-comparison/four-arm-ac/conditions-fixture.mjs
domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs
domain/agent-comparison/four-arm-ac/locator-provenance.mjs
domain/agent-comparison/retrieval/contracts.mjs
domain/agent-comparison/retrieval/embedding-adapter.mjs
domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs
domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs
domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs
domain/agent-comparison/retrieval/interfaces/embedding-config.schema.json
domain/chunking/chunker.mjs
domain/contracts.mjs
domain/postgres/reference-vector-retrieval-repository.mjs
domain/retrieval/metadata-filter.mjs
domain/runtime/abortable.mjs
```

`fake-deterministic-embedding-adapter.mjs` and `fixed-kure-hybrid-retriever-adapter.mjs`/
`chunker.mjs`/`bm25.mjs` are pulled in only as unconditional top-level imports of files this worker
genuinely calls (`embedding-adapter.mjs`, `arm-retriever-adapter.mjs`) — real production code,
never exercised by this worker's own call paths (it always requests `kind: "HTTP_EMBEDDINGS"` and
never calls Arm A/C's own search functions), included because ES module semantics require the
whole file to load.

## 4. Clean-checkout reproducibility (Section F)

`scripts/a4_a3_clean_checkout_smoke.sh` (new, added this turn) clones the branch's committed HEAD
into a fresh `mktemp` directory outside any Codex worktree path, then:

```text
1. npm install (clean, from the committed package.json/package-lock.json)      -> OK
2. node --check on both worker scripts                                         -> OK
3. python import of arm_a4_a3_live_adapter / arm_a4_a3_live_worker_client      -> OK
   (asserts ARM_A4_A3_LIVE_IMPL_ROOT not in REQUIRED_ENV_VARS)                 -> OK
4. readiness (ARM_A4_A3_LIVE_IMPL_ROOT and ARM_A_LIVE_IMPL_ROOT both unset)     -> arm_a4_a3_live_ready=true
5. 3 real, non-Gold questions through the full A4 pool -> R4 -> A3 -> refill
   -> top-20 pipeline against the real 442,549-chunk index                     -> 3/3 succeeded
6. handoff to the Python QA dispatcher (answer_api.answer_ex, real worker,
   base_factory=None since the optional data/index/doc_index.jsonl line-window
   base is not present in this environment for EITHER backend — a pre-existing,
   gitignored local-data precondition unrelated to this turn's self-containment
   work, see note below)                                                       -> EXECUTION_MODE=RETRIEVAL, non-empty retrieved_context, no error
7. worker shutdown                                                              -> clean
8. external-worktree file-handle check (lsof on the worker's own pid, grepped
   for any /Documents/Codex/worktrees/ path outside the clean checkout itself)  -> 0 hits
```

This was run manually this turn (captured above) and is now also committed as a reusable script
for future re-verification.

**Note on `data/index/doc_index.jsonl`**: `build_line_window_retriever`'s default `base_factory`
(shared by both `ARM_A_LIVE` and `ARM_A4_A3_LIVE`) reads this file, which is `.gitignore`d
(`data/index/`) and does not exist even in the original, non-clean development worktree in this
environment — this is a pre-existing condition of the whole `data/index/` local-artifact
convention, not something introduced or broken by this turn's self-containment work. The existing
test suite already works around it the same way (`tests/agents/test_arm_a_live_adapter.py`'s and
`test_arm_a4_a3_live_adapter.py`'s own `_fake_base_factory`/`base_factory=None`).

## 5. Full-index re-verification (Section G, self-contained runtime)

Re-ran `scripts/a4_a3_full_index_smoke.mjs` (now updated so the `ARM_A4_A3_LIVE` side needs no
impl-root env var at all; `ARM_A_LIVE`'s own side is unchanged/still external by design) against
the real 442,549-chunk READY index, same 10 questions/7 categories as the prior turn's smoke:

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

Identical per-question pool/reject/refill numbers to the pre-vendoring run (prior report,
`A4_A3_PLUS_QA_FINAL_INTEGRATION_V1.md` §4) — confirms vendoring changed zero retrieval behavior.

```text
arm_a_live:      success 10/10, self_hit 10/10, worker_restart_count 0,
                 p50 21195ms, p95 31608ms, max 31608ms, peak RSS 3276MB
arm_a4_a3_live:  success 10/10, self_hit 10/10, worker_restart_count 0,
                 p50 1629ms, p95 4113ms, max 4113ms, peak RSS 3996MB
                 average_pool_size 146.9, total_a3_reject 79, total_a3_keep_unknown 363,
                 total_refill 6, shortfall_question_count 0,
                 all_rank_contiguous true, all_sha_verified true, all_a3_decision_valid true
db_write_count:  0
```

No new latency threshold was used to fail this result; only OOM/crash/repeated-timeout/shortfall
would be blockers, and none occurred. The one question with a high reject count
(`multi_node_result`, 58/156) reproduced exactly as before — the rule was not touched.

## 6. CLOVA provider gate (Section H)

Checked existence only (never the value): `CLOVA_API_KEY` is **not set** in this environment. No
key value was printed, logged, or requested from the user. No mock QA result was fabricated.

```text
SELF_CONTAINED_RUNTIME_GREEN
QA_JUDGE_BLOCKED_EXTERNAL_PROVIDER
```

Section I (the judge34 comparison) was **not run** — per the governing turn's own gate, it only
runs when a provider key is present. The self-contained runtime fix and its verification are
committed/pushed regardless (Section H's explicit instruction).

## 7. Verification run

```text
python3 -m pytest tests/agents/test_arm_a4_a3_live_adapter.py -q       -> 27 passed
python3 -m pytest tests/ -q --ignore=tests/contract --ignore=tests/parsing
    -> 849 passed, 7 skipped, 0 failed (in ~192s; the ARM_A_LIVE full-index smoke test genuinely
       exercises the real infra now that it's available, hence the longer wall time — not a hang)
node --check scripts/arm_a4_a3_live_worker.mjs          -> OK
node --check scripts/a4_a3_full_index_smoke.mjs         -> OK
node --check scripts/a4_a3_clean_checkout_smoke.sh (bash -n)  -> OK
git diff --check                                        -> clean
```

`tests/contract/*` and `tests/parsing/*` remain excluded for the same pre-existing reason as the
prior turn (`data/3.공시/corpus` not present locally) — unrelated to this turn's changes.

Personal-path/secret/DB-URL scan on every new/modified file: no API key, password, or credential
found anywhere. The one already-accepted local Postgres connection-string convention
(`postgresql://jaewan@127.0.0.1:55329/p11f0_scratch`, no password, peer-auth localhost-only)
continues to match this repository's own already-committed precedent
(`docs/reports/A_PLUS_QA_FULL_INDEX_SMOKE_V1.md`). No `pyright`/`mypy` is configured for this
project — reported explicitly rather than silently skipped, same as last turn.

## 8. Confirmations

```text
external_worktree_runtime_dependency:  removed (0 file handles opened outside the clean checkout
                                        during Section F's real search run)
db_write_count:                        0
dev_check_accessed:                    false
holdout_accessed:                      false
gold_accessed:                         false
clova_api_key_value_exposed:           never (existence-only check)
mock_qa_result_fabricated:             false
pr_created:                            false
force_amend_rebase_reset_used:         false
existing_arm_a_live_fallback:          preserved, unmodified (own worktree dependency untouched)
```

## 9. Final verdict

```text
A4_A3_RUNTIME_READY_QA_PROVIDER_CHECK_PENDING
```

Self-contained packaging is fully GREEN: clean-checkout reproducibility holds with zero external
worktree dependency, the full-index re-verification against the real 442,549-chunk index reproduces
identical retrieval behavior to before vendoring, and the full existing test suite remains green
(849/849 applicable). The only remaining gap to a `A4_A3_PLUS_QA_READY_FOR_FINAL_CHECK` verdict is
Section I's judge34-equivalent comparison, blocked purely by the absence of a configured
`CLOVA_API_KEY` in this environment. `DEV_CHECK`/`HOLDOUT` were not opened this turn, and will not
be until a separate future approval explicitly authorizes exactly one run after a
`READY_FOR_FINAL_CHECK`-class verdict — which this is not.

## 10. Push

Committed as new commits on the existing branch `codex/a4-a3-plus-qa-final-v01` (no amend/force/
rebase/reset), pushed to `origin` and `demo-ai-festival`, no PR created.
