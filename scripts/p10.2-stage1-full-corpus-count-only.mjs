#!/usr/bin/env node
// Turn P10.2 / Stage 1: count-only Fixed Token + Section-Aware Flat
// chunking over the REAL, FULL parsed DocumentIR corpus. NO embedding
// model is loaded and NO vector is ever computed here.
//
// THREE DISTINCT DATA LAYERS EXIST FOR THIS CORPUS -- this script uses
// ONLY layer 1, and this file documents why:
//   1. PARSED DocumentIR (raw, ~8.62GB across 4 files at
//      .../work/a-document-ir/source/{exchange,holding,major,
//      periodic-001}.jsonl) -- the ONLY layer whose shape
//      (doc_id/nodes[]/source_files/warnings/parse_quality) matches
//      domain/chunking/chunker.mjs's required input. THIS is what this
//      script re-chunks.
//   2. The Turn P5 "document retrieval snapshot" (document-chunks.v0.1.jsonl,
//      pinned sha256 4fa1ea1c...04309bf0b7b, 1,874,688 rows, ~2.90GB) --
//      an ALREADY-CHUNKED, DOWNSTREAM artifact built by a DIFFERENT
//      chunking policy (domain/agent-comparison/retrieval/document-
//      snapshot/*, the P4/P5 "document-node-first-v0.1" char-based
//      chunker -- NOT domain/chunking/chunker.mjs, NOT Fixed-512/
//      Section-Flat). Its pins are recorded in scripts/analyze-document-
//      retrieval-index-v01.mjs's EXPECTED_PINS but the physical file is
//      NOT present anywhere in this environment (checked: this worktree,
//      the main checkout, and every sibling worktree's work/ tree) --
//      this script does not read it, and could not verify it even if it
//      wanted to.
//   3. The pure chunk text_content UTF-8 sum (~1.06GB) -- a further-
//      derived statistic over layer 2, not a file this script reads.
//
// Every byte/document count below is MEASURED at run start (fs.stat /
// real streaming), never hardcoded from a prior report.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { loadDocumentMetadataIndex, toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { corpusSourceFileStats, streamAllDocuments } from "../domain/agent-comparison/chunking-comparison/full-corpus-streamer.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.2-chunking-embedding-grid");
const MAIN_CHECKOUT_ROOT = "/Users/jaewan/Documents/Codex/2026-07-28/ai-ai-festival-agent-1-ai";
const RAW_SOURCE_DIR = path.join(MAIN_CHECKOUT_ROOT, "work/a-document-ir/source");
const DOCUMENTS_JSONL_PATH = path.join(MAIN_CHECKOUT_ROOT, "work/domain-seed/documents.jsonl");
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: process.env.P10_2_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) });

// The Turn P5 retrieval-snapshot layer's own pins, cited (never verified
// against a local file, since it is not present in this environment) --
// recorded here purely so this report can name it explicitly rather than
// silently omit it.
const LAYER_2_RETRIEVAL_SNAPSHOT_PINS_CITED_NOT_VERIFIED = Object.freeze({
  snapshot_id: "docsnap_8e480ec27b33b15bada7b3e764df5385",
  document_chunks_path_name: "document-chunks.v0.1.jsonl",
  document_chunks_bytes: 2899830197,
  document_chunks_sha256: "4fa1ea1c97a550ce35b287164268ed22ae4bd02df357b0c24845604d92bf0b7b",
  document_records_path_name: "document-records.v0.1.jsonl",
  document_records_bytes: 3877948,
  document_records_sha256: "17ffa5dd661de8e61e42fffa55fcbac4679ce9f7a0b3c350fcb35c3055bd3f50",
  chunk_count: 1874688,
  chunk_text_content_utf8_bytes: 1059299442,
  physical_file_present_in_this_environment: false,
  chunking_policy: "document-node-first-v0.1 (domain/agent-comparison/retrieval/document-snapshot/*), NOT domain/chunking/chunker.mjs -- structurally incompatible input for Fixed-512/Section-Flat re-chunking",
});

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

const BLOCK_TYPE_ROLLUP = Object.freeze({
  TABLE_WHOLE: "TABLE", TABLE_ROW: "TABLE",
  SECTION_PARENT: "TITLE", EVENT_PARENT: "TITLE", HOLDING_STATUS_PARENT: "TITLE", SECTION_FLAT: "TITLE_OR_PARAGRAPH",
  PARAGRAPH_CHILD: "PARAGRAPH", FIELD_GROUP_CHILD: "PARAGRAPH", FIXED_WINDOW: "PARAGRAPH",
  DOCUMENT_FALLBACK: "FALLBACK",
});

// Streams the full corpus ONCE per strategy, chunking each document and
// immediately reducing it to running statistics -- never accumulates a
// full chunk array for the whole corpus (would be tens of GB in memory).
async function runStrategyCountOnly(strategyConfig, metadataIndex) {
  const startedAt = Date.now();
  let peakRss = process.memoryUsage().rss;

  let documentsProcessed = 0;
  let documentsMissingMetadata = 0;
  let totalChunks = 0;
  let searchEligibleChunks = 0;
  const chunksPerDocument = [];
  const tokenCounts = [];
  const charLengths = [];
  const contentShaSet = new Set();
  const embedTextSet = new Set();
  const blockTypeCounts = {};
  const violationSamples = [];
  let violationCount = 0;
  const idPattern = /^chunk_[0-9a-f]{24}$/;

  for await (const { documentId, rawRecord } of streamAllDocuments(RAW_SOURCE_DIR)) {
    const metadataRecord = metadataIndex.byDocumentId.get(documentId);
    if (!metadataRecord) { documentsMissingMetadata += 1; continue; }
    const document = toChunkerDocument(metadataRecord);
    const chunks = chunkDocument(rawRecord, document, strategyConfig, PROVENANCE);
    documentsProcessed += 1;
    chunksPerDocument.push(chunks.length);
    totalChunks += chunks.length;

    for (const chunk of chunks) {
      if (!idPattern.test(chunk.chunk_id) || chunk.document_id !== documentId || chunk.metadata.corp_code !== metadataRecord.corp_code) {
        violationCount += 1;
        if (violationSamples.length < 10) violationSamples.push({ documentId, chunk_id: chunk.chunk_id });
      }
      contentShaSet.add(chunk.content_sha256);
      tokenCounts.push(chunk.token_count);
      charLengths.push(chunk.raw_text.length);
      const rollup = BLOCK_TYPE_ROLLUP[chunk.chunk_type] ?? "OTHER";
      blockTypeCounts[rollup] = (blockTypeCounts[rollup] ?? 0) + 1;
      if (chunk.metadata.retrieval_eligible) { searchEligibleChunks += 1; embedTextSet.add(chunk.embed_text); }
    }

    if (documentsProcessed % 500 === 0) {
      const rss = process.memoryUsage().rss;
      peakRss = Math.max(peakRss, rss);
      console.error(`[p10.2-stage1]   ${strategyConfig.chunking_config_id}: ${documentsProcessed} documents processed, ${totalChunks} chunks so far, rss=${Math.round(rss / 1e6)}MB`);
    }
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const sortedChunksPerDoc = [...chunksPerDocument].sort((a, b) => a - b);
  const sortedTokenCounts = [...tokenCounts].sort((a, b) => a - b);
  const sortedCharLengths = [...charLengths].sort((a, b) => a - b);

  return {
    chunking_config_id: strategyConfig.chunking_config_id,
    documents_processed: documentsProcessed,
    documents_missing_metadata: documentsMissingMetadata,
    total_chunks: totalChunks,
    search_eligible_chunks: searchEligibleChunks,
    unique_content_sha256: contentShaSet.size,
    exact_duplicate_ratio: totalChunks > 0 ? 1 - contentShaSet.size / totalChunks : null,
    chunks_per_document: { p50: percentile(sortedChunksPerDoc, 0.5), p95: percentile(sortedChunksPerDoc, 0.95), max: sortedChunksPerDoc.at(-1) ?? null },
    char_length: { p50: percentile(sortedCharLengths, 0.5), p95: percentile(sortedCharLengths, 0.95), max: sortedCharLengths.at(-1) ?? null },
    token_count_proxy: { p50: percentile(sortedTokenCounts, 0.5), p95: percentile(sortedTokenCounts, 0.95), max: sortedTokenCounts.at(-1) ?? null },
    block_type_rollup: blockTypeCounts,
    locator_provenance_violations: violationCount,
    locator_provenance_violation_samples: violationSamples,
    expected_embedding_calls_if_full_corpus_embedded: embedTextSet.size,
    build_time_ms: Date.now() - startedAt,
    peak_rss_bytes: peakRss,
  };
}

async function main() {
  console.error("[p10.2-stage1] measuring REAL input file bytes (never hardcoded)...");
  const sourceFileStats = await corpusSourceFileStats(RAW_SOURCE_DIR);
  const totalInputBytes = sourceFileStats.reduce((sum, f) => sum + f.bytes, 0);
  console.error(`[p10.2-stage1] parsed DocumentIR input: ${sourceFileStats.length} files, ${totalInputBytes} bytes (${(totalInputBytes / 1e9).toFixed(3)} GB)`);
  for (const f of sourceFileStats) console.error(`[p10.2-stage1]   ${f.docGroup}: ${f.filename} = ${f.bytes} bytes`);

  console.error("[p10.2-stage1] loading document metadata index (4,204 docs, read-only)...");
  const metadataIndex = await loadDocumentMetadataIndex(DOCUMENTS_JSONL_PATH);
  console.error(`[p10.2-stage1] metadata index: ${metadataIndex.byDocumentId.size} documents`);

  const strategies = P10_STRATEGIES.filter((s) => s.strategy_name !== "document-type-hierarchical-parent-child"); // Fixed + Section-Flat only -- Hierarchical stays excluded per Turn P10.1.1
  if (strategies.length !== 2) throw new Error(`FAIL-CLOSED: expected exactly 2 non-hierarchical strategies, got ${strategies.length}`);

  const results = [];
  for (const strategyConfig of strategies) {
    console.error(`[p10.2-stage1] running ${strategyConfig.chunking_config_id} over the FULL corpus (2 passes for determinism)...`);
    const first = await runStrategyCountOnly(strategyConfig, metadataIndex);
    const second = await runStrategyCountOnly(strategyConfig, metadataIndex);
    const firstSha = sha256Hex({ total: first.total_chunks, unique: first.unique_content_sha256, eligible: first.search_eligible_chunks, blocks: first.block_type_rollup });
    const secondSha = sha256Hex({ total: second.total_chunks, unique: second.unique_content_sha256, eligible: second.search_eligible_chunks, blocks: second.block_type_rollup });
    const deterministic = firstSha === secondSha;
    if (!deterministic) console.error(`[p10.2-stage1] FAIL-CLOSED WARNING: ${strategyConfig.chunking_config_id} is NOT deterministic across two full-corpus runs`);
    results.push({ ...first, canonical_result_sha256: firstSha, deterministic_rebuild: deterministic });
  }

  await mkdir(OUT_DIR, { recursive: true });
  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    corpus_snapshot_id: PROVENANCE.targetCorpusSnapshotId,
    data_layers: {
      layer_1_parsed_document_ir_raw: {
        role: "THE input this script actually re-chunks",
        files: sourceFileStats,
        total_bytes_measured_now: totalInputBytes,
        total_documents_in_metadata_index: metadataIndex.byDocumentId.size,
      },
      layer_2_retrieval_snapshot_downstream_not_used: LAYER_2_RETRIEVAL_SNAPSHOT_PINS_CITED_NOT_VERIFIED,
      layer_3_text_content_sum_not_used: { bytes_cited: 1059299442, note: "further-derived statistic over layer 2; this script never reads it" },
    },
    strategies: results,
  };
  await writeFile(path.join(OUT_DIR, "stage1-full-corpus-count-only.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    status: "OK",
    total_input_bytes_measured: totalInputBytes,
    strategies: results.map((r) => ({ chunking_config_id: r.chunking_config_id, total_chunks: r.total_chunks, search_eligible_chunks: r.search_eligible_chunks, deterministic_rebuild: r.deterministic_rebuild, violations: r.locator_provenance_violations, build_time_ms: r.build_time_ms })),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.2-stage1] FAILED (fail-closed):", error.stack ?? error.message);
  process.exitCode = 1;
});
