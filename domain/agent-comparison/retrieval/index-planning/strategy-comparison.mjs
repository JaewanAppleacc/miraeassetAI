// Turn P5.1: pure comparison of the 4 candidate index strategies named in
// the task brief. Every number here is derived from the real, already-
// computed length/duplicate/boilerplate analysis -- nothing here calls an
// embedding API or opens a database connection.
import { buildStorageScenario } from "./embedding-size-model.mjs";

export function buildStrategyComparison({ lengthAnalysis, duplicateAnalysis, boilerplateAnalysis, totalDocuments }) {
  const totalChunks = lengthAnalysis.total_chunks;
  const totalUtf8Bytes = lengthAnalysis.utf8_byte_length.total_bytes;
  const totalTokenRange = lengthAnalysis.korean_aware_token_proxy_range;
  const titleOnlyChunkCount = lengthAnalysis.extreme_shape_candidates.title_only_chunk_count;

  const strategyA = {
    strategy_id: "FULL_CHUNK_INDEX",
    description: "Embed all 1,874,688 chunks exactly as Turn P5 produced them. No dedup, no tiering, no exclusion.",
    embedding_payload_count: totalChunks,
    occurrence_count: totalChunks,
    input_token_proxy_range: totalTokenRange,
    storage: buildStorageScenario({ payloadCount: totalChunks, occurrenceCount: totalChunks, totalUtf8Bytes }),
    provenance_preserved: true,
    provenance_note: "Trivial -- one embedding row per chunk, no mapping layer needed.",
    recall_risk: "Baseline. No Gold-based recall claim is made either for or against this strategy in this Turn.",
    implementation_complexity: "LOW -- no new mapping layer, no change to how a Retriever hit is resolved back to a chunk.",
  };

  const strategyB = {
    strategy_id: "EXACT_TEXT_DEDUP_INDEX",
    description: "Embed only the unique text_sha256 values; every chunk occurrence resolves to its shared embedding via an occurrence map.",
    embedding_payload_count: duplicateAnalysis.unique_text_count,
    occurrence_count: totalChunks,
    embedding_calls_avoided_vs_full: duplicateAnalysis.embedding_calls_avoidable,
    input_token_proxy_range: duplicateAnalysis.unique_text_totals.korean_aware_token_proxy_range,
    storage: buildStorageScenario({
      payloadCount: duplicateAnalysis.unique_text_count,
      occurrenceCount: totalChunks,
      totalUtf8Bytes: duplicateAnalysis.unique_text_totals.total_utf8_bytes,
    }),
    provenance_preserved: true,
    provenance_note: "Requires an occurrence-mapping layer (text_sha256 -> every [chunk_id, source_document_id, source_locator]) between the embedding payload and a served search result -- see provenance-preservation-report.v0.1.json for a reconstruction proof against the real corpus.",
    recall_risk: "Identical text always embeds identically regardless of which document it came from -- no information loss for an exact duplicate. A shared boilerplate vector could appear as a repeated candidate across many documents' results unless the caller de-duplicates by document at query time; this is a serving-layer concern, not a provenance loss.",
    implementation_complexity: "MEDIUM -- needs the occurrence-mapping layer; the Retriever adapter (domain/agent-comparison/retrieval/pgvector-retriever-adapter.mjs) would need to resolve a hit's embedding row back to the CALLER-SELECTED occurrence (e.g. nearest to the query's own document/corp_code filter), not just any occurrence.",
  };

  const strategyC = {
    strategy_id: "HIERARCHICAL_INDEX",
    description: "Tier 1 searches document/section-level representative text (constructed deterministically from real node/title/metadata -- never model-generated) to select candidate documents; tier 2 then searches fine-grained chunks only within those selected documents.",
    tier1_representative_payload_count_range: {
      low: totalDocuments,
      high: titleOnlyChunkCount,
      note: "low = one representative per document; high = one representative per TITLE/section-like node. The actual granularity is an UNDECIDED design parameter, not a fixed plan.",
    },
    tier2_upper_bound_payload_count: totalChunks,
    tier2_note: "Tier-2 fine chunks are embedded ONLY on demand, for documents tier-1 selects at query time -- not upfront for the whole corpus. The figure above is an upper bound (every chunk, if every document were eventually queried), not an expected upfront embedding cost.",
    provenance_preserved: true,
    provenance_note: "Representative text is built deterministically from real DocumentIR node/title/metadata fields (never an LLM summary), so it always traces back to a real node_id/source_locator.",
    recall_risk: "Two-tier retrieval can miss a real answer whose home document's representative text does not surface it at tier 1 -- this is a genuine, unevaluated recall risk this Turn does not measure against Gold.",
    implementation_complexity: "HIGH -- representative-text granularity is undecided, and both HYBRID_RETRIEVAL and DOCUMENT_FIRST_RAG's existing retrieval call shape would need a two-phase query path that does not exist today.",
  };

  const boilerplateOccurrences = boilerplateAnalysis.boilerplate_candidate_occurrence_count;
  const primaryOccurrenceCount = totalChunks - boilerplateOccurrences;
  const strategyD = {
    strategy_id: "PRIMARY_PLUS_COLD_FALLBACK",
    description: "Only NOT_CANDIDATE (non-boilerplate-candidate) chunks are embedded into the primary vector index by default; BOILERPLATE_CANDIDATE chunks are kept in a cold, still-searchable store (e.g. lexical/BM25 or on-demand embedding) used only as a limited fallback when primary search fails.",
    primary_embedding_payload_count: primaryOccurrenceCount,
    cold_store_chunk_count: boilerplateOccurrences,
    occurrence_count: totalChunks,
    input_token_proxy_range: {
      low: Math.round(totalTokenRange.total_low * (primaryOccurrenceCount / Math.max(1, totalChunks))),
      high: Math.round(totalTokenRange.total_high * (primaryOccurrenceCount / Math.max(1, totalChunks))),
      note: "Proportionally scaled from the full-corpus token proxy range by the primary/total chunk-count ratio -- not separately recomputed per chunk.",
    },
    storage: buildStorageScenario({
      payloadCount: primaryOccurrenceCount,
      occurrenceCount: primaryOccurrenceCount,
      totalUtf8Bytes: Math.round(totalUtf8Bytes * (primaryOccurrenceCount / Math.max(1, totalChunks))),
    }),
    provenance_preserved: true,
    provenance_note: "Cold-store chunks are NEVER deleted -- they remain a real, searchable (non-vector) record with their own chunk_id/source_locator, just outside the default primary vector index.",
    recall_risk: "Requires evaluation before adoption: excluding BOILERPLATE_CANDIDATE chunks from the primary index assumes they rarely carry the unique evidence a query needs. This Turn's boilerplate rule already protects date/amount-bearing text from this exclusion (see boilerplate-candidate-analysis.v0.1.json's protected_despite_high_frequency_count), but the RESIDUAL recall impact of the exclusion is not measured against Gold in this Turn.",
    implementation_complexity: "MEDIUM-HIGH -- needs a cold-store search path and a fallback-trigger policy; must not silently become the de facto production path without an explicit evaluation gate.",
  };

  return { FULL_CHUNK_INDEX: strategyA, EXACT_TEXT_DEDUP_INDEX: strategyB, HIERARCHICAL_INDEX: strategyC, PRIMARY_PLUS_COLD_FALLBACK: strategyD };
}
