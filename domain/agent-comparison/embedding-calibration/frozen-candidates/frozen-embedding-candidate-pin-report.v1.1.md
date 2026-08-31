<!-- Turn P9.1 -->
# Frozen Embedding Candidate Pin & Compatibility Audit (v1.1)

This is a **pin/audit document, not a model selection**. `actual_external_embedding_call_performed`,
`real_embedding_full_load_started`, `final_embedding_model_selected`, `agent_ranking_performed`,
`dev_gold_accessed`, and `holdout_accessed` are all `false` for this Turn and every artifact it
produced. No model was downloaded and no embedding API was called while producing this document.

The machine-readable source of truth is
[`frozen-embedding-candidates.v1.1.json`](./frozen-embedding-candidates.v1.1.json), validated
against [`frozen-embedding-candidate.schema.json`](./frozen-embedding-candidate.schema.json).
This document summarizes it for a human reader and adds the Section C local-server *design*
(no server or model installed this Turn).

## Candidates

| | KURE-v1 | BGE-M3 | PIXIE-Rune |
|---|---|---|---|
| Repository | `nlpai-lab/KURE-v1` | `BAAI/bge-m3` | **unresolved** -- see below |
| Revision | `4ed4540949c70b7da2c74004a915e1f2d5e46e4f` | `5617a9f61b028005a4858fdac845db406aefb181` | `BLOCKED_MISSING_IMMUTABLE_REVISION` |
| Architecture | XLM-RoBERTa (fine-tuned from BGE-M3) | XLM-RoBERTa + RetroMAE | XLM-RoBERTa (confirmed for v1.5 only) |
| Dimension | 1024 | 1024 | unresolved |
| Max input | 8192 tokens | 8192 tokens | unresolved (v1.5 = 6144) |
| Pooling | CLS | CLS | unresolved (v1.5 = CLS) |
| Normalize | yes (built-in `Normalize` module) | yes (built-in `Normalize` module) | unresolved (v1.5 = yes) |
| Query prefix | none | none ("no longer requires... instructions to the queries") | unresolved (v1.5 = `"query: "`) |
| Document prefix | none | none | unresolved (v1.5 = `""`) |
| License | MIT | MIT | Apache-2.0 (all 3 known variants) |
| Competition status | `ELIGIBLE_FOR_BOUNDED_CALIBRATION` | `ELIGIBLE_FOR_BOUNDED_CALIBRATION` | `BLOCKED_UNVERIFIED_MODEL_ID` |
| Adapter compatibility | `COMPATIBLE_VIA_LOCAL_OPENAI_SHAPED_SERVER` | `COMPATIBLE_VIA_LOCAL_OPENAI_SHAPED_SERVER` | same classification, provisional pending identity resolution |

### Why KURE-v1 and BGE-M3 are `ELIGIBLE_FOR_BOUNDED_CALIBRATION`

CLAUDE.md's rule 2 (Section 3) blocks embeddings "that could be interpreted as derived from a
generative LLM" (its own example: the Qwen-embedding family, which repurposes a decoder-only
generative backbone). Both models' own official cards confirm they are **pure bidirectional
encoders** (XLM-RoBERTa lineage, BERT/RoBERTa-family — architecturally incapable of autoregressive
generation), never initialized from or fine-tuned out of a generative/decoder model. BGE-M3's card
states this family requires no query instruction at all. KURE-v1 is a direct Korean fine-tune of
BGE-M3 (same encoder lineage). Both are MIT-licensed, and both have a real, independently-verified
40-hex commit SHA and a confirmed embedding dimension — the two invariants that must hold before
`actual_external_call_authorized` can ever be set for either.

This is a considered judgment based on solid, sourced evidence, not a default-to-eligible
assumption: per this Turn's own instruction, an *unclear* derivation would have forced
`REQUIRES_ORGANIZER_APPROVAL` instead. It was not unclear here.

### Why PIXIE-Rune is `BLOCKED_UNVERIFIED_MODEL_ID`

CLAUDE.md names only **"PIXIE-Rune (실험 전 정확한 revision 고정)"** — no version qualifier. Three
distinct, actively published repositories exist under this family name from TelePIX Co., Ltd.:

| Repository | Revision | License |
|---|---|---|
| `telepix/PIXIE-Rune-v1.0` | `091fe5a6682119cfc02451f37fdece163ddf38de` | apache-2.0 |
| `telepix/PIXIE-Rune-v1.5` | `29dd334196af53e6cfc16674379e743334f5fa66` | apache-2.0 |
| `telepix/PIXIE-Rune-Preview` | `5103ecbda7dd9e502f8414c54731da0c3f2dc72b` | apache-2.0 |

Per this Turn's own instruction ("정확한 revision을 찾을 수 없으면 추정하지 말고
BLOCKED_MISSING_IMMUTABLE_REVISION으로 둔다"), no single one of these was guessed as "the" answer.
v1.5 was independently inspected as the most-likely candidate (latest stable, non-preview,
marginally better on TelePIX's own reported STELLA/MTEB-Korean benchmarks) — its architecture is
the same non-generative XLM-RoBERTa encoder family as KURE-v1/BGE-M3, and it uses an **asymmetric**
query/document prefix (`query_prefix: "query: "`, `document_prefix: ""`), confirmed directly from
its own `config_sentence_transformers.json`. This is documented as research, not as a pin: the
registry's `repository_id`/`immutable_revision` for `pixie_rune` remain unresolved until the
organizer/owner names one exact build.

## Adapter compatibility audit

The existing `HTTP_EMBEDDINGS` contract is:

```
POST { model, input: string[] }
→ { data: [{ embedding: number[] }] }
```

None of the three providers operate an official, already-running HTTP embeddings endpoint for
these open-weight models (no paid managed API from nlpai-lab/BAAI/TelePIX was found). All three are
open-weight `sentence-transformers`-compatible checkpoints that **can** be served locally via
HuggingFace's own Text Embeddings Inference (TEI), whose `/v1/embeddings` route already accepts
`{input, model}` and returns `{data:[{embedding}]}` — byte-shape-compatible with the existing
adapter contract, requiring **zero new protocol code** to consume once such a server is actually
running. That places all three at `COMPATIBLE_VIA_LOCAL_OPENAI_SHAPED_SERVER`, never forced into
`EXISTING_HTTP_EMBEDDINGS_COMPATIBLE` (which would misrepresent that a call could be made today
without standing up any infrastructure), and never `REQUIRES_NEW_PROTOCOL_ADAPTER` (TEI's shape
genuinely matches, so no new adapter code is needed — only a server).

### Local server design (design only — nothing installed or run this Turn)

If a local TEI-compatible server is ever stood up for one of these candidates, it must satisfy:

- **Server protocol**: `POST /v1/embeddings` with body `{ model: string, input: string[] }`,
  response `{ data: [{ embedding: number[] }] }` — identical to the existing `HTTP_EMBEDDINGS`
  adapter's own expectation; no calibration code changes needed to talk to it.
- **Health/version endpoint**: `GET /health` (200 when the model is loaded and ready to serve;
  non-200 otherwise) and `GET /info` returning at minimum `{ model_id, model_sha, max_input_length,
  embedding_dimension }` — this is what makes the next bullet checkable at connection time rather
  than only discoverable from a bad response later.
- **Model revision attestation**: before the FIRST request of a run, the caller fetches `/info` and
  asserts `model_sha` equals the registry's own `immutable_revision` for the candidate being run;
  a mismatch fails the run closed before any embedding request is sent — a locally-served model
  silently upgraded/rolled to a different revision must never be mistaken for the pinned one.
  `model_id` in the resulting run manifest is always `${repository_id}@${immutable_revision}` (see
  `registry.mjs`'s `toCalibrationConfig`), so any manifest is self-describing even without the
  server still running.
- **Dimension check**: every returned vector's length is checked against the registry's own
  `embedding_dimension` before it is trusted (reusing `embedding-adapter.mjs`'s existing
  `assertVectorsShape`/runner.mjs's `assertFiniteVector` — no new dimension-checking code needed,
  only a server that responds in the existing shape).
- **Query/document mode**: never passed as a literal field in the wire request (the existing
  contract has no such field). Instead, mode-specific prefixing happens client-side, BEFORE the
  text is submitted as `input[]`, via `prepareTextForMode(candidate, text, mode)` — the single
  chokepoint this registry module exposes for that purpose. The server itself only ever sees
  already-prefixed strings; it does not need to know which role a string is playing.
  For self-match evaluation, a query-embedded and a document-embedded copy of the SAME text are
  cached and compared separately whenever `query_prefix !== document_prefix`.
- **Batching limit**: bounded by the SAME `batch_size`/`maximum_request_count` fields
  `CalibrationConfig` already defines — the local server does not get its own separate budget
  concept; it is just another `HTTP_EMBEDDINGS` endpoint under the existing budget/authorization
  gates.
- **Timeout/error contract**: the existing `request_timeout_ms` + `EmbeddingCallError` codes
  (`EMBEDDING_CALL_TIMEOUT`, `EMBEDDING_CALL_HTTP_ERROR`, `EMBEDDING_CALL_MALFORMED_RESPONSE`,
  `EMBEDDING_CALL_UNKNOWN_ERROR`) apply unchanged — a local server is not a special case needing
  its own error taxonomy.
- **Secret/non-leak contract**: a local server typically needs no API key at all (no
  `Authorization` header); if a future deployment adds one, it follows the exact same
  `api_key_env_var`-by-name, fail-closed-if-unset pattern `embedding-adapter.mjs` already
  enforces for hosted providers — never a literal key in `CalibrationConfig`, a manifest, or a log.

## Test results

See the final report delivered alongside this Turn's commit for the full pass/fail table. Summary:
frozen-candidate registry/contract/compatibility/leak tests all green, full P9 regression (49/49)
green, `test:agent-comparison`/variants/integration green, `schema:validate`/`typecheck`/`build`/
`git diff --check` green. Zero real network calls, zero model downloads, zero API key usage.
