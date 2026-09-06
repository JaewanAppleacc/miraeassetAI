# Turn A-RETRIEVAL-REMEDIATION-V1 — handoff

Status: `CODE_AND_OFFLINE_TESTS_READY` · DEV_TUNE re-execution NOT performed (needs the live Postgres/KURE/BM25-cache stack).
Base: `900d3cc` (`codex/fourarm-a2-integration-v01`). Branch: `feat/fourarm-a-retrieval-remediation-v01`.

## What this is

An **opt-in retrieval policy** for arms A/C that fixes the retrieval-stage defects found by auditing the committed
`results/A.results.jsonl` against DEV_TUNE-101 (full evidence: the B/D team's `docs/reviews/2026-09-06-armA-structure-and-gaps.md`
and `docs/reviews/a-additional-improvements-20260906.md`). The frozen official behaviour is untouched: every caller that does
not name a policy gets `FROZEN_POLICY` = the byte-identical code path that produced the committed results. The remediation
runs beside it on the same input and is compared, never overwritten.

## Defects addressed (measured on the committed A results)

| # | defect | evidence | remediation |
|---|---|---|---|
| 1 | `correction:false` (98/101 questions) mapped to a hard `is_correction=false` prefilter — the flag means "the question mentions 정정", not "exclude 정정 filings" | 정정 filings = 1,004/4,204 documents (24%; exchange 631/1,469). A returned 0/1,809 정정 chunks on those questions, D 170/1,940. DEV_TUNE happened to have no 정정-gold question with `correction:false`, so the score did not show it | `correction_filter: ONLY_WHEN_ASKED` — filter only when `correction:true` |
| 2 | extracted `exchange_subtypes` used as a hard prefilter on BOTH legs | 2 questions returned 0 results (알테오젠 ALT-B4 ×2: extracted 단일판매공급계약체결, real 투자판단관련주요경영사항); 8 questions returned <20, 6 returned 0 | `doc_subtype_filter: RELAX_ON_SHORTFALL` — subtype pass first, then a pass without it fills the shortfall |
| 3 | no receipt-date binding for exchange/holding/major; BM25 tokenises `2023-12-04` into 2023/12/04 and the index text carries no receipt date | 21/81 date-anchored questions missed all_found@10 vs 6/19 others; 5 doc-level misses were same-company other-date filings (한화에어로스페이스, 삼성바이오로직스, 와이지, 하나금융지주, KAI) | `receipt_date_window: TWO_PASS` — full date in the question text → `metadata.receipt_date` window pass first (`[d-1, d+3]`, holding `[d-1, d+30]`, periodic-only conditions excluded), then unfiltered fill. Widths measured: rcept_dt − question date = exchange 0..3, major 0..1, holding 0..30, periodic 42..45 (period end, not a filing date) |
| 4 | BM25 pads its top-100 with score-0 ids (id order) and each earns `1/(60+rank)` in RRF | reproduced synthetically (Codex review #2); frequency on the real 101 not measured | `bm25_zero_score: DROP` |
| 5 | overlapping Fixed-512 windows of one document occupy several slots | top-10 slots: 27% same-document repeats, 14% node-overlapping windows | `dedupe_contained_windows: true` — a window whose nodes are all already covered by kept windows of the same document is deferred (never dropped). `per_doc_cap` left at 0 (multi-slot single-document questions need several chunks) |
| 6 | `search(k)` drives the dense candidate count and the fusion output together (k=10 ≠ prefix of k=20) | reproduced (Codex review #3) | `dense_candidate_k: 20`, `fusion_pool_k: 40` — prefix property holds (tested) |

Not addressed here (needs re-chunking / re-embedding / re-indexing on the live stack): 81 `parse_quality.tier=fallback`
documents excluded by `retrieval_eligible` (22 of them are real 1,400–2,300-node 사업보고서 of 하나금융지주·KB금융·두산에너빌리티·
효성중공업·NAVER·고려아연), the particle-blind BM25 tokeniser, posting-list BM25, multi-node chunking.

## Files

- `domain/agent-comparison/four-arm-ac/four-arm-retrieval-policy.mjs` (new): `FROZEN_POLICY`, `REMEDIATION_V1_POLICY`,
  `resolvePolicy`, `questionFullDates`, `deriveReceiptWindow`, `buildRetrievalPlan`, `buildFilterPasses`, `diversifyResults`.
- `four-arm-conditions-to-filter-mapper.mjs`: `mapOfficialConditionToFilterInput(conditions, index, { policy, question })` —
  frozen default unchanged; adds `policy_id` and `plan` (null when frozen).
- `retrieval/fixed-kure-hybrid-retriever-adapter.mjs`: `policy` option (`dense_candidate_k`, `bm25_zero_score`) and
  `retrieve(request, { signal, queryVector })` (embed once per question across passes).
- `arm-retriever-adapter.mjs`: `policy` option; `search(question, conditions, k, { plan })`; frozen → the original single
  pass verbatim; remediation → ordered passes `window → window_relaxed → base → base_relaxed`, each only filling behind the
  previous, then `diversifyResults`, then cut to k and re-numbered. `lastSearch()` returns the pass log for the ledger.
- `scripts/p11f0-fourarm-devtune-ac-run.mjs`: `--policy frozen-a-v1|remediation-v1`. A non-frozen policy writes
  `<ARM>.results.<policy>.ndjson` / `<ARM>.run.<policy>.json` (+ `policy_id`, `retrieval_passes`, `receipt_window`,
  per-item `retrieval_pass`); the frozen file names and line shape are unchanged.
- `tests/four-arm-a-retrieval-remediation.test.mjs` (new): 15 offline tests with a fake client that evaluates the real
  prefilter WHERE clause and a fake dense repository that applies the shared `passesMetadataFilters`.

## How to run (owner of the live stack)

```bash
# frozen (must reproduce the committed A results byte-for-byte -- run it first as the control)
DATABASE_URL=... P11F0_KURE_SERVER_URL=http://127.0.0.1:<port>/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A --batch-id <batch_id>
# remediation (separate output files, same batch id)
DATABASE_URL=... P11F0_KURE_SERVER_URL=http://127.0.0.1:<port>/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A --batch-id <batch_id> --policy remediation-v1
```
Score both with the frozen scorer (hydrate text as in `SCORING_VIEW_FIX_V1_RESULT.md`), compare per question, and report
Recall@5/10/20, LOW all_found@10, critical/minor/unresolved side by side. Expected direction: the 5 date-anchored doc-level
misses and the 2 subtype 0-result questions recover; watch for any question that gets worse (the window pass puts same-date
filings first — a question whose date is incidental could lose a chunk of another filing to the tail).

## Procedure note

This changes the retrieval pre-conditions of a pre-registered experiment. It is a post-selection remediation candidate,
to be run as a NEW execution beside the frozen A results with Owner approval — never as a replacement of them.
