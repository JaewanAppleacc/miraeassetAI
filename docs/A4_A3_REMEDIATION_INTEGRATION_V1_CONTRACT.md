# A4-A3-REMEDIATION-INTEGRATION-V1 — Contract

Written and committed BEFORE any new integration result or score is produced or viewed.
Fixes the actual call structure (traced from source, not assumed), what is added vs. what
stays byte-unchanged, and the invariants/decision rule so none of them can be adjusted
after seeing a result.

## 0. Starting-point verification

```text
new worktree:            agent-a4-a3-remediation-integration-v01
new branch:               codex/a4-a3-remediation-integration-v01
checked out from:        codex/a4-a3-qa-condition-integration-v01 @ 3287f9ecceed233803ac656d260b9f7d20c3d816
                          (verified via `git ls-remote origin`/`git ls-remote demo-ai-festival` — both match)
remediation source (read-only reference, commit object only, never checked out as a
  worktree here): feat/fourarm-a-retrieval-remediation-v01 @ b30b909dad9b56d22dc116f1fffb041e0d69e5ff
  (verified via `git ls-remote demo-ai-festival` — matches)
remediation validation (read-only reference for the already-measured numbers this turn's
  input cites): codex/a-remediation-replay-contract-v02 @ 19d5d4d9c4da5068d0f13482ca3d5dac66f5e1ea
  (verified via `git ls-remote origin`/`git ls-remote demo-ai-festival` — both match)
frozen submission (never checked out into this worktree, never written to):
  codex/a4-a3-plus-qa-frozen-v01 @ 6e24545671892a1222d75453d4e74547646aa489
working tree:            clean immediately after worktree creation
npm install:             node_modules already present from the base commit (pg/ajv/ajv-formats),
                          `npm install` confirms up to date, no new dependency added
```

## 1. Existing baseline this turn compares against — inherited from the task input, not
independently re-measured before this contract (comparison methodology fixed in §8; the
baseline itself is re-run and re-verified as part of Section H below, not merely trusted)

```text
current A4 R4+A3 retrieval (ARM_A4_A3_LIVE, unmodified):
  Recall@10: 0.8776, HIGH Recall@10: 0.872, LOW all-found@10: 16/19, critical: 0
remediation-v1 (plain Arm A retrieval, from codex/a-remediation-replay-contract-v02):
  Recall@10: 0.8287 -> 0.9510, HIGH Recall@10: 0.816 -> 0.956, LOW all-found@10: 16/19 -> 16/19,
  critical: 0 -> 0, zero-result: 6 -> 4, p95: 1428ms -> 1288ms
```

Note: the remediation-v1 numbers above measure PLAIN Arm A (no A4 wide pool / R4 reranker /
A3 guard) — this turn integrates the remediation's retrieval-CONDITION logic (correction
handling, subtype relaxation, date windows, BM25 zero-score drop) into the A4/A3 candidate-
generation legs, not those exact plain-Arm-A numbers. The new Recall/critical numbers this
turn produces (Section H) are a different, new measurement (A4+A3 with vs. without the
integrated remediation), compared against the current A4+A3 baseline in §1, not against the
plain-Arm-A remediation numbers.

## 2. Actual call structure — traced from source (Section B), fixed before any
implementation change

```text
1. QA condition mapper (domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs,
   unmodified) -- mapQaOrLegacyConditionsToFourArmConditions(conditions, {nameToCorpCodeIndex})
   reshapes QA's QueryConditions.as_dict() (or the precomputed devtune101_conditions.v2.jsonl
   shape) into the pipeline's own `question.conditions` shape.
2. ARM_A4_A3_LIVE worker (scripts/arm_a4_a3_live_worker.mjs, unmodified) --
   handleSearch(question, conditions, topK) calls runQuestionPipeline(deps, question_, [r4Config]).
3. runQuestionPipeline (domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs,
   unmodified), in order:
   a. mapOfficialConditionToFilterInput(question.conditions, nameToCorpCodeIndex) -> mapped.filters
      (four-arm-conditions-to-filter-mapper.mjs, unmodified)
   b. buildMetadataFiltersFromConditions(mapped.filters) -> filters
      (conditions-fixture.mjs, unmodified)
   c. fetchEligibleChunkIds(client, retrievalIndexId, filters) -> eligibleIds
      (../../retrieval/metadata-filter.mjs, unmodified) -- ONE call, ONE filter set, SQL-level
      hard prefilter
   d. bm25Search(bm25Index, question.question, {topK: BM25_CANDIDATE_K=100, eligibleIds})
      -> bm25Ranked (../retrieval/fixed-kure-bm25-index.mjs, unmodified)
   e. embeddingAdapter.embedQuery(question.question) -> queryVector -- the ONE embed call
      for the whole question (retrieval/embedding-adapter.mjs, unmodified)
   f. createPostgresVectorRetrievalRepository({client}).searchDocumentChunksByVector(
      {retrievalIndexId, queryVector, topK: DENSE_CANDIDATE_K=100, filters, expectedPins})
      -> denseRows (../../postgres/reference-vector-retrieval-repository.mjs, unmodified)
   g. row-level passesMetadataFilters() double-check on the bm25 leg only (defense in depth
      on top of c's SQL-level prefilter)
   h. hydrateCandidateRecord() each leg's raw {id, score} into a full CandidateRecord (real
      text + chunk_text_sha256 verification + locator/provenance via locator-provenance.mjs,
      unmodified)
   i. RRF(bm25_top100, dense's own top-20 subset) -> originalATop20 (a same-run "plain Arm A"
      compatibility artifact; buildWideCandidatePool's own reproducibility check on this
      input is OPT-IN -- it runs only when the array is non-empty, verified by reading
      a4-wide-candidate-pool.mjs directly, not assumed)
   j. buildWideCandidatePool({original_a_top20, bm25_top100, dense_top100}) -> pool
      (<=200, dedup, a4-wide-candidate-pool.mjs, unmodified)
   k. extractQuestionConditions(question.question, mapped.filters) -> requiredConditions
      (exported from a4-a3-retrieval-pipeline.mjs, reused, unmodified)
   l. for every candidate: extractEvidenceFacts(candidate) (same file, exported) then
      detectEvidenceContradictions({questionConditions, evidenceFacts}) -> REJECT / KEEP_UNKNOWN
      / PASS, ONCE per chunk_id (a3-evidence-contradiction-guard.mjs, unmodified)
   m. rankCandidatePool(pool, questionContext, r4Config) -> full R4-ranked list
      (a4-reranker-engine.mjs + a4-reranker-configs.v1.json R4_wide_rrf_centric, unmodified)
   n. selectWithStableRefill(full, decisions, {outputK: 20}) -> final top-20 (REJECT removed,
      refilled from the remaining ranked pool in stable order; a4-reranker-engine.mjs, unmodified)
4. Worker wire-shaping (unmodified): rank renumber, reranker_rank preserved, a3_decision
   recomputed (defense in depth, never a second implementation of A3's judgement),
   backend tag attached -> final top-20 items returned over stdout.
```

`b30b909`'s own `fusion_pool_k=40` is NOT copied into this contract anywhere — every leg
cap used by this turn's new code is the EXISTING A4/A3 constant (`BM25_CANDIDATE_K=100`,
`DENSE_CANDIDATE_K`/`WIDE_DENSE_CANDIDATE_K=100`, read directly from
`a4-a3-retrieval-pipeline.mjs`/`a4-wide-candidate-pool.mjs`, not re-declared or guessed).

## 3. What is added (new files only) vs. what stays byte-unchanged

**Unmodified (verified by `git diff` against this branch's own base commit, both before and
after implementation — see the final report):**
`a4-a3-retrieval-pipeline.mjs`, `a4-wide-candidate-pool.mjs`, `a4-reranker-features.mjs`,
`a4-reranker-engine.mjs`, `a4-reranker-configs.v1.json`, `a3-evidence-contradiction-guard.mjs`,
`four-arm-conditions-to-filter-mapper.mjs`, `conditions-fixture.mjs`, `qa-condition-mapper.mjs`,
`locator-provenance.mjs`, `scripts/arm_a4_a3_live_worker.mjs`, `scripts/arm_a_live_worker.mjs`,
`src/dart_detective/arm_a4_a3_live_adapter.py`, `src/dart_detective/arm_a4_a3_live_worker_client.py`,
`src/dart_detective/arm_a_serving_bridge.py` — every file the existing `ARM_A_LIVE`/
`ARM_A4_A3_LIVE` backends depend on.

**Added (new files, this turn):**
- `domain/agent-comparison/four-arm-ac/four-arm-retrieval-policy.mjs` — vendored
  byte-identical from `b30b909` (pure functions: `resolvePolicy`, `FROZEN_POLICY`,
  `REMEDIATION_V1_POLICY`, `buildRetrievalPlan`, `buildFilterPasses`, `questionFullDates`,
  `deriveReceiptWindows`, `orderCandidates`, `promoteRelaxed`, `interleaveRelaxed`,
  `rankCandidates`). Byte-identity verified via sha256 against the source commit (recorded
  in the final report, following this project's own established vendoring discipline).
- `domain/agent-comparison/four-arm-ac/a4-a3-remediation-candidate-legs.mjs` — NEW facade:
  generates the BM25 leg and dense leg candidate lists under a retrieval policy (multi-pass
  merge/promotion/interleave per §4 below), capped at the EXISTING `BM25_CANDIDATE_K=100`/
  `DENSE_CANDIDATE_K=100` (not `b30b909`'s `fusion_pool_k=40`). Duplicates four small,
  private DB-fetch/hydration helpers from `a4-a3-retrieval-pipeline.mjs`
  (`fetchChunksByIds`, `fetchStagingSpans`, `toCandidateMetadata`, `hydrateCandidateRecord`)
  rather than exporting them from that file or importing them, so that file needs zero
  modification (confirmed: they are not currently exported).
- `domain/agent-comparison/four-arm-ac/a4-a3-remediation-retrieval-pipeline.mjs` — NEW,
  mirrors `runQuestionPipeline`'s outer orchestration (questionContext /
  `extractQuestionConditions` / per-candidate `detectEvidenceContradictions` / R4 rank /
  stable refill) but sources its `bm25_top100`/`dense_top100` from the new candidate-legs
  module instead of the single-pass logic — reuses every already-exported function from
  `a4-a3-retrieval-pipeline.mjs`, `a4-wide-candidate-pool.mjs`, `a4-reranker-engine.mjs`,
  `a3-evidence-contradiction-guard.mjs` unmodified; `original_a_top20` is passed as `[]`
  (the reproducibility check in `buildWideCandidatePool` is opt-in on non-empty input,
  verified from source — not applicable once the legs themselves are policy-modified).
- `scripts/arm_a4_a3_remediation_live_worker.mjs` — new persistent worker, copy of
  `scripts/arm_a4_a3_live_worker.mjs`'s protocol/readiness/wiring shell, calling
  `runQuestionPipelineRemediationAware(deps, question_, [r4Config], REMEDIATION_V1_POLICY)`
  instead of `runQuestionPipeline`. `backend` tag in the wire response is
  `"ARM_A4_A3_REMEDIATION_LIVE"`, never `"ARM_A4_A3_LIVE"`.
- `src/dart_detective/arm_a4_a3_remediation_live_worker_client.py` /
  `arm_a4_a3_remediation_live_adapter.py` — new Python client/adapter, structurally
  identical to the existing `ARM_A4_A3_LIVE` pair (env var prefix
  `ARM_A4_A3_REMEDIATION_LIVE_*`, own required-env list, own typed errors) — duplicated
  rather than parameterized, matching this project's own stated precedent for
  `arm_a4_a3_live_worker_client.py` vs. `arm_a_live_worker_client.py` ("duplicated rather
  than parameterized because the two backends have different required env vars... and
  this turn's own prohibitions forbid touching" the existing one).
- `src/dart_detective/arm_a_serving_bridge.py`: **not modified** — the new backend constant
  (`RETRIEVAL_BACKEND_ARM_A4_A3_REMEDIATION_LIVE = "ARM_A4_A3_REMEDIATION_LIVE"`) and its
  registration live in the new adapter module itself; `answer_api.py` is not touched either
  (per this turn's scope: retrieval-level integration and DEV_TUNE verification only — QA
  Evidence V2, DocumentBinder, and HCX answer generation are out of scope, so no serving-path
  wiring is added this turn beyond what a future, separate turn would need).
- `scripts/fourarm/run_arm_a4_a3_live_family.py` — new, retrieval-only DEV_TUNE-101 runner
  (mirrors `scripts/fourarm/run_arm.py`'s shape/output contract for B/D) that calls either
  the `ARM_A4_A3_LIVE` or `ARM_A4_A3_REMEDIATION_LIVE` worker's raw `search()` once per
  condition, producing `{arm}.results.jsonl`/`{arm}.run.json` in the same interfaces.md
  §1-1 shape the existing scorer already reads — needed because no existing runner drives
  the live A4/A3 workers against the full precomputed conditions file (the existing
  `run_arm.py` is B/D-only, via `retriever_adapter.bind()`, a different code path).
- Offline tests (Section F) + a non-Gold smoke script (Section G) — new files only.

## 4. Remediation logic applied to each leg (Section C, mapped onto the actual structure)

```text
1. correction: filters.is_correction is forced to null unless mapped.filters.is_correction
   === true (ONLY_WHEN_ASKED) -- applied to the filters object BEFORE it is handed to
   buildFilterPasses, never inside four-arm-conditions-to-filter-mapper.mjs itself.
2. subtype relaxation: buildRetrievalPlan/buildFilterPasses (vendored, unmodified) already
   produce a "primary" pass (with mapped.filters.doc_subtypes as extracted) and an ALWAYS-
   run "relaxed" pass (doc_subtypes stripped) whenever doc_subtypes is non-empty. Evidence
   promotion (promoteRelaxed, relaxed_promote_top=5) and NOT fixed-stride interleave
   (relaxed_interleave_every=0) -- both values come from REMEDIATION_V1_POLICY unmodified.
3. date windows: buildRetrievalPlan derives one receipt-date window per full date in the
   question text (questionFullDates), merged only when overlapping, capped at 3
   (max_receipt_windows), periodic-only doc_groups get no window -- all from the vendored
   policy module, unmodified. Multiple window passes are merged round-robin inside the new
   per-leg orchestration (§3), not via a fixed interleave.
4. BM25 score<=0 candidates are dropped (bm25_zero_score: "DROP") on the BM25 leg only,
   per pass, before admission into the merged leg list.
5. query embedding: embedQuery() is called exactly ONCE per question (outside any per-pass
   loop); every dense-leg pass reuses that same vector.
```

## 5. New backend name

```text
ARM_A4_A3_REMEDIATION_LIVE
```

`ARM_A_LIVE` and `ARM_A4_A3_LIVE` are unmodified, byte- and behavior-identical to the base
commit (verified via `git diff` in the final report).

## 6. Required invariants (Section E — verified in the final report, not merely asserted)

```text
BM25 leg candidates <= 100 (post-merge, post-dedup)
dense leg candidates <= 100 (post-merge, post-dedup)
dedup wide pool <= 200 (buildWideCandidatePool's own existing invariant, unmodified)
every pool candidate receives R4 scoring (rankCandidatePool over the full pool, unmodified)
R4 config == R4_wide_rrf_centric, byte-identical to a4-reranker-configs.v1.json (unmodified file)
A3 refill never reaches outside the top-20 window (selectWithStableRefill's own existing
  invariant, unmodified)
A3 removes REJECT only; KEEP_UNKNOWN is kept
final order is a stable subsequence of the R4 rank order
final candidate count <= 20
duplicate chunk_id count == 0 in any final top-20
node_indices/provenance fully preserved end to end (never collapsed to a single node)
query embedding calls == 1 per question
DB writes == 0
sha256 of domain/agent-comparison/four-arm-ac/results/A.results.jsonl,
  domain/agent-comparison/four-arm-ac/results/A.run.json (if present in this worktree),
  and every file listed in §3's "unmodified" list: unchanged from this branch's own base commit
```

## 7. Offline tests (Section F) — planned, written before any DEV_TUNE-101 number exists

18 cases as specified in the governing instructions (correction semantics x2, subtype
relaxation x2, multi-date windows x2, periodic exclusion, BM25 zero-score drop, single
query embedding, per-leg 100 caps, wide pool <=200, full R4 scoring, A3 stable refill,
existing-backend non-regression, input immutability/determinism, no hardcoded question_id/
company name, zero Gold/QA/LLM dependency) — implemented with fake/offline fixtures (no
live Postgres/KURE required), matching the existing `qa-condition-mapper.test.mjs`'s own
offline-fixture style in this repository.

## 8. Retrieval DEV_TUNE-101 comparison (Section H) — methodology fixed now

```text
compare:  ARM_A4_A3_LIVE (unmodified, re-run fresh this turn as the baseline — not merely
          trusted from the task input's cited numbers, since this turn's own code/environment
          may differ from whatever produced them)
     vs.  ARM_A4_A3_REMEDIATION_LIVE (new)
same:     corpus, index (fixed_kure_index_8fe191342205848d1d6a6123f38a54e7, 442549 records),
          KURE pin (nlpai-lab/KURE-v1 @ 4ed4540949c70b7da2c74004a915e1f2d5e46e4f, dim 1024),
          data/eval/devtune101_conditions.v2.jsonl (sha256 83d5b8a0...), Gold
          (data/eval/phase1_devtune_gold.v0.1.jsonl, sha256 7941144c...f102b), top_k=20,
          scorer (src/dart_corpus/evaluation/fourarm.py / scripts/fourarm/score.py,
          unmodified in this branch), single full 101-question batch each, run once.
runner:   scripts/fourarm/run_arm_a4_a3_live_family.py (new) — calls the live worker's raw
          search() directly per condition (bypasses answer_api/QA-assembly entirely, since
          Evidence V2/DocumentBinder/HCX are out of scope this turn), writes results in the
          existing {arm}.results.jsonl/{arm}.run.json shape.
scoring compatibility: this environment's data/index/ status and NodeStore availability are
          checked fresh (not assumed from a prior turn) before choosing --no-locator-check
          vs. a real NodeStore check; whichever applies is disclosed identically for both
          runs (same scorer invocation, same flag, for both).
```

No partial re-run: both runs cover the full, identical 101-question batch, exactly once
each, in this section.

## 9. Decision rule (fixed before any result)

```text
BLOCKED_CONTRACT                          if any invariant in §6 fails, if the corpus/index/
                                           conditions/Gold pins do not match §8 exactly, or if
                                           the scorer cannot run (crash) even after any
                                           locator-compatibility handling already established
                                           by this project's own precedent.
A4_A3_REMEDIATION_REJECTED_SAFETY         if critical increases versus the freshly re-run
                                           ARM_A4_A3_LIVE baseline.
A4_A3_REMEDIATION_NOT_ADOPTED             if no invariant/safety condition fails, but the
                                           quality bar in the governing instructions'
                                           Section I is not met (Recall@10 or HIGH Recall@10
                                           does not improve versus the baseline, or p95
                                           latency exceeds 2x baseline).
A4_A3_REMEDIATION_RECOMMENDED_FOR_QA      if ALL of: critical == 0; Recall@10 >= the
                                           freshly-measured ARM_A4_A3_LIVE baseline's own
                                           Recall@10; HIGH Recall@10 >= that baseline's own
                                           HIGH Recall@10; LOW all-found@10 >= that baseline's
                                           own LOW all-found@10; zero-result does not
                                           increase; Recall@10 OR HIGH Recall@10 strictly
                                           improves versus that baseline; retrieval p95 <=
                                           2x that baseline's p95.
```

The `>=`/`==` comparisons above are against THIS turn's own freshly re-run
`ARM_A4_A3_LIVE` baseline (Section H), not against the task input's cited
`0.8776`/`0.872`/`16/19`/`0` figures verbatim — those figures are the expectation this
turn's own re-measurement is checked against for consistency, disclosed either way in the
final report, per the same "verify, don't just trust a given number" discipline this
project has used throughout its history.

## 10. Confirmed in advance

```text
QA Evidence V2 / DocumentBinder files: not touched, not read for this turn's logic
HCX / any LLM call: none, anywhere in this turn's new code or test/smoke runs
DEV_CHECK / HOLDOUT: not accessed
frozen submission branch (codex/a4-a3-plus-qa-frozen-v01): not checked out, not modified
b30b909 wholesale cherry-pick: not performed -- only four-arm-retrieval-policy.mjs is
  vendored verbatim (pure, arm-agnostic policy functions); every A4/A3-specific piece is
  newly written to call the existing, unmodified A4/A3 modules
A4 candidate pool shrunk to 40: never -- 100/100/200 caps preserved throughout, verified
  numerically in the final report
R4 weights / A3 rules: not changed, anywhere
new backend is opt-in only: ARM_A4_A3_LIVE's own code path is never executed by the new
  worker/adapter and vice versa
policy/weight/candidate-k changed after seeing a result: none -- this document is final
  before any implementation, test run, smoke run, or DEV_TUNE-101 number exists
```
