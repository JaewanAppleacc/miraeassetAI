# FINAL-COMBINED-CANDIDATE-C-HCX-DEVTUNE-V1 — Freeze

Written and committed BEFORE any new score is produced or viewed. Fixes the pins, the
execution order, the wiring method, the metric-computation methodology, and the decision
rule so none of them can be adjusted after seeing a result.

## 0. Starting-point verification (Section A)

```text
new worktree:            agent-final-combined-c-hcx-devtune-v01
new branch:               codex/final-combined-c-hcx-devtune-v01
checked out from:        codex/a4-a3-final-candidate-comparison-v01 @ a12c38853e80d3850ab028e833010216f53ae6e8
                          (verified via `git ls-remote origin`/`git ls-remote demo-ai-festival` —
                          both match exactly)
baseline runtime source (already merged into a12c388, ancestor confirmed via
  `git merge-base --is-ancestor`): codex/a4-a3-remediation-integration-v01 @
  b5f9443f7ca3ec2d57c2d17453070ab23c4a6341
binder/evidence source (already merged into a12c388, ancestor confirmed):
  codex/a4-a3-qa-binder-evidence-v2-integration-v01 @ 5ff49b6d128b5fafd2a922691eb5820a4f9a293a
working tree:             clean immediately after worktree creation
npm install:              20 packages, clean
CLOVA_API_KEY:            present (existence-only check; value never read/printed, then or now)
KURE /info:                repository_id=nlpai-lab/KURE-v1,
                          model_revision=4ed4540949c70b7da2c74004a915e1f2d5e46e4f,
                          embedding_dimension=1024 (matches every prior pin in this project)
READY index:              fixed_kure_index_8fe191342205848d1d6a6123f38a54e7, record_count=442549
                          (queried directly from disclosure_reference.reference_retrieval_indexes)
DB access:                 read-only throughout (SELECT-only call graph; no code path this turn
                          uses issues INSERT/UPDATE/DELETE)
Gold:                      data/eval/phase1_devtune_gold.v0.1.jsonl, 101 lines,
                          sha256=7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b
                          (unchanged, matches every prior pin)
DEV_CHECK/HOLDOUT:         not present in this worktree's reachable data paths; not accessed
```

## 1. Backend names (verified against source, not assumed)

```text
baseline:  ARM_A4_A3_REMEDIATION_LIVE
candidate: ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE
```

`grep` on `src/dart_detective/arm_a_serving_bridge.py` confirms `RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE = "ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE"`
is registered in `RETRIEVAL_BACKENDS` and dispatched in `answer_api._build_retriever()` —
confirmed via `pytest tests/agents/test_arm_a_adapter.py` (18/18 pass, including the
byte-identity pin on `answer_api.py`/`arm_a_serving_bridge.py`, which this turn's own
commit `a12c388` updated together with its additive edit — the legitimate "extend +
update the pin in the same commit" pattern this project has used for every prior backend
addition).

The plain `ARM_A4_A3_REMEDIATION_LIVE` string is **not** registered in
`RETRIEVAL_BACKENDS` on this branch (confirmed by `grep` — it appears only in a comment),
consistent with `codex/a4-a3-remediation-integration-v01`'s own history (that backend was
always reached via direct adapter construction + `answer_api.reset(retriever=...)`
injection, never via `configure(retrieval_backend=...)`, to avoid touching the
byte-pinned `answer_api.py`). This turn reuses the SAME injection method for the
baseline, unmodified from the prior turn's own report
(`docs/reports/A4_A3_QA_HCX_COMPARISON_V1.md` §1). The candidate, by contrast, uses the
now-properly-registered `configure(retrieval_backend="ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE")`
path directly — no injection needed for it.

## 2. Same QA code / prompt / model / temperature / seed (verified)

```text
QA code:            byte-identical between the two runs -- only the retrieval backend differs
                     (confirmed: neither run modifies any file; the driver only selects a
                     backend before calling the same, unmodified scripts/judge_devtune.py)
CLOVA_MODEL:         unset -> default HCX-005 (llm.py CLOVA_DEFAULT_MODEL), identical both runs
DART_QA_FC_TEMPERATURE: unset -> default 0.1, identical both runs
DART_QA_SEED:        unset -> default 42, identical both runs
DART_QA_LATE_EXPANSION / DART_QA_EXPANDED_RETRIEVAL: unset -> both OFF, identical both runs
```

## 3. Execution order and no partial re-runs (fixed)

```text
1. ARM_A4_A3_REMEDIATION_LIVE — full 101/101, once, real HCX
2. ARM_A4_A3_REMEDIATION_BINDER_EVIDENCE_V2_LIVE — full 101/101, once, real HCX
```

No question is re-run individually; no partial result from either run is merged or
substituted. If either run does not reach 101/101, the whole turn reports
`BLOCKED_CONTRACT`, not a partial comparison.

## 4. Metric computation methodology (fixed before any result)

From `scripts/judge_devtune.py`'s own `summary.json` (unmodified scorer, matching the
convention already used in `docs/reports/A4_A3_QA_HCX_COMPARISON_V1.md`):

```text
full / partial / zero        summary.value.{full,partial,zero}
unanswerable                 count of rows where expected_answerability != "SUPPORTED"
                              (i.e. excluded from value_denominator) OR got_answerability
                              indicates WITHHELD/NOT_FOUND on a SUPPORTED-expected row
                              (answerability_ok=false) -- reported as a distinct count,
                              not folded into "zero"
weighted score                full + 0.5*partial (established convention, same as the two
                              prior HCX comparisons this session)
numeric full & denominator    summary.by_type_value_full.NUMERIC_LOOKUP ("x/y" string)
slots full in context         summary.slots_full_in_context (count) / n
answerability                 summary.answerability_ok / n
citation validity             summary.citation_ok / n
groundedness                  slots_full_in_context / n (same mapping as the A-remediation-
                              validation turns' own metric-mapping addendum)
critical evidence errors      count of rows where citation_ok=false AND
                              validation_status=="SUPPORTED" (same definition used in every
                              prior turn this session that reported this metric)
minor / unresolved evidence   NOT computable from judge_devtune.py's own per-question
                              output (that vocabulary belongs to the separate
                              src/dart_corpus/evaluation/fourarm.py retrieval-only scorer,
                              which this turn does not invoke -- this is a QA-level HCX
                              comparison, not a retrieval-only DEV_TUNE-101 pass). Reported
                              as "not applicable at this level", not fabricated as 0.
execution errors               count of wire/meta rows showing an unhandled exception or
                              crash marker (same check as every prior turn)
latency                        wire meta.latency_ms, p50/p95/max
per-question improved/regressed/unchanged   ordinal comparison of value_score
                              (zero < partial < full) between the two runs, same question IDs
```

DocumentBinder / Evidence V2 internals (binder status distribution, evidence cap overflow,
document_id mixing, BOUND single-document check, Evidence V2 input/output counts) are
**not** observable from `judge_devtune.py`'s `retrieved_context` (which only serializes
`document_id`/`source_locator`/`slot_name`/`chunk_id`/`quoted_text` — confirmed empirically
via a real, non-Gold smoke call before this document was written, no `binder_status` field
survives into that serialization). These are computed via a **separate, additional,
retrieval-only pass** (no LLM call, real KURE/Postgres) over the same 101 Gold questions,
calling `ArmA4A3RemediationBinderEvidenceV2ServingRetriever.retrieve(question,
conditions=None, k=20)` directly (letting the retriever's own `.conditions()` extraction
run, matching real production behavior) and reading:
- `RetrievedChunk.metadata["binder_status"]` / `["binder_document_id"]` / `["binder_group_id"]`
  per chunk, for status distribution and document-mixing/single-document checks
- `retriever.last["n_base"]` / `["n"]` after each call, for Evidence V2 input/output counts
- `len(results) <= TOTAL_EVIDENCE_CAP` (imported constant, not re-derived) for the cap-overflow check

This is a diagnostic pass, not a re-run of the graded QA comparison — it does not call the
LLM, does not affect or duplicate any `judge_devtune.py` metric, and runs once, after the
graded comparison, over the same fixed 101-question set.

## 5. Decision rule (fixed before any result)

```text
BLOCKED_CONTRACT                  if either run does not reach 101/101, if CLOVA_API_KEY is
                                   absent, if the KURE/index pins do not match, or if the QA
                                   code/prompt/model/temperature/seed differ between the two runs.

C rejected (KEEP_REMEDIATION_BASELINE) if ANY of:
  - critical evidence errors increase versus baseline
  - execution errors increase versus baseline
  - citation validity is lower than baseline
  - answerability is lower than baseline
  - numeric full (rate) is below baseline
  - slots full in context (rate) is below baseline
  - weighted score does not strictly exceed baseline (tie or mixed/ambiguous result also
    keeps the baseline -- never rounds up to C)

FINAL_CANDIDATE_C_SELECTED        only if every condition above holds (no rejection
                                   trigger fires) AND weighted score strictly improves.
```

No Binder/Evidence rule, budget (`TOTAL_EVIDENCE_CAP`), or prompt is changed after this
document is committed, regardless of what either run's result looks like. `DEV_CHECK` is
not run this turn even if C is selected — only the final backend selection is frozen in
the report; DEV_CHECK remains a separate, future, explicitly-authorized turn.

## 6. Preservation (fixed)

```text
original backend code / result files:  read-only this turn; not modified
Gold text, questions, answers, chunk text:  written only under gitignored work/, never committed
commit diff:                            reviewed before commit for API keys, absolute personal
                                        paths, or PII -- none included
```
