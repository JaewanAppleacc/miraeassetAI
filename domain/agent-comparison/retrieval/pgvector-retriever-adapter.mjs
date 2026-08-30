// Turn P4: adapts a pgvector search repository (domain/postgres/
// reference-vector-retrieval-repository.mjs, or any object with the same
// shape -- e.g. a synthetic in-memory one for tests) into the EXISTING,
// UNMODIFIED domain/runtime/retriever-store.mjs adapter contract:
// `{ async retrieve(request, { signal }) -> RetrieverResult }`. This file
// invents no new Retriever contract -- retrieval-request.schema.json/
// retrieval-result.schema.json (frozen, Turn <= P1) are followed exactly,
// down to score_type/component_scores/citation_authority/source_spans.
//
// GROUNDING BOUNDARY (repeated from ../flows/*-agent.mjs's own header
// comments, because it is the single most important fact about this
// file): a search hit returned here is a CANDIDATE ONLY. citation_authority
// is pinned to "SOURCE_SPANS" and text_provenance describes how raw_text
// relates to the source -- neither one is a grounding decision. Nothing in
// this adapter calls services.validator.validateEvidence; that happens
// later, inside HYBRID_RETRIEVAL/DOCUMENT_FIRST_RAG themselves, exactly as
// it already does for their existing (non-vector) retrieval paths. A high
// similarity_score never substitutes for that check.
import { createHash } from "node:crypto";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Real VERIFIED_EVIDENCE source_locators already in this project follow
// `${document_id}/${file_id}#node=N` or `...#node=N&row=R&col=C`
// (domain/runtime/citation-validator.mjs's own parseEvidenceLocator parses
// the identical shape) -- reused here read-only to recover a real node/row/
// col when present, never fabricated when absent.
const LOCATOR_PATTERN = /#node=(\d+)(?:&row=(\d+)&col=(\d+))?$/;

function buildSourceSpan(hit) {
  const fileId = typeof hit.metadata?.file_id === "string" && hit.metadata.file_id !== ""
    ? hit.metadata.file_id
    : `file_${sha256Hex(`${hit.source_document_id}:${hit.chunk_id}`).slice(0, 24)}`;
  const match = LOCATOR_PATTERN.exec(hit.source_locator ?? "");
  const nodeId = match ? `${hit.source_document_id}::n${match[1]}` : `${hit.source_document_id}::${hit.chunk_id}`;
  const row = match?.[2] !== undefined ? Number(match[2]) : null;
  const col = match?.[3] !== undefined ? Number(match[3]) : null;
  return {
    file_id: fileId,
    rel_path: `${hit.source_document_id}/${fileId.slice("file_".length)}.xml`,
    node_id: nodeId,
    order_index: Number.isInteger(hit.chunk_ordinal) ? hit.chunk_ordinal : 0,
    row_start: row, row_end: row, col_start: col, col_end: col,
    source_locator: hit.source_locator,
  };
}

function toResultItem(hit, rank) {
  return {
    rank,
    score: hit.similarity_score,
    score_type: "COSINE",
    component_scores: { bm25: null, dense: hit.similarity_score, rrf: null, reranker: null },
    document_id: hit.source_document_id,
    chunk_id: hit.chunk_id,
    // VERIFIED_EVIDENCE chunks are not products of the real chunking
    // pipeline (domain/chunking/chunk.schema.json) -- DOCUMENT_FALLBACK is
    // that enum's own catch-all for exactly this "not from that pipeline"
    // case, not a claim about document structure.
    chunk_type: "DOCUMENT_FALLBACK",
    parent_chunk_id: null,
    // A VERIFIED_EVIDENCE chunk's text_content IS the Evidence's own
    // quoted_text, byte-for-byte (see reference-vector-retrieval-loader.mjs's
    // own header comment) -- SOURCE_VERBATIM is accurate, not optimistic.
    text_provenance: "SOURCE_VERBATIM",
    citation_authority: "SOURCE_SPANS",
    raw_text: hit.text_content,
    source_locator: hit.source_locator,
    source_spans: [buildSourceSpan(hit)],
  };
}

// `vectorRepository` needs only `.search({ retrievalIndexId, sourceKinds,
// queryVector, topK, corpCodes, documentIds, similarityThreshold,
// expectedPins }, { signal }) -> ChunkHit[]` -- the real Postgres
// implementation and a synthetic in-memory test double both satisfy this
// with the identical shape.
export function createPgvectorRetrieverAdapter({
  vectorRepository,
  embeddingAdapter,
  embeddingConfig,
  retrievalIndexId,
  sourceKinds,
  expectedPins,
}) {
  if (!vectorRepository || typeof vectorRepository.search !== "function") throw new TypeError("vectorRepository is required");
  if (!embeddingAdapter || typeof embeddingAdapter.embedQuery !== "function") throw new TypeError("embeddingAdapter is required");
  if (typeof retrievalIndexId !== "string" || retrievalIndexId === "") throw new TypeError("retrievalIndexId is required");

  return Object.freeze({
    // `request` has already been schema-validated and deep-frozen by
    // retriever-store.mjs before this is ever called -- this function
    // trusts corpus_snapshot_id/chunking_config_id/index_snapshot_id
    // pinning to that caller, and only translates metadata_filters/top_k/
    // question into a vector search + RetrieverResult envelope.
    async retrieve(request, { signal } = {}) {
      const startedAt = Date.now();
      const queryVector = await embeddingAdapter.embedQuery(request.question, embeddingConfig);
      const corpCodes = request.metadata_filters?.corp_codes?.length ? request.metadata_filters.corp_codes : undefined;
      const documentIds = request.metadata_filters?.document_ids?.length ? request.metadata_filters.document_ids : undefined;

      const hits = await vectorRepository.search(
        { retrievalIndexId, sourceKinds, queryVector, topK: request.top_k, corpCodes, documentIds, expectedPins },
        { signal },
      );

      return {
        schema_version: "0.2.0",
        query_id: request.query_id,
        retrieval_method: request.retrieval_method,
        corpus_snapshot_id: request.corpus_snapshot_id,
        chunking_config_id: request.chunking_config_id,
        index_snapshot_id: request.index_snapshot_id,
        applied_filters: request.metadata_filters,
        top_k: request.top_k,
        latency_ms: Date.now() - startedAt,
        results: hits.map((hit, index) => toResultItem(hit, index + 1)),
      };
    },
  });
}
