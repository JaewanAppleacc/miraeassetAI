# `FOURARM-AC-SCORING-VIEW-FIX-V1` — Pre-Freeze Amendment

Written and committed **before** any hydrated score is generated or viewed, per this
Turn's Section A. Pins the facts and rules that govern the rest of this Turn.

## Pinned facts

- **Code HEAD at freeze time**: `b88984e` (`b88984ebdf98c577dbe46207a64c8b257c9def0b`),
  branch `codex/fourarm-official-integration-v01`.
- **Defect being amended**: `METADATA_CONTRACT_DEFECT`, established in
  `UNRESOLVED_AUDIT_V1.md` (previous Turn). A/C's own `results.jsonl` result items
  carry `chunk_text_sha256` but never a `text` field; the frozen scorer's
  `check_locators()` (`fourarm.py:323-327`) requires `text` on the result item
  itself (not the NodeStore) as its first content-verification gate, so every
  A/C slot-match candidate fell through to `unresolved: no_text_to_verify`
  regardless of actual evidentiary correctness. 246 distinct packets (229 A / 216
  C) were affected — 100% of the union, a single uniform cause.

## What this Turn does and does not touch

- Retrieval results, ranks, and locators produced by A/C are **not** changed by
  this Turn. No re-retrieval, re-embedding, re-ranking, or re-BM25/RRF pass runs.
- A single, additive, read-only-DB-sourced `text` field is added to a **temporary
  scoring view**, never to the committed `A.results.jsonl`/`C.results.jsonl`/
  `A.run.json`/`C.run.json`.
- The exact chunk text is looked up by exact `chunk_id` from the same READY
  retrieval index (`fixed_kure_index_8fe191342205848d1d6a6123f38a54e7`,
  `disclosure_reference.reference_retrieval_chunks`, read-only `SELECT`) that
  produced the original retrieval — **the same corpus content the retrieval
  already surfaced**, not a new lookup or a broader context window.
- The looked-up text is accepted **only** if its own SHA-256 hashes to exactly
  the `chunk_text_sha256` already recorded in the original result item. Any
  mismatch, any missing chunk_id, any duplicate chunk_id, or any
  `source_document_id` mismatch against the result's own `doc_id` **halts the
  entire hydration** — no partial hydration, no per-row skip-and-continue.
- The hydrated view is written **only** under gitignored `work/` — never
  committed, never logged in full, never quoted in any committed report.
- The frozen scorer (`fourarm.py`/`score.py`, commit `50cc1aac5…`) is **not**
  modified.
- B/D's own results/run files, `score.B.json`/`score.D.json`, and the Owner
  resolutions are **not** modified; this Turn only re-confirms they reproduce
  byte-identical after the full-batch rescore.
- All 101 questions are rescored in **one single full-batch pass** for every one
  of A/B/C/D — no partial or single-arm rescoring.

## Rules pinned before any new score is viewed

1. Hydration either succeeds 100% (every A/C result item resolves to a
   SHA-verified, document-matched chunk text) or it does not run at all —
   any single failure (missing/duplicate chunk_id, hash mismatch, document
   mismatch) is a hard stop, reported as `BLOCKED_CONTRACT`, with the original
   committed A/C artifacts left untouched.
2. If hydration succeeds and rescoring shows A/C UNRESOLVED = 0 with the
   existing frozen tie-break rules selecting A: report
   `PROVISIONAL_WINNER=A`.
3. If hydration succeeds but genuine UNRESOLVED packets remain (a real
   evidentiary ambiguity the scorer flags even with full text present): those
   packets, and only those, are prepared as arm-blind Owner review packets
   (`COMMON_SOURCE`/`ARM_SPECIFIC`/`UNKNOWN` only — no new classification such
   as `EQUIVALENT_EVIDENCE`). No automatic adjudication.
3b. If a genuinely new scorer- or result-contract defect is found during this
   process (distinct from the already-diagnosed missing-`text` defect), it is
   reported separately and not silently fixed.
4. `PROVISIONAL_WINNER` is never declared by relaxing B/D's frozen
   `HARD_GATE_FAILED` state, and never by rerunning/reconfiguring A/C
   favorably after seeing a result.

This amendment is committed before Section B (hydrator implementation) begins.
