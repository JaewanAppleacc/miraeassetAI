#!/usr/bin/env node
// Turn P10.3-TABLE / Stage 1: mechanical TABLE_EVALUATION_ITEM
// classification over the real DEV_TUNE-101 Gold set, resolved against the
// real parsed DocumentIR (via P10.1's .raw-corpus-cache.v0.1.jsonl, rebuilt
// fresh by this Turn's start-condition step). Writes ONLY aggregate counts
// and per-item structural tags -- question_id is an opaque identifier
// already used throughout P10.1/P10.1.1/P10.2's own committed outputs, but
// question/answer/evidence_span TEXT is never read into any written field.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { classifyGoldItemForTables, TABLE_ITEM_TAGS } from "../domain/agent-comparison/chunking-comparison/table-item-classifier.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3-table-diagnostic");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");

async function main() {
  if (!existsSync(RAW_CACHE_PATH)) {
    throw new Error(`FAIL-CLOSED: ${RAW_CACHE_PATH} not found -- run scripts/p10.1-build-evaluation-corpus.mjs first (reused unmodified, no new embedding)`);
  }
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cacheLines = (await readFile(RAW_CACHE_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rawRecordByDocId = new Map(cacheLines.map((entry) => [entry.document_id, entry.raw_record]));

  const perItem = goldItems.map((item) => classifyGoldItemForTables(item, rawRecordByDocId));

  const tableItems = perItem.filter((r) => r.is_table_item);
  const nonTableItems = perItem.filter((r) => !r.is_table_item);
  const tagDistribution = Object.fromEntries(TABLE_ITEM_TAGS.map((tag) => [tag, tableItems.filter((r) => r.tags.includes(tag)).length]));

  const totalTableSources = perItem.reduce((sum, r) => sum + r.table_source_count, 0);
  const totalUnresolvableSources = perItem.reduce((sum, r) => sum + r.unresolvable_source_count, 0);
  const totalUnresolvableTableCells = perItem.reduce((sum, r) => sum + r.unresolvable_table_cell_count, 0);

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    dev_tune_item_count: goldItems.length,
    table_evaluation_item_count: tableItems.length,
    non_table_evaluation_item_count: nonTableItems.length,
    tag_distribution: tagDistribution,
    total_table_kind_sources: totalTableSources,
    total_unresolvable_sources_all_kinds: totalUnresolvableSources,
    total_unresolvable_table_cells: totalUnresolvableTableCells,
    // Structural-only per-item records: question_id (opaque id, already
    // used throughout P10.1/P10.1.1/P10.2's own committed outputs),
    // is_table_item, tags, and resolution counts. NO question/answer/
    // evidence_span text.
    per_item: perItem.map((r) => ({
      question_id: r.question_id,
      question_type: r.question_type,
      is_table_item: r.is_table_item,
      tags: r.tags,
      table_source_count: r.table_source_count,
      unresolvable_table_cell_count: r.unresolvable_table_cell_count,
      distinct_rows_touched: r.distinct_rows_touched ?? 0,
      distinct_cells_touched: r.distinct_cells_touched ?? 0,
      distinct_table_nodes_touched: r.distinct_table_nodes_touched ?? 0,
      distinct_documents_touched: r.distinct_documents_touched ?? 0,
    })),
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "table-item-inventory.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    dev_tune_item_count: goldItems.length,
    table_evaluation_item_count: tableItems.length,
    non_table_evaluation_item_count: nonTableItems.length,
    tag_distribution: tagDistribution,
    total_unresolvable_table_cells: totalUnresolvableTableCells,
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3-stage1-table-item-classification] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
