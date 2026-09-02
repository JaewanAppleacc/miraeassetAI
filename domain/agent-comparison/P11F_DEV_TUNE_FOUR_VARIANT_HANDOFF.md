# Turn P11-F handoff: DEV_TUNE-101 four-variant comparison — STOPPED at retrieval-infra gate

Status: **RETRIEVAL_INFRASTRUCTURE_NOT_READY**. Zero real HCX calls were made this Turn. Zero
DEV_TUNE question/answer/evidence text was ever read or logged beyond gate validation. Nothing was
pushed to `origin`; the local merge commit was neither amended, reset, nor rebased.

## What this Turn completed (GREEN)

1. **Worktree/branch**: created `/Users/jaewan/Documents/Codex/worktrees/agent-dev-tune-four-variant-v01`
   on branch `codex/agent-dev-tune-four-variant-v01`, based on P11-E SHA `0a1750573415ec6db5b166c2e4b69eb9ebe16bb7`
   (`HCX_005_NATIVE_FUNCTION_CALLING_ADAPTER_INTEGRATED`).
2. **P10.2 merge**: `git merge --no-ff origin/codex/agent-chunking-embedding-grid-v01` (SHA
   `14adb49fcacf9104613b351b4544f1eddf0f3ac0`) — clean, zero conflicts (only `package.json`
   auto-merged). merge-base: `e2700dacccb7916552bdb2aabd4cb71bf7b8eca3`. Result commit:
   `061215d10e5673338d97ebde4adb1ab568cb8d94`.
3. **P10.4 non-selection**: recorded, NOT merged. SHA `05a206cc9e98108f4e00828025ce0bf68ab668b0`,
   status `ADAPTIVE_TABLE_CHUNKING_REQUIRES_FIX_COST_GATE`.
4. **DEV_TUNE-101 Gold gate**: fetched `demo-ai-festival/codex/gold-phase1-207-evaluation-v01`
   (remote SHA `b911c64f08a18befbfa18678af86ff84db663bb0`) into
   `work/p11f-dev-tune-four-variant/gold-fetch/` (gitignored, never committed — see `.gitignore:50`
   `/work/`). Ran the existing `domain/agent-comparison/chunking-comparison/dev-tune-input-gate.mjs`
   validator unmodified — **all checks GREEN**:
   - `dev-tune-gold.v0.1.jsonl` SHA-256 = `7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b` (exact match)
   - `owner_decision_sha256` = `00dc07913a3674102fbb341b5bf61c10ad3ea3d6e0bf52206f366157f88a6c8d` (exact match)
   - exactly 101 rows, all `split=DEV_TUNE`, 0 duplicate `question_id`, all rows valid JSON
   - `dev_tune_agent_use_authorized=true`; `dev_check_agent_use_authorized`,
     `holdout_agent_access_authorized`, `holdout_evaluation_authorized`, `agent_ranking_authorized`,
     `production_wiring_authorized` all `=false`
   - Only the two named files were ever read; no README/DEV_CHECK/HOLDOUT path was opened.
5. **P10.2 retrieval pin read (not modified)**: `work/p10.2-chunking-embedding-grid/final-selection.v0.1.json`
   confirms `final_chunking_strategy="fixed-token-512-o64.v0.1.0"`,
   `final_embedding_repository="nlpai-lab/KURE-v1"`,
   `final_embedding_revision="4ed4540949c70b7da2c74004a915e1f2d5e46e4f"`, `dimension=1024`,
   empty query/document prefixes. Exact retrieval constants pinned from
   `scripts/p10.2-stage2-embedding-grid.mjs:44-46`: `BM25_TOP_K=100`, `RETURN_TOP_K=20`,
   `RRF_K_CONSTANT=60`; BM25 itself is Okapi k1=1.5/b=0.75 over
   `domain/chunking/chunker.mjs`'s `tokenizeWithOffsets` (`domain/agent-comparison/chunking-comparison/bm25.mjs`).

## Why execution stopped here

Section E requires the actual DEV_TUNE run to use real BM25+dense+RRF retrieval, at the pinned
Fixed-512×KURE-v1 configuration, over the real corpus. That does not exist as a queryable artifact
today:

- `domain/agent-comparison/chunking-comparison/model-scoped-embedding-cache.mjs` is an in-memory
  `Map` only (no disk persistence) — P10.2's own 25,361 real KURE-v1 embedding calls
  (`work/p10.2-chunking-embedding-grid/final-selection.v0.1.json`'s
  `unique_embedding_calls`/`unique_embedding_calls_is_proxy`) were spent once, ephemerally, during
  that grid run, and are gone.
- The one pre-built retrieval snapshot referenced in this repo
  (`work/p10.2-chunking-embedding-grid/stage1-full-corpus-count-only.v0.1.json`'s
  `layer_2_retrieval_snapshot_downstream_not_used`, id `docsnap_8e480ec27b33b15bada7b3e764df5385`)
  uses a *different, explicitly-incompatible* chunking policy
  (`document-node-first-v0.1`, not Fixed-512-o64) and its own manifest records
  `"physical_file_present_in_this_environment": false` — it is not usable even if the policy matched.
- The existing "real bundle" harness (`domain/agent-comparison/seed-bundle-harness.mjs`, exercised by
  `tests/agent-comparison-integration-real-bundle-smoke.test.mjs`) gives real
  structuredStore/documentStore/evidenceStore adapters over the committed `seed-release-v0.20` bundle,
  but **builds no `retriever` adapter at all** — `domain/runtime/agent-runtime.mjs:1401-1409`'s
  `serviceAdapters.retriever` stays entirely unset in every existing real-bundle test.
- The raw corpus (`work/a-document-ir/source/*.jsonl` in the main checkout) is 8.6GB / 4,204
  documents. Building real retrieval means: re-chunk at Fixed-512-o64 (cheap, deterministic) + embed
  every resulting chunk with a real KURE-v1 API call (P10.2's own run needed 25,361 calls for this
  exact combination — expensive, long-running) + build a real BM25/dense index + implement a new
  `retriever` adapter matching the `RetrieverRequest -> RetrieverResult` contract AgentFlows expect.

No live PostgreSQL server was running in this environment either (`pg_isready` failed, no
`DATABASE_URL`), ruling out a live-DB-backed retrieval path as an immediate alternative.

Section E's own rule — "Fixed 구성의 실제 output이 P10.2 pin과 달라지면 DEV_TUNE 실행 전에 중단하고
원인을 보고한다" — was interpreted to extend to "the pinned configuration cannot even be executed
yet": rather than substitute a different (unpinned) retrieval path, silently degrade to
structured-store-only retrieval, or spend real HCX/embedding budget building an ad hoc index without
authorization, this Turn stopped and reported the gap. Presented with this finding, the user chose to
stop the Turn and hand off the infrastructure gap rather than authorize an ad hoc build inline.

## What did NOT happen this Turn

- Zero real HCX API calls (Native Function Calling or otherwise).
- Zero embedding API calls.
- Zero DEV_CHECK/HOLDOUT file reads.
- Zero scoring, zero Agent ranking, zero production wiring.
- No four-variant DEV_TUNE runner, checkpoint ledger, manifest, or comparison report was built —
  building those was deferred pending the retrieval-infra decision above.

## What already exists and is directly reusable once retrieval is solved

- `domain/agent-comparison/chunking-comparison/dev-tune-input-gate.mjs` — the exact DEV_TUNE
  authorization gate this Turn requires; reuse unmodified.
- `domain/agent-comparison/benchmark-runner.mjs`'s `runBenchmark()` — already runs one
  (variant, model_config) combination over a question list through the unmodified `runAgentFlow`,
  producing schema-valid `TelemetryEvent`s with all the reproducibility pins section G asks for
  (`agent_variant_revision`, `model_config_sha256`, `prompt_template_sha256`, `dataset_sha256`,
  `code_revision`, `fallback_scoring_policy`).
- `domain/agent-comparison/integration/four-variant-comparison.mjs`'s `runFourVariantComparison()` —
  already isolates a fresh instrumented adapter/Flow/context per variant per item and is fully
  adapter-kind-agnostic via its caller-supplied `modelAdapterFactory`; no change needed to point it at
  `HCX_NATIVE_V3_FUNCTION_CALLING` (see P11-E, SHA `0a17505`).
- `domain/agent-comparison/benchmark/scorers/index.mjs`'s `scoreItem()` — the 8-axis scorer
  (answerability/numeric_claim/date_claim/fact_coverage/event_relation/citation/style/operational)
  section K asks for; needs a Gold-item → `datasetRecord` mapping (Gold's own
  `expected_answer`/`expected_fact_ids`/`expected_event_ids`/`gold_document_ids`/`scoring_spec` shape
  differs from `scoreItem`'s expected `expected_answerability`/`expected_numeric_claims`/
  `expected_facts`/`expected_events`/`expected_relations`/`allowed_evidence_ids` field names — this
  mapping does not exist yet and is new work).
- `domain/agent-comparison/reproducibility.mjs` — `computeModelConfigSha256`/`computeDatasetSha256`/
  `computePromptTemplateSha256`/`detectCodeRevision`, ready to use for the manifest in section G.
- `domain/agent-comparison/integration/comparison-record.mjs` — already strips raw text down to
  `answer_sha256`/`execution_trace_sha256` per record, matching section M's non-leak allowlist almost
  exactly.

## Fixed-512 chunk counts (as supplied by the Owner; not independently re-derived this Turn)

- total chunks: **447,895**
- search-eligible chunks: **442,549**
- unique embeddable chunks: **441,879**

These are materially larger than the `chunk_count` this Turn independently found in the
*incompatible* `docsnap_8e480ec27b33b15bada7b3e764df5385` snapshot (1,874,688, under a different
`document-node-first-v0.1` policy) — the two numbers are not comparable and neither substitutes for
the other. No Fixed-512-o64 chunk materialization matching either of these counts exists as a
queryable artifact in this environment today.

## Missing components (all required before a real DEV_TUNE-101×4-variant run)

1. Real KURE-v1 full-corpus embedding, **persisted** (not the ephemeral in-memory
   `model-scoped-embedding-cache.mjs` `Map` P10.2 used).
2. A PostgreSQL/pgvector index over that embedding set.
3. Fixed-512-o64 chunk *occurrence* materialization (document → chunk → offset linkage) at the counts
   above.
4. A BM25 index over the same Fixed-512-o64 chunk set (constants already pinned:
   k1=1.5, b=0.75, `tokenizeWithOffsets`, top-k=100).
5. A dense retriever over the persisted KURE-v1 index (top-k=20).
6. An RRF-combination `retrieverAdapter` (k=60) satisfying the `RetrieverRequest -> RetrieverResult`
   contract `runAgentFlow`'s `serviceAdapters.retriever` expects
   (`domain/runtime/agent-runtime.mjs:1401-1409`).
7. Wiring that `retrieverAdapter` into `SharedServices` alongside the existing real
   structuredStore/documentStore/evidenceStore adapters (`seed-bundle-harness.mjs` provides those
   three today; `retriever` is the one missing piece).

## Reusable from the P8 resumable loader (`domain/postgres/reference-dedup-resumable-loader.mjs`)

Not the same table/embedding target (P8 loads `reference_dedup_indexes/canonical_texts/occurrences`
for dedup, not Fixed-512×KURE-v1 chunks for retrieval), but its **architecture** is exactly the
pattern the missing pieces above need and should be adapted, not reinvented:
- Four independently-resumable, bounded-memory phases (DISCOVERY → EMBEDDING → MATERIALIZATION →
  FINALIZATION), never holding more than one batch in memory.
- DISCOVERY streams source JSONL and checkpoints `(byte_offset, line_number)` in the same transaction
  as each batch's rows — directly reusable for streaming the 8.6GB raw corpus.
- EMBEDDING leases bounded batches of PENDING rows (`FOR UPDATE SKIP LOCKED`), embeds only that batch,
  validates, writes back — directly reusable for the KURE-v1 embedding pass, at real API cost, in a
  crash-safe/resumable way (avoids re-paying for chunks already embedded if a run is interrupted).
- FINALIZATION re-verifies every count against the real tables before flipping to READY — the same
  discipline the next Turn's manifest gate should apply before declaring the index usable.
- Requires a live PostgreSQL — this loader is under `domain/postgres/`, DB-session/lease-locking
  based; it does not have a non-Postgres mode.

## Existing code vs. new code needed

**Already exists, reuse unmodified:**
- `domain/agent-comparison/chunking-comparison/dev-tune-input-gate.mjs` (DEV_TUNE gate)
- `domain/agent-comparison/benchmark-runner.mjs` (`runBenchmark`, per-variant question-list runner)
- `domain/agent-comparison/integration/four-variant-comparison.mjs` (`runFourVariantComparison`,
  already adapter-kind-agnostic)
- `domain/agent-comparison/benchmark/scorers/index.mjs` (`scoreItem`, the 8-axis scorer)
- `domain/agent-comparison/reproducibility.mjs` (manifest hash helpers)
- `domain/agent-comparison/integration/comparison-record.mjs` (raw-text-free record projection)
- `domain/agent-comparison/seed-bundle-harness.mjs` (real structuredStore/documentStore/evidenceStore
  adapters over the committed `seed-release-v0.20` bundle)
- `domain/postgres/reference-dedup-resumable-loader.mjs` (architecture template only, per above)
- `domain/agent-comparison/chunking-comparison/{bm25,rrf}.mjs` (algorithms; not yet wired to a
  persisted index or a `retriever` adapter)
- `domain/agent-comparison/hcx-native-function-calling-adapter.mjs` (P11-E; ready to use once
  execution resumes)

**New code needed (none of this exists yet):**
- Fixed-512-o64 chunk occurrence materialization over the real corpus
- A persisted KURE-v1 embedding store + pgvector index
- A persisted/queryable BM25 index over the same chunk set
- A `retrieverAdapter` implementing `RetrieverRequest -> RetrieverResult`, combining BM25+dense via
  `reciprocalRankFusion` at the pinned constants
- A Gold-item → `datasetRecord` mapping for `scoreItem()` (Gold's own field names
  `expected_answer`/`expected_fact_ids`/`expected_event_ids`/`gold_document_ids`/`scoring_spec` differ
  from `scoreItem`'s expected `expected_answerability`/`expected_numeric_claims`/`expected_facts`/
  `expected_events`/`expected_relations`/`allowed_evidence_ids`)
- The DEV_TUNE-101×4-variant checkpoint/attempt ledger (section J of this Turn's brief) and its
  resume logic
- The paired item-level comparison + Pareto classification report (section L)

## P11-F readiness gate

```
gate_status: RETRIEVAL_INFRASTRUCTURE_NOT_READY
blocking_reason: no persisted Fixed-512-o64 x KURE-v1 embedding index, no BM25 index, no
  retrieverAdapter, no live PostgreSQL/pgvector -- real BM25+dense+RRF retrieval over the pinned
  P10.2 configuration is not executable in this environment today.
dev_tune_101_executed: false
real_hcx_calls: 0
structured_first_solo_run: false
fake_or_bounded_retriever_substituted: false
reduced_corpus_substituted: false
local_merge_commit_pushed: false
local_merge_commit_amended_or_reset_or_rebased: false
```

## Recommended next dedicated Turn

A retrieval-infrastructure Turn, scoped narrowly to: (1) re-chunk the real corpus at
`fixed-token-512-o64.v0.1.0`, (2) embed every resulting chunk with real KURE-v1 (rev
`4ed4540949c70b7da2c74004a915e1f2d5e46e4f`) and **persist** the result (not the in-memory-only cache
P10.2 used), (3) implement and test a `retriever` adapter (BM25 top-k=100, RRF k=60, return top-k=20,
matching `scripts/p10.2-stage2-embedding-grid.mjs`'s own pinned constants exactly) satisfying the
`RetrieverRequest -> RetrieverResult` contract the four AgentFlows already expect. Only once that
exists should a Turn re-attempt the real 404-call DEV_TUNE-101 four-variant comparison this Turn's
brief describes.

This worktree/branch is left as-is (merge intact, Gold-gate-verified fetch left under gitignored
`work/`, `.claude/settings.json` Stop-hook override left local/uncommitted) so that Turn can resume
from here without repeating this investigation.

## Access/execution confirmations

- **DEV_TUNE access**: the two Owner-authorized files (`dev-tune-gold.v0.1.jsonl`,
  `dev-tune-release-manifest.v0.1.json`) WERE read, exactly as section C of this Turn's own brief
  authorizes, solely to run `validateDevTuneInputGate()` (row count/SHA/split/duplicate/authorization
  checks). This is gate validation, not execution: no DEV_TUNE question was ever sent to an AgentFlow,
  a retriever, or HCX. **DEV_TUNE execution: 0 items.**
- **DEV_CHECK access: 0.** No DEV_CHECK path was read, listed beyond a directory-tree confirmation of
  absence, or opened.
- **HOLDOUT access: 0.** Same as above.
- **Real HCX calls: 0.** No network call was made to any HCX endpoint this Turn.
- **Production/runtime changes: 0.** No file under `domain/runtime/` was touched; this Turn's only
  file changes are the P10.2 merge (already-reviewed upstream commits) and this handoff document.
- **Process/temp-file status at end of Turn**: no PostgreSQL server running (`pg_isready` fails, no
  `DATABASE_URL`); no test/build process left running by this Turn; `work/` contains only the P10.1/
  P10.1.1/P10.2 files that arrived via the merge plus this Turn's own gitignored
  `work/p11f-dev-tune-four-variant/gold-fetch/` (two files, DEV_TUNE gold+manifest, never committed).
  No other temp/scratch file was created by this Turn outside the scratchpad directory.
