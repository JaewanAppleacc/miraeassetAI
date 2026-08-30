# Retrieval Index Sizing / Dedup / Boilerplate Analysis (Turn P5.1)

Analyzes Turn P5's already-built, 1,874,688-chunk portable snapshot
(`work/domain-seed/document-retrieval-snapshot-v0.1/`) to decide what a
future indexing Turn should actually embed -- WITHOUT embedding anything,
loading PostgreSQL, or touching the snapshot itself. This Turn produces a
**plan**, not an index.

## Why this Turn exists

Turn P5 preserved every chunk verbatim, including exact duplicates and
low-information boilerplate. Embedding all 1,874,688 chunks unconditionally
would be safe but wasteful. This Turn measures how wasteful, and compares
four candidate strategies before anyone commits to an embedding bill.

## Pipeline (`build-index-plan.mjs`)

1. Fail-closed pin verification against the Turn P5.1 task's own stated
   pins (snapshot_id, document/chunk counts, both file sha256, gate/
   portability/determinism/P4-compat statuses) -- see
   `scripts/analyze-document-retrieval-index-v01.mjs`'s `EXPECTED_PINS`.
2. ONE streaming pass over `document-chunks.v0.1.jsonl` (2.9GB, never fully
   loaded into memory) feeding two accumulators simultaneously:
   `length-analysis.mjs` (size/shape distributions) and
   `duplicate-analysis.mjs` (exact-duplicate detection, O(1) memory per
   unique hash -- see that file's own header comment for why no per-hash
   Set of document ids is ever needed).
3. `boilerplate-rules.mjs` classifies each UNIQUE text (not each chunk) once
   against the already-built duplicate map -- deterministic rules only,
   with a hard protective override: a chunk containing a date-like or
   amount-like pattern is NEVER a `BOILERPLATE_CANDIDATE`, regardless of
   frequency.
4. A second, TARGETED streaming pass verifies dedup provenance is really
   reconstructible for the highest-occurrence sample hashes (the highest-
   value case to prove safe).
5. `strategy-comparison.mjs` + `embedding-size-model.mjs` build the 4-way
   comparison and size estimates for 384/768/1024/1536-dim vectors.
6. `build-index-plan.mjs` writes all output atomically; a failure anywhere
   leaves zero final files.

## The one hard safety rule

**Frequency alone never excludes a chunk.** `contracts.mjs`'s
`isProtectedFromBoilerplate` (date-like or amount-like pattern match) is
checked before any boilerplate classification, and
`boilerplate-candidate-analysis.v0.1.json`'s
`protected_despite_high_frequency_count` reports exactly how often that
protection mattered on the real corpus.

## What this Turn deliberately does NOT do

- No real embedding API call (all token/cost figures are explicit, labeled
  heuristic ranges or formulas -- see `embedding-size-model.mjs`'s own
  comments).
- No PostgreSQL connection, no write to `reference_retrieval_chunks`.
- No modification of Turn P5's snapshot (verified by a unit test that
  checks its sha256 is byte-identical before and after a full analysis
  run).
- No recall claim, with or without Gold -- see every strategy's
  `recall_risk` field and `recommended-index-plan.v0.1.json`'s
  `uncertainties` list.
- No specific embedding provider/model price is hard-coded anywhere; cost
  is a formula the Owner evaluates with their own unit price.

## Output location

`work/domain-seed/retrieval-index-analysis-v0.1/` (gitignored, per this
repo's existing `/work/` policy). Only this module's code, contracts, and
tests are committed.
