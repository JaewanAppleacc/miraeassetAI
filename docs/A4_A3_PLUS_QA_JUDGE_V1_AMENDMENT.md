# A4-A3-PLUS-QA-SELF-CONTAINED-AND-JUDGE-V1 — Amendment

Turn A4-A3-PLUS-QA-SELF-CONTAINED-AND-JUDGE-V1. Written and committed BEFORE any new QA/judge
result (Section I) is viewed. Fixes the comparison methodology and the pass/fail decision rule so
neither can be adjusted after seeing a result.

## Starting-point verification (Section A, done before this document)

```text
worktree:            agent-a4-a3-plus-qa-final-v01
branch:              codex/a4-a3-plus-qa-final-v01
HEAD (local):        c03b4d7faa2eaf2167bb77acc342d573bfff17df
HEAD (origin):       c03b4d7faa2eaf2167bb77acc342d573bfff17df   (fetched fresh, matches)
HEAD (demo-ai-festival): c03b4d7faa2eaf2167bb77acc342d573bfff17df (fetched fresh, matches)
working tree:        clean
freeze commit:       0c5cd6e (docs: freeze A4-A3-PLUS-QA-FINAL-INTEGRATION-V1 pins before any result)
full-index smoke:    present (docs/reports/A4_A3_PLUS_QA_FINAL_INTEGRATION_V1.md, §4-5 — 10/10
                     questions succeeded on both ARM_A_LIVE and ARM_A4_A3_LIVE, 0 errors/restarts/shortfalls)
existing A backend tests: GREEN (re-run this turn: see verification log)
A4+A3 smoke tests:   GREEN (26/26 in tests/agents/test_arm_a4_a3_live_adapter.py, re-run this turn)
original result/run/scorer files: unchanged (this turn touches only this worktree's own files;
                     the four-arm-ac devtune worktree/branch is not written to)
other writers:       none found on this worktree (lsof/git-lock check, single shell owner)
```

## Comparison specification (fixed before any result)

```yaml
baseline_backend: ARM_A_LIVE
candidate_backend: ARM_A4_A3_LIVE
candidate_reranker: R4_wide_rrf_centric
candidate_guard: A3_CONTRADICTION_GUARD_V1
question_set: the existing, already-approved judge34 set (results/judge34/'s own 34 questions)
question_count: 34
qa_code: byte-identical between the two backend runs — only DART_QA_RETRIEVAL_BACKEND differs
provider: identical (whatever get_llm() resolves to when CLOVA_API_KEY is present — HyperCLOVA X only, per CLAUDE.md §3)
model: identical (CLOVA_MODEL env / CLOVA_DEFAULT_MODEL, unchanged between runs)
temperature: identical (existing DART_QA_FC_TEMPERATURE fixed value, default 0.1, unchanged)
max_tokens: identical (existing fixed value, unchanged)
seed: identical (existing DART_QA_SEED fixed value, default 42, unchanged)
```

## Decision rule (fixed before any result)

`ARM_A4_A3_LIVE` becomes a final-check candidate ONLY if ALL of the following hold, comparing
against the SAME-run `ARM_A_LIVE` + QA result on the identical 34 questions:

```text
execution_errors == 0
citation_validity        >= same-run ARM_A_LIVE
answerability             >= same-run ARM_A_LIVE
numeric_correctness       >= same-run ARM_A_LIVE
groundedness              >= same-run ARM_A_LIVE
weighted_score            >= same-run ARM_A_LIVE
critical_evidence_errors == 0
```

If even one of these regresses, today's submission backend stays `ARM_A_LIVE`. A tie keeps the
existing, simpler `ARM_A_LIVE` + QA. After seeing a result: no QA prompt change, no R4 weight
change, no A3 rule change, no partial re-run, no new exception rule.

## Self-contained packaging scope (Section C-E, fixed before any result)

The full import graph reachable from `scripts/arm_a4_a3_live_worker.mjs`'s dynamic imports was
traced mechanically (not guessed) starting from `a4-a3-retrieval-pipeline.mjs`,
`four-arm-conditions-to-filter-mapper.mjs`, `a3-evidence-contradiction-guard.mjs`,
`arm-retriever-adapter.mjs` (for `KURE_PIN`), `embedding-adapter.mjs`, and
`fixed-kure-bm25-index.mjs`, resolving every relative (`./`/`../`) `import` recursively. This
produced 21 production files (listed in `config/a4-a3-runtime-source-manifest.v1.json`), all taken
byte-identical from `codex/fourarm-a4-a3-devtune-v01` @ `3ee4462026126a0dd8fc5c99a6d83df510a84058`.
No test file, Gold fixture, result file, or raw artifact is part of this graph — confirmed by
inspecting every traced path (all under `domain/`, none under `tests/`, `work/`, `results/`, or
`domain/evaluation/`). `fake-deterministic-embedding-adapter.mjs` and
`fixed-kure-hybrid-retriever-adapter.mjs`/`chunker.mjs`/`bm25.mjs` are pulled in only because they
are unconditional top-level imports of files this worker genuinely needs
(`embedding-adapter.mjs`, `arm-retriever-adapter.mjs`) — they are real production code, never
exercised at runtime by this worker's own logic (it always requests `kind: "HTTP_EMBEDDINGS"` and
never calls Arm A/C's own search functions), but ES module semantics require the whole file to
load successfully, so they are included rather than stubbed.

`pg` (the Postgres client) is added as a normal npm dependency of this repository
(`package.json`, pinned to `8.23.0` — the same version the source worktree uses) instead of being
borrowed from another worktree's `node_modules` via `ARM_A_LIVE_IMPL_ROOT`-style path
injection. This is standard package management, not an exception to the "no external worktree
dependency" rule.
