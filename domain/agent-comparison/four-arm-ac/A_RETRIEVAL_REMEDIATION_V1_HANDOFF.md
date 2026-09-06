# Turn A-RETRIEVAL-REMEDIATION-V1 — handoff (review rounds 1–3 applied)

Status: `CODE_AND_OFFLINE_TESTS_READY` · DEV_TUNE re-execution NOT performed (needs the live Postgres/KURE/BM25-cache stack).
Base: `900d3cc` (`codex/fourarm-a2-integration-v01`). Branch: `feat/fourarm-a-retrieval-remediation-v01`.
Reviews in the B/D team repo: `docs/reviews/a-remediation-c6b9a19-review.md` (round 1, five findings) and
`docs/reviews/a-remediation-40686e7-review.md` (round 2, three findings), `docs/reviews/a-remediation-cf040a4-review.md`
(round 3, two runner-integrity findings) — all accepted and applied (see below).

## What this is

An **opt-in retrieval policy** for arms A/C that addresses the retrieval-stage defects found by auditing the committed
`results/A.results.jsonl` against DEV_TUNE-101 (evidence: the B/D team's `docs/reviews/2026-09-06-armA-structure-and-gaps.md`
and `docs/reviews/a-additional-improvements-20260906.md`). The frozen official behaviour is untouched: every caller that does
not name a policy gets `FROZEN_POLICY` = the byte-identical code path that produced the committed results. The remediation
runs beside it on the same input and is compared, never overwritten.

## Defects addressed (measured on the committed A results)

| # | defect | evidence | remediation (`REMEDIATION_V1_POLICY`) |
|---|---|---|---|
| 1 | `correction:false` (98/101 questions) mapped to a hard `is_correction=false` prefilter — the flag means "the question mentions 정정", not "exclude 정정 filings" | 정정 filings = 1,004/4,204 documents (24%; exchange 631/1,469). A returned 0/1,809 정정 chunks on those questions, D 170/1,940. DEV_TUNE had no 정정-gold question with `correction:false`, so the score did not show it | `correction_filter: ONLY_WHEN_ASKED` — filter only when `correction:true` |
| 2 | extracted `exchange_subtypes` used as a hard prefilter on BOTH legs | 2 questions returned 0 results (알테오젠 ALT-B4 ×2: extracted 단일판매공급계약체결, real 투자판단관련주요경영사항); 8 returned <20, 6 returned 0 | `doc_subtype_filter: RELAX_ALWAYS` — "primary" passes keep the subtype, "relaxed" passes without it ALWAYS run. Their candidates are **promoted by evidence** (`relaxed_promote_top: 5`): a relaxed pass ranks the superset of its partner's pool, so a relaxed-only candidate within the top 5 of its own relaxed pass is inserted before the first partner-pass item that ranks worse than it there; everything else stays behind all primary items. A wrong subtype that fills the pool no longer hides the right filing, and a weak off-subtype chunk never enters the top-10 of a correct-subtype question (both tested). The fixed-stride interleave of the first revision is OFF (`relaxed_interleave_every: 0`, ablation knob only) |
| 3 | no receipt-date binding for exchange/holding/major; BM25 tokenises `2023-12-04` into 2023/12/04 and the index text carries no receipt date | 21/81 date-anchored questions missed all_found@10; 5 doc-level misses were same-company other-date filings (한화에어로스페이스, 삼성바이오로직스, 와이지, 하나금융지주, KAI) | `receipt_date_window: PER_DATE` — one `metadata.receipt_date` window pass PER full date in the question text (`[d-1, d+3]`; holding or unknown doc_groups `[d-1, d+30]`; periodic-only conditions none; overlapping windows merged, distant dates never joined into one range; at most 3). **Every window pass runs and the windows are merged round-robin** (the j-th chunk of each window in turn), so a first date whose filing fills the pool cannot crowd the second date's filing out (tested: 45-chunk first filing + 2-chunk second filing → the second filing's chunks land at ranks 2 and 4). Then unfiltered fill. Widths measured: rcept_dt − question date = exchange 0..3, major 0..1, holding 0..30, periodic 42..45 (period end, not a filing date) |
| 4 | BM25 pads its top-100 with score-0 ids (id order) and each earns `1/(60+rank)` in RRF | reproduced synthetically (Codex review #2) | `bm25_zero_score: DROP` (both arms) |
| 5 | `search(k)` drives the dense candidate count and the fusion output together (k=10 ≠ prefix of k=20) | reproduced (Codex review #3) | `dense_candidate_k: 20` and a FIXED candidate pool `fusion_pool_k: 40`; the pool is collected and ranked once, independent of k, then cut — the k-prefix property is tested for k = 3/10/20/40 on the reviewer's own fixture; k > 40 is refused |
| 6 | overlapping Fixed-512 windows of one document occupy several slots | top-10 slots: 27% same-document repeats, 14% node-overlapping windows | **OFF by default.** `dedupe_contained_windows` now means verified-text containment only (the chunk's hydrated text sits entirely inside an already-kept chunk of the same document); node/row provenance is never used because different rows of one table share a node_index. `per_doc_cap` (0 = off) is a second knob. Both are for a measured sweep, not part of the default candidate |

Not addressed here (needs re-chunking / re-embedding / re-indexing on the live stack): 81 `parse_quality.tier=fallback`
documents excluded by `retrieval_eligible` (22 of them are real 1,400–2,300-node 사업보고서 of 하나금융지주·KB금융·두산에너빌리티·
효성중공업·NAVER·고려아연), the particle-blind BM25 tokeniser, posting-list BM25, multi-node chunking, and the meaning of a
date in the question (filing date vs. contract end date is not distinguished — periodic-only exclusion is the only guard).

## Review round 1 (c6b9a19 → this version)

1. [P1] node-set "contained window" dedupe deferred different rows of one table → replaced by verified-text containment and
   turned OFF by default.
2. [P2] pass loop stopped at `merged >= k` → primary passes now fill a fixed pool (40) and relaxed passes always run; the
   ranking is computed on the whole pool and then cut, so k=10 is the prefix of k=20 (tested on the reviewer's fixture).
3. [P2] subtype relaxation only on shortfall → relaxed passes always run, candidates interleaved at a fixed stride.
4. [P2] multiple dates merged into one wide range → one window per date, merged only when they overlap, capped at 3.
5. [P2] frozen control command overwrote `A.run.json` → the runner refuses to write into a directory that already holds a
   completed run (`--overwrite` required), and both commands below use fresh `--out-dir`s.

## Review round 2 (40686e7 → this version)

1. [P1] relaxed candidates were inserted at every 4th rank regardless of score → fixed-stride interleave OFF; replaced by
   pair-wise evidence promotion (`promoteRelaxed`: top-5 of its own relaxed pass, inserted only past partner-pass items it
   outranks in that same pass, never above a higher-priority block). Regression tests: correct subtype + 10 strong primary
   + very weak off-subtype candidate (stays 11th); the same off-subtype filing as the strongest match (rank 1).
2. [P2] a first date window that filled the pool skipped the second window → every window pass runs, windows merge
   round-robin, base runs only if the primary pool is still short. Regression test: 45-chunk first filing + 2-chunk second.
3. [P2] `--overwrite` bypassed the guard but resumed from the stale NDJSON → `--overwrite` now deletes the old results
   NDJSON and run.json first and starts fresh; resume (no run.json yet) and overwrite are distinct.

## Review round 3 (cf040a4 → this version) — runner result integrity

1. [P1] `--overwrite` only acted when `run.json` existed, so an unfinished checkpoint (results NDJSON only) was resumed
   instead of restarted → `--overwrite` is evaluated first and removes results NDJSON + run.json whether or not the run
   completed; without it a completed run is refused and an unfinished one is resumed.
2. [P1] resume never checked the run identity and an errored question's retry left both rows in the file while run.json
   claimed completion → every checkpoint row must match the current `arm/batch_id/code_sha256/config_sha256/policy_id`
   (refuses otherwise); a question is done only with a successful row; on completion the file is rewritten canonically
   (exactly one successful row per batch question, batch order, atomic temp+rename) and `results_sha256` pins that
   content. For a clean run the canonical file is byte-identical to the appended one (tested). `run.json` gains a
   `checkpoint` block (`resumed`, rows on disk before canonicalisation, canonical rows).
   The logic lives in `four-arm-run-checkpoint.mjs` (pure, no `pg`) with its own offline tests; the runner is only
   source-scanned because loading it needs `pg` from node_modules.

## Files

- `domain/agent-comparison/four-arm-ac/four-arm-retrieval-policy.mjs` (new): `FROZEN_POLICY`, `REMEDIATION_V1_POLICY`,
  `resolvePolicy`, `questionFullDates`, `deriveReceiptWindows`, `buildRetrievalPlan`, `buildFilterPasses`,
  `orderCandidates`, `interleaveRelaxed`, `rankCandidates`.
- `four-arm-conditions-to-filter-mapper.mjs`: `mapOfficialConditionToFilterInput(conditions, index, { policy, question })` —
  frozen default unchanged; adds `policy_id` and `plan` (null when frozen).
- `retrieval/fixed-kure-hybrid-retriever-adapter.mjs`: `policy` option (`dense_candidate_k`, `bm25_zero_score`) and
  `retrieve(request, { signal, queryVector })` (embed once per question across passes).
- `arm-retriever-adapter.mjs`: `policy` option; `search(question, conditions, k, { plan })`; frozen → the original single
  pass verbatim; remediation → all window passes (merged round-robin), then `base` only while the primary pool is short,
  then `base_relaxed` always; per-pass ranks recorded; `rankCandidates` (optional dedupe/cap → evidence promotion →
  optional interleave), cut to k, re-numbered. `lastSearch()` returns the pass log (label, group, skipped, returned,
  added), the pool size and the plan for the ledger.
- `scripts/p11f0-fourarm-devtune-ac-run.mjs`: `--policy frozen-a-v1|remediation-v1`; refuses a directory that holds a
  completed run; `--overwrite` removes that run's results NDJSON + run.json and starts fresh (resume only applies to an
  unfinished run without run.json). A non-frozen
  policy writes `<ARM>.results.<policy>.ndjson` / `<ARM>.run.<policy>.json` (+ `policy_id`, `retrieval_passes`,
  `receipt_windows`, per-item `retrieval_pass`/`retrieval_group`); the frozen file names and line shape are unchanged.
- `four-arm-run-checkpoint.mjs` (new): checkpoint parsing, run-identity validation, done/errored state, canonical rewrite,
  atomic write — pure functions the runner calls.
- `tests/four-arm-a-retrieval-remediation.test.mjs` (new): offline tests with a fake client that evaluates the real
  prefilter WHERE clause and a fake dense repository that applies the shared `passesMetadataFilters`.
- `tests/four-arm-run-checkpoint.test.mjs` (new): checkpoint/resume/canonicalisation tests + a source scan of the runner.

## How to run (owner of the live stack)

Use a NEW output directory for every run — the runner refuses to overwrite a completed run, and its checkpoint resumes by
question id, so never reuse a previous run's folder after changing the policy.

```bash
# control: frozen policy (must reproduce the committed A results on the retrieval fields -- run first)
DATABASE_URL=... P11F0_KURE_SERVER_URL=http://127.0.0.1:<port>/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A --batch-id <new_batch_id> --out-dir work/a-remediation-review/control
# candidate: remediation policy, same batch id
DATABASE_URL=... P11F0_KURE_SERVER_URL=http://127.0.0.1:<port>/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A --batch-id <new_batch_id> --policy remediation-v1 --out-dir work/a-remediation-review/candidate
```

Control check: compare the control run to the committed `results/A.results.jsonl` on the retrieval fields only
(question_id, rank, chunk_id, doc_id, node_index/node_indices, score, chunk_text_sha256) — latency, code SHA and
timestamps differ by construction and are not part of the equivalence.

Candidate check: hydrate text as in `SCORING_VIEW_FIX_V1_RESULT.md`, score both with the frozen scorer, and report per
question: Recall@5/10/20, LOW all_found@10, questions improved/regressed, zero-result count, critical/minor/unresolved, p95
latency (the candidate runs 2 + 2×windows passes per question when a subtype was extracted, 1 + windows otherwise —
static distribution over the official 101: 1 pass 5, 2 passes 85, 4 passes 11; each pass reuses the query embedding). Expected
direction: the 5 date-anchored doc-level misses and the 2 subtype 0-result questions recover. Add the two review fixtures
(subtype saturation, multi-date comparison) to the regression set. Do not read a single combined run as the effect of any
one change — sweep the knobs (`bm25_zero_score`, `receipt_date_window`, `relaxed_interleave_every`) separately if the
per-question diff needs attribution.

## Procedure note

This changes the retrieval pre-conditions of a pre-registered experiment. It is a post-selection remediation candidate,
to be run as a NEW execution beside the frozen A results with Owner approval — never as a replacement of them.
