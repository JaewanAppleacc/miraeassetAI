# A4-A3-PLUS-QA-FINAL-INTEGRATION-V1 — Freeze

Turn A4-A3-PLUS-QA-FINAL-INTEGRATION-V1. Written and committed BEFORE any real
`ARM_A4_A3_LIVE` search, smoke run, judge34-equivalent comparison, or other
new evaluation result is viewed. Nothing below may change after a result is
seen; a real defect found via non-Gold smoke/contract-test failure may still
be fixed pre-result per the same discipline the upstream A4/A3 turns already
used (see `agent-fourarm-a4-a3-devtune-v01`'s own amendment "Addendum"
section), but the fix must be reported, never silently absorbed into these
pins.

## Base pins

```text
qa_base_branch:              codex/a-plus-qa-full-index-smoke-v01
qa_base_commit:               61aad1652e3d943f0efb32aea2b7f088cbf6de64
a4_a3_source_branch:          codex/fourarm-a4-a3-devtune-v01
a4_a3_source_commit:          3ee4462026126a0dd8fc5c99a6d83df510a84058
selected_reranker_config:     R4_wide_rrf_centric

component pins (blob SHA inside a4_a3_source_commit):
  wide_pool_module_commit:      c9b4cb0e67cc3a87a7ab250d6c1adacd5723aa56
  reranker_engine_commit:        0e4acf0e4d82cf6362e16ad90f6d6f7e6d9c8ee5
  a3_guard_commit:                9358e2077397675febc82ae5fbc5240f32bc198a

new worktree:                 agent-a4-a3-plus-qa-final-v01
new branch:                   codex/a4-a3-plus-qa-final-v01
```

All four source refs verified present at the exact pinned commit on both
`origin` and `demo-ai-festival` immediately before this document was written.

## Import strategy (no full-history merge)

The A4/A3 production modules are **not copied** into this repository. The new
Node worker (`scripts/arm_a4_a3_live_worker.mjs`) dynamically `import()`s the
already-existing, unmodified four-arm-ac modules straight from the
`agent-fourarm-a4-a3-devtune-v01` worktree, at the path given by the
`ARM_A4_A3_LIVE_IMPL_ROOT` env var — the exact same "separate read-only
worktree, dynamic import, never merged/copied" pattern
`scripts/arm_a_live_worker.mjs` already uses for `ARM_A_LIVE`. This
repository's own git history therefore never gains the four-arm-ac commit
history, and no A4/A3 file is duplicated or forked here.

## Freeze content

```yaml
retriever_backend: ARM_A4_A3_LIVE
chunking: Fixed-512
bm25_candidate_k: 100
dense_candidate_k: 100
rrf_constant: 60
wide_pool_max: 200
reranker_config: R4_wide_rrf_centric
reranker_config_sha256: 1af2f55c88629542d7118becfd84f6cf598a7df2734c3718bfb01570917ea495
guard: A3_CONTRADICTION_GUARD_V1
guard_policy: REJECT_ONLY_EXPLICIT_CONTRADICTIONS
keep_unknown: true
stable_refill: true
retrieval_output_k: 20
qa_base_commit: 61aad1652e3d943f0efb32aea2b7f088cbf6de64
a4_a3_source_commit: 3ee4462026126a0dd8fc5c99a6d83df510a84058
```

`reranker_config_sha256` is `sha256(JSON.stringify(config_object))` computed
directly from the pinned `a4-reranker-configs.v1.json`'s `R4_wide_rrf_centric`
entry (full config object — `config_id`/`family`/`description`/`weights`),
inside the pinned `a4_a3_source_commit`. Recomputed and verified against the
live file at freeze time:

```json
{
  "config_id": "R4_wide_rrf_centric",
  "family": "R4",
  "description": "wide RRF 중심 -- the widened top-100 union-RRF score dominates, with a small blend of the three narrower legs for stability.",
  "weights": { "wide_rrf": 0.7, "bm25": 0.1, "dense": 0.1, "original_rrf": 0.1 }
}
```

## Existing backend preserved

`ARM_A_LIVE` (and `ARM_A_FIXED_RRF`/`ARM_A_FROZEN_REPLAY`, and `DEFAULT`)
remain fully intact and unmodified. `ARM_A4_A3_LIVE` is added as a new,
additional entry in `arm_a_serving_bridge.RETRIEVAL_BACKENDS` and in
`answer_api._build_retriever()`'s dispatch — never a replacement, never a
default. There is no automatic fallback between backends during evaluation:
each backend is invoked explicitly per Section G of the governing turn
instructions, and any `ARM_A4_A3_LIVE` failure is reported as such, never
silently retried against `ARM_A_LIVE`.

## Infra pins actually in scope for this environment (verified at freeze time)

```text
database:                postgresql://jaewan@127.0.0.1:55329/p11f0_scratch  (local scratch Postgres)
retrieval_index_id:      fixed_kure_index_8fe191342205848d1d6a6123f38a54e7
index_status:            READY
record_count:            442549
unique_embedding_count:  441879
embedding_dimension:     1024
corpus_snapshot_id:      corpus_04750795e1a2d5c3
load_session_id (BM25/provenance): fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36
kure_server:             http://127.0.0.1:58411/v1/embeddings  (nlpai-lab/KURE-v1 @ 4ed4540949c70b7da2c74004a915e1f2d5e46e4f, dim 1024 — confirmed live via /health,/info)
clova_api_key_present:   false (CLOVA_API_KEY unset in this environment at freeze time)
```

`clova_api_key_present: false` is recorded here, before any QA run, so that a
`BLOCKED_EXTERNAL_QA_PROVIDER` outcome in Section I cannot later look like a
post-hoc excuse — it is a known, pre-registered fact at freeze time.
