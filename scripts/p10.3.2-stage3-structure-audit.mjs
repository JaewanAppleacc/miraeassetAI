#!/usr/bin/env node
// Turn P10.3.2 / Stage 3: real chunking (Fixed-512+o64, Section-Aware-
// Flat -- unmodified domain/chunking/chunker.mjs, same as P10.3) over the
// 372-doc bounded evaluation corpus, cross-referenced against the FULL
// corrected 92-item/339-source table population (Stage 1-2's output), not
// just the 75-source subset P10.3 originally examined. Zero embedding
// calls, zero model server spawned.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { resolveAuthoritativeCellV2, ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority-v2.mjs";
import {
  findChunksClaimingRow, rowFullyPresentInChunk, evaluateCellPreservation, evaluateUnitPreservation, evaluateAmbiguousNumericCollision,
} from "../domain/agent-comparison/chunking-comparison/table-structure-preservation.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.2-table-full-population-audit");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "0".repeat(40), parserConfigHash: "0".repeat(64) });
const UNIT_DECLARATION_PATTERN = /\(?\s*단위\s*[:：]/;
const UNIT_TOKEN_PATTERN = /(?:원|천원|백만원|억원|%|퍼센트|주|천주|만주|배|포인트|bp)/;

const NON_HIERARCHICAL_STRATEGIES = P10_STRATEGIES.filter((s) => s.strategy_name !== "document-type-hierarchical-parent-child");
if (NON_HIERARCHICAL_STRATEGIES.length !== 2) throw new Error("FAIL-CLOSED: expected exactly 2 non-hierarchical strategies");

function findUnitDeclaringRows(node) {
  const rows = node?.normalized_rows ?? [];
  const declaring = [];
  for (const [rowIndex, row] of rows.entries()) {
    const joined = String(row.join(" | ")).normalize("NFKC").replace(/\s+/g, " ").trim();
    if (UNIT_DECLARATION_PATTERN.test(joined) && UNIT_TOKEN_PATTERN.test(joined)) declaring.push(rowIndex);
  }
  return declaring;
}

function chunkAllDocuments(strategyConfig, rawCache) {
  const byDocumentId = new Map();
  for (const entry of rawCache) {
    byDocumentId.set(entry.document_id, chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), strategyConfig, PROVENANCE));
  }
  return byDocumentId;
}

async function main() {
  if (!existsSync(RAW_CACHE_PATH)) throw new Error(`FAIL-CLOSED: ${RAW_CACHE_PATH} not found`);
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cacheLines = (await readFile(RAW_CACHE_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rawRecordByDocId = new Map(cacheLines.map((entry) => [entry.document_id, entry.raw_record]));

  const strategyReports = [];
  for (const strategyConfig of NON_HIERARCHICAL_STRATEGIES) {
    console.error(`[p10.3.2-stage3] chunking 372-doc corpus with ${strategyConfig.chunking_config_id} (real chunker.mjs, no embedding)...`);
    const chunksByDoc = chunkAllDocuments(strategyConfig, cacheLines);

    const perItemResults = [];
    for (const item of goldItems) {
      const cellChecks = [];
      const rowsByItemForMultiCell = [];
      for (const slot of item.required_evidence_slots ?? []) {
        for (const source of slot.acceptable_sources ?? []) {
          const raw = rawRecordByDocId.get(source.document_id);
          const resolved = resolveAuthoritativeCellV2({ rawRecord: raw, locator: source.source_locator, evidenceSpanText: source.evidence_span, extensions: item.extensions });
          if (resolved.root_cause !== ROOT_CAUSE.GOLD_LOCATOR_EXACT && resolved.root_cause !== ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS) continue;
          const node = resolved.node;
          const nodeId = node.node_id ?? `${source.document_id}::${node.source?.rel_path}::orderIndex${node.source?.order_index}`;
          const chunks = chunksByDoc.get(source.document_id) ?? [];
          const unitRows = findUnitDeclaringRows(node);
          const rowIndices = resolved.matched_row_indices ?? [resolved.row_index];

          for (const rowIndex of rowIndices) {
            if (rowIndex === null || rowIndex === undefined) continue;
            const claimingChunks = findChunksClaimingRow(chunks, nodeId, rowIndex);
            const preservation = evaluateCellPreservation({ node, nodeId, rowIndex, chunks });
            const unit = evaluateUnitPreservation({ node, nodeId, rowIndex, unitDeclaringRowIndices: unitRows, chunks });
            const collision = evaluateAmbiguousNumericCollision({ node, rowIndex, colIndices: resolved.col_indices });
            const locatorProvenanceLost = claimingChunks.length === 0;
            cellChecks.push({
              ...preservation, ...unit,
              ambiguous_numeric_collision_applicable: collision.applicable, ambiguous_numeric_collision: collision.collision,
              locator_provenance_lost: locatorProvenanceLost,
              gold_locator_ambiguous: resolved.root_cause === ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS,
            });
            rowsByItemForMultiCell.push(preservation.gold_cell_retrievable && !locatorProvenanceLost);
          }
        }
      }
      if (cellChecks.length === 0) continue;

      const multiCellContextIncomplete = rowsByItemForMultiCell.length >= 2 && rowsByItemForMultiCell.some((ok) => !ok);

      const criticalViolations = [];
      for (const c of cellChecks) {
        const attribution = c.gold_locator_ambiguous ? "GOLD_LOCATOR_AMBIGUOUS" : "CHUNKING_ATTRIBUTABLE";
        // LOCATOR_RESOLVES_TO_WRONG_CELL matches P10.3's ORIGINAL definition
        // exactly (locator_misrepresentation: ANY chunk that claims this
        // row's coverage but whose raw_text does not actually contain it
        // -- even if a DIFFERENT claiming chunk does, making the cell
        // still retrievable overall). Kept identical to P10.3 rather than
        // narrowed to "!gold_cell_retrievable" so the corrected numbers
        // are methodologically comparable, not just superficially
        // relabeled. LOCATOR_PROVENANCE_LOST is the new, stronger,
        // mutually-exclusive case: NO chunk claims this row at all.
        if (c.locator_provenance_lost) criticalViolations.push({ type: "LOCATOR_PROVENANCE_LOST", attribution });
        else if (c.locator_misrepresentation) criticalViolations.push({ type: "LOCATOR_RESOLVES_TO_WRONG_CELL", attribution });
        if (c.row_header_applicable && c.row_header_preserved === false) criticalViolations.push({ type: "ROW_HEADER_VALUE_MISMATCH", attribution });
        if (c.column_header_applicable && c.column_header_preserved === false) criticalViolations.push({ type: "PERIOD_COLUMN_VALUE_MISMATCH", attribution });
        if (c.unit_applicable && c.unit_preserved === false) criticalViolations.push({ type: "UNIT_MISSING_OR_MISCOMBINED", attribution });
      }
      if (multiCellContextIncomplete) criticalViolations.push({ type: "MULTI_CELL_CONTEXT_INCOMPLETE", attribution: "CHUNKING_ATTRIBUTABLE" });

      perItemResults.push({
        question_id: item.question_id,
        cell_check_count: cellChecks.length,
        gold_cell_retrievable_count: cellChecks.filter((c) => c.gold_cell_retrievable).length,
        row_header_preserved_count: cellChecks.filter((c) => c.row_header_applicable && c.row_header_preserved).length,
        row_header_applicable_count: cellChecks.filter((c) => c.row_header_applicable).length,
        column_header_preserved_count: cellChecks.filter((c) => c.column_header_applicable && c.column_header_preserved).length,
        column_header_applicable_count: cellChecks.filter((c) => c.column_header_applicable).length,
        period_header_preserved_count: cellChecks.filter((c) => c.column_header_applicable && c.column_header_preserved).length,
        period_header_applicable_count: cellChecks.filter((c) => c.column_header_applicable).length,
        unit_preserved_count: cellChecks.filter((c) => c.unit_applicable && c.unit_preserved).length,
        unit_applicable_count: cellChecks.filter((c) => c.unit_applicable).length,
        table_title_preserved_count: cellChecks.filter((c) => c.table_title_preserved === true).length,
        table_title_applicable_count: cellChecks.filter((c) => c.table_title_preserved !== null).length,
        section_context_preserved_count: cellChecks.filter((c) => c.table_title_preserved === true).length,
        section_context_applicable_count: cellChecks.filter((c) => c.table_title_preserved !== null).length,
        locator_provenance_lost_count: cellChecks.filter((c) => c.locator_provenance_lost).length,
        locator_misrepresentation_count: cellChecks.filter((c) => c.locator_misrepresentation).length,
        ambiguous_numeric_collision_count: cellChecks.filter((c) => c.ambiguous_numeric_collision).length,
        ambiguous_numeric_collision_applicable_count: cellChecks.filter((c) => c.ambiguous_numeric_collision_applicable).length,
        multi_cell_context_incomplete: multiCellContextIncomplete,
        critical_violation_count: criticalViolations.length,
        critical_violations: criticalViolations,
      });
    }

    const sum = (key) => perItemResults.reduce((acc, r) => acc + r[key], 0);
    strategyReports.push({
      chunking_config_id: strategyConfig.chunking_config_id,
      table_items_evaluated: perItemResults.length,
      totals: {
        cell_checks: sum("cell_check_count"),
        gold_cell_retrievable: sum("gold_cell_retrievable_count"),
        row_header_applicable: sum("row_header_applicable_count"), row_header_preserved: sum("row_header_preserved_count"),
        column_header_applicable: sum("column_header_applicable_count"), column_header_preserved: sum("column_header_preserved_count"),
        period_header_applicable: sum("period_header_applicable_count"), period_header_preserved: sum("period_header_preserved_count"),
        unit_applicable: sum("unit_applicable_count"), unit_preserved: sum("unit_preserved_count"),
        table_title_applicable: sum("table_title_applicable_count"), table_title_preserved: sum("table_title_preserved_count"),
        section_context_applicable: sum("section_context_applicable_count"), section_context_preserved: sum("section_context_preserved_count"),
        locator_provenance_lost: sum("locator_provenance_lost_count"),
        locator_misrepresentation: sum("locator_misrepresentation_count"),
        ambiguous_numeric_collision_applicable: sum("ambiguous_numeric_collision_applicable_count"), ambiguous_numeric_collision: sum("ambiguous_numeric_collision_count"),
        multi_cell_context_incomplete_items: perItemResults.filter((r) => r.multi_cell_context_incomplete).length,
      },
      critical_violation_count: sum("critical_violation_count"),
      per_item: perItemResults,
    });
    console.error(`[p10.3.2-stage3] ${strategyConfig.chunking_config_id}: ${perItemResults.length} table items, ${sum("critical_violation_count")} critical violations`);
  }

  const report = {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    note: "period_header and column_header, and table_title and section_context, are reported as the SAME underlying measured signal for this chunker/corpus: node.period_text/unit_text are never populated by the parser (verified empirically), and Fixed/Section-Flat chunks never attach a separate table_metadata.caption field (only chunker.mjs's Hierarchical strategy does) -- both pairs collapse to the same code-computed check (header_row_indices co-location; chunk.section_path non-empty) and are disclosed as identical rather than fabricating an artificial distinction.",
    strategies: strategyReports,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "full-population-table-structure-report.v0.2.json"), `${JSON.stringify(report, null, 2)}\n`);

  // Focused violation/attribution summary, distinct from the full
  // structure report above (which carries every per-item structural
  // measurement) -- this file answers "how many violations, of which
  // type, attributed to what cause" without the surrounding detail.
  const VIOLATION_TYPES = ["LOCATOR_RESOLVES_TO_WRONG_CELL", "ROW_HEADER_VALUE_MISMATCH", "PERIOD_COLUMN_VALUE_MISMATCH", "UNIT_MISSING_OR_MISCOMBINED", "MULTI_CELL_CONTEXT_INCOMPLETE", "LOCATOR_PROVENANCE_LOST"];
  const ATTRIBUTIONS = ["CHUNKING_ATTRIBUTABLE", "SOURCE_PARSE_LIMITATION", "GOLD_LOCATOR_AMBIGUOUS", "LOCATOR_PROVENANCE_CONFLICT", "RESOLVER_IMPLEMENTATION_BUG", "NOT_A_VIOLATION"];
  const violationSummary = { schema_version: "0.2.0", generated_at: new Date().toISOString(), strategies: {} };
  for (const s of strategyReports) {
    const byType = Object.fromEntries(VIOLATION_TYPES.map((t) => [t, 0]));
    const byAttribution = Object.fromEntries(ATTRIBUTIONS.map((a) => [a, 0]));
    for (const item of s.per_item) {
      for (const v of item.critical_violations) {
        byType[v.type] = (byType[v.type] ?? 0) + 1;
        byAttribution[v.attribution] = (byAttribution[v.attribution] ?? 0) + 1;
      }
    }
    violationSummary.strategies[s.chunking_config_id] = {
      total_critical_violations: s.critical_violation_count,
      by_type: byType,
      by_attribution: byAttribution,
      chunking_attributable_total: byAttribution.CHUNKING_ATTRIBUTABLE,
    };
  }
  await writeFile(path.join(OUT_DIR, "full-population-critical-violations.v0.2.json"), `${JSON.stringify(violationSummary, null, 2)}\n`);

  console.log(JSON.stringify({
    strategies: strategyReports.map((r) => ({ chunking_config_id: r.chunking_config_id, table_items_evaluated: r.table_items_evaluated, critical_violation_count: r.critical_violation_count, gold_cell_retrievable: `${r.totals.gold_cell_retrievable}/${r.totals.cell_checks}` })),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.2-stage3-structure-audit] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
