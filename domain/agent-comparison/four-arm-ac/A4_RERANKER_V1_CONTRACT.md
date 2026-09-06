# A4 Reranker Engine v1 — Contract

Turn: `A4-RERANKER-ENGINE-V1`. This document is written and frozen
**before** any real DEV_TUNE result, Gold, A result, or oracle result is
opened this Turn — implementation and synthetic tests only. It defines
the exact input/output shapes `a4-reranker-engine.mjs` and
`a4-reranker-features.mjs` are built against, so the engine can be
integration-tested against a real wide-candidate-pool producer later
without either side guessing at the other's field names.

**Correction 1 (input-pool ceiling, pre-results, no real result opened):**
the A4 wide pool is BM25 top-100 UNION dense top-100, deduplicated by
`chunk_id` — up to **200** distinct candidates, not 100. Frozen Arm A's
original top-20 is itself already a subset of that union (every A top-20
member appears in the BM25 and/or dense top-100 legs), so it is never
counted as 20 candidates on top of the 200.

**Correction 2 (schema compatibility with the real wide-pool producer,
pre-results, no real result opened):** section 2 below is rewritten to
match `buildWideCandidatePool()`'s actual return shape
(`codex/fourarm-a4-wide-pool-v01` @ `defd73302bd2b4fd6007283c968a87b3bbf49d0b`,
`domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs`) exactly,
field-for-field, so the reranker consumes that function's real output
with **zero** remapping — no adapter/shim layer. Concretely:
`candidate.bm25_top100`/`candidate.dense_top100`/
`candidate.in_original_a_top20` are replaced by
`candidate.source_membership.{bm25_top100,dense_top100,original_a_top20}`,
and `candidate.scores.{bm25,dense,original_a_rrf,wide_rrf}.rank` are
replaced by `candidate.source_ranks.{bm25,dense,original_a,wide_rrf}`
(plain integers/`null`, not `{score,rank}` objects — the actual score
values, when needed, live separately in
`candidate.source_scores.{bm25,dense,original_a_rrf,wide_rrf}`). Neither
correction adds, removes, or reweights any config, and no real
DEV_TUNE/Gold/A/oracle result was opened to make either.

**Correction 3 (full-ranking + stable refill, `A4-RERANKER-FULL-RANKING-
REFILL-V1`, pre-results, no real result opened):** the engine previously
truncated to top-20 *inside* `rerankCandidates()`, with no way for a
downstream stage to reject a top-20 member and backfill from rank 21+
without re-scoring/re-sorting. Section 1's pipeline and section 7 below
are updated: `rankCandidatePool()` is now the primary entry point (full
ranking, every input candidate, never truncated); `rerankCandidates()` is
now an unchanged-meaning, backward-compatible wrapper —
`rankCandidatePool(...).slice(0, TOP_K)`, nothing else — and
`selectWithStableRefill()` is a new, generic, A3-agnostic pure function
that turns a full ranking plus a per-candidate PASS/REJECT/KEEP_UNKNOWN
decision map into a final top-K with rejected top-K members backfilled
from later ranks. No config, weight, feature, or tie-break rule changed.

## 1. Role (fixed)

```
candidate pool → feature extraction → reranker score → deterministic sort
  → FULL ranking (rankCandidatePool)
  → optional top-K slice (rerankCandidates) OR external decisions + stable refill (selectWithStableRefill)
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

This is `buildWideCandidatePool()`'s own real `pool[i]` shape
(`a4-wide-candidate-pool.mjs`, `codex/fourarm-a4-wide-pool-v01` @
`defd73302bd2b4fd6007283c968a87b3bbf49d0b`), reproduced field-for-field —
the engine consumes this exact object with **no** remapping layer:

```ts
type RerankerCandidate = {
  chunk_id: string;                 // required, unique within a pool
  document_id: string;
  text: string | null;              // raw chunk text -- used ONLY for lexical/coverage features, NEVER compared against a Gold span
  chunk_text_sha256: string;
  node_index: number | null;
  node_indices: number[];           // [] if unknown -- never used as "missing" (empty is a real, resolved single/zero-node case)
  locator: object;                  // producer-defined shape; {} if unknown. No feature currently reads inside it (see section 4 note).
  provenance: object;                // producer-defined shape; {} if unknown. No feature currently reads inside it (see section 4 note).
  metadata: object;                  // producer-defined shape; {} if unknown

  // Membership flags: which source leg(s) this candidate came from, and
  // whether it was part of Frozen Arm A's own OFFICIAL top-20 output (not
  // merely "would rank in the top 20 under a recomputed formula" -- see
  // source_ranks.original_a below for that distinction). At least one of
  // bm25_top100/dense_top100 MUST be true -- the engine rejects
  // (RangeError) any candidate with both false, since it could not have
  // come from the pre-registered BM25-top-100-union-dense-top-100 union.
  source_membership: {
    original_a_top20: boolean;
    bm25_top100: boolean;
    dense_top100: boolean;
  };

  // Ranks (plain integers or null -- NOT {score,rank} objects).
  source_ranks: {
    // BM25/dense leg rank: an integer in [1,100], or null (not found by
    // this leg at all -- a legitimate absence, scored 0 by the
    // corresponding feature, never a validation failure).
    bm25: number | null;
    dense: number | null;
    // Arm A's RRF rank recomputed over the FULL pool via A's own formula
    // (RRF(k=60) over bm25_top100 + dense_top100's own top-20 subset) --
    // NOT capped at 20 in general; a candidate outside A's actual
    // official top-20 still gets a "would-be" rank here as diagnostic
    // signal. The engine enforces [1,20] ONLY when
    // source_membership.original_a_top20 is true; otherwise any positive
    // integer (or null) is accepted.
    original_a: number | null;
    // Diagnostic-only RRF rank over bm25_top100 + the FULL dense_top100
    // (never treated as final). An integer in [1,200], or null.
    wide_rrf: number | null;
  };

  // Actual score values, when needed (no current feature reads these --
  // every feature that uses a leg's standing uses its RANK, not its raw
  // score, to avoid cross-leg score-scale normalization issues).
  source_scores: {
    bm25: number | null;
    dense: number | null;
    original_a_rrf: number | null;
    wide_rrf: number | null;
  };
};
```

Nothing else is defined on this type. A candidate with additional
producer-side fields is accepted (the engine only reads the fields
above), but the engine never depends on any field not listed here.

**Known, disclosed gap (not fixed this Turn — out of the explicit
required-change list):** `table_context`/`provenance_completeness`
(section 4) were originally written against an assumed shape with
top-level `row`/`col`/`is_table`/`locator_status` fields. The real
producer's output has no such top-level fields (that information, if
present at all, lives inside the producer-defined `locator`/`provenance`
objects, whose internal shape is not yet pinned by any contract). Against
real `buildWideCandidatePool()` output, both features therefore currently
evaluate to their neutral `0.5` for every candidate — this does not throw
and does not block a valid top-20 (see the integration test in section
6), but it does mean these two signals are not yet informative on real
data. Wiring them to `locator`/`provenance`'s real internal shape is
follow-up work, not part of this schema-compatibility fix.

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
| `bm25` | `source_ranks.bm25` (reciprocal) | not found by this leg → **0** (real absence) |
| `dense` | `source_ranks.dense` (reciprocal) | not found by this leg → **0** |
| `original_rrf` | `source_ranks.original_a` (reciprocal) — Arm A's recomputed RRF rank, uncapped | no rank at all → **0**; a rank beyond 20 still contributes a smaller-but-nonzero value, by design (diagnostic signal, distinct from the boolean `original_a_protect` below) |
| `wide_rrf` | `source_ranks.wide_rrf` (reciprocal) | not in the wide pool at all → **0** (should not occur if the candidate came from the wide pool itself) |
| `lexical_overlap` | question-text token overlap with candidate text | no text on either side → **0.5** (neutral) |
| `term_coverage` | required metric/row-name presence in candidate text | no text or no required labels → **0.5** |
| `metadata_match` | corp/period/doc-group agreement with question expectations | no candidate metadata or no expectations given → **0.5** |
| `table_context` | row/col resolved or `is_table` known (see section 2's disclosed gap — currently always neutral against real producer output) | unknown → **0.5** |
| `provenance_completeness` | `locator_status` quality (see section 2's disclosed gap — currently always neutral against real producer output) | unknown/missing → **0.5** |
| `original_a_protect` | `source_membership.original_a_top20` — was this chunk in A's actual OFFICIAL top-20 (not merely a good `source_ranks.original_a` value) | boolean, no "missing" case (defaults `false` → 0) |

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
  `compareScored`): `reranker_score` desc → `source_membership.
  original_a_top20` desc → `source_ranks.original_a` asc (**only when**
  `source_membership.original_a_top20` is true — a candidate outside A's
  actual top-20 never gets this protective rank comparison, even if it
  carries a numeric `source_ranks.original_a`) → `source_ranks.wide_rrf`
  asc → `chunk_id` bytewise asc.
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
- Every candidate must carry `source_membership.bm25_top100=true` or
  `source_membership.dense_top100=true` (or both) — a candidate with
  neither is a hard `RangeError`.
- `source_ranks.bm25` and `source_ranks.dense` must each be an integer in
  `[1, 100]` or `null`; `source_ranks.wide_rrf` must be an integer in
  `[1, 200]` or `null`; `source_ranks.original_a` must be a positive
  integer or `null` in general, but when `source_membership.
  original_a_top20` is true it must additionally be in `[1, 20]` (and
  cannot be `null`) — any other value (0, a float, an out-of-range rank,
  `NaN`) is a hard `RangeError`, checked before any scoring.
- The **most important integration guarantee**: the real
  `buildWideCandidatePool()` return value (`{ pool } `) can be passed to
  `rerankCandidates(pool, questionContext, config)` directly — `pool`
  itself, no field renamed, no wrapper object, no adapter function in
  between. See
  `tests/four-arm-a4-reranker.test.mjs`'s wide-pool contract-integration
  tests, which import the real `buildWideCandidatePool` and do exactly
  this.
- Input candidate objects are never mutated — every candidate in the
  pipeline is spread into a **new** object; the caller's own array/objects
  are safe to reuse or freeze before calling.

## 7. Full ranking and stable refill API (`A4-RERANKER-FULL-RANKING-REFILL-V1`)

```ts
function rankCandidatePool(pool, questionContext, config): RankedCandidate[];
function rerankCandidates(pool, questionContext, config): RankedCandidate[]; // = rankCandidatePool(...).slice(0, TOP_K)
function selectWithStableRefill(
  rankedPool: RankedCandidate[],
  decisions: Record<string /* chunk_id */, "PASS" | "REJECT" | "KEEP_UNKNOWN">,
  options?: { outputK?: number } // default TOP_K = 20
): RankedCandidate[];
```

- `rankCandidatePool` is the primary entry point: same validation and
  scoring as before, but returns **every** candidate in `pool`, ranked
  (`rank` 1..`pool.length`), never truncated. An empty `pool` returns `[]`.
- `rerankCandidates` is unchanged in meaning — a thin wrapper,
  `rankCandidatePool(...).slice(0, TOP_K)` — no separate re-scoring or
  re-sorting happens inside it, so `rerankCandidates(...)` is always
  exactly the first `TOP_K` entries of
  `rankCandidatePool(...)` for the same three arguments.
- `selectWithStableRefill` is a **generic, A3-agnostic pure function** —
  it imports no A3 module and does not reimplement or approximate
  contradiction judgement. It only consumes an already-made decision per
  `chunk_id`:
  - Keeps `rankedPool`'s own order; never re-sorts, never recomputes a
    score.
  - Drops `REJECT`; keeps `PASS` and `KEEP_UNKNOWN` unchanged (same
    object reference, not a copy).
  - Returns the first `outputK` survivors in that order — so a `REJECT`
    inside what would have been the top-K is silently backfilled by the
    next surviving candidate at a later rank (stable refill), with no
    re-ranking of the survivors themselves.
  - Fails closed: a `rankedPool` entry with no `chunk_id`, a duplicate
    `chunk_id`, a missing decision for any `chunk_id` in `rankedPool`, or
    a decision outside `{PASS, REJECT, KEEP_UNKNOWN}` all throw before
    any selection happens. An extra `decisions` key with no matching
    `rankedPool` entry is harmless and ignored.
  - Never fabricates or pads — if fewer than `outputK` candidates survive,
    the returned array is simply shorter.
  - Never mutates `rankedPool`, its entries, or `decisions`.
