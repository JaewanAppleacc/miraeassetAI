# A3 Candidate Ceiling Audit v1 — Pre-registration Amendment

Turn: `A3-CANDIDATE-CEILING-AUDIT-V1`. Written and committed **before** any
oracle Recall number is computed, per this Turn's own rule ("결과 확인 전
사전 등록"). Nothing below this line is edited after candidate generation
starts.

## 0. Scope restatement (binding)

This Turn only measures the retrieval **ceiling** (oracle Recall) of Frozen
Arm A's candidate pool at top-20/50/100. It does **not**:

- implement a reranker,
- declare an A3 winner,
- re-run retrieval after seeing results,
- adjust weights, chunking, or fusion constants after seeing results,
- re-run a subset of questions,
- add a new Gold-allowed source,
- touch DEV_CHECK/HOLDOUT,
- modify A/A2's original `results/`/`run.json` files or worktrees.

## 1. Base references (fixed before execution)

| Item | Value |
|---|---|
| A implementation branch | `codex/fourarm-ac-vector-import-v01` |
| A implementation commit | `44f05231de8b9a3b6fdb6ff422435d0586937941` |
| A results / latest contract branch | `codex/fourarm-a2-integration-v01` |
| A results / latest contract commit | `900d3cc72336a1aece86ec776d84f55ec3564cc8` |
| Ancestry | `44f0523…` is a verified ancestor of `900d3cc7…` (`git merge-base --is-ancestor` = true) |
| New worktree | `agent-fourarm-a3-ceiling-audit-v01` |
| New branch | `codex/fourarm-a3-ceiling-audit-v01`, branched from `900d3cc7…` |
| DB mode | read-only for this entire Turn (no `INSERT`/`UPDATE`/`DELETE`/DDL issued at any point) |

## 2. Fixed retrieval conditions (locked, not touched after this commit)

- **Corpus**: identical to A (`corpus_04750795e1a2d5c3`, manifest_sha256
  `04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364`).
- **Chunking**: Fixed-512 (`fixed-token-512-o64.v0.1.0`), unmodified.
- **Metadata prefilter**: identical to A — same
  `official-conditions-v2-importer.mjs`-validated
  `devtune101_conditions.v2.jsonl` → `mapOfficialConditionToFilterInput` →
  `buildMetadataFiltersFromConditions` → `fetchEligibleChunkIds` /
  `passesMetadataFilters` pipeline, same company resolver
  (`seed-company-directory-owner-decision.v0.1.approved.json`), zero code
  changes to any of these modules.
- **BM25 candidate k**: 100 (`bm25TopK: 100`, A's own default — unchanged).
- **KURE dense candidate k**: 100 (`topK: 100` passed to
  `searchDocumentChunksByVector`, widened from A's official
  `dense_candidate_k=20` — **only** this candidate-return limit changes).
- **Fusion**: existing A `reciprocalRankFusion` (`rrf.mjs`), `k=60`,
  unchanged, applied to the **union** of the two 100-candidate legs
  (`HYBRID_UNION_RRF`, matching A's own `rrf_candidate_set: "UNION"`),
  fused-output cap raised to 100 (`topK: 100`) so the RRF leg is also
  observed at full requested depth.
- **Measurement cutoffs**: 10 / 20 / 50 / 100.
- **Questions**: all of DEV_TUNE-101 (101/101), no subset.
- **Code reused unmodified**: `bm25Search`, `fixed-kure-bm25-index.mjs`
  (persisted index), `fetchEligibleChunkIds`, `passesMetadataFilters`
  (`domain/retrieval/metadata-filter.mjs`), `searchDocumentChunksByVector`
  (`reference-vector-retrieval-repository.mjs`), `reciprocalRankFusion`
  (`rrf.mjs`), `classifySpans`/`buildProvenanceSet`
  (`locator-provenance.mjs`), `createEmbeddingAdapter` (HTTP_EMBEDDINGS,
  same KURE pin), `mapOfficialConditionToFilterInput` +
  `createGatedSeedCompanyResolver`. A **new** orchestration script
  (`scripts/p11f0-fourarm-a3-ceiling-candidates.mjs`) calls these same
  functions directly so the BM25-leg and dense-leg candidate lists can be
  captured **before** fusion (A's own runner only ever exposes the fused
  top-k) — no existing file above is edited.

## 3. Pre-registered decision rule (fixed, not adjustable after results)

| oracle Recall@100 (union) | Verdict |
|---|---|
| `>= 0.92` | `A3_RERANKER_CEILING_GREEN` — reranker experiment worth running |
| `0.90 <= x < 0.92` | `A3_RERANKER_CEILING_MARGINAL` — reranker viable but thin; consider pairing with multi-query |
| `< 0.90` | `A3_RERANKER_CEILING_INSUFFICIENT` — reranker alone cannot reach 0.90; table-dual or multi-query candidate generation needed |
| input/reproducibility failure | `BLOCKED_CONTRACT` |

0.92 is pre-registered as the minimum headroom a perfect reranker needs to
still land at 0.90 after imperfect real-world re-ranking loss.

## 4. Oracle definition (fixed)

"Oracle Recall@k" = the same slot-level hit definition the frozen scorer
(`ac_scorer_50cc1aac…`, `fourarm.patched.py`'s `slot_found`) uses, applied
to our own top-k candidate lists instead of A's official top-20 output:

- Primary match: a candidate's `doc_id` equals the Gold source's
  `document_id`, and the Gold source's `node_index` is a member of that
  candidate's `{node_index} ∪ node_indices`.
- Text disambiguation: when the DocumentIR NodeStore
  (`a2-documentir-node-store.mjs`'s `createDocumentIrFetchNode`, reused
  unmodified, read-only against the 4 pinned DocumentIR files) shows the
  Gold evidence line exists in the full node's rendered text but **not**
  inside the specific candidate chunk's own text, the candidate is treated
  as the wrong window of the right node and is **not** counted as a match
  — identical to the frozen scorer's own rule.
- Aggregation: `recall@k = (Σ slots_found@k) / (Σ n_slots)` pooled across
  the relevant question set (micro-average at the slot level, not a
  per-question macro-average) — the same formula as `fourarm.patched.py`'s
  `_agg()`, so these oracle numbers are directly comparable in scale to
  A's already-reported `RESULTS_SUMMARY.md` Recall@10 numbers.
- Excluded questions: any question with `n_slots == 0` (none expected in
  DEV_TUNE-101; recorded if found).

## 5. Segment definitions (fixed; two are heuristic and disclosed as such)

- **전체 / HIGH / LOW**: `devtune101_conditions.v2.jsonl`'s own `segment`
  field (verbatim, not re-derived).
- **periodic / major / holding / exchange**: `conditions.doc_groups[0]`
  from the same official conditions file (the same field the retrieval
  filter itself uses).
- **표 node / 비표 node**: computed at Gold **slot-source** granularity
  (not per-question) — a source is "표 node" iff its `source_locator`
  parses a non-null `row`/`col`; recall is pooled over the sources in each
  bucket.
- **연결/별도 명시 문항** (heuristic, disclosed): a question is in this
  bucket iff Gold's `tags` includes `"scope"`, or any of its
  `expected_execution.required_fact_slots[].scope` is `"CONSOLIDATED"`.
  Gold has no single dedicated boolean field for this; this is the closest
  available proxy and is reported as such, not as ground truth.
- **기간 비교 문항** (heuristic, disclosed): a question is in this bucket
  iff Gold's `question_type == "COMPARISON_CALC"`, or `tags` includes
  `"same_company_different_period"` or `"period_type"`. Same caveat as
  above.

## 6. Reproducibility commitments

- Query embedding calls: at most 101 (one `embedQuery` per question, no
  retries-with-different-text, no per-leg duplicate calls — the same
  vector is reused for the dense leg and the union fusion).
- Corpus/document embedding calls (`embedDocuments`): 0.
- DB writes: 0 (verified by `pg_stat_activity`-free session and read-only
  query review before commit).
- Candidate pool raw text and Gold content: written only under
  `work/a3-candidates/` and `work/gold/` (both `/work/`-gitignored per
  this repo's root `.gitignore`), never in a committed path.
- Committed artifacts this Turn: this amendment, the two new orchestration
  scripts, and the final aggregate report — SHAs, counts, and failure
  classifications only.
- Before trusting any oracle number, A's official top-20 (`A.results.jsonl`)
  is replayed at top-20 with the identical question/filter/BM25/dense/RRF
  pipeline and its `chunk_id` prefix is compared byte-for-byte against the
  original. A mismatch anywhere ends this Turn with
  `NON_COMPARABLE_RETRIEVAL_REPLAY` instead of reporting oracle numbers.

## 7. Environment / input-pin verification (recorded before any candidate generation; not an oracle result)

All of the following were checked directly against the live environment,
not assumed from documentation:

| Pin | Expected | Found | Status |
|---|---|---|---|
| `code_head_sha256` note aside — actual git ancestry | `44f0523…` ⊂ `900d3cc7…` | confirmed via `git merge-base --is-ancestor` | OK |
| A `config_sha256` (`A.run.json`) | `399bcd59944319e232aa428e47befe54fbb8f7cc1b44eed9d72a28d3e3dbbbc3` | present verbatim in `results/A.run.json` | OK |
| DocumentIR `exchange.jsonl` sha256 | `80000c1c12f09bb59ce5bea41f62c5a70a39bdc965859c8436c261e9bde02c2a` | matches | OK |
| DocumentIR `holding.jsonl` sha256 | `fd88d83c53a4c465ec1cbedce0a41046cfa7819822e2d7df046fccf42b8cbc09` | matches | OK |
| DocumentIR `major.jsonl` sha256 | `5c58da7ad32fe31603f59bdea6829c29e6cb00b823c336b6e90b71f41d25d3ba` | matches | OK |
| DocumentIR `periodic.jsonl` sha256 (on-disk alias `periodic-001.jsonl`) | `0aee546312b93797cf35f946144e044d8f43a947c38bb49b0766b623076be852` | matches (8.1GB file, full hash) | OK |
| KURE revision / dimension | `nlpai-lab/KURE-v1` @ `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dim 1024 | live local server `/info`: repository/revision/dimension all match | OK |
| Retrieval index status/count | `fixed_kure_index_8fe191342205848d1d6a6123f38a54e7`, READY, 442549 | `disclosure_reference.reference_retrieval_indexes` row matches exactly | OK |
| BM25 index sha256 / doc count | `d5a58b0addbfda9ce6b807b0659a2c4ef7ded97a3f1d7797115f46aebfa929c6`, 442549 docs | cache file `fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36.bm25-index.v2.ndjson` hash matches exactly | OK |
| DEV_TUNE Gold sha256 | `7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b` | `dev-tune-gold.v0.1.jsonl` (101 rows) matches exactly | OK |
| conditions sha256 | `83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527` | `devtune101_conditions.v2.jsonl` matches exactly | OK |
| universe sha256 | `96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc` | `universe.csv` matches exactly | OK |

No mismatch found → this Turn does **not** end with `BLOCKED_INPUT_PIN`.
Execution proceeds under section C of the Turn instructions.

Live infra used this Turn (all pre-existing, none newly provisioned or
reconfigured by this Turn): local Postgres 16 instance on
`127.0.0.1:55329`, database `p11f0_scratch`, and a local KURE-v1 HTTP
embedding server (`sentence_transformers`, MPS device) already running on
`127.0.0.1:58411` before this Turn began, launched by an unrelated prior
session — this Turn only issues read/query calls against both, never
starts, stops, or reconfigures either process.
