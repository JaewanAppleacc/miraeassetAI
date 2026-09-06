# A4/A3 QA(HCX) Comparison — ARM_A4_A3_LIVE vs ARM_A4_A3_REMEDIATION_LIVE

Full DEV_TUNE-101 comparison at the QA-serving level (real HyperCLOVA X calls), on the
same branch, same code, same conditions. No verdict/decision rule was requested this
time — this is a metrics report.

## 0. Pins

```text
branch:                codex/a4-a3-remediation-integration-v01
verified remote SHA:   b5f9443f7ca3ec2d57c2d17453070ab23c4a6341
                        (confirmed identical on origin and demo-ai-festival via
                        `git ls-remote` immediately before this run; local worktree
                        HEAD matched exactly, working tree clean)
question set:          data/eval/phase1_devtune_gold.v0.1.jsonl (DEV_TUNE-101), unchanged
scorer/runner:         scripts/judge_devtune.py, unmodified
QA code:                byte-identical between the two runs -- only the retrieval backend differs
CLOVA_API_KEY:          present (existence-only check; value never read/printed)
CLOVA_MODEL / DART_QA_FC_TEMPERATURE / DART_QA_SEED: unset -> defaults (HCX-005, 0.1, 42),
                        identical for both runs
DART_QA_LATE_EXPANSION / DART_QA_EXPANDED_RETRIEVAL: unset -> both OFF, identical
DEV_CHECK / HOLDOUT:    not accessed
Evidence V2 / DocumentBinder: not touched, not imported
```

## 1. How the second backend was wired in, without modifying any existing file

`ARM_A4_A3_REMEDIATION_LIVE` is not registered in `arm_a_serving_bridge.RETRIEVAL_BACKENDS`
by design (the prior integration turn's own declared scope excluded `answer_api.py`
wiring). Adding it there was attempted and then reverted this turn after discovering that
`tests/agents/test_arm_a_adapter.py::test_existing_qa_files_byte_unchanged` pins an exact
SHA-256 for `answer_api.py` ("B/D 경로 불변 위반" guard) — confirmed empirically (the test
failed on the attempted addition). Both `answer_api.py` and `arm_a_serving_bridge.py` were
reverted to their exact committed state (`git diff --stat` against HEAD is empty for both,
verified before this run).

Instead, a small, uncommitted, gitignored driver (`work/run_judge101_a4a3_backend.py`) uses
`answer_api`'s own already-public, already-existing extension points:
- `ARM_A4_A3_LIVE`: `answer_api.configure(retrieval_backend="ARM_A4_A3_LIVE", base_factory=None)`
  — the existing, already-wired path, unchanged.
- `ARM_A4_A3_REMEDIATION_LIVE`: builds the retriever directly via
  `arm_a4_a3_remediation_live_adapter.build_arm_a4_a3_remediation_live_serving_retriever()`
  (a file this turn already added, itself untouched again this turn) and injects it via
  `answer_api.reset(retriever=...)` — a function whose own docstring says "테스트용: 캐시를
  버리거나 가짜 retriever를 주입한다" (for testing: discard the cache or inject a retriever),
  i.e. an intended, pre-existing extension point, not a workaround. `_store`/`_arm`/
  `_arm_pins` are set the same way `_build_retriever()` itself would have set them — no
  file was written to, only runtime module state.

## 2. Results

| metric | ARM_A4_A3_LIVE | ARM_A4_A3_REMEDIATION_LIVE |
|---|---|---|
| full | 39 | **45** |
| partial | 30 | 31 |
| zero | 23 | **16** |
| value_denominator (SUPPORTED & value-bearing) | 92 | 92 |
| **weighted score** (full + 0.5×partial) | 54.0 | **60.5** |
| numeric full (NUMERIC_LOOKUP) | 29/55 (0.5273) | **34/55 (0.6182)** |
| slots full in context | 45/101 | **54/101** |
| answerability (answerability_ok/n) | 92/101 (0.9109) | 92/101 (0.9109, unchanged) |
| citation (citation_ok/n) | 101/101 (1.0000) | 101/101 (1.0000, unchanged) |
| critical evidence errors | 0 | 0 |
| execution errors (questions_failed) | 0 | 0 |
| n / fallbacks | 101 / 1 | 101 / 1 |
| latency p50 / p95 / max (ms) | 19833 / 39160 / 47196 | **13318 / 30757 / 41168** |
| latency mean (ms) | 20000.4 | 12738.7 |

Both runs: 101/101 questions completed, zero unhandled exceptions, zero provider outages
(no 429/40009/timeout observed in either run's `llm_error` distribution — all degraded-path
triggers are the pipeline's own designed JSON-parse-miss/citation/period gates).

## 3. Per-question improved / regressed / unchanged

Ordinal comparison of `value_score` (zero < partial < full) between the two runs, same 101
question IDs:

```text
improved:  13
regressed:  6
unchanged: 82
```

Regressed question IDs: `author_bfc0f3bb801bc9eab3faaa3c`, `author_d640cbedd7330f4b9bcfeeb7`,
`author_f55322f4532a9fec91015c34`, `gold_b_034334dce8cb5eaaa6589096`,
`gold_b_192fa6ea90c0cdefc2616fc0`, `gold_b_f23bcdcee714d7436867d683`.

Net effect is positive: weighted score +6.5, numeric full +5, slots-full-in-context +9,
zero-count -7, all with identical answerability and citation rates and zero critical
evidence errors in both runs. The 6 regressions are consistent with the LLM-generation-
stage churn this project's own history has repeatedly measured between otherwise-identical
runs at temperature 0.1 (retrieval feeding a slightly different but often overlapping
evidence set into claim-level generation/validation gates) — not re-diagnosed further here,
since no verdict was requested this turn.

## 4. Confirmations

```text
existing_frozen_results_or_files_modified: false -- answer_api.py and arm_a_serving_bridge.py
                                            are byte-identical to HEAD (git diff --stat empty,
                                            re-verified immediately before this run); no file
                                            under domain/, scripts/, or src/ was changed this turn
DEV_CHECK_or_HOLDOUT_accessed:             false
QA_code_prompt_model_temperature_seed:     identical between the two runs (only
                                            DART_QA_RETRIEVAL_BACKEND selection differs, via
                                            the injection method in §1)
raw_wires_and_judge_rows:                  work/judge101_a4a3_live/, work/judge101_a4a3_remediation_live/
                                            (gitignored, not committed; only this report's
                                            aggregate numbers are recorded in git)
db_write_count:                             0
pr_created:                                 false
force_amend_rebase_reset_used:              false
```
