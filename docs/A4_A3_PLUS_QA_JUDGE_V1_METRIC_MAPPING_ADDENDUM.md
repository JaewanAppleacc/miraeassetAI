# A4-A3-PLUS-QA-JUDGE-V1 Amendment — Metric-mapping addendum

Written and committed while the `ARM_A_LIVE` 101-question run is in progress (10-20/101
completed, no aggregate `summary.json` produced or viewed yet for either backend under the
corrected 101-question spec) — before either backend's aggregate result exists, per the
same "fixed before any result is seen" discipline as the amendment and the prior addendum.

## Why this is needed

The amendment's decision rule (`docs/A4_A3_PLUS_QA_JUDGE_V1_AMENDMENT.md`, § Decision rule)
names five metrics — `citation_validity`, `answerability`, `numeric_correctness`,
`groundedness`, `weighted_score` — plus `critical_evidence_errors`. None of these names
exist verbatim in this repository's scorer (`scripts/judge_devtune.py`), which is the
existing, unmodified, judge1..judge34-era tool this turn uses to actually run the
comparison (per the question-set addendum). Rather than inventing a new scoring script
(forbidden — no new design, no post-hoc criteria), each amendment metric is mapped to the
closest already-existing field `judge_devtune.py` computes for every one of its prior 34
iterations. This mapping is fixed now, identically for both backends, before any number
from either run is seen.

## Mapping (fixed)

All fields below come straight out of `results/<out-dir>/summary.json`, unmodified format:

```text
citation_validity     = summary.citation_ok / summary.n
answerability         = summary.answerability_ok / summary.n
numeric_correctness   = summary.by_type_value_full["NUMERIC_LOOKUP"] as a fraction
                         (the "full"-value rate specifically on NUMERIC_LOOKUP-type
                         questions -- the only DEV_TUNE type name that means "numeric" in
                         this repo's own taxonomy; already computed, no new code)
groundedness          = summary.slots_full_in_context / summary.n
                         (fraction of questions where every required_evidence_slot is
                         present in retrieved_context -- "the evidence needed was actually
                         retrieved", the closest existing meaning of "groundedness")
weighted_score        = summary.value["full"] + 0.5 * summary.value["partial"]
                         (raw count, NOT normalized -- this is the exact "가중" formula
                         used in every judge1..judge34 entry throughout this project's
                         CLAUDE.md history, e.g. "가중 73.0". Comparing raw counts across
                         the two backend runs is valid under the same convention already
                         used throughout that history to compare different code versions
                         against the same fixed n=101 DEV_TUNE set.)
```

`critical_evidence_errors` has no existing automated field (this repo's four-arm scorer's
"치명" classification is a retrieval-benchmark concept, not part of `judge_devtune.py`'s
per-question output). Fixed definition, applied identically to both runs:

```text
critical_evidence_errors = count of rows where citation_ok == false
                            AND validation_status == "SUPPORTED"
```

i.e. the pipeline served a confident, non-withheld, non-refused answer with no accession
number (`\d{14}`) findable anywhere in the answer or its retrieved context -- an answer
presented as grounded fact with no citation evidence in the transcript at all. This is the
narrowest, most defensible reading of "critical evidence error" available from existing,
unmodified fields; it is reported as a raw count and, per the amendment, must be exactly 0
on `ARM_A4_A3_LIVE` for that arm to pass.

## What this addendum does not do

It does not change `scripts/judge_devtune.py`, does not add a new scoring script, does not
touch the Comparison specification or Decision rule sections of the amendment (same-run
comparison, all seven conditions, tie loses to `ARM_A_LIVE`), and does not affect either
backend differently -- the same four ratios and one count are computed from the same
`summary.json` schema for both runs.
