# A3 Candidate Ceiling Audit v1 — Result

Turn: `A3-CANDIDATE-CEILING-AUDIT-V1`. Pre-registration:
`A3_CANDIDATE_CEILING_AUDIT_V1_AMENDMENT.md` (committed before any number
below was computed). This Turn does **not** implement a reranker and does
**not** declare an A3 winner.

## Final verdict: `NON_COMPARABLE_RETRIEVAL_REPLAY`

The pre-registered top-20 replay check (amendment section 6 / Turn section
F) **fails**: only 10/101 questions (9.9%) reproduce Frozen Arm A's
official top-20 `chunk_id` sequence exactly once the dense candidate leg is
widened to top-100. Per the pre-registered rule, the oracle Recall numbers
below are **not adopted as official** — they describe a measurement
surface that is not a strict, order-preserving superset of A's
already-graded top-20. Section G's GREEN/MARGINAL/INSUFFICIENT ladder is
not applied this Turn.

## Root cause (found, not guessed)

`reciprocalRankFusion` correctly gives an absent leg score 0 (by design,
`rrf.mjs`, unmodified). Widening the dense leg from A's official
`dense_candidate_k=20` to this Turn's pre-registered 100 means many
chunks that previously got **zero** dense contribution now get a real one
(dense rank 21–100), which can raise their fused score enough to jump
ahead of chunks that were in the original top-20. This is not a bug in
either script — it is the correct, expected behavior of RRF-over-union
under a wider candidate window; it just means "the same union RRF, but
with a wider dense window" is a genuinely different ranking function from
A's frozen one, not merely a truncation-safe extension of it.

Concrete, byte-verified example (`author_0459b5f8f37b0192316cd77c`,
`chunk_64d74c47bcd26bd190892959`, doc `holding_20240403000410`):

| | BM25 rank | Dense rank | RRF score | Formula |
|---|---|---|---|---|
| A's official run (dense top-20 only) | 1 | *absent* (outside top-20) | `0.01639344262295082` | `1/(60+1)` |
| This Turn's run (dense top-100) | 1 | 22 | `0.028588564574170333` | `1/(60+1) + 1/(60+22)` |

That single new contribution moved this chunk from official rank 11 to
rank 1 of the new fused list, displacing the chunk that was officially
ranked 1st down to rank 2. The effect recurs across the corpus because
BM25-top100 and dense-top100 overlap heavily (`source_overlap.both` =
274/286 slots below) — most Gold-relevant chunks that either leg finds are
found by *both* legs somewhere in their respective top-100s, so widening
the dense window very often changes at least one fused rank inside the
old top-20.

## Section B — input pin verification

All pins matched exactly (full table in the amendment doc, section 7):
A `config_sha256`/`code_head_sha256` ancestry, all 4 DocumentIR file
SHA-256s (including the 8.1GB `periodic-001.jsonl` alias), KURE-v1
revision/dimension (live server `/info`), retrieval index status/record
count (`READY`, 442549), BM25 index SHA/document count, DEV_TUNE Gold
SHA (101 rows), conditions SHA, universe SHA. No `BLOCKED_INPUT_PIN`.

## Section C — candidate pool generation (completed)

- 101/101 questions processed, one candidate-pool JSON per question
  (`work/a3-candidates/`, gitignored) with BM25 top-100, dense top-100,
  and union-RRF top-100 (`k=60`), each candidate hydrated with
  `doc_id`/`node_index`/`node_indices`/`locator`/`row`/`col`/
  `chunk_text_sha256`/raw text.
- Query embedding calls: **101** total across both runs (a 2-question
  smoke test + the 99-question remainder; the resumable checkpoint
  skipped the 2 already-done files) — at the pre-registered ceiling,
  never exceeded.
- Corpus/document embedding calls (`embedDocuments`): **0**.
- DB writes: **0** (`grep` of both new scripts for
  `INSERT|UPDATE|DELETE|DROP|ALTER|CREATE` finds none; both scripts open
  a single read-only session per run).
- Determinism: re-running the candidate script against an
  already-written question file is a verified no-op (checkpoint skip on
  matching `candidate_k`/`rrf_k`) — same code, same DB/BM25 index/KURE
  server, same output.

## Section D — oracle Recall (diagnostic only — see verdict above)

Pooled at the **slot** level (`Σ slots_found@k / Σ slots_total`), same
formula as the frozen scorer's own `_agg()`; 100/101 questions scored
(`gold_b_e95de359f794df64ffab5044`, `NOT_FOUND`/`ANSWERABILITY`, has 0
required evidence slots and is excluded, matching the frozen scorer's own
exclusion rule). 286 slots total.

| leg | R@10 | R@20 | R@50 | R@100 | all_found@10 | all_found@100 |
|---|---|---|---|---|---|---|
| BM25 top-100 | 0.7587 | 0.8636 | 0.9161 | 0.9650 | 0.6700 | 0.9100 |
| Dense top-100 | 0.7727 | 0.8462 | 0.9510 | 0.9650 | 0.6500 | 0.9200 |
| Union RRF top-100 | 0.8741 | 0.9056 | 0.9615 | **0.9720** | 0.7700 | 0.9300 |

Had the replay check passed, union oracle Recall@100 = 0.9720 would have
mapped to `A3_RERANKER_CEILING_GREEN` under the pre-registered rule (§3).
It is reported here as a **diagnostic upper bound of a related but
distinct retrieval configuration** (A + wider dense window), not as the
ceiling of the already-frozen, already-graded arm A top-20.

### Segment breakdown (union RRF leg, Recall@100 / all_found_rate@100)

| segment | n questions | slots | R@100 | all_found_rate@100 |
|---|---|---|---|---|
| ALL | 100 | 286 | 0.9720 | 0.9300 |
| HIGH | 81 | 250 | 0.9800 | 0.9506 |
| LOW | 19 | 36 | 0.9167 | 0.8421 |
| periodic | 13 | 33 | 0.9697 | 0.9231 |
| major | 11 | 24 | 0.9167 | 0.8182 |
| holding | 33 | 105 | 1.0000 | 1.0000 |
| exchange | 34 | 99 | 0.9495 | 0.8824 |
| 표 node (slot-source granularity) | — | 197 | 1.0000 | — |
| 비표 node (slot-source granularity) | — | 89 | 0.9101 | — |
| 연결/별도 명시 (heuristic, §5) | 14 | 40 | 1.0000 | 1.0000 |
| 기간 비교 (heuristic, §5) | 12 | 32 | 1.0000 | 1.0000 |

BM25-only and dense-only breakdowns for the same segments are in
`work/a3-oracle-report.json` (gitignored; the numbers above are the full
set this report draws from — nothing beyond aggregate figures from that
file is reproduced here).

## Section E — failure decomposition (union RRF, k=100, 8 unresolved slots)

| classification | count |
|---|---|
| `UNRESOLVED` | 4 |
| `METADATA_FILTER_EXCLUDED` | 4 |
| `CORRECT_DOCUMENT_NOT_RETRIEVED` | 0 |
| `CORRECT_DOCUMENT_WRONG_NODE` | 0 |
| `CORRECT_NODE_BELOW_CUTOFF` | not applicable at the k=100 ceiling itself (see note below) |
| `TABLE_CONTEXT_FRAGMENTED` | 0 |
| `QUERY_VOCABULARY_MISMATCH` | not auto-assigned this Turn (folded into `UNRESOLVED` — see note) |
| `SCOPE_PERIOD_UNIT_CONFUSION` | not auto-assigned this Turn (folded into `UNRESOLVED` — see note) |
| `CORPUS_OR_GOLD_MISMATCH` | 0 |

- The 4 `UNRESOLVED` slots are all `slot_name: "corpus_coverage_check"` —
  a deliberately negative-evidence slot pattern (checking that a document
  is genuinely absent), which this Turn's automatic classifier has no
  confident rule for and correctly declines to guess at.
- The 4 `METADATA_FILTER_EXCLUDED` slots (3 questions:
  `author_a7d2486c24a01dace51cdbe0`, `author_d640cbedd7330f4b9bcfeeb7` ×2,
  `author_ffcc4093fb37a87f1a40322d`) are a real, actionable finding: the
  Gold document exists in the retrieval index and passes the SQL-level
  eligibility check for *some* filter shape, but fails
  `passesMetadataFilters` under that specific question's own derived
  filters — worth an Owner-reviewed look at the conditions→filter mapping
  for these 3 questions specifically, independent of anything reranking
  could fix.
- `QUERY_VOCABULARY_MISMATCH` and `SCOPE_PERIOD_UNIT_CONFUSION` were not
  automatically distinguished this Turn (both require semantic judgment
  this Turn's classifier cannot certify) — per the Turn's own instruction
  ("분류를 자동 확정할 근거가 없으면 UNRESOLVED로 둔다"), any slot that would
  have needed one of these two labels is reported under `UNRESOLVED`
  instead of a guessed label. None of the 8 unresolved slots this Turn
  actually needed either label, once corpus/metadata causes were ruled
  out first.
- `CORRECT_NODE_BELOW_CUTOFF` is defined relative to *this Turn's own*
  ceiling (k=100); since 100 is also the outer edge of every candidate
  pool this Turn generated, nothing can be observed "below" it — the
  category legitimately has zero members at the k=100 ceiling itself (it
  is used internally for the top-20-vs-top-50/100 breakdown below).

### Cross-leg overlap (286 slots, union-RRF top-100 membership)

| | count |
|---|---|
| Found by both BM25 and dense top-100 | 274 |
| BM25-only | 2 |
| Dense-only | 2 |
| Found by neither (within top-100 of either leg) | 8 |
| Not in top-20 but appears by top-50/100 | 19 |
| Slots with no matching candidate anywhere in union-RRF top-100 | 10 |

(The 10 vs. 8 difference between "no matching candidate" and "8 slots
classified as misses" is expected: the classifier count only covers
slots the *stricter* frozen-scorer `slot_found` logic — including its
DocumentIR-NodeStore "wrong window of the right node" rejection — treats
as failed, while the raw 10 uses only the primary `(doc_id, node∈nodes)`
membership test with no text/NodeStore disambiguation.)

## Section F — verification (all as pre-registered)

| check | result |
|---|---|
| Top-20 replay match rate | **9.9%** (10/101) — see verdict above |
| A/A2 original `results/`/`run.json` SHA before vs. after | unchanged (`shasum` diff = 0) |
| DB writes | 0 |
| Corpus/document embedding calls | 0 |
| Query embedding calls | 101 (≤101 ceiling) |
| DEV_CHECK/HOLDOUT accessed | 0 files (neither path referenced anywhere in this Turn's two scripts) |
| Partial/subset question re-runs | 0 (101/101 in one pass; checkpoint skip only re-validates already-identical `candidate_k`/`rrf_k`, never re-runs a *different* config for a subset) |
| Gold / candidate raw text committed | 0 (both live only under gitignored `/work/`) |

## Section H — final report summary

- Base commits: A `44f05231de8b9a3b6fdb6ff422435d0586937941`
  (`codex/fourarm-ac-vector-import-v01`), A2/contract
  `900d3cc72336a1aece86ec776d84f55ec3564cc8`
  (`codex/fourarm-a2-integration-v01`, verified ancestor-inclusive of A).
- Final worktree/branch: `agent-fourarm-a3-ceiling-audit-v01` /
  `codex/fourarm-a3-ceiling-audit-v01`.
- Input pin verification: all GREEN (table above / amendment §7).
- Top-20 prefix reproduction: **failed**, 9.9% match rate — this Turn's
  headline finding.
- Oracle Recall@10/20/50/100 — BM25: 0.7587 / 0.8636 / 0.9161 / 0.9650;
  Dense: 0.7727 / 0.8462 / 0.9510 / 0.9650; Union RRF: 0.8741 / 0.9056 /
  0.9615 / **0.9720** (diagnostic only, not official — see verdict).
- Segment breakdown: table above (full detail in gitignored
  `work/a3-oracle-report.json`).
- Failure distribution: 4 `UNRESOLVED`, 4 `METADATA_FILTER_EXCLUDED`, 0 in
  every other pre-registered category (see caveats above).
- BM25-only/dense-only/both/neither: 2 / 2 / 274 / 8 (of 286 slots).
- Additional finds beyond top-20 (top-50/100 only): 19 slots.
- Query embedding calls: 101. Corpus embedding calls: 0. DB writes: 0.
- A/A2 original file SHAs: unchanged.
- DEV_CHECK/HOLDOUT access: 0.
- **Final ceiling judgment: `NON_COMPARABLE_RETRIEVAL_REPLAY`** (not
  `A3_RERANKER_CEILING_GREEN`/`MARGINAL`/`INSUFFICIENT`, not
  `BLOCKED_CONTRACT` — inputs and reproducibility of the *pool-generation
  step itself* were fine; it is the *comparability to A's frozen top-20*
  that fails).
- **Recommendation: neither A3 nor A4/A5 yet.** The next Turn should be a
  narrow, pre-registered decision Turn that resolves this specific
  question before any reranker or candidate-generation work resumes:
  either (a) formally re-freeze a new arm-A top-20 under
  `dense_candidate_k=100` with Owner sign-off (after which a real A3
  ceiling audit against *that* frozen top-20 would be directly
  comparable), or (b) treat "wider dense window" as a distinct arm
  variant to be scored end-to-end on its own, never presented as a
  drop-in extension of the existing frozen A numbers. This Turn does not
  make that call itself.

## Artifacts

- Committed: this file, the amendment
  (`A3_CANDIDATE_CEILING_AUDIT_V1_AMENDMENT.md`), and the two new scripts
  under `scripts/`.
- Not committed (gitignored, `/work/`): `work/a3-candidates/*.json` (raw
  candidate text), `work/gold/dev-tune-gold.v0.1.jsonl` (Gold copy),
  `work/a3-manifest.json`, `work/a3-oracle-report.json`,
  `work/a3-failure-records.json`, `work/a3-best-rank.json`,
  `work/domain-seed/*` (company resolver inputs).
