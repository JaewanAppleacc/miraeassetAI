// Turn P5.2: adapts a dedup search repository
// (domain/postgres/reference-dedup-retrieval-repository.mjs, or any object
// with the same shape -- e.g. a synthetic in-memory one for tests) into
// the EXISTING, UNMODIFIED domain/runtime/retriever-store.mjs adapter
// contract, exactly like Turn P4's pgvector-retriever-adapter.mjs does for
// VERIFIED_EVIDENCE. Invents no new Retriever contract.
//
// GROUNDING BOUNDARY (identical to pgvector-retriever-adapter.mjs's own):
// a search hit here is a CANDIDATE ONLY. citation_authority is pinned to
// "SOURCE_SPANS"; nothing in this file calls
// services.validator.validateEvidence. A shared canonical embedding never
// becomes a grounding decision by itself -- every returned row is a real,
// individually-verifiable OCCURRENCE (chunk_id/source_document_id/
// source_locator), not the canonical row.
//
// DISTANCE METRIC BOUNDARY (Turn P5.2.1): the common retrieval-result
// contract requires DENSE results to carry score_type="COSINE"
// (domain/retrieval/retrieval-result.schema.json), and this Turn does not
// extend that shared schema or domain/contracts.mjs. 004's own DB schema
// legitimately allows l2/inner_product indexes (repository.search() can
// query either), but THIS adapter's public wiring only ever accepts a
// COSINE index -- l2/inner_product results are never relabeled as
// "COSINE", they are refused before any result is ever built. This is
// enforced by forcing `distance_metric: "cosine"` into every
// expectedPins passed to dedupRepository.search(), which already fails
// closed (DedupRetrievalRepositoryError) against the REAL, DB-verified
// index row inside assertReadyRetrievalIndex -- a caller cannot override
// this by supplying its own `distance_metric` in expectedPins; the forced
// value always wins.
import { createHash } from "node:crypto";

const SUPPORTED_DISTANCE_METRIC = "cosine";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildSourceSpan(hit) {
  const fileId = typeof hit.metadata?.file_id === "string" && hit.metadata.file_id !== ""
    ? hit.metadata.file_id
    : `file_${sha256Hex(`${hit.source_document_id}:${hit.chunk_id}`).slice(0, 24)}`;
  return {
    file_id: fileId,
    rel_path: hit.metadata?.file_relative_path ?? `${hit.source_document_id}/${fileId.slice("file_".length)}.xml`,
    node_id: hit.node_id,
    order_index: Number.isInteger(hit.chunk_ordinal) ? hit.chunk_ordinal : 0,
    // Turn P5's own source_locator scheme (`${document_id}/${path}#node=N`)
    // carries no row/col -- never fabricated here.
    row_start: null, row_end: null, col_start: null, col_end: null,
    source_locator: hit.source_locator,
  };
}

function toResultItem(hit, rank) {
  const isTable = hit.block_type === "TABLE";
  return {
    rank,
    score: hit.similarity_score,
    score_type: "COSINE",
    component_scores: { bm25: null, dense: hit.similarity_score, rrf: null, reranker: null },
    document_id: hit.source_document_id,
    chunk_id: hit.chunk_id,
    chunk_type: isTable ? "TABLE_ROW" : "SECTION_FLAT",
    parent_chunk_id: null,
    // TABLE chunks are Turn P5's own deterministic row/cell-separator
    // linearization (chunking-policy.mjs's table_row_join/table_row_separator),
    // never the untouched original markup -- DETERMINISTIC_LINEARIZATION is
    // accurate here, not SOURCE_VERBATIM. Non-table text is the parser's
    // own extracted node text, unaltered beyond leading/trailing trim.
    text_provenance: isTable ? "DETERMINISTIC_LINEARIZATION" : "SOURCE_VERBATIM",
    citation_authority: "SOURCE_SPANS",
    // hit.canonical_text is BYTE-IDENTICAL to this occurrence's own
    // original text_content -- that identity is what "exact duplicate"
    // means (see reference-dedup-retrieval-loader.mjs's own text_sha256
    // collision guard). This is never a different document's text leaking
    // into this one's result -- it is verified equal at load time.
    raw_text: hit.canonical_text,
    source_locator: hit.source_locator,
    source_spans: [buildSourceSpan(hit)],
  };
}

// `dedupRepository` needs only `.search({ retrievalIndexId, queryVector,
// topK, corpCodes, documentIds, similarityThreshold, expectedPins },
// { signal }) -> OccurrenceHit[]` -- see
// reference-dedup-retrieval-repository.mjs's own header comment for why
// its SQL already guarantees the metadata-filter-before-top-k ordering;
// this adapter does not (and must not) re-filter or re-rank anything
// itself, it only reshapes each returned occurrence row into a
// RetrieverResult item.
export function createDedupRetrieverAdapter({
  dedupRepository,
  embeddingAdapter,
  embeddingConfig,
  retrievalIndexId,
  expectedPins,
}) {
  if (!dedupRepository || typeof dedupRepository.search !== "function") throw new TypeError("dedupRepository is required");
  if (!embeddingAdapter || typeof embeddingAdapter.embedQuery !== "function") throw new TypeError("embeddingAdapter is required");
  if (typeof retrievalIndexId !== "string" || retrievalIndexId === "") throw new TypeError("retrievalIndexId is required");

  return Object.freeze({
    async retrieve(request, { signal } = {}) {
      const startedAt = Date.now();
      const queryVector = await embeddingAdapter.embedQuery(request.question, embeddingConfig);
      const corpCodes = request.metadata_filters?.corp_codes?.length ? request.metadata_filters.corp_codes : undefined;
      const documentIds = request.metadata_filters?.document_ids?.length ? request.metadata_filters.document_ids : undefined;

      // The caller's own expectedPins (if any) are honored for every OTHER
      // pin, but distance_metric is always forced to "cosine" here -- a
      // caller claiming `expectedPins: { distance_metric: "l2" }` can never
      // talk this adapter into accepting an l2/inner_product index.
      const hits = await dedupRepository.search(
        { retrievalIndexId, queryVector, topK: request.top_k, corpCodes, documentIds, expectedPins: { ...expectedPins, distance_metric: SUPPORTED_DISTANCE_METRIC } },
        { signal },
      );

      // Defense in depth: even though reference-dedup-retrieval-repository.mjs's
      // own SQL now enforces a final LIMIT topK (Turn P5.2.1), this adapter
      // never trusts that alone -- a hard slice here is a second,
      // independent guarantee that this adapter's own public contract
      // (results.length <= request.top_k) holds regardless of what any
      // dedupRepository implementation (real or synthetic) returns.
      const bounded = hits.slice(0, request.top_k);

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
        results: bounded.map((hit, index) => toResultItem(hit, index + 1)),
      };
    },
  });
}
