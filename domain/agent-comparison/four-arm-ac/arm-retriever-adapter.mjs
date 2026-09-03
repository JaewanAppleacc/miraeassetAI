// Turn AC-IMPL: RetrieverAdapter for vFINAL arms A (FIXED+FULL_DENSE) and
// C (FIXED+DENSE_OFF) -- section B's Fixed common base (corpus snapshot,
// fixed-token-512-o64.v0.1.0 chunker output, chunk IDs/text/provenance,
// BM25 tokenizer/index/candidate pool, final top-k) is never rebuilt here:
// this module only WIRES already-existing, unmodified pieces --
// domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs
// (arm A's BM25+dense+RRF path, reused as-is) and
// domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs's persisted
// BM25 index (the SAME index object is passed to both arms -- arm C never
// builds a second index).
//
// Arm C (DENSE_OFF) is a STRUCTURAL guarantee, not a behavioral one: its
// constructor refuses a vectorRepository/embeddingAdapter argument, and its
// only search code path (searchArmC below) never imports or references
// reciprocalRankFusion, embedQuery, or searchDocumentChunksByVector --
// there is no line of code in this file through which arm C could reach
// any of the three, so "0 dense/embedding/RRF calls" holds even if a
// caller tried to smuggle those dependencies in some other way.
import { createHash } from "node:crypto";
import { createFixedKureHybridRetrieverAdapter } from "../retrieval/fixed-kure-hybrid-retriever-adapter.mjs";
import { bm25Search } from "../retrieval/fixed-kure-bm25-index.mjs";
import { buildMetadataFiltersFromConditions } from "./conditions-fixture.mjs";
import { classifySpans, verifyNodeIdentity, summarizeLocatorCoverage } from "./locator-provenance.mjs";

// vFINAL section C's KURE pin, and P10.2's own pinned retrieval constants
// (scripts/p10.2-stage2-embedding-grid.mjs:44-46, already reused unchanged
// by fixed-kure-hybrid-retriever-adapter.mjs) -- reproduced here as the
// single source this module checks arm A's expectedPins against, so a
// caller cannot silently point arm A at a different embedding model.
export const KURE_PIN = Object.freeze({
  repository: "nlpai-lab/KURE-v1",
  revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
  dimension: 1024,
});
export const BM25_TOP_K = 100;
export const RRF_K_CONSTANT = 60;
export const CHUNKING_POLICY_ID = "fixed-token-512-o64.v0.1.0";

export const ARM_DEFS = Object.freeze({
  A: Object.freeze({ arm_code: "A", arm_id: "FIXED+FULL_DENSE" }),
  C: Object.freeze({ arm_code: "C", arm_id: "FIXED+DENSE_OFF" }),
});

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The SAME filter predicate fixed-kure-hybrid-retriever-adapter.mjs's own
// (private) passesFilters applies to its BM25 leg -- reproduced here
// (rather than imported, since the original is not exported) so arm C's
// BM25-only candidates are filtered identically to arm A's BM25 leg, per
// vFINAL section C ("C: metadata filter → A와 동일한 BM25 candidates/
// ranking → top 20").
function passesMetadataFilters(row, filters) {
  if (Array.isArray(filters?.corp_codes) && filters.corp_codes.length > 0 && !filters.corp_codes.includes(row.corp_code)) return false;
  if (Array.isArray(filters?.document_ids) && filters.document_ids.length > 0 && !filters.document_ids.includes(row.source_document_id)) return false;
  if (Array.isArray(filters?.doc_groups) && filters.doc_groups.length > 0 && !filters.doc_groups.includes(row.metadata?.doc_group)) return false;
  if (Array.isArray(filters?.doc_subtypes) && filters.doc_subtypes.length > 0 && !filters.doc_subtypes.includes(row.metadata?.doc_subtype)) return false;
  if (filters?.retrieval_eligible === true && row.metadata?.retrieval_eligible === false) return false;
  return true;
}

async function fetchChunksByIds(client, retrievalIndexId, chunkIds) {
  if (chunkIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT chunk_id, source_document_id, corp_code, source_locator, chunk_ordinal, text_content, text_sha256, metadata
     FROM disclosure_reference.reference_retrieval_chunks
     WHERE retrieval_index_id = $1 AND chunk_id = ANY($2::text[])`,
    [retrievalIndexId, chunkIds],
  );
  return new Map(result.rows.map((r) => [r.chunk_id, r]));
}

async function fetchStagingSpans(client, loadSessionId, chunkIds) {
  if (chunkIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT chunk_id, source_spans FROM disclosure_reference.reference_fixed_kure_chunk_staging
     WHERE load_session_id = $1 AND chunk_id = ANY($2::text[])`,
    [loadSessionId, chunkIds],
  );
  return new Map(result.rows.map((r) => [r.chunk_id, r.source_spans]));
}

// Section F's own result-field list (rank, chunk_id, doc_id, node_index,
// locator, row/col when known, chunk_text_sha256, score, metadata,
// arm_code/arm_id) -- a DIFFERENT, new contract from the frozen
// RetrieverRequest/RetrieverResult schema arm A's reused hybrid adapter
// still speaks internally; this function is the only place the two are
// bridged, and it never mutates the frozen retrieval-result.schema.json.
function toArmResultItem(row, spans, { rank, score, scoreType, componentScores, arm }) {
  if (!row) throw new Error(`toArmResultItem: no reference_retrieval_chunks row found for a ranked chunk_id (retrieval_index_id/chunk_id mismatch)`);
  const resolution = classifySpans(spans ?? []);
  return Object.freeze({
    rank,
    chunk_id: row.chunk_id,
    doc_id: row.source_document_id,
    node_index: resolution.node_index,
    locator: resolution.locator ?? row.source_locator,
    row: resolution.row,
    col: resolution.col,
    locator_status: resolution.status,
    chunk_text_sha256: row.text_sha256 ?? sha256Hex(row.text_content),
    score,
    score_type: scoreType,
    component_scores: componentScores,
    metadata: row.metadata ?? {},
    arm_code: ARM_DEFS[arm].arm_code,
    arm_id: ARM_DEFS[arm].arm_id,
  });
}

export function createArmRetrieverAdapter({
  arm, client, bm25Index, retrievalIndexId, loadSessionId, corpusSnapshotId,
  vectorRepository, embeddingAdapter, expectedPins,
  bm25TopK = BM25_TOP_K, rrfK = RRF_K_CONSTANT,
}) {
  if (arm !== "A" && arm !== "C") throw new TypeError(`arm must be "A" or "C", got ${JSON.stringify(arm)}`);
  if (!client || typeof client.query !== "function") throw new TypeError("client is required");
  if (!bm25Index) throw new TypeError("bm25Index is required");
  if (typeof retrievalIndexId !== "string" || retrievalIndexId === "") throw new TypeError("retrievalIndexId is required");
  if (typeof loadSessionId !== "string" || loadSessionId === "") throw new TypeError("loadSessionId is required");

  if (arm === "A") {
    if (!vectorRepository || typeof vectorRepository.searchDocumentChunksByVector !== "function") {
      throw new TypeError("arm A (FIXED+FULL_DENSE) requires a vectorRepository");
    }
    if (!embeddingAdapter || typeof embeddingAdapter.embedQuery !== "function") {
      throw new TypeError("arm A (FIXED+FULL_DENSE) requires an embeddingAdapter");
    }
    if (expectedPins?.embedding_revision !== undefined && expectedPins.embedding_revision !== KURE_PIN.revision) {
      throw new Error(`KURE_PIN_MISMATCH: expected revision ${KURE_PIN.revision}, got ${expectedPins.embedding_revision}`);
    }
    if (expectedPins?.embedding_dimension !== undefined && expectedPins.embedding_dimension !== KURE_PIN.dimension) {
      throw new Error(`KURE_PIN_MISMATCH: expected dimension ${KURE_PIN.dimension}, got ${expectedPins.embedding_dimension}`);
    }
  } else if (vectorRepository !== undefined || embeddingAdapter !== undefined) {
    throw new TypeError(
      "arm C (FIXED+DENSE_OFF) must not be constructed with a vectorRepository/embeddingAdapter -- "
      + "zero dense/embedding access is a structural guarantee, not a behavioral one",
    );
  }

  const snapshotId = corpusSnapshotId ?? retrievalIndexId;
  const hybridAdapter = arm === "A"
    ? createFixedKureHybridRetrieverAdapter({ client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId, expectedPins, bm25TopK, rrfK })
    : null;

  async function searchArmA(question, filters, k) {
    const request = {
      schema_version: "0.1.0", query_id: `query_ac_a_${sha256Hex(question).slice(0, 16)}`, question,
      corpus_snapshot_id: snapshotId, chunking_config_id: CHUNKING_POLICY_ID, index_snapshot_id: retrievalIndexId,
      metadata_filters: filters, top_k: k, retrieval_method: "HYBRID_RRF",
    };
    const result = await hybridAdapter.retrieve(request, {});
    const chunkIds = result.results.map((r) => r.chunk_id);
    const [rowsById, spansById] = await Promise.all([
      fetchChunksByIds(client, retrievalIndexId, chunkIds),
      fetchStagingSpans(client, loadSessionId, chunkIds),
    ]);
    return result.results.map((r) => toArmResultItem(
      rowsById.get(r.chunk_id), spansById.get(r.chunk_id),
      { rank: r.rank, score: r.score, scoreType: r.score_type, componentScores: r.component_scores, arm },
    ));
  }

  // Zero embeddingAdapter/vectorRepository/reciprocalRankFusion references
  // anywhere in this function -- the ONLY candidate generation here is
  // bm25Search over the SAME bm25Index arm A's BM25 leg uses, at the SAME
  // BM25_TOP_K, filtered by the SAME passesMetadataFilters predicate.
  async function searchArmC(question, filters, k) {
    const bm25Ranked = bm25Search(bm25Index, question, { topK: bm25TopK });
    const chunkIds = bm25Ranked.map((r) => r.id);
    const [rowsById, spansById] = await Promise.all([
      fetchChunksByIds(client, retrievalIndexId, chunkIds),
      fetchStagingSpans(client, loadSessionId, chunkIds),
    ]);
    const filtered = bm25Ranked.filter((r) => {
      const row = rowsById.get(r.id);
      return row !== undefined && passesMetadataFilters(row, filters);
    });
    const top = filtered.slice(0, k);
    return top.map((r, index) => toArmResultItem(
      rowsById.get(r.id), spansById.get(r.id),
      { rank: index + 1, score: r.score, scoreType: "BM25", componentScores: { bm25: r.score, dense: null, rrf: null, reranker: null }, arm },
    ));
  }

  return Object.freeze({
    arm_code: ARM_DEFS[arm].arm_code,
    arm_id: ARM_DEFS[arm].arm_id,

    // search(question, conditions, k=20): `conditions` is the pre-computed
    // dict shape section D describes (never Gold-derived -- see
    // conditions-fixture.mjs). Mirrors the reference interfaces.md's own
    // `search(self, question, conditions, k=20) -> list[Chunk]` signature.
    async search(question, conditions = {}, k = 20) {
      if (typeof question !== "string" || question.trim() === "") throw new TypeError("question must be a non-empty string");
      if (!Number.isInteger(k) || k < 1) throw new TypeError("k must be a positive integer");
      const filters = buildMetadataFiltersFromConditions(conditions);
      const results = arm === "A" ? await searchArmA(question, filters, k) : await searchArmC(question, filters, k);
      return Object.freeze(results);
    },

    // fetch_node(doc_id, node_index): identity verification only (section
    // G) -- confirms the (doc_id, node_index) pair is actually referenced
    // by this load session's own persisted chunk spans; never fabricates
    // node-level original text (not persisted independently of chunk-level
    // raw_text by this loader -- see locator-provenance.mjs's header).
    async fetch_node(docId, nodeIndex) {
      if (typeof docId !== "string" || docId === "") throw new TypeError("doc_id is required");
      if (!Number.isInteger(nodeIndex) || nodeIndex < 0) throw new TypeError("node_index must be a non-negative integer");
      const result = await client.query(
        `SELECT chunk_id, source_spans FROM disclosure_reference.reference_fixed_kure_chunk_staging
         WHERE load_session_id = $1 AND document_id = $2`,
        [loadSessionId, docId],
      );
      return verifyNodeIdentity({ documentId: docId, nodeIndex, chunkRows: result.rows });
    },

    // readiness(): code_ready / full_index_ready / official_experiment_ready
    // returned separately per section I -- every check below is a REAL
    // query against this adapter's own wired client/retrievalIndexId/
    // loadSessionId, never a hardcoded true.
    async readiness() {
      const reasons = [];
      const bm25Ready = Boolean(bm25Index && bm25Index.documentCount > 0);
      if (!bm25Ready) reasons.push("BM25_INDEX_EMPTY_OR_MISSING");

      const indexRow = (await client.query(
        `SELECT index_status, embedding_provider, embedding_model, embedding_revision, embedding_dimension, record_count
         FROM disclosure_reference.reference_retrieval_indexes WHERE retrieval_index_id = $1`,
        [retrievalIndexId],
      )).rows[0] ?? null;
      const sessionRow = (await client.query(
        `SELECT status, expected_total_chunk_count, expected_search_eligible_count, expected_unique_embeddable_count, materialized_chunk_count
         FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id = $1`,
        [loadSessionId],
      )).rows[0] ?? null;

      let denseReady = true;
      let denseDisabledVerified = null;
      if (arm === "A") {
        denseReady = Boolean(indexRow) && indexRow.index_status === "READY"
          && indexRow.embedding_provider === "nlpai-lab" && indexRow.embedding_model === "KURE-v1"
          && indexRow.embedding_revision === KURE_PIN.revision && Number(indexRow.embedding_dimension) === KURE_PIN.dimension;
        if (!denseReady) reasons.push("A_DENSE_INDEX_NOT_READY_OR_PIN_MISMATCH");
      } else {
        // Structural, verified at construction time (the constructor
        // throws if vectorRepository/embeddingAdapter were ever supplied);
        // re-asserted here so readiness() itself is evidence, not opinion.
        denseDisabledVerified = vectorRepository === undefined && embeddingAdapter === undefined;
      }

      const shardReady = Boolean(sessionRow) && sessionRow.status === "READY"
        && Number(sessionRow.materialized_chunk_count) === Number(sessionRow.expected_total_chunk_count)
        && Number(sessionRow.materialized_chunk_count) > 0;
      if (!shardReady) reasons.push("LOAD_SESSION_NOT_READY_OR_COUNT_MISMATCH");

      const spansResult = await client.query(
        `SELECT source_spans FROM disclosure_reference.reference_fixed_kure_chunk_staging WHERE load_session_id = $1`,
        [loadSessionId],
      );
      const coverage = summarizeLocatorCoverage(spansResult.rows);
      if (!coverage.all_fully_resolved) reasons.push("A_C_LOCATOR_PROVENANCE_NOT_READY");

      const fullIndexReady = bm25Ready && denseReady && shardReady;
      const officialExperimentReady = fullIndexReady && coverage.all_fully_resolved;

      return Object.freeze({
        arm_code: ARM_DEFS[arm].arm_code,
        arm_id: ARM_DEFS[arm].arm_id,
        code_ready: true,
        full_index_ready: fullIndexReady,
        official_experiment_ready: officialExperimentReady,
        checks: Object.freeze({
          bm25_index_ready: bm25Ready,
          bm25_document_count: bm25Index?.documentCount ?? 0,
          dense_index_ready: arm === "A" ? denseReady : null,
          dense_disabled_verified: arm === "C" ? denseDisabledVerified : null,
          load_session_status: sessionRow?.status ?? null,
          materialized_chunk_count: sessionRow?.materialized_chunk_count ?? null,
          expected_total_chunk_count: sessionRow?.expected_total_chunk_count ?? null,
          expected_unique_embeddable_count: sessionRow?.expected_unique_embeddable_count ?? null,
          locator_provenance: coverage,
          kure_pin: KURE_PIN,
        }),
        reasons: Object.freeze(reasons),
      });
    },
  });
}
