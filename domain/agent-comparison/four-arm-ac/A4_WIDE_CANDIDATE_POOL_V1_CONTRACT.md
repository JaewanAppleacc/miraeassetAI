# FOURARM-A4-WIDE-CANDIDATE-POOL-V1 — contract

## Scope of this turn

`Turn A4-WIDE-CANDIDATE-POOL-V1` implements a pure, deterministic
**union/dedup pool builder**: given arm A's existing official top-20, a
BM25 top-100 leg, and a KURE dense top-100 leg (all pre-computed
elsewhere), it produces one wide candidate pool for a future A4 reranker,
keyed by `chunk_id`. This turn does **not** implement a reranker, the
Contradiction Guard, QA wiring, or any Gold scoring — those are explicitly
out of scope per the task.

This turn does **not**:
- call a retriever, a database, an embedding model, or a reranker,
- re-run arm A or recompute its actual official output,
- read Gold, an oracle number, DEV_TUNE, or any existing critical packet,
- modify `A.results.jsonl`, `A.run.json`, `C.results.jsonl`, `C.run.json`,
  or any A2 result/run file (verified unchanged by SHA256 — see the
  handoff doc),
- write to a database or to any file other than the two new files this
  turn adds,
- truncate its own output pool to any top-N before returning it.

Everything is exercised only against hand-authored synthetic fixtures.

## Entry point

```js
import { buildWideCandidatePool } from "./a4-wide-candidate-pool.mjs";

const { pool, diagnostics } = buildWideCandidatePool({
  original_a_top20,   // arm A's existing, unmodified official top-20
  bm25_top100,        // the BM25 leg's own ranked list
  dense_top100,       // the KURE dense leg's own WIDE ranked list
});
```

Pure function. Never mutates any input. Depends only on each record's own
declared `rank` field, never on its position within its array — so calling
it with the same three lists in any element order produces byte-identical
output (only the `rank`/`score`/identity fields of each record matter, not
where that record sits in its array).

## Frozen config constants

```text
BM25_CANDIDATE_K            = 100   (bm25_candidate_k)
ORIGINAL_DENSE_CANDIDATE_K  = 20    (original_dense_candidate_k)
WIDE_DENSE_CANDIDATE_K      = 100   (wide_dense_candidate_k)
RRF_CONSTANT                = 60    (rrf_constant)
ORIGINAL_OUTPUT_K           = 20    (original_output_k)
```

These match `arm-retriever-adapter.mjs`'s own `BM25_TOP_K=100` /
`RRF_K_CONSTANT=60` exactly (not re-derived — reproduced as fixed
constants here so no caller can silently change the per-question candidate
budget by passing a different value).

## Input shape

`original_a_top20`, `bm25_top100`, `dense_top100`: arrays of
**CandidateRecord**, each carrying the common base fields plus its own
explicit `rank` (1-based, unique within its own array, `<=` that array's
capacity constant) and, for `bm25_top100`/`dense_top100`, a finite `score`.
`original_a_top20` records do not require a `score` (this module never
trusts a passed-through A score; it recomputes A's RRF score itself — see
below).

```text
CandidateRecord (base fields, required on every entry):
  chunk_id:           string (non-empty)
  document_id:        string (non-empty)
  text:                string | null
  chunk_text_sha256:  string (non-empty)
  node_index:          integer | null
  node_indices:        integer[]           (defaults to [] if omitted)
  locator:             object              (defaults to {} if omitted)
  provenance:          object              (defaults to {} if omitted)
  metadata:            object              (defaults to {} if omitted)
  rank:                integer >= 1        (leg-specific, see above)
  score:               number              (bm25_top100/dense_top100 only; required)
```

A list may be a partial/sparse representative subset (ranks need not form
a contiguous `1..length` run) — what is enforced is: no two records in the
same list share a `rank`, no two records in the same list share a
`chunk_id`, no `rank` exceeds that list's fixed capacity, and the list's
own length never exceeds that capacity.

## Output shape

```text
{
  pool: CandidatePoolItem[],   // chunk_id-ascending, deduplicated, never truncated
  diagnostics: {
    version, bm25_candidate_k, original_dense_candidate_k,
    wide_dense_candidate_k, rrf_constant, original_output_k,
    pool_size, original_a_top20_count, bm25_top100_count, dense_top100_count,
  }
}
```

`CandidatePoolItem`:

```text
chunk_id, document_id, text, chunk_text_sha256, node_index, node_indices,
locator, provenance, metadata,

source_membership: { original_a_top20, bm25_top100, dense_top100 }  // booleans
source_ranks:  { original_a, bm25, dense, wide_rrf }                // integer | null
source_scores: { bm25, dense, original_a_rrf, wide_rrf }            // number | null
```

## The two ranks, and why they differ

- **`source_ranks.original_a`** reproduces arm A's own RRF exactly: it is
  computed via `RRF(k=RRF_CONSTANT)` fused over `bm25_top100` (full, up to
  100) and `dense_top100`'s own `rank <= ORIGINAL_DENSE_CANDIDATE_K`
  subset — i.e. the dense candidates A's original retrieval actually saw.
  It is computed for **every** pool candidate the formula reaches, not
  only the official top-20 — a candidate beyond A's actual cutoff still
  gets a "would-be" original-A rank, useful diagnostic signal, but it is
  never treated as something A actually returned (`source_membership.
  original_a_top20` is the separate, authoritative "A actually returned
  this" flag).
- **`source_ranks.wide_rrf`** is the same RRF formula, but fused over the
  FULL `dense_top100` (up to `WIDE_DENSE_CANDIDATE_K`=100) instead of only
  its top-20 subset. This is a diagnostic ranking only — **it is never
  treated as the final ranking**, per the task's own instruction.

**Reproduction check (fail-closed):** when `original_a_top20` is
non-empty, this module verifies that its first `min(length,
ORIGINAL_OUTPUT_K)` entries, in the `rank` order they were given, exactly
match the recomputed `original_a` RRF order's leading entries. A mismatch
throws `WideCandidatePoolInputError` with code
`ORIGINAL_A_RRF_NOT_REPRODUCIBLE` — it means the `bm25_top100`/
`dense_top100` lists supplied are not the ones A's actual retrieval used
for that question, a caller data-consistency bug this module refuses to
paper over.

## RRF formula (fixed, explicit tie-break)

```text
contribution(rank) = 1 / (RRF_CONSTANT + rank)
score(chunk)        = sum of contribution(rank) over every leg the chunk appears in
                       (a leg it is absent from contributes 0 -- union semantics,
                       matching arm A's own HYBRID_UNION_RRF, never intersection-only)
rank order          = sort by score DESC, tie-break by chunk_id ASCENDING
                       (plain codepoint/lexicographic string comparison,
                       never locale-sensitive collation)
```

## Dedup / merge rules

- The pool is the union of `original_a_top20` ∪ `bm25_top100` ∪
  `dense_top100`, keyed by `chunk_id` — every A top-20 candidate is
  included unconditionally, regardless of whether it also happens to
  appear in the raw `bm25_top100`/`dense_top100` legs.
- A `chunk_id` appearing in more than one input list contributes exactly
  ONE item to `pool`.
- **Identity fields must agree across every list a `chunk_id` appears
  in**: a `document_id` or `chunk_text_sha256` mismatch for the same
  `chunk_id` throws `WideCandidatePoolInputError`
  (`DOCUMENT_ID_CONFLICT` / `CHUNK_TEXT_SHA256_CONFLICT`) rather than
  silently picking one.
- **Descriptive fields** (`text`, `locator`, `provenance`, `metadata`) are
  merged by priority: `original_a_top20` > `bm25_top100` > `dense_top100`
  — the first non-null value found in that order wins.
- **`node_indices`** is the one field merged by UNION, not priority: every
  occurrence's `node_index` (singleton) and `node_indices` (array) are
  combined into one sorted, deduplicated array, so multi-node provenance
  is never narrowed by which list happened to carry it. The singleton
  `node_index` output field is the smallest value in that merged set.

## Determinism and purity

- Depends only on the `rank`/`score`/identity value of each record, never
  on iteration or array order, `Date.now()`, randomness, or module-level
  mutable state.
- Every returned object is `Object.freeze`d; inputs are only read, never
  written.
- No packet ID, company name, question sentence, Gold value, or oracle
  number is hardcoded anywhere in the module.
- Zero imports, zero I/O of any kind (no network, DB, filesystem,
  embedding, or reranker call).

## Files

- `domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs` — this
  module. Exports `buildWideCandidatePool`, `WideCandidatePoolInputError`,
  `A4_WIDE_POOL_VERSION`, and the five frozen config constants above.
- `tests/four-arm-a4-wide-candidate-pool.test.mjs` — 20 synthetic tests.
- This file.
- `A4_WIDE_CANDIDATE_POOL_V1_HANDOFF.md` — handoff for the next
  integrator (the reranker turn).
