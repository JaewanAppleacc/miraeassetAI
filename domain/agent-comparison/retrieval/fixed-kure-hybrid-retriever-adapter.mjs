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
import { passesMetadataFilters, fetchEligibleChunkIds } from "../../retrieval/metadata-filter.mjs";

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
  // Turn A-RETRIEVAL-REMEDIATION-V1 (opt-in; null = frozen behaviour):
  //   policy.dense_candidate_k -- dense-leg candidate count DECOUPLED from
  //     request.top_k. Frozen: the dense leg fetches request.top_k
  //     candidates, so changing the output k also changes the candidate
  //     set (and therefore the ranking) -- a caller asking for 10 does not
  //     get the first 10 of the 20-result answer.
  //   policy.bm25_zero_score -- "DROP" keeps score-0 BM25 candidates out of
  //     RRF (frozen "KEEP": bm25Search pads its top-K with zero-score ids
  //     in id order and each still earns 1/(k+rank) in the fusion).
  policy = null,
}) {
  if (!client || typeof client.query !== "function") throw new TypeError("client is required");
  if (!bm25Index) throw new TypeError("bm25Index is required");
  if (!vectorRepository || typeof vectorRepository.searchDocumentChunksByVector !== "function") throw new TypeError("vectorRepository is required");
  if (!embeddingAdapter || typeof embeddingAdapter.embedQuery !== "function") throw new TypeError("embeddingAdapter is required");
  if (typeof retrievalIndexId !== "string" || retrievalIndexId === "") throw new TypeError("retrievalIndexId is required");
  const denseCandidateK = (Number.isInteger(policy?.dense_candidate_k) && policy.dense_candidate_k > 0) ? policy.dense_candidate_k : null;
  const dropZeroBm25 = policy?.bm25_zero_score === "DROP";

  return Object.freeze({
    // `request` has already been schema-validated and deep-frozen by
    // retriever-store.mjs before this is ever called.
    // options.queryVector (opt-in): an already-computed embedding of
    // request.question, so a multi-pass caller embeds ONCE instead of once
    // per pass. Absent -> embedded here exactly as before.
    async retrieve(request, { signal, queryVector: queryVectorIn } = {}) {
      const startedAt = Date.now();
      const filters = request.metadata_filters;
      const isUnion = request.retrieval_method === "HYBRID_UNION_RRF";

      // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section G: metadata filter
      // applied to the candidate pool BEFORE ranking, on BOTH legs -- never
      // a post-hoc prune of an already-ranked top-K. fetchEligibleChunkIds
      // restricts BM25's own candidate pool via eligibleIds (bm25Search
      // then only ever scores/ranks eligible chunks); `filters` passed
      // straight through to the dense leg's own SQL WHERE (same shared
      // buildEligibilityWhereClause, so both legs apply IDENTICAL
      // semantics for every filter field).
      const eligibleIds = await fetchEligibleChunkIds(client, retrievalIndexId, filters, { signal });
      const bm25Ranked = bm25Search(bm25Index, request.question, { topK: bm25TopK, eligibleIds });
      const queryVector = (Array.isArray(queryVectorIn) && queryVectorIn.length > 0)
        ? queryVectorIn
        : await embeddingAdapter.embedQuery(request.question);
      const denseRows = await vectorRepository.searchDocumentChunksByVector(
        { retrievalIndexId, queryVector, topK: denseCandidateK ?? request.top_k, filters, expectedPins },
        { signal },
      );

      const bm25ChunkIds = bm25Ranked.map((r) => r.id);
      const bm25RowsById = await fetchChunksByIds(client, retrievalIndexId, bm25ChunkIds);
      // Row-level double-check (defense in depth on top of the SQL-level
      // prefilter above) -- never expected to drop anything the prefilter
      // already excluded, but never trusted blindly either.
      const bm25RankedFiltered = bm25Ranked
        .filter((r) => { const row = bm25RowsById.get(r.id); return row && passesMetadataFilters(row, filters); })
        // Remediation (policy.bm25_zero_score === "DROP"): a candidate with no
        // lexical overlap at all must not enter RRF with a rank credit.
        .filter((r) => !dropZeroBm25 || r.score > 0)
        .map((r) => ({ id: r.id, score: r.score }));

      const denseRowsById = new Map(denseRows.map((r) => [r.chunk_id, r]));
      const denseRanked = denseRows.map((r) => ({ id: r.chunk_id, score: r.similarity_score }));

      let bm25Leg;
      let denseLeg;
      if (isUnion) {
        // vFINAL section C: official candidate A fuses the UNION of both
        // candidate sets -- a chunk found by only one leg is never dropped
        // before fusion; reciprocalRankFusion already handles this
        // correctly (an id present in only one list still gets fused, with
        // the absent leg contributing exactly 0 -- see rrf.mjs's own test
        // coverage), so no intersection step runs at all here.
        bm25Leg = bm25RankedFiltered;
        denseLeg = denseRanked;
      } else {
        // domain/contracts.mjs's RETRIEVAL_METHOD_REQUIRED_COMPONENTS.HYBRID_RRF
        // = ["bm25", "dense", "rrf"] (frozen, unchanged): every HYBRID_RRF
        // result must carry a non-null score from BOTH legs, so RRF here
        // fuses the INTERSECTION of the two candidate sets, never their
        // union -- a chunk found by only one method is not a valid
        // HYBRID_RRF result and is dropped before fusion (still
        // discoverable via a separate BM25-only or DENSE-only
        // request.retrieval_method). Byte-for-byte the same behavior this
        // adapter already had before HYBRID_UNION_RRF existed.
        const denseIds = new Set(denseRanked.map((r) => r.id));
        const bm25Ids = new Set(bm25RankedFiltered.map((r) => r.id));
        bm25Leg = bm25RankedFiltered.filter((r) => denseIds.has(r.id));
        denseLeg = denseRanked.filter((r) => bm25Ids.has(r.id));
      }

      const fused = reciprocalRankFusion([bm25Leg, denseLeg], { k: rrfK, topK: request.top_k });

      const bm25ScoreById = new Map(bm25Leg.map((r) => [r.id, r.score]));
      const denseScoreById = new Map(denseLeg.map((r) => [r.id, r.score]));
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
