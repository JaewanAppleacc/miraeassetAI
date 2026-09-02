// Turn P11-F0 section J: the RetrieverAdapter that connects the P11-F0
// Fixed-512-o64 x KURE-v1 hybrid index (BM25 + Dense + RRF) to the
// EXISTING, UNMODIFIED domain/runtime/retriever-store.mjs contract:
// `{ async retrieve(request, { signal }) -> RetrieverResult }`. Invents no
// new Retriever contract -- retrieval-request.schema.json/
// retrieval-result.schema.json (frozen) are followed exactly, and
// retriever-store.mjs itself independently re-validates every field this
// adapter returns before any AgentFlow ever sees it.
//
// REUSED, UNMODIFIED, never copied: domain/postgres/
// reference-vector-retrieval-repository.mjs's own searchDocumentChunksByVector
// (the dense leg, already source_kind='DOCUMENT_CHUNK'-scoped, already
// corp_codes/document_ids-filtered, already READY/pin/dimension-checked),
// domain/agent-comparison/chunking-comparison/rrf.mjs's reciprocalRankFusion
// (P10.2's own RRF_K_CONSTANT=60, RETURN_TOP_K=20 pin, threaded in by the
// caller -- see scripts/p11f0-corpus-discovery.mjs's sibling
// scripts/p10.2-stage2-embedding-grid.mjs for where those constants come
// from), and fixed-kure-bm25-index.mjs's persisted BM25 index (itself
// reusing bm25.mjs unmodified).
//
// AgentFlow files never see any of this -- they only ever call
// services.retriever.resolve(request), which is retriever-store.mjs's own
// boundary. No provider/SQL code is ever imported by a flows/*.mjs file.
import { reciprocalRankFusion } from "../chunking-comparison/rrf.mjs";
import { bm25Search } from "./fixed-kure-bm25-index.mjs";

const BM25_TOP_K = 100; // P10.2's own pinned candidate funnel (scripts/p10.2-stage2-embedding-grid.mjs:44)
const RRF_K_CONSTANT = 60; // P10.2's own pinned RRF constant (ibid:46)

// Real VERIFIED_EVIDENCE source_locators (and this loader's own Fixed-512
// chunk source_locators, produced by the SAME domain/chunking/chunker.mjs)
// follow `${document_id}/${file_id}#node=N`; reused read-only, never
// fabricated when absent -- mirrors pgvector-retriever-adapter.mjs's own
// buildSourceSpan exactly, generalized to also read chunk_type/
// parent_chunk_id back out of `metadata` (this Turn's own materialization
// choice -- 003's shared reference_retrieval_chunks table has no dedicated
// columns for either, see reference-fixed-kure-load-session-repository.mjs's
// materializeChunkBatch).
const LOCATOR_PATTERN = /#node=(\d+)(?:&row=(\d+)&col=(\d+))?$/;

function buildSourceSpan(row) {
  const match = LOCATOR_PATTERN.exec(row.source_locator ?? "");
  const nodeId = match ? `${row.source_document_id}::n${match[1]}` : `${row.source_document_id}::${row.chunk_id}`;
  const row_ = match?.[2] !== undefined ? Number(match[2]) : null;
  const col = match?.[3] !== undefined ? Number(match[3]) : null;
  return {
    file_id: `file_${row.chunk_id.slice("chunk_".length)}`,
    rel_path: `${row.source_document_id}/${row.chunk_id.slice("chunk_".length)}.xml`,
    node_id: nodeId,
    order_index: Number.isInteger(row.chunk_ordinal) ? row.chunk_ordinal : 0,
    row_start: row_, row_end: row_, col_start: col, col_end: col,
    source_locator: row.source_locator,
  };
}

function toResultItem(row, { rank, score, scoreType, componentScores }) {
  return {
    rank, score, score_type: scoreType, component_scores: componentScores,
    document_id: row.source_document_id,
    chunk_id: row.chunk_id,
    chunk_type: row.metadata?.chunk_type ?? "DOCUMENT_FALLBACK",
    parent_chunk_id: row.metadata?.parent_chunk_id ?? null,
    text_provenance: "SOURCE_VERBATIM", // text_content IS the chunk's own verbatim raw_text -- see materializeChunkBatch's header
    citation_authority: "SOURCE_SPANS",
    raw_text: row.text_content,
    source_locator: row.source_locator,
    source_spans: [buildSourceSpan(row)],
  };
}

function passesFilters(row, filters) {
  if (Array.isArray(filters?.corp_codes) && filters.corp_codes.length > 0 && !filters.corp_codes.includes(row.corp_code)) return false;
  if (Array.isArray(filters?.document_ids) && filters.document_ids.length > 0 && !filters.document_ids.includes(row.source_document_id)) return false;
  if (Array.isArray(filters?.doc_groups) && filters.doc_groups.length > 0 && !filters.doc_groups.includes(row.metadata?.doc_group)) return false;
  return true;
}

// `client` is a plain `pg` client/pool (query(sql, params) -> {rows}) --
// this module's own only piece of raw SQL: hydrating a bounded (<=100) set
// of BM25 candidate chunk_ids into full rows, since bm25Search only ever
// returns { id, score } pairs. Dense candidates already arrive fully
// hydrated from searchDocumentChunksByVector, which this function never
// duplicates.
async function fetchChunksByIds(client, retrievalIndexId, chunkIds) {
  if (chunkIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT chunk_id, source_document_id, corp_code, source_locator, chunk_ordinal, text_content, metadata
     FROM disclosure_reference.reference_retrieval_chunks
     WHERE retrieval_index_id = $1 AND chunk_id = ANY($2::text[])`,
    [retrievalIndexId, chunkIds],
  );
  return new Map(result.rows.map((r) => [r.chunk_id, r]));
}

// `bm25Index`: the loaded (persisted, in-memory) index from
// fixed-kure-bm25-index.mjs. `vectorRepository`: reference-vector-retrieval-repository.mjs's
// own createPostgresVectorRetrievalRepository() result, UNMODIFIED.
// `embeddingAdapter`: domain/agent-comparison/retrieval/embedding-adapter.mjs's
// own createEmbeddingAdapter() result, pointed at the LOCAL KURE-v1 server.
export function createFixedKureHybridRetrieverAdapter({
  client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId, expectedPins,
  bm25TopK = BM25_TOP_K, rrfK = RRF_K_CONSTANT,
}) {
  if (!client || typeof client.query !== "function") throw new TypeError("client is required");
  if (!bm25Index) throw new TypeError("bm25Index is required");
  if (!vectorRepository || typeof vectorRepository.searchDocumentChunksByVector !== "function") throw new TypeError("vectorRepository is required");
  if (!embeddingAdapter || typeof embeddingAdapter.embedQuery !== "function") throw new TypeError("embeddingAdapter is required");
  if (typeof retrievalIndexId !== "string" || retrievalIndexId === "") throw new TypeError("retrievalIndexId is required");

  return Object.freeze({
    // `request` has already been schema-validated and deep-frozen by
    // retriever-store.mjs before this is ever called.
    async retrieve(request, { signal } = {}) {
      const startedAt = Date.now();
      const filters = request.metadata_filters;

      const bm25Ranked = bm25Search(bm25Index, request.question, { topK: bm25TopK });
      const queryVector = await embeddingAdapter.embedQuery(request.question);
      const denseRows = await vectorRepository.searchDocumentChunksByVector(
        {
          retrievalIndexId, queryVector, topK: request.top_k,
          corpCodes: filters?.corp_codes?.length ? filters.corp_codes : undefined,
          documentIds: filters?.document_ids?.length ? filters.document_ids : undefined,
          expectedPins,
        },
        { signal },
      );

      const bm25ChunkIds = bm25Ranked.map((r) => r.id);
      const bm25RowsById = await fetchChunksByIds(client, retrievalIndexId, bm25ChunkIds);
      const bm25RankedFiltered = bm25Ranked
        .filter((r) => { const row = bm25RowsById.get(r.id); return row && passesFilters(row, filters); })
        .map((r) => ({ id: r.id, score: r.score }));

      const denseRowsById = new Map(denseRows.map((r) => [r.chunk_id, r]));
      const denseRanked = denseRows.map((r) => ({ id: r.chunk_id, score: r.similarity_score }));

      // domain/contracts.mjs's RETRIEVAL_METHOD_REQUIRED_COMPONENTS.HYBRID_RRF
      // = ["bm25", "dense", "rrf"] (frozen, this Turn never redefines it):
      // every HYBRID_RRF result must carry a non-null score from BOTH legs,
      // so RRF here fuses the INTERSECTION of the two candidate sets, never
      // their union -- a chunk found by only one method is not a valid
      // HYBRID_RRF result and is dropped before fusion (still discoverable
      // via a separate BM25-only or DENSE-only request.retrieval_method).
      const denseIds = new Set(denseRanked.map((r) => r.id));
      const bm25Ids = new Set(bm25RankedFiltered.map((r) => r.id));
      const bm25Intersected = bm25RankedFiltered.filter((r) => denseIds.has(r.id));
      const denseIntersected = denseRanked.filter((r) => bm25Ids.has(r.id));

      const fused = reciprocalRankFusion([bm25Intersected, denseIntersected], { k: rrfK, topK: request.top_k });

      const bm25ScoreById = new Map(bm25Intersected.map((r) => [r.id, r.score]));
      const denseScoreById = new Map(denseIntersected.map((r) => [r.id, r.score]));
      const results = fused.map((entry, index) => {
        const row = bm25RowsById.get(entry.id) ?? denseRowsById.get(entry.id);
        return toResultItem(row, {
          rank: index + 1, score: entry.score, scoreType: "RRF",
          componentScores: {
            bm25: bm25ScoreById.get(entry.id) ?? null,
            dense: denseScoreById.get(entry.id) ?? null,
            rrf: entry.score, reranker: null,
          },
        });
      });

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
        results,
      };
    },
  });
}
