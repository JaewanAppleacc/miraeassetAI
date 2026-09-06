# A4 Reranker Engine v1 — Handoff

Turn: `A4-RERANKER-ENGINE-V1` ("작업자 2"). Implementation + synthetic
tests only — no real DEV_TUNE result, Gold, A result, or oracle result
was opened at any point this Turn or either of its two follow-up fix
commits.

## Changelog (post-initial-implementation fixes, both pre-results)

1. **Pool-size ceiling fix** (`facbb143e48a5b42b19e326075baac032d8215f3`):
   the wide pool is BM25 top-100 UNION dense top-100 (≤200 after dedup),
   not 100 — `MAX_POOL_SIZE` raised to 200, membership-flag and rank-range
   validation added.
2. **Schema-compatibility fix with the real wide-pool producer** (this
   commit): rewrote the engine/features/contract/tests to consume
   `buildWideCandidatePool()`'s actual return shape
   (`codex/fourarm-a4-wide-pool-v01` @
   `defd73302bd2b4fd6007283c968a87b3bbf49d0b`,
   `a4-wide-candidate-pool.mjs`) with **zero remapping**:
   `source_membership.{bm25_top100,dense_top100,original_a_top20}` and
   `source_ranks.{bm25,dense,original_a,wide_rrf}` (plain integers, not
   `{score,rank}` objects) replace the earlier assumed
   `candidate.bm25_top100`/`candidate.scores.*.rank` shape. `source_ranks.
   original_a` is now understood as A's uncapped, recomputed "would-be"
   RRF rank (can exceed 20) — the `[1,20]` ceiling and the tie-break
   protection apply only when `source_membership.original_a_top20` is
   true. `source_ranks.wide_rrf` now has an explicit `[1,200]` validated
   range. A byte-identical copy of `a4-wide-candidate-pool.mjs` was
   brought into this branch (never modified) so the test suite can import
   the real function and feed its real output straight into
   `rerankCandidates()`.

## Purpose / acceptance criteria

Build a generic reranker engine that takes a wide (BM25 top-100 UNION
dense top-100, ≤200 after dedup) candidate pool plus a per-question
context and produces a deterministic top-20, using only the signals
listed in the Turn's own input contract (BM25/dense/original-A-RRF/
wide-RRF rank, lexical overlap, required metric/row-name coverage,
metadata consistency, table/header context, locator/provenance
completeness) — never a Gold field, a real failure packet id, a
company/question-specific exception, or DEV_CHECK/HOLDOUT data. Ship a
pre-registered, capped (≤12) family of scoring configs (R0–R5) fixed
**before** any real result is opened, and consume the real
`buildWideCandidatePool()` output with zero remapping.

Completion condition: `A4_RERANKER_ENGINE_IMPLEMENTED` (declared below).

## Plan used

1. Set up `agent-fourarm-a4-reranker-v01` / `codex/fourarm-a4-reranker-v01`
   from the recorded remote HEAD of `codex/fourarm-a3-ceiling-audit-v01`.
2. Write `A4_RERANKER_V1_CONTRACT.md` first — the exact
   `RerankerCandidate`/`RerankerQuestionContext` shapes and the fixed
   pipeline/tie-break rules — since no external wide-pool contract
   document was available to reference directly; this Turn defines and
   freezes its own, consistent with this repo's existing candidate-object
   conventions (`arm-retriever-adapter.mjs`'s result-item shape,
   `locator-provenance.mjs`'s `LOCATOR_STATUS` vocabulary).
3. Implement `a4-reranker-features.mjs` (10 pure feature functions, each
   finite in `[0,1]`, with an explicit missing-vs-absent distinction
   documented in its own header).
4. Implement `a4-reranker-engine.mjs` (config validation, weighted
   scoring, the one fixed global tie-break, top-20 truncation) — pure,
   synchronous, no I/O.
5. Register 6 configs (families R0–R5) in `a4-reranker-configs.v1.json`,
   each with an exact, hand-fixed weight vector (no learned/tuned
   weights — there is nothing to tune against without real results).
6. Write `tests/four-arm-a4-reranker.test.mjs` against every item in the
   Turn's own required-tests list, using only synthetic fixtures.
7. Run tests, `schema:validate`, `typecheck`, `git diff --check`.

## Changed files

- `domain/agent-comparison/four-arm-ac/A4_RERANKER_V1_CONTRACT.md` (new, then twice corrected)
- `domain/agent-comparison/four-arm-ac/A4_RERANKER_V1_HANDOFF.md` (this file, new, then twice corrected)
- `domain/agent-comparison/four-arm-ac/a4-reranker-features.mjs` (new, then corrected for the real field shape)
- `domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs` (new, then corrected twice — pool ceiling, then field shape)
- `domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json` (new; untouched by either fix)
- `tests/four-arm-a4-reranker.test.mjs` (new, then corrected twice)
- `domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs` — **brought in from
  `codex/fourarm-a4-wide-pool-v01` @ `defd73302bd2b4fd6007283c968a87b3bbf49d0b`,
  byte-identical, never modified** (verified by SHA-256 match against that
  commit's own blob before and after this Turn's commit) — needed so the
  test suite can import and call the real `buildWideCandidatePool()`.
  Nothing else from that branch (its own contract/handoff/test files) was
  copied in.

## Tests run and results

- `node --test tests/four-arm-a4-reranker.test.mjs`: **31/31 pass**
  (byte-identical determinism, stable-subset/top-20 invariants, 200-wide
  ceiling with the 100/101/199/200-accepted/201-rejected boundary,
  full-pool scoring before truncation, no-mutation, missing-feature
  neutrality, BM25-only/dense-only handling, original-A protective
  signal — both the boolean-only and full-tie-break-chain cases, and the
  case proving a non-top-20 candidate's diagnostic `original_a` rank is
  never used as a protective signal — multi-node provenance invariance,
  no per-question special-casing, fail-closed config/membership/rank-range
  validation, config-count ≤12, source-level isolation from
  Gold/A3-Guard/QA/DB/KURE, byte-invariance of the 4 pre-existing result
  files this Turn must not touch, and three wide-pool contract-integration
  tests that import the real `buildWideCandidatePool()` and feed its
  actual return value into `rerankCandidates()` with no remapping layer).
- `npm run schema:validate`: PASS, 36 pairs validated (unchanged — no new
  schema/example pair was added, since neither new JSON file is
  registered in `scripts/validate-interface-schemas.mjs`'s fixed pair
  list).
- `npm run typecheck` (`tsc --noEmit`): PASS — this repo's `tsconfig.json`
  `include` only covers `.ts`/`.tsx`/`.mts`/`.d.ts` plus specific
  `app|build|db|examples|worker` directories, so the new `.mjs`/test files
  are outside its scope; typecheck is unaffected either way.
- `git diff --check`: clean (no whitespace errors).

## Contract / schema changes

None to any existing contract or schema. Two new, self-contained
documents/type shapes are introduced
(`A4_RERANKER_V1_CONTRACT.md`'s `RerankerCandidate`/
`RerankerQuestionContext`) — no existing frozen contract (Section 4/15 of
the top-level `CLAUDE.md`) is touched.

## Generated artifacts and hashes

No data artifacts were generated (implementation + synthetic tests only).
The four pre-existing result files verified byte-unchanged this Turn:

| file | sha256 |
|---|---|
| `results/A.results.jsonl` | `1132226193290fda5e007c417982a005b3381ac11b07a22d2c388d133d6ce156` |
| `results/A.run.json` | `1dd354f6db72845a4c69337453a0713eeb4b55ed51c2cecfe1ddeb8c09d0c395` |
| `results/A2.results.jsonl` | `3083901a68ae0e79f2c1e7d9c841337384898f8276769ea30483c7923416a773` |
| `results/A2.run.json` | `c55d90ab5b66619fe8d75dbe27791fcf846f48bb0463eee611c7e76ee4fc6b40` |

## Known limitations / open items for the integration Turn

- **Resolved by this fix** (was previously an open item): `RerankerCandidate`
  now matches `buildWideCandidatePool()`'s actual return shape
  field-for-field, verified by three tests that call the real function and
  feed its real output into `rerankCandidates()` with no adapter layer.
- **Still open, disclosed, not part of the schema-compatibility fix**:
  `table_context`/`provenance_completeness` (two of the ten features)
  read top-level `row`/`col`/`is_table`/`locator_status` fields that the
  real `buildWideCandidatePool()` output does not carry (that information,
  if present, lives inside its `locator`/`provenance` objects, whose
  internal shape is not yet pinned by any contract). Against real pool
  output these two features currently always evaluate to their neutral
  `0.5` — this does not throw or block a valid top-20, but the two signals
  are not yet informative on real data. Wiring them to `locator`/
  `provenance`'s real internal shape is separate follow-up work.
- Per the A3 Candidate Ceiling Audit's own finding
  (`A3_CANDIDATE_CEILING_AUDIT_V1_RESULT.md`, verdict
  `NON_COMPARABLE_RETRIEVAL_REPLAY`): a wide (dense_candidate_k=100) pool
  is **not** a rank-preserving superset of Frozen Arm A's official top-20
  under plain RRF. This engine's own `original_a_protect` feature and the
  R0 config exist specifically so a reranker *can* recover A's original
  ordering as a strong prior when desired, but the integration Turn
  should not assume `source_membership.original_a_top20`/`source_ranks.
  original_a` alone reproduces A's exact frozen order without the same
  protective weighting applied.
- Weights in `a4-reranker-configs.v1.json` are hand-fixed, not tuned —
  by design, since no real result may inform them this Turn. The
  integration Turn evaluates all ≤12 pre-registered configs against
  DEV_TUNE-101 in one pass and is the first point at which any
  performance signal touches this engine.
- No `A3 Contradiction Guard` integration exists here — this engine's
  output is a plain top-20 ranking; the guard runs downstream, per the
  pipeline in the Turn's own instructions
  (`A4 wide pool → pre-registered reranker configs → A3 Contradiction Guard → top-20 → 기존 QA`).

## Declaration

`A4_RERANKER_ENGINE_IMPLEMENTED`
