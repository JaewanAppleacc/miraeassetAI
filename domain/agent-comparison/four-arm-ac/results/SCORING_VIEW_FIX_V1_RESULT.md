# A/C Hydrated Rescore — `FOURARM-AC-SCORING-VIEW-FIX-V1`

Follows `SCORING_VIEW_FIX_V1_AMENDMENT.md` (committed at `f2d2a8a`, before any new
score was viewed). This amends the `METADATA_CONTRACT_DEFECT` diagnosed in
`UNRESOLVED_AUDIT_V1.md` — A/C's own `results.jsonl` never carried a `text` field,
only `chunk_text_sha256`, causing the frozen scorer's `check_locators()` to fall
through to `unresolved: no_text_to_verify` for every single slot match.

## What changed and what did not

A/C's own committed `results.jsonl`/`run.json` were **never modified** — re-verified
byte-identical before and after (see Section H below). The frozen scorer
(`fourarm.py`/`score.py`, commit `50cc1aac5…`) was **not** modified. B/D's own
results/run files and Owner resolutions were **not** modified.

A **temporary, additive scoring view** was built by a new read-only hydrator
(`scripts/p11f0-fourarm-scoring-view-hydrator.mjs`): for every result item in A's
and C's own committed `results.jsonl`, its exact `chunk_id` was looked up in the
same READY retrieval index that produced the original retrieval
(`fixed_kure_index_8fe191342205848d1d6a6123f38a54e7`,
`disclosure_reference.reference_retrieval_chunks`, read-only `SELECT`), and the
looked-up text was accepted only when its own SHA-256 matched the result item's
already-recorded `chunk_text_sha256` exactly, and only when the row's
`source_document_id` matched the result's own `doc_id` exactly. All 1,869 result
items in A and all 1,869 in C hydrated successfully — **zero** missing, duplicate,
hash-mismatch, or document-mismatch cases in either arm (1,642 unique chunk_ids for
A, 1,620 for C). No re-retrieval, re-embedding, re-ranking, or NodeStore
whole-node substitution occurred. Full field-by-field invariance (question_id,
rank, chunk_id, doc_id, node_index/node_indices, locator, row/col, score,
score_type, and result ordering) was independently re-verified after hydration —
the `text` field is the only addition.

The hydrated views (`work/bd_handoff/scoring_view/{A,C}.scoring_view.jsonl`),
which now contain real corpus text, exist **only** under gitignored `work/` — never
committed.

## Full-batch rescore (all 4 arms, one single pass)

`score.py --arms A B C D --final --resolutions .../resolutions.json` was run once,
against: the hydrated A/C scoring views (registered locally under a
gitignored-only copy of `arm_registry.json`/`run.json` with updated
`results_sha256` reflecting the hydration — the git-committed originals are
untouched), frozen B/D results, the same DEV_TUNE-101 Gold SHA
(`7941144c09c…f102b`), the same conditions/universe/DocumentIR pins, and the same
already-frozen Owner resolutions (`resolutions.json`, SHA `f2a46d0d2…`, confirmed
byte-unchanged after the run).

**B and D reproduced byte-identical** to their previously-frozen `score.B.json`
(`92a3b73…`) and `score.D.json` (`186cf33c…`) — confirmed by direct diff, not
merely by SHA. Nothing about B/D changed.

## Results (k=10 primary)

| arm | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all_found@10 | critical | minor | unresolved | hard-safe |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.7587 | 0.8287 | 0.8566 | 0.816 | 0.9167 | 16/19 | 0 | 1 | **21** | **yes** |
| B (frozen) | 0.479 | 0.5874 | 0.6713 | 0.576 | 0.6667 | 11/19 | 2 | 0 | 15 | no |
| C | 0.7238 | 0.7587 | 0.8636 | 0.748 | 0.8333 | 14/19 | **1 (new)** | 1 | 15 | **no (new)** |
| D (frozen) | 0.486 | 0.5839 | 0.6678 | 0.576 | 0.6389 | 9/19 | 2 | 0 | 11 | no |

Compared to the pre-hydration run, A's UNRESOLVED dropped from 229 → **21** and C's
from 216 → **15** (union of genuinely distinct, not-yet-adjudicated packets: 22 —
see below). Recall also rose for both (A: 0.8007→0.8287 @10; C: 0.7552→0.7587 @10),
because previously text-dependent matches (the `"text"` fallback path in
`slot_found()`) were structurally invisible without a `text` field and are now
correctly counted.

## New, genuine finding: C now fails the hard safety gate

With real text available, the scorer found a genuine **critical** violation in C:
`row_col_differs:(0, 0)!=(0, 1)` — Gold specifies a particular row/column, and C's
retrieved chunk's own row/col metadata names a *different* cell for the same node.
This is a real evidentiary problem in C's retrieval, not a scorer or contract
defect — it was invisible before only because the missing-`text` defect blocked
the scorer from ever reaching this comparison. **C's hard-safe status changes from
yes to no.** A remains the sole hard-safe arm.

## Gate chain

1. **Hard safety gate** (critical=0): only **A** passes. B (critical=2, frozen),
   C (critical=1, new finding), D (critical=2, frozen) all fail.
2. **Quality gate**: A is the only hard-safe arm, so A trivially passes
   (`ALL=0.8287`, `HIGH=0.816`).
3. **LOW all_found@10**: A=16/19 (only candidate remaining).
4. **Selection**: candidate **A**, `selection_type=PERFORMANCE_WINNER` — **held,
   not finalized** (see below).

## Final judgement: still `PENDING_UNRESOLVED` — genuinely closer, not resolved

`judgement.json.status` remains `PENDING_UNRESOLVED` (mapped to `BLOCKED` for this
report). **A/C's UNRESOLVED count is not zero** (A=21, C=15), so per the
amendment's pinned rule #2, this Turn does **not** declare
`PROVISIONAL_WINNER=A` — that requires the scorer's own chain to reach
`PROVISIONAL_WINNER`, which it does not while any UNRESOLVED packet remains
unadjudicated.

Deduplicating A's and C's own UNRESOLVED packets by the scorer's own arm-blind
`packet_id` hash gives **22 distinct packets**, all of which are **genuinely new**
— zero overlap with the already-Owner-adjudicated 17 packets from the prior B/D
review (confirmed by exact packet_id set difference). Reason distribution of the
22: `claim_text_not_in_node` (13), `duplicate_evidence_different_node` (9) — both
legitimate categories already used for B/D's own prior review, not new
classifications.

## Owner arm-blind review packets prepared

22 packets, arm identity/score/candidate hidden, prepared as
`domain/agent-comparison/four-arm-ac/official/unresolved-review-template-v2.json`
— each entry: `packet_id → {classification: "UNKNOWN" (unset), note: "",
_question_id, _slot, _reason}`, matching the exact shape already used for the
prior B/D review template. No `doc_id`/`node_index`/`chunk_text` is exposed in
this committed file. Only `COMMON_SOURCE`/`ARM_SPECIFIC`/`UNKNOWN` are valid
classification values — no new category was introduced. No automatic
classification was performed; every entry starts `UNKNOWN`. Combined SHA-256 of
the 22 raw packet files (full content, including real chunk text) is
`d69f4bcd1448a57e7f1a4b2d733e8f1cbaa28a71b648a1f747fc2cf71efcf507`; the raw
packets themselves remain local-only under gitignored
`work/bd_handoff/scorer/results/fourarm/unresolved/`.

## Security / access boundary

- DEV_CHECK/HOLDOUT: 0 files searched, 0 opened.
- No raw chunk text, Gold content, or evidence span appears in any committed
  file — the hydrated views and raw Owner packets (which now carry real corpus
  text) exist only under gitignored `work/`.
- No DATABASE_URL, connection string, host, or port appears in any committed
  file or this report — the hydrator requires `DATABASE_URL` from the
  environment and fails closed if unset (see Section H's integration test).
- No API keys, no production wiring, no HCX calls.

## H. Verification

- Original A/C `results.jsonl`/`run.json` (git-tracked): SHA re-verified
  byte-identical before and after this Turn's entire hydration + rescore
  process.
- Frozen scorer code (`fourarm.py`/`score.py`): SHA re-verified unchanged.
- B/D's own `results.jsonl`/`run.json` and `score.B.json`/`score.D.json`:
  byte-identical to the prior frozen pins (direct `diff`, not only SHA).
- Owner `resolutions.json`: SHA re-verified unchanged (`f2a46d0d2…`).
- Hydrated text SHA: 100% match rate independently re-verified (1,869/1,869 for
  A, 1,869/1,869 for C — every hydrated `text`'s own SHA-256 equals the result
  item's pre-existing `chunk_text_sha256`).
- Scoped `tests/four-arm-*` suite, a new Postgres read-only integration test for
  the hydrator, `schema:validate`, `npx tsc --noEmit`, `git diff --check`, and a
  final leak scan all recorded in the commit that follows this report.
