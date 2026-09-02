#!/usr/bin/env node
// Turn P10.4 / Stage 5: count-only Adaptive Table Chunking over the REAL,
// FULL parsed DocumentIR corpus (4,204 docs, ~8.62GB). NO embedding model
// is loaded and NO vector is ever computed here -- reuses P10.2's proven
// full-corpus-streamer.mjs (unmodified) and the same 2-pass-per-run
// determinism pattern as scripts/p10.2-stage1-full-corpus-count-only.mjs.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { chunkAdaptive } from "../domain/chunking/adaptive-table-chunker.mjs";
import { ADAPTIVE_POLICY_ID, TABLE_ROW_CHILD_MAX_TOKENS } from "../domain/chunking/adaptive-chunking-policy.mjs";
import { PARSE_LIMITED_TABLE_SOURCES, PARSE_LIMITED_TABLE_NODE_IDS } from "../domain/chunking/adaptive-parse-limited-sources.v0.1.mjs";
import { loadDocumentMetadataIndex, toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { corpusSourceFileStats, streamAllDocuments } from "../domain/agent-comparison/chunking-comparison/full-corpus-streamer.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.4-adaptive-table-chunking");
const MAIN_CHECKOUT_ROOT = "/Users/jaewan/Documents/Codex/2026-07-28/ai-ai-festival-agent-1-ai";
const RAW_SOURCE_DIR = path.join(MAIN_CHECKOUT_ROOT, "work/a-document-ir/source");
const DOCUMENTS_JSONL_PATH = path.join(MAIN_CHECKOUT_ROOT, "work/domain-seed/documents.jsonl");
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: process.env.P10_4_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) });
const ADAPTIVE_CONFIG = Object.freeze({ chunking_config_id: ADAPTIVE_POLICY_ID, strategy_name: "adaptive-table-aware", strategy_version: "0.1.0", max_tokens: 512, overlap_tokens: 64, table_row_child_max_tokens: TABLE_ROW_CHILD_MAX_TOKENS });
const KURE_EMBEDDING_DIMENSION = 1024;

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

// Turn P10.4-R / Section G: the canonical per-chunk projection fed into
// the STREAMING determinism hash below -- fixed key order, only the
// fields that actually define this chunk's retrieval-relevant identity
// (never a field that could vary for a reason unrelated to correctness,
// e.g. chunk_index which is just array position). Deliberately does NOT
// include raw_text/embed_text themselves (content_sha256 already
// canonicalizes their content byte-for-byte, cheaper to hash and compare).
function canonicalChunkProjection(chunk) {
  return JSON.stringify({
    chunk_id: chunk.chunk_id,
    chunk_type: chunk.chunk_type,
    content_sha256: chunk.content_sha256,
    document_id: chunk.document_id,
    source_locator: chunk.source_locator,
    source_spans: chunk.source_spans.map((s) => ({ node_id: s.node_id, order_index: s.order_index, row_start: s.row_start, row_end: s.row_end, col_start: s.col_start, col_end: s.col_end })),
    retrieval_eligible: chunk.metadata.retrieval_eligible,
    index_role: chunk.metadata.index_role,
    context_states: chunk.metadata.context_states ?? null,
    table_node_id: chunk.metadata.table_node_id ?? null,
  });
}

async function runAdaptiveCountOnly(metadataIndex) {
  const startedAt = Date.now();
  let peakRss = process.memoryUsage().rss;

  let documentsProcessed = 0;
  let documentsMissingMetadata = 0;
  let totalChunks = 0;
  let searchEligibleChunks = 0;
  let fixedReusedChunks = 0; // FIXED_WINDOW, retrieval_eligible: true (non-table-touching)
  let fixedDemotedChunks = 0; // FIXED_WINDOW, table-touching, retrieval_eligible: false
  let tableAwareChildCount = 0; // TABLE_ROW_WITH_HEADERS + TABLE_ROW_SEGMENT_WITH_HEADERS
  let rowSegmentCount = 0; // TABLE_ROW_SEGMENT_WITH_HEADERS only
  let parentContextCount = 0; // TABLE_PARENT_CONTEXT
  let multiRowContextCount = 0; // MULTI_ROW_CONTEXT
  let tablesWithIrregularColumnCounts = 0; // informational only -- never an exclusion gate
  let parseLimitedTablesEncountered = 0; // Turn P10.4-R / Section C: nodes matching the 4 pinned sources, seen across the full corpus
  const chunksPerDocument = [];
  const contentShaSet = new Set();
  const embedTextSet = new Set();
  const blockTypeCounts = {};
  const violationSamples = [];
  let violationCount = 0;
  const idPattern = /^chunk_[0-9a-f]{24}$/;
  // Turn P10.4-R / Section G: STREAMING canonical hash over every chunk's
  // canonical projection, never an aggregate-counts-only hash -- two runs
  // producing the same TOTALS via a different underlying chunk stream must
  // NOT be reported as deterministic. Updated incrementally per chunk
  // (never materializes all 2.58M projections at once).
  const canonicalStreamHash = createHash("sha256");

  for await (const { documentId, rawRecord } of streamAllDocuments(RAW_SOURCE_DIR)) {
    const metadataRecord = metadataIndex.byDocumentId.get(documentId);
    if (!metadataRecord) { documentsMissingMetadata += 1; continue; }
    const document = toChunkerDocument(metadataRecord);
    const chunks = chunkAdaptive(rawRecord, document, ADAPTIVE_CONFIG, PROVENANCE);
    documentsProcessed += 1;
    chunksPerDocument.push(chunks.length);
    totalChunks += chunks.length;

    for (const table of (rawRecord.nodes ?? [])) {
      if (table.kind === "table") {
        const counts = table.actual_col_counts ?? [];
        if (counts.length >= 2 && new Set(counts).size > 1) tablesWithIrregularColumnCounts += 1;
        if (PARSE_LIMITED_TABLE_NODE_IDS.has(table.node_id)) parseLimitedTablesEncountered += 1;
      }
    }

    for (const chunk of chunks) {
      if (!idPattern.test(chunk.chunk_id) && !chunk.chunk_id.startsWith("chunk_")) {
        violationCount += 1;
        if (violationSamples.length < 10) violationSamples.push({ documentId, chunk_id: chunk.chunk_id });
      }
      if (chunk.document_id !== documentId || chunk.metadata.corp_code !== metadataRecord.corp_code) {
        violationCount += 1;
        if (violationSamples.length < 10) violationSamples.push({ documentId, chunk_id: chunk.chunk_id, reason: "id/corp_code mismatch" });
      }
      contentShaSet.add(chunk.content_sha256);
      blockTypeCounts[chunk.chunk_type] = (blockTypeCounts[chunk.chunk_type] ?? 0) + 1;
      if (chunk.metadata.retrieval_eligible) { searchEligibleChunks += 1; embedTextSet.add(chunk.embed_text); }
      canonicalStreamHash.update(canonicalChunkProjection(chunk));
      canonicalStreamHash.update("\n");

      if (chunk.chunk_type === "FIXED_WINDOW") {
        if (chunk.metadata.retrieval_eligible) fixedReusedChunks += 1; else fixedDemotedChunks += 1;
      } else if (chunk.chunk_type === "TABLE_ROW_WITH_HEADERS") {
        tableAwareChildCount += 1;
      } else if (chunk.chunk_type === "TABLE_ROW_SEGMENT_WITH_HEADERS") {
        tableAwareChildCount += 1; rowSegmentCount += 1;
      } else if (chunk.chunk_type === "TABLE_PARENT_CONTEXT") {
        parentContextCount += 1;
      } else if (chunk.chunk_type === "MULTI_ROW_CONTEXT") {
        multiRowContextCount += 1;
      }
    }

    if (documentsProcessed % 500 === 0) {
      const rss = process.memoryUsage().rss;
      peakRss = Math.max(peakRss, rss);
      console.error(`[p10.4-stage5]   ${documentsProcessed} documents processed, ${totalChunks} chunks so far, rss=${Math.round(rss / 1e6)}MB`);
    }
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const sortedChunksPerDoc = [...chunksPerDocument].sort((a, b) => a - b);

  return {
    chunking_config_id: ADAPTIVE_POLICY_ID,
    documents_processed: documentsProcessed,
    documents_missing_metadata: documentsMissingMetadata,
    total_chunks: totalChunks,
    search_eligible_chunks: searchEligibleChunks,
    fixed_reused_chunks: fixedReusedChunks,
    fixed_demoted_table_touching_chunks: fixedDemotedChunks,
    table_aware_child_count: tableAwareChildCount,
    row_segment_count: rowSegmentCount,
    non_searchable_parent_context_count: parentContextCount,
    multi_row_context_count: multiRowContextCount,
    tables_with_irregular_column_counts_informational_only: tablesWithIrregularColumnCounts,
    parse_limited_table_sources_excluded: {
      pinned_count: PARSE_LIMITED_TABLE_SOURCES.length,
      encountered_count: parseLimitedTablesEncountered,
      sources: PARSE_LIMITED_TABLE_SOURCES,
    },
    unique_content_sha256: contentShaSet.size,
    exact_duplicate_ratio: totalChunks > 0 ? 1 - contentShaSet.size / totalChunks : null,
    unique_embeddable_text_count: embedTextSet.size,
    chunks_per_document: { p50: percentile(sortedChunksPerDoc, 0.5), p95: percentile(sortedChunksPerDoc, 0.95), max: sortedChunksPerDoc.at(-1) ?? null },
    block_type_counts: blockTypeCounts,
    locator_provenance_violations: violationCount,
    locator_provenance_violation_samples: violationSamples,
    // Turn P10.4-R / Section G: real streaming per-chunk canonical hash --
    // replaces the old aggregate-counts-only hash. Two passes only agree
    // here if every chunk's canonical projection matches, in the same
    // order, not just the totals.
    canonical_chunk_stream_sha256: canonicalStreamHash.digest("hex"),
    build_time_ms: Date.now() - startedAt,
    peak_rss_bytes: peakRss,
  };
}

async function main() {
  console.error("[p10.4-stage5] measuring REAL input file bytes (never hardcoded)...");
  const sourceFileStats = await corpusSourceFileStats(RAW_SOURCE_DIR);
  const totalInputBytes = sourceFileStats.reduce((sum, f) => sum + f.bytes, 0);
  console.error(`[p10.4-stage5] parsed DocumentIR input: ${sourceFileStats.length} files, ${totalInputBytes} bytes (${(totalInputBytes / 1e9).toFixed(3)} GB)`);

  console.error("[p10.4-stage5] loading document metadata index (4,204 docs, read-only)...");
  const metadataIndex = await loadDocumentMetadataIndex(DOCUMENTS_JSONL_PATH);
  console.error(`[p10.4-stage5] metadata index: ${metadataIndex.byDocumentId.size} documents`);

  console.error("[p10.4-stage5] pass 1/2 (Adaptive, full corpus, count-only)...");
  const first = await runAdaptiveCountOnly(metadataIndex);
  console.error(`[p10.4-stage5] pass 1 done in ${first.build_time_ms}ms: ${first.total_chunks} total chunks, ${first.search_eligible_chunks} search-eligible`);
  console.error("[p10.4-stage5] pass 2/2 (determinism check)...");
  const second = await runAdaptiveCountOnly(metadataIndex);
  console.error(`[p10.4-stage5] pass 2 done in ${second.build_time_ms}ms: ${second.total_chunks} total chunks, ${second.search_eligible_chunks} search-eligible`);

  // Turn P10.4-R / Section G: determinism requires the STREAMING per-chunk
  // hash to match across passes, AND (belt-and-suspenders, cheap to check)
  // the aggregate counts/unique-counts/metadata-counts to match too --
  // never just the aggregate counts alone.
  const countsMatch = first.total_chunks === second.total_chunks
    && first.unique_content_sha256 === second.unique_content_sha256
    && first.unique_embeddable_text_count === second.unique_embeddable_text_count
    && JSON.stringify(first.block_type_counts) === JSON.stringify(second.block_type_counts);
  const streamShaMatches = first.canonical_chunk_stream_sha256 === second.canonical_chunk_stream_sha256;
  const deterministic = countsMatch && streamShaMatches;
  const firstSha = first.canonical_chunk_stream_sha256;
  if (!deterministic) console.error(`[p10.4-stage5] FAIL-CLOSED WARNING: Adaptive is NOT deterministic across two full-corpus runs (counts_match=${countsMatch}, stream_sha_matches=${streamShaMatches})`);
  if (first.parse_limited_table_sources_excluded.encountered_count !== first.parse_limited_table_sources_excluded.pinned_count) {
    console.error(`[p10.4-stage5] WARNING: expected ${first.parse_limited_table_sources_excluded.pinned_count} pinned parse-limited sources, encountered ${first.parse_limited_table_sources_excluded.encountered_count} in the full corpus (not fail-closed -- a corpus snapshot change is out of this Turn's scope, but this must be investigated before trusting the result)`);
  }

  // Full-corpus embedding projection (count-only -- no embedding executed).
  const fixedUniqueEmbedTextsProjection = 441879; // P10.2's real, measured Fixed full-corpus unique-embed-text count (stage1-full-corpus-count-only.v0.1.json), cited for the increase-rate comparison below
  const sectionUniqueEmbedTextsProjection = 492568; // same source, Section-Aware-Flat
  const rawVectorBytes = first.unique_embeddable_text_count * KURE_EMBEDDING_DIMENSION * 4;

  await mkdir(OUT_DIR, { recursive: true });
  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    adaptive_policy_id: ADAPTIVE_POLICY_ID,
    corpus_snapshot_id: PROVENANCE.targetCorpusSnapshotId,
    input: { files: sourceFileStats, total_bytes_measured_now: totalInputBytes, total_documents_in_metadata_index: metadataIndex.byDocumentId.size },
    pass_1: first,
    pass_2: second,
    canonical_result_sha256: firstSha,
    deterministic_rebuild: deterministic,
    full_corpus_embedding_projection: {
      unique_embedding_count: first.unique_embeddable_text_count,
      kure_dimension: KURE_EMBEDDING_DIMENSION,
      raw_vector_bytes: rawVectorBytes,
      raw_vector_gib: rawVectorBytes / 1024 ** 3,
      ann_index_range_gib: [rawVectorBytes * 1.2 / 1024 ** 3, rawVectorBytes * 1.5 / 1024 ** 3],
      increase_vs_fixed_full_corpus: { fixed_baseline_unique_embed_texts: fixedUniqueEmbedTextsProjection, ratio: first.unique_embeddable_text_count / fixedUniqueEmbedTextsProjection },
      increase_vs_section_full_corpus: { section_baseline_unique_embed_texts: sectionUniqueEmbedTextsProjection, ratio: first.unique_embeddable_text_count / sectionUniqueEmbedTextsProjection },
    },
  };
  await writeFile(path.join(OUT_DIR, "adaptive-full-corpus-count-report.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    status: "OK",
    total_input_bytes_measured: totalInputBytes,
    deterministic_rebuild: deterministic,
    total_chunks: first.total_chunks,
    search_eligible_chunks: first.search_eligible_chunks,
    table_aware_child_count: first.table_aware_child_count,
    unique_embeddable_text_count: first.unique_embeddable_text_count,
    increase_vs_fixed: first.unique_embeddable_text_count / fixedUniqueEmbedTextsProjection,
    build_time_ms_each_pass: [first.build_time_ms, second.build_time_ms],
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.4-stage5] FAILED (fail-closed):", error.stack ?? error.message);
  process.exitCode = 1;
});
