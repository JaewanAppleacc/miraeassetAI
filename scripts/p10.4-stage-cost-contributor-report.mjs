#!/usr/bin/env node
// Turn P10.4-R / Section H: honest, Gold-free full-corpus structural cost-
// contributor measurement, produced BEFORE any policy tuning. Reuses the
// same streaming pattern as Stage 5 (full-corpus-streamer.mjs, count-only,
// no embedding). NEVER reads a Gold question/answer/evidence_span --
// diagnostic-only, and any correction applied on the basis of this report
// must be a genuine corpus-wide structural fix (e.g. a packing under-
// utilization bug), never a heuristic chosen to force the <=1.5x cost gate
// to pass, never row/evidence deletion, never a >512-token chunk.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chunkAdaptive } from "../domain/chunking/adaptive-table-chunker.mjs";
import { tokenizeWithOffsets } from "../domain/chunking/chunker.mjs";
import { ADAPTIVE_POLICY_ID, TABLE_ROW_CHILD_MAX_TOKENS } from "../domain/chunking/adaptive-chunking-policy.mjs";
import { loadDocumentMetadataIndex, toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { corpusSourceFileStats, streamAllDocuments } from "../domain/agent-comparison/chunking-comparison/full-corpus-streamer.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.4-adaptive-table-chunking");
const MAIN_CHECKOUT_ROOT = "/Users/jaewan/Documents/Codex/2026-07-28/ai-ai-festival-agent-1-ai";
const RAW_SOURCE_DIR = path.join(MAIN_CHECKOUT_ROOT, "work/a-document-ir/source");
const DOCUMENTS_JSONL_PATH = path.join(MAIN_CHECKOUT_ROOT, "work/domain-seed/documents.jsonl");
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: process.env.P10_4_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) });
const ADAPTIVE_CONFIG = Object.freeze({ chunking_config_id: ADAPTIVE_POLICY_ID, strategy_name: "adaptive-table-aware", strategy_version: "0.1.0", max_tokens: 512, overlap_tokens: 64, table_row_child_max_tokens: TABLE_ROW_CHILD_MAX_TOKENS });
const TOP_N = 25;
const EXCESSIVE_ROW_THRESHOLD = 500; // informational bucket boundary, not a chunking gate

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}
function mean(values) { return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function topN(counterMap, n) {
  return [...counterMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

async function main() {
  console.error("[p10.4-cost-contributor] loading document metadata index (read-only)...");
  const metadataIndex = await loadDocumentMetadataIndex(DOCUMENTS_JSONL_PATH);
  const sourceFileStats = await corpusSourceFileStats(RAW_SOURCE_DIR);
  console.error(`[p10.4-cost-contributor] streaming ${sourceFileStats.length} source files, single pass (no determinism check needed -- diagnostic only, not gated)...`);

  const startedAt = Date.now();
  let documentsProcessed = 0;

  const perTableChildCounts = new Map(); // table_node_id -> retrieval-eligible table-aware child count
  const perDocChildCounts = new Map(); // document_id -> retrieval-eligible table-aware child count
  let totalRowsSeen = 0;
  let blankRows = 0; // every cell empty/whitespace-only
  let headerOrUnitOnlyRows = 0; // at most 1 non-empty cell (a label with no accompanying values)
  let excessiveRowTables = 0;
  let totalTables = 0;

  const contentShaCounts = new Map(); // content_sha256 -> occurrence count, retrieval-eligible table-aware children only
  let packedChunkCount = 0;
  const packedUtilization = []; // token_count / TABLE_ROW_CHILD_MAX_TOKENS, TABLE_ROW_WITH_HEADERS only
  let packedHeaderOverheadTokensTotal = 0; // sum of (table_title + section header lines' token cost) across packed chunks, estimated from the fixed per-chunk overhead lines actually present
  let packedRowLineTokensTotal = 0;

  for await (const { documentId, rawRecord } of streamAllDocuments(RAW_SOURCE_DIR)) {
    const metadataRecord = metadataIndex.byDocumentId.get(documentId);
    if (!metadataRecord) continue;
    const document = toChunkerDocument(metadataRecord);
    const chunks = chunkAdaptive(rawRecord, document, ADAPTIVE_CONFIG, PROVENANCE);
    documentsProcessed += 1;

    for (const chunk of chunks) {
      const isTableChild = chunk.chunk_type === "TABLE_ROW_WITH_HEADERS" || chunk.chunk_type === "TABLE_ROW_SEGMENT_WITH_HEADERS";
      if (isTableChild && chunk.metadata.retrieval_eligible) {
        const tableNodeId = chunk.metadata.table_node_id;
        perTableChildCounts.set(tableNodeId, (perTableChildCounts.get(tableNodeId) ?? 0) + 1);
        perDocChildCounts.set(documentId, (perDocChildCounts.get(documentId) ?? 0) + 1);
        contentShaCounts.set(chunk.content_sha256, (contentShaCounts.get(chunk.content_sha256) ?? 0) + 1);
      }
      if (chunk.chunk_type === "TABLE_ROW_WITH_HEADERS") {
        packedChunkCount += 1;
        packedUtilization.push(chunk.token_count / TABLE_ROW_CHILD_MAX_TOKENS);
        // composePackedRowsText() writes shared header lines (표제목/섹션/
        // 단위/열-기간) FIRST, then one "행: ..." (or bare value) line per
        // packed row -- the real per-chunk overhead is the ACTUAL token
        // count of just those header lines, tokenized with the SAME
        // tokenizer the chunker itself uses (never a proportional guess).
        const lines = chunk.raw_text.split("\n");
        const firstRowLineIndex = lines.findIndex((l) => l.startsWith("행: ") || !l.includes(":"));
        const headerLineCount = firstRowLineIndex > 0 ? firstRowLineIndex : 0;
        if (headerLineCount > 0) packedHeaderOverheadTokensTotal += tokenizeWithOffsets(lines.slice(0, headerLineCount).join("\n")).length;
        packedRowLineTokensTotal += chunk.token_count;
      }
    }

    for (const node of rawRecord.nodes ?? []) {
      if (node.kind !== "table") continue;
      totalTables += 1;
      const rows = node.normalized_rows ?? [];
      if (rows.length > EXCESSIVE_ROW_THRESHOLD) excessiveRowTables += 1;
      for (const row of rows) {
        totalRowsSeen += 1;
        const nonEmptyCellCount = row.filter((c) => String(c ?? "").trim().length > 0).length;
        if (nonEmptyCellCount === 0) blankRows += 1;
        else if (nonEmptyCellCount <= 1) headerOrUnitOnlyRows += 1;
      }
    }

    if (documentsProcessed % 1000 === 0) console.error(`[p10.4-cost-contributor]   ${documentsProcessed} documents processed`);
  }

  const totalRetrievalEligibleTableChunks = [...contentShaCounts.values()].reduce((a, b) => a + b, 0);
  const uniqueRetrievalEligibleTableChunks = contentShaCounts.size;
  const sortedUtil = [...packedUtilization].sort((a, b) => a - b);

  await mkdir(OUT_DIR, { recursive: true });
  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    note: "Gold-free, structural-only diagnostic. No question/answer/evidence_span text was ever read. Any correction applied on the basis of this report must be a genuine, corpus-wide structural fix -- never Gold-driven tuning, threshold relaxation, evidence deletion, locator-less dedup, a >512-token chunk, or a whole-table giant chunk.",
    documents_processed: documentsProcessed,
    tables_seen: totalTables,
    top_table_contributors_to_child_count: topN(perTableChildCounts, TOP_N),
    top_document_contributors_to_child_count: topN(perDocChildCounts, TOP_N),
    row_composition: {
      total_rows_seen: totalRowsSeen,
      blank_rows: blankRows,
      blank_row_ratio: totalRowsSeen > 0 ? blankRows / totalRowsSeen : null,
      header_or_unit_only_rows: headerOrUnitOnlyRows,
      header_or_unit_only_ratio: totalRowsSeen > 0 ? headerOrUnitOnlyRows / totalRowsSeen : null,
    },
    excessive_row_tables: { threshold_rows: EXCESSIVE_ROW_THRESHOLD, count: excessiveRowTables, ratio_of_all_tables: totalTables > 0 ? excessiveRowTables / totalTables : null },
    duplicate_boilerplate: {
      total_retrieval_eligible_table_chunks: totalRetrievalEligibleTableChunks,
      unique_retrieval_eligible_table_chunks: uniqueRetrievalEligibleTableChunks,
      exact_duplicate_ratio: totalRetrievalEligibleTableChunks > 0 ? 1 - uniqueRetrievalEligibleTableChunks / totalRetrievalEligibleTableChunks : null,
    },
    packed_chunk_token_budget_utilization: {
      packed_chunk_count: packedChunkCount,
      p50: percentile(sortedUtil, 0.5),
      p95: percentile(sortedUtil, 0.95),
      mean: mean(sortedUtil),
      interpretation: "utilization = token_count / TABLE_ROW_CHILD_MAX_TOKENS (512) for each TABLE_ROW_WITH_HEADERS chunk. A low p50/p95 here would indicate packRowsIntoChunks() is systematically under-filling the budget (a genuine bug worth fixing) rather than the cost ratio being inherent to finer per-row granularity.",
    },
    repeated_header_overhead_estimate: {
      packed_chunks_measured: packedChunkCount,
      estimated_header_overhead_tokens_total: packedHeaderOverheadTokensTotal,
      total_packed_chunk_tokens: packedRowLineTokensTotal,
      estimated_header_overhead_ratio: packedRowLineTokensTotal > 0 ? packedHeaderOverheadTokensTotal / packedRowLineTokensTotal : null,
    },
    build_time_ms: Date.now() - startedAt,
  };
  await writeFile(path.join(OUT_DIR, "adaptive-cost-contributor-report.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    status: "OK",
    documents_processed: documentsProcessed,
    packed_chunk_utilization_p50: report.packed_chunk_token_budget_utilization.p50,
    packed_chunk_utilization_p95: report.packed_chunk_token_budget_utilization.p95,
    exact_duplicate_ratio: report.duplicate_boilerplate.exact_duplicate_ratio,
    build_time_ms: report.build_time_ms,
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.4-cost-contributor] FAILED (fail-closed):", error.stack ?? error.message);
  process.exitCode = 1;
});
