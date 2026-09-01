#!/usr/bin/env node
// Turn P10.3-TABLE / Stage 2: real chunk structural preservation check.
// Runs the REAL, unmodified domain/chunking/chunker.mjs (Fixed-512+o64 and
// Section-Aware-Flat, both reused verbatim from P10_STRATEGIES) over the
// 372-document bounded evaluation corpus -- deterministic, zero embedding
// calls, zero model server spawned -- then cross-references every
// TABLE_EVALUATION_ITEM's resolved Gold cell (from Stage 1) against the
// REAL chunks each strategy actually produced, verifying literal text
// containment (never trusting a span's claim on its own).
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { findNodeById, resolveTableCell, findUnitDeclaringRows } from "../domain/agent-comparison/chunking-comparison/table-evidence-resolver.mjs";
import { classifyGoldItemForTables } from "../domain/agent-comparison/chunking-comparison/table-item-classifier.mjs";
import {
  evaluateCellPreservation,
  evaluateUnitPreservation,
  evaluateAmbiguousNumericCollision,
} from "../domain/agent-comparison/chunking-comparison/table-structure-preservation.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3-table-diagnostic");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "0".repeat(40), parserConfigHash: "0".repeat(64) });

const NON_HIERARCHICAL_STRATEGIES = P10_STRATEGIES.filter((s) => s.strategy_name !== "document-type-hierarchical-parent-child");
if (NON_HIERARCHICAL_STRATEGIES.length !== 2) throw new Error("FAIL-CLOSED: expected exactly 2 non-hierarchical strategies");

function chunkAllDocuments(strategyConfig, rawCache) {
  const byDocumentId = new Map();
  for (const entry of rawCache) {
    const chunks = chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), strategyConfig, PROVENANCE);
    byDocumentId.set(entry.document_id, chunks);
  }
  return byDocumentId;
}

async function main() {
  if (!existsSync(RAW_CACHE_PATH)) {
    throw new Error(`FAIL-CLOSED: ${RAW_CACHE_PATH} not found -- run scripts/p10.1-build-evaluation-corpus.mjs first`);
  }
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cacheLines = (await readFile(RAW_CACHE_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rawRecordByDocId = new Map(cacheLines.map((entry) => [entry.document_id, entry.raw_record]));

  const classifications = goldItems.map((item) => classifyGoldItemForTables(item, rawRecordByDocId));
  const tableItems = classifications.filter((c) => c.is_table_item);

  const perStrategyReports = [];
  for (const strategyConfig of NON_HIERARCHICAL_STRATEGIES) {
    console.error(`[p10.3-stage2] chunking 372-doc corpus with ${strategyConfig.chunking_config_id} (real chunker.mjs, no embedding)...`);
    const chunksByDoc = chunkAllDocuments(strategyConfig, cacheLines);

    const perItemResults = [];
    for (const item of goldItems) {
      const classification = classifications.find((c) => c.question_id === item.question_id);
      if (!classification.is_table_item) continue;

      const cellChecks = [];
      for (const slot of item.required_evidence_slots ?? []) {
        for (const source of slot.acceptable_sources ?? []) {
          const rawRecord = rawRecordByDocId.get(source.document_id);
          if (!rawRecord) continue;
          const node = findNodeById(rawRecord, source.source_locator);
          if (!node || node.kind !== "table") continue;
          const resolved = resolveTableCell(node, source.evidence_span);
          if (!resolved.matched) continue;
          const chunks = chunksByDoc.get(source.document_id) ?? [];
          const unitRows = findUnitDeclaringRows(node);

          for (const rowIndex of resolved.matched_row_indices) {
            const preservation = evaluateCellPreservation({ node, nodeId: source.source_locator, rowIndex, chunks });
            const unit = evaluateUnitPreservation({ node, nodeId: source.source_locator, rowIndex, unitDeclaringRowIndices: unitRows, chunks });
            const collision = evaluateAmbiguousNumericCollision({ node, rowIndex, colIndices: resolved.col_indices });
            cellChecks.push({ ...preservation, ...unit, ambiguous_numeric_collision_applicable: collision.applicable, ambiguous_numeric_collision: collision.collision });
          }
        }
      }
      if (cellChecks.length === 0) continue;

      const criticalViolations = [];
      for (const c of cellChecks) {
        if (!c.gold_cell_retrievable) criticalViolations.push({ type: "GOLD_CELLS_NOT_RECOVERABLE", node_id: c.node_id, row_index: c.row_index });
        if (c.row_header_applicable && c.row_header_preserved === false) criticalViolations.push({ type: "ROW_HEADER_VALUE_MISMATCH", node_id: c.node_id, row_index: c.row_index });
        if (c.column_header_applicable && c.column_header_preserved === false) criticalViolations.push({ type: "PERIOD_COLUMN_VALUE_MISMATCH", node_id: c.node_id, row_index: c.row_index });
        if (c.unit_applicable && c.unit_preserved === false) criticalViolations.push({ type: "UNIT_MISSING_OR_MISCOMBINED", node_id: c.node_id, row_index: c.row_index });
        if (c.locator_misrepresentation) criticalViolations.push({ type: "LOCATOR_RESOLVES_TO_WRONG_CELL", node_id: c.node_id, row_index: c.row_index });
      }

      perItemResults.push({
        question_id: item.question_id,
        cell_check_count: cellChecks.length,
        gold_cell_retrievable_count: cellChecks.filter((c) => c.gold_cell_retrievable).length,
        row_header_preserved_count: cellChecks.filter((c) => c.row_header_applicable && c.row_header_preserved).length,
        row_header_applicable_count: cellChecks.filter((c) => c.row_header_applicable).length,
        column_header_preserved_count: cellChecks.filter((c) => c.column_header_applicable && c.column_header_preserved).length,
        column_header_applicable_count: cellChecks.filter((c) => c.column_header_applicable).length,
        unit_preserved_count: cellChecks.filter((c) => c.unit_applicable && c.unit_preserved).length,
        unit_applicable_count: cellChecks.filter((c) => c.unit_applicable).length,
        table_title_preserved_count: cellChecks.filter((c) => c.table_title_preserved === true).length,
        table_title_applicable_count: cellChecks.filter((c) => c.table_title_preserved !== null).length,
        boundary_fracture_count: cellChecks.filter((c) => c.boundary_fracture).length,
        locator_misrepresentation_count: cellChecks.filter((c) => c.locator_misrepresentation).length,
        ambiguous_numeric_collision_count: cellChecks.filter((c) => c.ambiguous_numeric_collision).length,
        ambiguous_numeric_collision_applicable_count: cellChecks.filter((c) => c.ambiguous_numeric_collision_applicable).length,
        multi_cell_colocation: cellChecks.every((c) => c.gold_cell_retrievable),
        critical_violation_count: criticalViolations.length,
        critical_violations: criticalViolations,
      });
    }

    const sum = (key) => perItemResults.reduce((acc, r) => acc + r[key], 0);
    perStrategyReports.push({
      chunking_config_id: strategyConfig.chunking_config_id,
      table_items_evaluated: perItemResults.length,
      totals: {
        cell_checks: sum("cell_check_count"),
        gold_cell_retrievable: sum("gold_cell_retrievable_count"),
        row_header_applicable: sum("row_header_applicable_count"),
        row_header_preserved: sum("row_header_preserved_count"),
        column_header_applicable: sum("column_header_applicable_count"),
        column_header_preserved: sum("column_header_preserved_count"),
        unit_applicable: sum("unit_applicable_count"),
        unit_preserved: sum("unit_preserved_count"),
        table_title_applicable: sum("table_title_applicable_count"),
        table_title_preserved: sum("table_title_preserved_count"),
        boundary_fracture: sum("boundary_fracture_count"),
        locator_misrepresentation: sum("locator_misrepresentation_count"),
        ambiguous_numeric_collision_applicable: sum("ambiguous_numeric_collision_applicable_count"),
        ambiguous_numeric_collision: sum("ambiguous_numeric_collision_count"),
        multi_cell_colocation_items_ok: perItemResults.filter((r) => r.multi_cell_colocation).length,
      },
      critical_violation_count: sum("critical_violation_count"),
      per_item: perItemResults,
    });
    console.error(`[p10.3-stage2] ${strategyConfig.chunking_config_id}: ${perItemResults.length} table items, ${sum("critical_violation_count")} critical violations`);
  }

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    table_evaluation_item_count: tableItems.length,
    strategies: perStrategyReports,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "table-structure-preservation-report.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    table_evaluation_item_count: tableItems.length,
    strategies: perStrategyReports.map((r) => ({ chunking_config_id: r.chunking_config_id, critical_violation_count: r.critical_violation_count, gold_cell_retrievable: `${r.totals.gold_cell_retrievable}/${r.totals.cell_checks}` })),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3-stage2-structure-preservation] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
