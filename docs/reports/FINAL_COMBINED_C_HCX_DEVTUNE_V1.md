# FINAL-COMBINED-CANDIDATE-C-HCX-DEVTUNE-V1 — Final Report

Verdict: **`KEEP_REMEDIATION_BASELINE`**

Candidate C (remediation retrieval + DocumentBinder + Evidence V2) does **not** clear
several of the pre-registered rejection gates simultaneously: critical evidence errors
increase (0→1), citation validity decreases, numeric-full rate decreases, and weighted
score decreases rather than strictly improving. Per the freeze document's own decision
rule, any one of these alone keeps the baseline; here four independent triggers fire at
once. `FINAL_CANDIDATE_C_SELECTED` does not apply.

## 1. Pins

```text
new worktree:            agent-final-combined-c-hcx-devtune-v01
new branch:               codex/final-combined-c-hcx-devtune-v01
checked out from:        codex/a4-a3-final-candidate-comparison-v01 @ a12c38853e80d3850ab028e833010216f53ae6e8
baseline runtime source:  codex/a4-a3-remediation-integration-v01 @ b5f9443f7ca3ec2d57c2d17453070ab23c4a6341 (ancestor, confirmed)
binder/evidence source:   codex/a4-a3-qa-binder-evidence-v2-integration-v01 @ 5ff49b6d128b5fafd2a922691eb5820a4f9a293a (ancestor, confirmed)
freeze commit:            99ff9a0 (committed before either run was executed)
baseline backend:         ARM_A4_A3_REMEDIATION_LIVE
candidate backend:        ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE
Gold:                     data/eval/phase1_devtune_gold.v0.1.jsonl, sha256 7941144c...f102b (unchanged)
CLOVA_API_KEY:            present (existence-only check)
KURE /info:               nlpai-lab/KURE-v1 @ 4ed4540949c70b7da2c74004a915e1f2d5e46e4f, dim 1024
READY index:              fixed_kure_index_8fe191342205848d1d6a6123f38a54e7, 442549 records
```

## 2. Results (full DEV_TUNE-101, real HyperCLOVA X, both runs 101/101 complete)

| metric | baseline (ARM_A4_A3_REMEDIATION_LIVE) | candidate C | delta |
|---|---|---|---|
| full | 46 | 43 | -3 |
| partial | 31 | 32 | +1 |
| zero | 15 | 17 | +2 |
| unanswerable (answerability_ok=false) | 9 | 6 | -3 (improved) |
| **weighted score** (full + 0.5×partial) | **61.5** | **59.0** | **-2.5 (regressed)** |
| numeric full (NUMERIC_LOOKUP) | 34/55 (0.6182) | 33/55 (0.6000) | -1 (regressed) |
| slots full in context | 54/101 (0.5347) | 58/101 (0.5743) | +4 (improved) |
| answerability (answerability_ok/n) | 92/101 (0.9109) | 95/101 (0.9406) | +3 (improved) |
| **citation validity** (citation_ok/n) | **101/101 (1.0000)** | **100/101 (0.9901)** | **-1 (regressed)** |
| groundedness (slots_full_in_context/n) | 0.5347 | 0.5743 | +0.0396 (improved) |
| **critical evidence errors** | **0** | **1** | **+1 (regressed)** |
| execution errors | 0 | 0 | 0 |
| minor / unresolved evidence | not applicable at this QA-HCX level (see §4 of the freeze doc) | not applicable | -- |
| fallbacks | 1 | 0 | -1 |
| latency p50 / p95 / max (ms) | 13458 / 31269 / 42083 | 11108 / 26698 / 35242 | faster (not a gating metric) |

The single critical evidence error (`author_52e6c0ca8915c4a28c802e4c`, COMPARISON_CALC/OPEN):
`got_answerability=EVIDENCE_NOT_FOUND` but `validation_status=SUPPORTED` with
`citation_ok=false` and `llm_used=false` — a labeling inconsistency (a "no evidence found"
outcome stayed marked SUPPORTED instead of switching to NOT_FOUND/WITHHELD), exactly the
pattern this project's own `critical_evidence_errors` definition is meant to catch.

## 3. Per-question improved / regressed / unchanged

Ordinal comparison of `value_score` (zero < partial < full), same 101 question IDs:

```text
improved:   4
regressed:  6
unchanged: 91
```

Regressed: `author_52e6c0ca8915c4a28c802e4c` (the critical-evidence-error question above),
`author_66ddb05e5a3de362ff1c536f`, `author_ef82c30f267ca92d099c7a62`,
`author_f55322f4532a9fec91015c34`, `gold_b_3054ffad4d0cb92473806459`,
`gold_b_7c610de1801a78e791b92f60`.

## 4. DocumentBinder / Evidence V2 internals (Section D) — separate, non-LLM retrieval-only
pass over the same 101 Gold questions (methodology fixed in the freeze doc §4, before any
score was viewed)

```text
DocumentBinder status distribution (questions): BOUND 42, AMBIGUOUS 59,
                                                 MULTI_DOCUMENT_BOUND 0, UNRESOLVED 0
Evidence V2 input (n_base, always == k):         min 20, max 20, mean 20.0
Evidence V2 output (n_out, post binder+evidence): min 1, max 20, mean 12.66
evidence cap (TOTAL_EVIDENCE_CAP):                20
evidence cap exceeded:                            0/101 questions (never exceeded)
different document_id mixed within a BOUND question: 0/101 (never — BOUND stayed single-document
                                                     on every one of the 42 BOUND questions)
```

No `MULTI_DOCUMENT_BOUND` or `UNRESOLVED` case occurred anywhere in this particular
101-question set; `AMBIGUOUS` (passthrough, no row narrowing) was actually the more common
outcome (59/101) than `BOUND` (42/101) — DocumentBinder's own single-document narrowing
condition is evidently not met for the majority of DEV_TUNE-101's questions as posed,
which is itself informative context for why the QA-level metric gains from `BOUND`
questions' narrower, cap-respecting evidence sets do not outweigh the citation/critical/
numeric regressions seen across the full set.

## 5. Decision-rule application (fixed in the freeze doc, before either run was executed)

```text
critical evidence errors increase?      YES (0 -> 1)  -> REJECT trigger
citation validity lower than baseline?  YES (1.0000 -> 0.9901) -> REJECT trigger
answerability lower than baseline?      NO (improved) -> not a trigger
numeric full below baseline?            YES (0.6182 -> 0.6000) -> REJECT trigger
slots full in context below baseline?   NO (improved) -> not a trigger
weighted score strictly higher?         NO (61.5 -> 59.0, regressed) -> REJECT trigger
execution errors increase?              NO (0 -> 0) -> not a trigger
```

Four independent rejection triggers fire. Per the freeze doc: "동점 또는 혼합 결과면 검증된
baseline 유지" — a mixed result (some metrics up, several hard gates down) keeps the
baseline, never rounds up to C.

## 6. Final verdict

```text
KEEP_REMEDIATION_BASELINE
```

`ARM_A4_A3_REMEDIATION_LIVE` remains the selected backend. Candidate C's DocumentBinder +
Evidence V2 composition improves groundedness/slots-full-in-context and answerability, and
is measurably faster, but its net effect on the primary quality/safety metrics this turn's
own pre-registered gates protect (critical evidence errors, citation validity, numeric
correctness, weighted score) is a regression, not an improvement. `DEV_CHECK` is not run
this turn regardless of this outcome — only this backend-selection result is frozen.

## 7. Preservation / verification (Section F)

```text
git status --porcelain (before this report's own commit): clean -- no existing file modified
git diff --stat HEAD: empty for every file this branch inherited (this turn added only the
                      freeze doc, this report, and its structured summary)
git diff --check:      clean
Python syntax:         work/run_judge101_final_combined_backend.py and
                       work/analyze_binder_evidence.py both executed successfully end-to-end
                       (syntax implicitly verified by real execution)
relevant tests:        pytest tests/agents/test_arm_a_adapter.py (18/18),
                       tests/agents/test_arm_a4_a3_live_adapter.py (27/27),
                       tests/agents/test_arm_a4_a3_remediation_binder_evidence_v2_integration.py (18/18)
                       all pass
full applicable suite: pytest tests/agents/ -- 729 passed, 2 skipped, 1 failed. The one
                       failure (test_arm_a_live_full_index_smoke.py::
                       test_qa_pipeline_reaches_real_full_index_with_zero_bd_fallback_and_grounded_citations)
                       is a PRE-EXISTING test (last touched by commit 61aad16, unrelated to
                       any branch this turn touches) whose own assertion documents "CLOVA_API_KEY
                       unset" as the expected environment -- it now IS set (required for this
                       turn's own HCX runs), so the assertion fails on that pre-existing,
                       unrelated premise, not on anything this turn changed. NOTE: running this
                       specific test with CLOVA_API_KEY set causes pytest's own assertion-diff
                       output to print the key's actual value -- this was observed once during
                       this turn's own test sweep, disclosed to the user immediately, and the
                       exposed value was never re-printed or committed anywhere. This test
                       should be skipped (or the key unset) in any future run in an environment
                       where the key is configured.
DEV_CHECK/HOLDOUT:      not accessed
raw wires/judge rows/binder diagnostic: work/judge101_final_baseline/, work/judge101_final_candidate/,
                       work/binder_evidence_diagnostic.json (all gitignored, not committed --
                       only this report and its structured summary are)
personal paths / API keys in this turn's own commits: none (checked before each commit)
```
