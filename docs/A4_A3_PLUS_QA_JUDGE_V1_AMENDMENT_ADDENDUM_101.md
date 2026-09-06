# A4-A3-PLUS-QA-JUDGE-V1 Amendment — Addendum (question-set correction to 101)

Written and committed BEFORE any new `ARM_A_LIVE`/`ARM_A4_A3_LIVE` + QA result from this
addendum's corrected spec is produced or viewed (same discipline as the amendment itself).
This corrects exactly one factual error in `docs/A4_A3_PLUS_QA_JUDGE_V1_AMENDMENT.md`
(§ Comparison specification) and changes nothing else in it — no R4 weight, no A3 rule, no
extractor, no prompt, no decision rule.

## What was wrong

The amendment stated:

```yaml
question_set: the existing, already-approved judge34 set (results/judge34/'s own 34 questions)
question_count: 34
```

This was a misreading. `results/judge34/` is the **34th sequential judge-quality-iteration
directory** in this project's long-running history (`results/judge` → `judge2` → … →
`judge33` → renamed to `judge34` by commit `0c92abb`), and every one of those iterations
— judge1 through judge34 — always scored the **full 101-question DEV_TUNE Gold set**.
"34" names the iteration, not a question count. `results/judge34/judge.jsonl` has 101
rows; `results/judge34/summary.json` records `"n": 101, "answerability_ok": 101`. This
was confirmed and reported, without executing any question, in
`docs/reports/A4_A3_PLUS_QA_JUDGE34_V1.md` (verdict `BLOCKED_CONTRACT`), and the Owner has
now confirmed this reading is correct.

## Correction (the only change)

```yaml
question_set: DEV_TUNE 101 Gold (the same set every judge1..judge34 iteration scored)
question_source_file: data/eval/phase1_devtune_gold.v0.1.jsonl
question_source_sha256: 7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b
question_count: 101
```

Everything else in `docs/A4_A3_PLUS_QA_JUDGE_V1_AMENDMENT.md` — the comparison spec's
`baseline_backend`/`candidate_backend`/`candidate_reranker`/`candidate_guard`/`qa_code`/
`provider`/`model`/`temperature`/`max_tokens`/`seed` fields, and the entire Decision rule
section (same-run comparison, all seven metrics must hold or tie loses, no partial re-run,
no post-result prompt/R4/A3/extractor change) — is unchanged and still governs this turn.

## Execution runner (fixed before any result, not itself an experiment variable)

`scripts/judge_devtune.py` is the existing, unmodified scorer used for every prior
judge1..judge34 iteration (reads `--gold` DEV_TUNE 101, calls `answer_api.answer_ex`
once per question, writes `wires.jsonl`/`judge.jsonl`/`summary.json`). It has no flag to
select `DART_QA_RETRIEVAL_BACKEND` or to pass adapter-level Python kwargs (e.g.
`base_factory`), so a thin, uncommitted driver under `work/` (gitignored, not part of the
graded/frozen code) calls `answer_api.configure(retrieval_backend=<ARM>, base_factory=None)`
once at process start, then executes `scripts/judge_devtune.py`'s own unmodified `main()`
via `runpy` with only `--out-dir` supplied. `base_factory=None` is not a new decision: it
is the same, already-used, already-reported workaround
(`docs/reports/A4_A3_PLUS_QA_SELF_CONTAINED_AND_JUDGE_V1.md` §4, "base_factory=None since
the optional data/index/doc_index.jsonl line-window base is not present in this
environment for EITHER backend") for one pre-existing, gitignored, environment-local
artifact (`data/index/doc_index.jsonl`, rebuildable only from the 8GB DocumentIR source,
which is not present on this machine) that both backends already lack identically — it is
applied byte-identically to both `ARM_A_LIVE` and `ARM_A4_A3_LIVE` runs, so it cannot favor
either side of the comparison. No other environment variable, weight, rule, or prompt
differs between the two runs besides `DART_QA_RETRIEVAL_BACKEND` and each backend's own
already-frozen `ARM_A_LIVE_*` / `ARM_A4_A3_LIVE_*` infra pins (DB URL, retrieval index id,
load session ids, KURE server URL, BM25 cache dir — all recorded in
`docs/A4_A3_PLUS_QA_FINAL_V1_FREEZE.md`).

## Pins re-verified at addendum time (before either run)

```text
worktree:            agent-a4-a3-plus-qa-final-v01
branch:              codex/a4-a3-plus-qa-final-v01
HEAD (local):        038f695 (docs: report judge34 comparison BLOCKED_CONTRACT ...)
HEAD (origin):       038f695  (fetched fresh, matches)
HEAD (demo-ai-festival): 038f695  (fetched fresh, matches)
working tree:        clean
KURE-v1 server:      http://127.0.0.1:58411 — /health {"status":"ok"}, /info
                     repository_id=nlpai-lab/KURE-v1, model_revision=4ed4540949c70b7da2c74004a915e1f2d5e46e4f,
                     embedding_dimension=1024 (matches KURE_PIN in both adapters)
ARM_A4_A3_LIVE readiness: arm_a4_a3_live_ready=true, kure_ready=true, bm25_document_count=442549
ARM_A_LIVE readiness:     arm_a_live_ready=true, official_experiment_ready=true, bm25_document_count=442549
CLOVA_API_KEY:       present (existence-only check; value never read/printed)
CLOVA_MODEL:         unset -> default HCX-005 (llm.py CLOVA_DEFAULT_MODEL), identical both runs
DART_QA_FC_TEMPERATURE: unset -> default 0.1, identical both runs
DART_QA_SEED:        unset -> default 42, identical both runs
DART_QA_LATE_EXPANSION / DART_QA_EXPANDED_RETRIEVAL: unset -> both OFF, identical both runs
DEV_CHECK/HOLDOUT:   not accessed
```
