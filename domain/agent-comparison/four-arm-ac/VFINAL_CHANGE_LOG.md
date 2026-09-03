# vFINAL change log

Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section B/21.

vFINAL source: `/Users/jaewan/Downloads/4arm-vfinal-spec.txt`
SHA-256: `1a856dada61135df7c79f2cfc3c541a5fee8e820927e70786d00368db42da9f5`
(re-verified against the actual file at the start of this Turn; the original
vFINAL file itself is never overwritten by this Turn's work — this is a
separate, additive artifact.)

vFINAL section 21 permits a post-freeze change only for two reasons: (1) a
defect that makes official execution impossible, or (2) a contradiction
between rules. **No official DEV_TUNE-101 result exists yet** (this Turn
does not run one) — every correction below is a **pre-execution defect fix**
against the existing A/C implementation, not a change made after seeing
results. Nothing here was selected, tuned, or reverted based on any
DEV_TUNE/DEV_CHECK/HOLDOUT outcome, because none has been produced.

## Corrections made and why (vFINAL section B's own five items)

### 1. Candidate A's RRF candidate set was ambiguous / actually intersection-only

**Before**: `fixed-kure-hybrid-retriever-adapter.mjs`'s `retrieve()` always
computed the **intersection** of BM25 and dense candidates before fusing —
enforced both by the adapter's own filtering and by
`domain/contracts.mjs`'s `RETRIEVAL_METHOD_REQUIRED_COMPONENTS.HYBRID_RRF =
["bm25", "dense", "rrf"]` (every result must carry a non-null score from
BOTH legs). This is a valid method (`HYBRID_RRF`), but it does not implement
vFINAL section 3 ("A: 메타 필터 + BM25 + 전량 KURE dense + RRF" with the
`union` fusion pool `[해석 규칙]`/현재 intersection RRF는 공식 후보 A에
사용하지 않는다").

**Fix**: added a new, additive `retrieval_method` value, `HYBRID_UNION_RRF`
(`domain/contracts.mjs`, `domain/retrieval/retrieval-request.schema.json`,
`domain/retrieval/retrieval-result.schema.json`), whose
`RETRIEVAL_METHOD_REQUIRED_COMPONENTS` is `["rrf"]` only — a union result
item may legitimately carry a null `bm25` or `dense` component score (never
a fabricated one), because the underlying `reciprocalRankFusion` (`rrf.mjs`,
unmodified) was already union-capable (an id present in only one ranked
list still gets fused, contributing 0 from the absent leg). `existing
HYBRID_RRF's own contract/behavior is completely unchanged — the same
existing tests (intersection, zero-intersection-empty-result) still pass
unmodified. `arm-retriever-adapter.mjs`'s `searchArmA` now requests
`HYBRID_UNION_RRF`; `searchArmC` (BM25-only) is unaffected.

### 2. `synthetic-only metadata conditions` used with no fail-closed gate

**Before**: `config.A.json`/`config.C.json` pinned
`metadata_filter.source: "SYNTHETIC_FIXTURE_ONLY"` with `conditions_sha256:
null`, but nothing in the codebase would have refused an "official" run
against that source — it was documentation-only, not enforced.

**Fix**: new module `official-conditions-importer.mjs` — `validateOfficialConditionsArtifact`/
`importOfficialConditionsArtifact` (101-row, 1:1 `question_id`, artifact
SHA-256 + LOW/HIGH segmentation SHA-256, `OFFICIAL_ALLOWED_FIELDS`-only) and
`assertOfficialExecutionReady(source)`, which throws
`OFFICIAL_METADATA_FILTER_SOURCE_NOT_OFFICIAL` for any source other than
the literal string `"OFFICIAL_CONDITIONS_ARTIFACT"` — `SYNTHETIC_FIXTURE_ONLY`
included. No real `conditions.py` artifact exists yet (see
`conditions-fixture.mjs`'s own header — that name belongs to a separate
team's codebase), so `official_execution_ready` is `false` by construction:
there is no call site anywhere in this repository that supplies a real
artifact to `importOfficialConditionsArtifact`.

### 3. Metadata fields the builder returned but the predicate ignored

**Before** (found by direct code audit, not by running anything):
`buildMetadataFiltersFromConditions` already built the full filter object
(`corp_codes, document_ids, doc_groups, doc_subtypes, base_years,
base_months, receipt_date_from, receipt_date_to, is_correction,
retrieval_eligible`), but the two predicate functions that actually
enforced it diverged and were incomplete:
- Arm A's BM25 leg (`fixed-kure-hybrid-retriever-adapter.mjs`'s private
  `passesFilters`): checked only `corp_codes`/`document_ids`/`doc_groups`.
- Arm A's dense leg SQL (`reference-vector-retrieval-repository.mjs`'s
  `search()`): checked only `corp_codes`/`document_ids`.
- Arm C (`arm-retriever-adapter.mjs`'s private `passesMetadataFilters`):
  checked `corp_codes`/`document_ids`/`doc_groups`/`doc_subtypes`/
  `retrieval_eligible` — a **different** field set than arm A's BM25 leg,
  despite an in-code comment claiming they were "the same predicate".

`base_years`, `base_months`, `receipt_date_from`, `receipt_date_to`, and
`is_correction` were applied by **neither** leg, on **either** arm — zero
test coverage existed for any of them actually excluding a candidate.

**Fix**: one shared module, `domain/retrieval/metadata-filter.mjs` —
`passesMetadataFilters(row, filters)` (row-level, all 10 fields) and
`buildEligibilityWhereClause(filters, paramStartIndex, columnPrefix)` (SQL
fragment, same 10 fields, JSONB-path expressions for the fields stored
inside `metadata`). Both arm A's BM25 leg, arm A's dense leg, and arm C now
import this ONE implementation — no separate copy exists anywhere in
`four-arm-ac/` or `retrieval/` anymore.

### 4. Metadata filter applied after ranking, not before

**Before**: both legs ranked/scored the **unfiltered** candidate pool first
(BM25: full-corpus scoring, top-100; dense: SQL `ORDER BY distance LIMIT
20`), then pruned the already-ranked result — a filter that excluded many
candidates could leave fewer than top-k filter-compliant results even when
more existed further down the true ranking.

**Fix**: `fetchEligibleChunkIds(client, retrievalIndexId, filters)`
(`metadata-filter.mjs`) queries the eligible `chunk_id` set directly against
`reference_retrieval_chunks` **before** any ranking; `bm25Search` gained an
additive `eligibleIds` parameter (omitted ⇒ scores the whole index,
byte-for-byte unchanged from before this Turn) that restricts the candidate
pool it scores; `vectorRepository.search()` gained an additive `filters`
parameter that pushes the full field set into the SQL `WHERE` clause (via
the same `buildEligibilityWhereClause`) **before** the `ORDER BY`/`LIMIT`.
Both arm A's BM25 leg and arm C now call `fetchEligibleChunkIds` first, then
`bm25Search(..., { eligibleIds })` — the row-level predicate still runs
afterward too, as a defense-in-depth double-check, never the only gate.

### 5. `final_top_k=20` conflated evaluation cutoff and retrieval output count

**Before**: one field, `final_top_k: 20`, doing double duty as both "how
many results the retriever returns" and (implicitly) "what k the evaluator
reports/decides on" — vFINAL section 15 requires these named and pinned
separately.

**Fix**: `config.A.json`/`config.C.json` now carry `bm25_candidate_k: 100`,
`dense_candidate_k` (20 for A, 0 for C), `retrieval_output_k: 20`,
`primary_evaluation_k: 10`, `reported_cutoffs: [5, 10, 20]`, `rrf_constant`
(60 for A, null for C), `rrf_candidate_set` (`"UNION"` for A, null for C),
and `retrieval_method` (`"HYBRID_UNION_RRF"` for A, `"BM25"` for C).
`final_top_k` is removed. `pair-diff.mjs`'s `ALLOWED_PAIR_DIFF_KEYS` gained
`retrieval_method`/`dense_candidate_k`/`rrf_constant`/`rrf_candidate_set`
(the fields directly tied to the dense ablation) — `bm25_candidate_k`/
`retrieval_output_k`/`primary_evaluation_k`/`reported_cutoffs` are
deliberately **not** in that list, so a real divergence there still fails
`CONFIG_PAIR_MISMATCH`.

## What did NOT change

- `HYBRID_RRF`'s own contract, behavior, and every pre-existing test
  covering it (intersection semantics, zero-intersection-empty-result).
- `domain/chunking/chunker.mjs` — untouched, per this Turn's own
  instruction and the prior Turn's real-corpus root-cause finding (the
  chunking algorithm was exonerated; the OOM was in the PostgreSQL write
  path — see section I of this Turn's final report).
- `reciprocalRankFusion` (`rrf.mjs`) — the union-capable fusion algorithm
  itself needed no change; only the caller's intersection-vs-union choice
  did.
- The corpus/chunking pins in `config.A.json`/`config.C.json`
  (`corpus_snapshot_id`, `corpus_manifest_sha256`, `chunking_policy_sha256`)
  — still pinned to `VALIDATION_SHARD_750` as of this change log. Section N
  of this Turn re-pins them to the full corpus only once Discovery is
  independently verified GREEN (see this Turn's final report).

## Not addressed by this change log (explicitly out of scope for this Turn)

- Arms B and D — `config.B.json`/`config.D.json` do not exist in this
  repository yet; this Turn's sections C/D only cover candidates A and C.
- Any real `conditions.py` artifact — still not provided; `official-
  conditions-importer.mjs` is importer/schema/validator only, per section F.
- Actual DEV_TUNE-101 execution, DEV_CHECK, HOLDOUT — forbidden by this
  Turn's own instructions regardless of readiness state.
