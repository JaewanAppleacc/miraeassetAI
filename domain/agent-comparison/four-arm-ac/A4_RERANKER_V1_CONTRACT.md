# A4 Reranker Engine v1 — Contract

Turn: `A4-RERANKER-ENGINE-V1`. This document is written and frozen
**before** any real DEV_TUNE result, Gold, A result, or oracle result is
opened this Turn — implementation and synthetic tests only. It defines
the exact input/output shapes `a4-reranker-engine.mjs` and
`a4-reranker-features.mjs` are built against, so the engine can be
integration-tested against a real wide-candidate-pool producer later
without either side guessing at the other's field names.

**Correction (input-pool ceiling, pre-results, no real result opened):**
the A4 wide pool is BM25 top-100 UNION dense top-100, deduplicated by
`chunk_id` — up to **200** distinct candidates, not 100. Frozen Arm A's
original top-20 is itself already a subset of that union (every A top-20
member appears in the BM25 and/or dense top-100 legs), so it is never
counted as 20 candidates on top of the 200. This correction only changes
the pool-size ceiling and adds two membership flags (section 2) and rank
validation (section 2/5); it does not add, remove, or reweight any
config, and no real result was opened to make it.

## 1. Role (fixed)

```
candidate pool → feature extraction → reranker score → deterministic sort → top-20
```

The reranker **only** ranks. It never:

- removes a candidate for looking like a contradiction — that is
  A3 Contradiction Guard's job, run separately and downstream of this
  engine, never inside it;
- deletes a candidate for missing information — a candidate with a gap
  (no text, no metadata, no dense score, …) gets a **neutral** feature
  value for the affected signal(s) only, never a fabricated bad score
  and never removal;
- issues a new search, DB query, or KURE call — the engine is pure and
  synchronous, and takes its entire candidate pool as a plain argument;
- looks past the input pool's own ceiling (BM25 top-100 UNION dense
  top-100, ≤200 candidates) — see `MAX_POOL_SIZE` in
  `a4-reranker-engine.mjs`, enforced as a hard `RangeError`, not a
  convention; every one of those ≤200 candidates is scored before the
  final sort — there is no pre-scoring truncation to 100;
- reads a Gold field, a real failure-packet id, a company-specific
  exception, or DEV_CHECK/HOLDOUT data. No such field exists anywhere in
  the two type shapes below, and no code path in this Turn's two modules
  performs file/DB/network I/O of any kind.

## 2. `RerankerCandidate` (one wide-pool candidate)

```ts
type RerankerCandidate = {
  chunk_id: string;                 // required, unique within a pool
  doc_id: string | null;
  node_index: number | null;
  node_indices: number[];           // [] if unknown -- never used as "missing" (empty is a real, resolved single/zero-node case)
  locator: string | null;
  locator_status:                   // same vocabulary as locator-provenance.mjs's LOCATOR_STATUS
    | "NODE_AND_ROW_RESOLVED" | "NODE_RESOLVED_ROW_AMBIGUOUS"
    | "MULTI_NODE_AMBIGUOUS" | "EMPTY_SPANS_INVALID" | null;
  row: number | null;
  col: number | null;
  is_table: boolean | null;         // null = unknown, not "false"
  text: string | null;              // raw chunk text -- used ONLY for lexical/coverage features, NEVER compared against a Gold span
  chunk_text_sha256: string | null;
  metadata: {
    corp_code: string | null;
    doc_group: "periodic" | "major" | "holding" | "exchange" | null;
    doc_subtype: string | null;
    base_year: number | null;
    base_month: number | null;
    receipt_date: string | null;    // ISO date, informational only -- no feature currently reads it
    is_correction: boolean | null;
  } | null;
  scores: {
    // rank: an integer in [1, 100], or null (not found by this leg at
    // all -- a legitimate absence, scored 0 by the corresponding
    // feature, never a validation failure).
    bm25: { score: number | null; rank: number | null } | null;
    dense: { score: number | null; rank: number | null } | null;
    // Frozen Arm A's OFFICIAL run (dense_candidate_k=20): rank is an
    // integer in [1, 20], or null if this candidate was never in A's own
    // frozen top-20, which is real information (scored 0), not a gap.
    original_a_rrf: { score: number | null; rank: number | null } | null;
    // The widened (dense_candidate_k=100) union-RRF pool this candidate
    // came from. No fixed rank ceiling is validated on this leg (the
    // fused pool itself can be up to 200 wide).
    wide_rrf: { score: number | null; rank: number | null } | null;
  };
  // Explicit, first-class protective signal: true iff this exact chunk_id
  // was ranked 1..20 in Frozen Arm A's own official results (independent
  // of, and redundant with, scores.original_a_rrf.rank <= 20 -- kept as
  // its own boolean so a config can weight it directly and so the
  // engine's fixed tie-break rule never has to re-derive it).
  in_original_a_top20: boolean;
  // Membership flags: which source leg(s) this candidate came from. At
  // least one MUST be true -- the engine rejects (RangeError) any
  // candidate with both false/absent, since such a candidate could not
  // have come from the pre-registered BM25-top-100-union-dense-top-100
  // contract.
  bm25_top100: boolean;
  dense_top100: boolean;
};
```

Nothing else is defined on this type. A candidate with additional
producer-side fields is accepted (the engine only reads the fields
above), but the engine never depends on any field not listed here.

## 3. `RerankerQuestionContext` (per-question, never Gold)

```ts
type RerankerQuestionContext = {
  question_id: string;
  question_text: string | null;
  // The question's own required metric/row-name vocabulary -- derived
  // from question authoring / official conditions (e.g. the kind of
  // terms already present in devtune101_conditions.v2.jsonl's own
  // `conditions.candidate_terms`), NEVER from a Gold answer or Gold
  // evidence span.
  required_metric_labels: string[] | null;
  expected_corp_codes: string[] | null;
  expected_doc_groups: string[] | null;
  expected_base_years: number[] | null;
  expected_base_months: number[] | null;
};
```

Every field here must be derivable from the question's own authored
conditions at retrieval time — the same kind of object arm A's real
retrieval code already builds via
`four-arm-conditions-to-filter-mapper.mjs`, never from a Gold row. If a
future wiring step cannot populate a field without opening Gold, it must
pass `null`/omit it — the corresponding feature already degrades to a
neutral 0.5 for that signal (see `a4-reranker-features.mjs`).

## 4. Feature set (fixed, 10 keys)

| feature key | signal | absent/missing behavior |
|---|---|---|
| `bm25` | BM25 leg rank (reciprocal) | not found by this leg → **0** (real absence) |
| `dense` | dense leg rank (reciprocal) | not found by this leg → **0** |
| `original_rrf` | Frozen Arm A's own official RRF rank (reciprocal) | not in A's official pool → **0** |
| `wide_rrf` | widened union-RRF rank (reciprocal) | not in the wide pool at all → **0** (should not occur if the candidate came from the wide pool itself) |
| `lexical_overlap` | question-text token overlap with candidate text | no text on either side → **0.5** (neutral) |
| `term_coverage` | required metric/row-name presence in candidate text | no text or no required labels → **0.5** |
| `metadata_match` | corp/period/doc-group agreement with question expectations | no candidate metadata or no expectations given → **0.5** |
| `table_context` | row/col resolved or `is_table` known | unknown → **0.5** |
| `provenance_completeness` | `locator_status` quality | unknown/missing → **0.5** |
| `original_a_protect` | was this chunk in A's frozen top-20 | boolean, no "missing" case (defaults `false` → 0) |

Every feature is a finite number in `[0, 1]`. `extractFeatures()` throws
if any computed value is not finite — a defect in a feature function,
never a valid "we don't know" state (that is always 0.5, not `NaN`).

## 5. Config contract (`a4-reranker-configs.v1.json`)

- At most 12 entries, pre-registered before any real result is opened.
  This version ships 6 (families R0–R5, one config each).
- Each entry: `config_id` (unique string), `family`, `description`,
  `weights` (a subset of the 10 feature keys above, each weight a finite
  number `>= 0`; an omitted key defaults to weight 0).
- `validateConfig()`/`assertValidConfig()` reject: a missing/empty
  `config_id`, a non-object `weights`, an unknown weight key, or any
  weight that is not a finite, non-negative number (`NaN`/`Infinity`/
  negative all rejected) — fail-closed, never coerced to 0 silently.
- The tie-break chain is **not** part of a config — it is one fixed rule
  the engine always applies (see `a4-reranker-engine.mjs`'s
  `compareScored`): `reranker_score` desc → `in_original_a_top20` desc →
  `original_a_rank` asc → `wide_rrf_rank` asc → `chunk_id` bytewise asc.
- No config may be added, removed, or reweighted after a real DEV_TUNE/
  Gold/A/oracle result has been opened by any Turn. A materially
  different idea is a new `v2` file, never a silent edit to `v1`.

## 6. Determinism guarantees

- `rerankCandidates(pool, questionContext, config)` is a pure function:
  same three arguments (by deep value) → byte-identical
  `JSON.stringify()` output, every time, on any machine.
- The output is always `output.every(o => pool.some(c => c.chunk_id === o.chunk_id))`
  and has no duplicate `chunk_id`s — a stable subset of the input, never
  a fabricated candidate.
- `pool.length > 200` is a hard `RangeError`, not a silent truncation —
  this engine assumes its caller already enforced the wide-pool ceiling
  (BM25 top-100 UNION dense top-100) and refuses to guess about anything
  beyond it. Pools of exactly 100, 101, 199, or 200 are all accepted;
  201 is rejected.
- Every candidate must carry `bm25_top100=true` or `dense_top100=true`
  (or both) — a candidate with neither is a hard `RangeError`.
- `scores.bm25.rank` and `scores.dense.rank` must each be an integer in
  `[1, 100]` or `null`; `scores.original_a_rrf.rank` must be an integer
  in `[1, 20]` or `null` — any other value (0, a float, a rank outside
  the range, `NaN`) is a hard `RangeError`, checked before any scoring.
- Input candidate objects are never mutated — every candidate in the
  pipeline is spread into a **new** object; the caller's own array/objects
  are safe to reuse or freeze before calling.
