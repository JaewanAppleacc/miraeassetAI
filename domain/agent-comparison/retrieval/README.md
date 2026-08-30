# Vector Retrieval (Turn P4)

Config-driven embedding contract plus the adapter that bridges a pgvector
search backend into the existing, unmodified `services.retriever.retrieve`
contract (`domain/runtime/retriever-store.mjs`). Nothing here is a new
Retriever contract -- `domain/retrieval/retrieval-request.schema.json` and
`retrieval-result.schema.json` (frozen) are followed exactly.

## Files

| File | Role |
|---|---|
| `contracts.mjs` | Ajv validator for `EmbeddingConfig` |
| `interfaces/embedding-config.schema.json` | Provider/model identity for an EmbeddingAdapter -- mirrors `../interfaces/model-config.schema.json` |
| `embedding-adapter.mjs` | `createEmbeddingAdapter(config)` -- `FAKE_DETERMINISTIC` \| `HTTP_EMBEDDINGS`, fails closed with no API key, typed `EmbeddingCallError` |
| `fake-deterministic-embedding-adapter.mjs` | Offline, reproducible, order-preserving fake embeddings |
| `pgvector-retriever-adapter.mjs` | Adapts a pgvector search repository into `services.retriever`'s adapter shape |

## The grounding boundary, restated

A vector search hit is a **candidate only**. `citation_authority` is pinned
to `"SOURCE_SPANS"`; `similarity_score` is never a substitute for
`services.validator.validateEvidence`. This file never calls that
validator itself -- HYBRID_RETRIEVAL and DOCUMENT_FIRST_RAG each do, exactly
as they already do for their existing (non-vector) retrieval paths (see
`../flows/hybrid-retrieval-agent.mjs` / `../flows/document-first-rag-agent.mjs`'s
own header comments).

## Wiring into an Agent variant

`../integration/wire-vector-retriever.mjs` is the ONLY place a
`pgvector-retriever-adapter` gets injected into a variant -- it does so by
constructing the standard `context`/`serviceAdapters`/`flowOptions`
arguments `four-variant-comparison.mjs`'s `runFourVariantComparison` (or a
plain `runAgentFlow` call) already accepts, never by editing a variant's
own flow file. STRUCTURED_FIRST and PLANNER (without
`input.hints.enable_retrieval_fallback`) are unaffected by design.

## Turn P5: portable DocumentIR retrieval snapshot

`document-snapshot/` (see its own README) builds a portable, chunk-level
snapshot of A's full 4,204-document DocumentIR corpus and a pure adapter
proving that snapshot's chunks are shaped correctly for Turn P4's
`DOCUMENT_CHUNK` source_kind. It still makes no real embedding call and
writes nothing to PostgreSQL -- indexing the resulting snapshot for real is
a future Turn's work.

## Turn P5.1: retrieval index sizing/dedup/boilerplate analysis

`index-planning/` (see its own README) analyzes Turn P5's snapshot to
compare 4 candidate indexing strategies (full, exact-text-dedup,
hierarchical, primary+cold-fallback) and recommends one, without embedding
anything or touching PostgreSQL. It is a plan, not an index.

## No real embedding API call anywhere in this Turn

Every test and script in this Turn uses `FAKE_DETERMINISTIC` only. The
`HTTP_EMBEDDINGS` adapter kind is real, tested code (with an injected
`fetchImpl` in tests), but is never invoked against a real endpoint here --
comparing real embedding-model performance is out of scope until a Gold
split is finalized in a separate Turn.
