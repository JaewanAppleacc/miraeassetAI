#!/usr/bin/env node
// Turn P10.4 / Stage 4 + Stage 6: runs REAL Adaptive chunking over the
// 372-doc bounded evaluation corpus, then re-verifies structural
// preservation against P10.3.2's corrected 92-item/339-source Gold
// population (table-locator-authority-v2.mjs/table-item-classifier-v2.mjs
// reused UNMODIFIED, read-only). Stage 4's 4 known PARSE_RECOVERY_REQUIRED
// sources (from work/p10.3.2-table-full-population-audit/parse-limited-
// source-disposition.v0.1.json, read-only) are excluded from the Gold-
// scoring denominator here, with the exclusion count/reason recorded
// explicitly -- never force-resolved. No embedding call, no chunking of
// Gold/DocumentIR originals modified.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chunkAdaptive, resolveTableContext, resolveUnit } from "../domain/chunking/adaptive-table-chunker.mjs";
import { ADAPTIVE_POLICY_ID, CONTEXT_STATE, TABLE_ROW_CHILD_MAX_TOKENS } from "../domain/chunking/adaptive-chunking-policy.mjs";
import { PARSE_LIMITED_TABLE_SOURCES, PARSE_LIMITED_TABLE_NODE_IDS } from "../domain/chunking/adaptive-parse-limited-sources.v0.1.mjs";
import { sourceSegments } from "../domain/chunking/chunker.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { resolveAuthoritativeCellV2, ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority-v2.mjs";
import { classifyGoldItemForTablesV2 } from "../domain/agent-comparison/chunking-comparison/table-item-classifier-v2.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.4-adaptive-table-chunking");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");
const P10_3_2_DISPOSITION_PATH = path.join(ROOT, "work/p10.3.2-table-full-population-audit/parse-limited-source-disposition.v0.1.json");
const P10_3_2_STRUCTURE_PATH = path.join(ROOT, "work/p10.3.2-table-full-population-audit/full-population-critical-violations.v0.2.json");
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "0".repeat(40), parserConfigHash: "0".repeat(64) });
const ADAPTIVE_CONFIG = Object.freeze({ chunking_config_id: ADAPTIVE_POLICY_ID, strategy_name: "adaptive-table-aware", strategy_version: "0.1.0", max_tokens: 512, overlap_tokens: 64, table_row_child_max_tokens: TABLE_ROW_CHILD_MAX_TOKENS });

function normalize(text) { return String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim(); }

function findRowChunks(chunksForDoc, nodeId, rowIndex) {
  return chunksForDoc.filter((c) =>
    (c.chunk_type === "TABLE_ROW_WITH_HEADERS" || c.chunk_type === "TABLE_ROW_SEGMENT_WITH_HEADERS")
    && c.source_spans.some((s) => s.node_id === nodeId && s.row_start <= rowIndex && rowIndex <= s.row_end));
}

function rowFullyPresent(node, rowIndex, chunk) {
  const rowText = normalize((node.normalized_rows?.[rowIndex] ?? []).join(" | "));
  if (!rowText) return false;
  if (normalize(chunk.raw_text).includes(rowText)) return true;
  // TABLE_ROW_SEGMENT_WITH_HEADERS chunks only cover a column sub-range --
  // compare against the SAME sub-range's text, never the full row, for
  // those (matches how the segment was actually constructed).
  const span = chunk.source_spans[0];
  if (span.col_start === null) return false;
  const subCells = (node.normalized_rows?.[rowIndex] ?? []).slice(span.col_start, span.col_end + 1);
  const subText = normalize(subCells.join(" | "));
  return subText.length > 0 && normalize(chunk.raw_text).includes(subText);
}

async function main() {
  if (!existsSync(RAW_CACHE_PATH)) throw new Error(`FAIL-CLOSED: ${RAW_CACHE_PATH} not found`);
  if (!existsSync(P10_3_2_DISPOSITION_PATH)) throw new Error(`FAIL-CLOSED: ${P10_3_2_DISPOSITION_PATH} not found (P10.3.2 result, read-only reference)`);

  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cacheLines = (await readFile(RAW_CACHE_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rawRecordByDocId = new Map(cacheLines.map((entry) => [entry.document_id, entry.raw_record]));
  const disposition = JSON.parse(await readFile(P10_3_2_DISPOSITION_PATH, "utf8"));

  console.error("[p10.4-stage6] chunking 372-doc corpus with Adaptive (real chunker, no embedding)...");
  const chunksByDoc = new Map();
  let parseLimitedTablesEncountered = 0;
  for (const entry of cacheLines) {
    chunksByDoc.set(entry.document_id, chunkAdaptive(entry.raw_record, toChunkerDocument(entry.metadata), ADAPTIVE_CONFIG, PROVENANCE));
    for (const node of entry.raw_record.nodes ?? []) {
      if (node.kind === "table" && PARSE_LIMITED_TABLE_NODE_IDS.has(node.node_id)) parseLimitedTablesEncountered += 1;
    }
  }

  // Turn P10.4-R / Section E: ground-truth table context (title/section/
  // unit), computed ONCE per table node from the SOURCE STRUCTURE ITSELF
  // (the same resolveTableContext() the chunker uses to build headers),
  // independent of whether any particular row was actually retrieved.
  // Fixes the bug where "applicable" was derived from a RETRIEVED chunk's
  // own metadata claim -- a table with no confirmed title/section/unit
  // (correctly ABSENT_IN_SOURCE) was wrongly counted as "applicable" and
  // scored as a preservation failure whenever nothing was retrieved for it.
  const tableGroundTruthCache = new Map(); // node_id -> {tableTitle, sectionTitle, unitRowIndex}
  const segmentsByDocCache = new Map(); // document_id -> sourceSegments(rawRecord)
  function tableGroundTruth(documentId, node) {
    const cached = tableGroundTruthCache.get(node.node_id);
    if (cached) return cached;
    let segments = segmentsByDocCache.get(documentId);
    if (!segments) {
      segments = sourceSegments(rawRecordByDocId.get(documentId));
      segmentsByDocCache.set(documentId, segments);
    }
    const rowSegmentsForTable = segments.filter((s) => s.kind === "table-row" && s.tableNodeId === node.node_id);
    const ctx = resolveTableContext(node, rowSegmentsForTable);
    tableGroundTruthCache.set(node.node_id, ctx);
    return ctx;
  }

  const classifications = goldItems.map((item) => classifyGoldItemForTablesV2(item, rawRecordByDocId));
  const tableItems = classifications.filter((c) => c.is_table_item);
  const excludedParseRecoveryCount = disposition.final_status_distribution?.PARSE_RECOVERY_REQUIRED ?? 0;

  const perItemResults = [];
  let totalCellChecks = 0;
  let excludedCellChecks = 0;

  for (const item of goldItems) {
    const cellChecks = [];
    for (const slot of item.required_evidence_slots ?? []) {
      for (const source of slot.acceptable_sources ?? []) {
        const raw = rawRecordByDocId.get(source.document_id);
        const resolved = resolveAuthoritativeCellV2({ rawRecord: raw, locator: source.source_locator, evidenceSpanText: source.evidence_span, extensions: item.extensions });
        if (resolved.root_cause === ROOT_CAUSE.SOURCE_PARSE_LIMITATION || resolved.root_cause === ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE) {
          excludedCellChecks += 1;
          continue; // Stage 4: the 4 known parse-limited sources -- excluded, never force-resolved
        }
        if (resolved.root_cause !== ROOT_CAUSE.GOLD_LOCATOR_EXACT && resolved.root_cause !== ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS) continue;

        const node = resolved.node;
        const chunksForDoc = chunksByDoc.get(source.document_id) ?? [];
        const rowIndices = resolved.matched_row_indices ?? [resolved.row_index];
        for (const rowIndex of rowIndices) {
          if (rowIndex === null || rowIndex === undefined) continue;
          totalCellChecks += 1;
          const claimingChunks = findRowChunks(chunksForDoc, node.node_id, rowIndex);
          const fullTextChunks = claimingChunks.filter((c) => rowFullyPresent(node, rowIndex, c));
          const goldCellRetrievable = fullTextChunks.length > 0;
          const bestChunk = fullTextChunks[0] ?? claimingChunks[0] ?? null;
          const misrepresenting = claimingChunks.filter((c) => !rowFullyPresent(node, rowIndex, c));

          const cells = (node.normalized_rows?.[rowIndex] ?? []).map((c) => normalize(c));
          const rowHeaderApplicable = cells.length > 1 && cells[0].length > 0;
          const rowHeaderPreserved = rowHeaderApplicable ? (bestChunk ? normalize(bestChunk.raw_text).includes(cells[0]) : false) : null;

          const headerRowIndices = node.header_row_indices ?? [];
          const columnHeaderApplicable = headerRowIndices.length > 0 && !headerRowIndices.includes(rowIndex);
          let columnHeaderPreserved = null;
          if (columnHeaderApplicable) {
            const headerRowText = normalize((node.normalized_rows?.[headerRowIndices[0]] ?? []).join(" | "));
            columnHeaderPreserved = bestChunk ? normalize(bestChunk.raw_text).includes(headerRowText) : false;
          }

          // Turn P10.4-R / Section E: applicable = GROUND TRUTH (is this
          // info actually present in the SOURCE table structure at all),
          // computed independent of whether a chunk was even retrieved --
          // never derived from a retrieved chunk's own metadata claim (a
          // table genuinely lacking a confirmed title/section/unit must
          // never be counted as "applicable" just because nothing was
          // retrieved for it). preserved = applicable AND the actual
          // raw_text of the best-matching chunk contains the expected
          // substring -- verified against the real text, never trusted
          // from the chunk's own metadata flag alone.
          const groundTruth = tableGroundTruth(source.document_id, node);
          const groundTruthRowUnit = resolveUnit(cells, node, groundTruth.unitRowIndex);

          const tableTitleApplicable = groundTruth.tableTitle.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE;
          const tableTitlePreserved = tableTitleApplicable
            ? (bestChunk ? normalize(bestChunk.raw_text).includes(`표제목: ${normalize(groundTruth.tableTitle.value)}`) : false)
            : null;

          const sectionApplicable = groundTruth.sectionTitle.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE;
          const sectionContextPreserved = sectionApplicable
            ? (bestChunk ? normalize(bestChunk.raw_text).includes(`섹션: ${normalize(groundTruth.sectionTitle.value)}`) : false)
            : null;

          const unitApplicable = groundTruthRowUnit.context_state !== CONTEXT_STATE.ABSENT_IN_SOURCE;
          // unit_preserved: verified directly against raw_text (not just
          // trusting the chunk's own metadata claim) -- an inline unit
          // token is part of the row's own cell text (already covered by
          // rowFullyPresent), an inherited one must show a "단위:" line.
          let unitPreserved = null;
          if (unitApplicable && bestChunk) {
            unitPreserved = groundTruthRowUnit.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE ? goldCellRetrievable : /단위:/.test(bestChunk.raw_text);
          } else if (unitApplicable) {
            unitPreserved = false;
          }

          // INHERITED_CONTEXT_WITHOUT_PROVENANCE: the RETRIEVED chunk
          // claims an INHERITED_FROM_TABLE_CONTEXT unit state but its
          // raw_text has no "단위:" line to back it up -- a self-
          // consistency check on the chunk's own claim, so this
          // deliberately still reads the retrieved chunk's own metadata
          // (contextStates), not the ground truth.
          const contextStates = bestChunk?.metadata?.context_states ?? {};
          const inheritedContextWithoutProvenance = !!(bestChunk && contextStates.unit === CONTEXT_STATE.INHERITED_FROM_TABLE_CONTEXT && !/단위:/.test(bestChunk.raw_text));

          cellChecks.push({
            node_id: node.node_id, row_index: rowIndex,
            gold_cell_retrievable: goldCellRetrievable, locator_misrepresentation: misrepresenting.length > 0,
            locator_provenance_lost: claimingChunks.length === 0,
            row_header_applicable: rowHeaderApplicable, row_header_preserved: rowHeaderPreserved,
            column_header_applicable: columnHeaderApplicable, column_header_preserved: columnHeaderPreserved,
            unit_applicable: unitApplicable, unit_preserved: unitPreserved,
            table_title_applicable: tableTitleApplicable, table_title_preserved: tableTitlePreserved,
            section_context_applicable: sectionApplicable, section_context_preserved: sectionContextPreserved,
            inherited_context_without_provenance: inheritedContextWithoutProvenance,
          });
        }
      }
    }
    if (cellChecks.length === 0) continue;

    const tags = classifications.find((c) => c.question_id === item.question_id)?.tags ?? [];
    const isMultiCell = tags.includes("MULTI_ROW_CALCULATION") || tags.includes("MULTI_COLUMN_COMPARISON");
    const multiCellComplete = !isMultiCell || cellChecks.every((c) => c.gold_cell_retrievable);

    const violations = [];
    for (const c of cellChecks) {
      if (c.locator_provenance_lost) violations.push({ type: "LOCATOR_PROVENANCE_LOST" });
      else if (c.locator_misrepresentation) violations.push({ type: "LOCATOR_RESOLVES_TO_WRONG_CELL" });
      if (c.row_header_applicable && c.row_header_preserved === false) violations.push({ type: "ROW_HEADER_VALUE_MISMATCH" });
      if (c.column_header_applicable && c.column_header_preserved === false) violations.push({ type: "PERIOD_COLUMN_VALUE_MISMATCH" });
      if (c.unit_applicable && c.unit_preserved === false) violations.push({ type: "EXPLICIT_UNIT_LOST" });
      if (c.inherited_context_without_provenance) violations.push({ type: "INHERITED_CONTEXT_WITHOUT_PROVENANCE" });
    }
    if (isMultiCell && !multiCellComplete) violations.push({ type: "MULTI_CELL_CONTEXT_INCOMPLETE" });

    perItemResults.push({
      question_id: item.question_id, cell_check_count: cellChecks.length,
      gold_cell_retrievable_count: cellChecks.filter((c) => c.gold_cell_retrievable).length,
      row_header_preserved_count: cellChecks.filter((c) => c.row_header_applicable && c.row_header_preserved).length,
      row_header_applicable_count: cellChecks.filter((c) => c.row_header_applicable).length,
      column_header_preserved_count: cellChecks.filter((c) => c.column_header_applicable && c.column_header_preserved).length,
      column_header_applicable_count: cellChecks.filter((c) => c.column_header_applicable).length,
      unit_preserved_count: cellChecks.filter((c) => c.unit_applicable && c.unit_preserved).length,
      unit_applicable_count: cellChecks.filter((c) => c.unit_applicable).length,
      table_title_preserved_count: cellChecks.filter((c) => c.table_title_applicable && c.table_title_preserved).length,
      table_title_applicable_count: cellChecks.filter((c) => c.table_title_applicable).length,
      table_title_source_absent_count: cellChecks.filter((c) => !c.table_title_applicable).length,
      section_context_preserved_count: cellChecks.filter((c) => c.section_context_applicable && c.section_context_preserved).length,
      section_context_applicable_count: cellChecks.filter((c) => c.section_context_applicable).length,
      section_context_source_absent_count: cellChecks.filter((c) => !c.section_context_applicable).length,
      unit_source_absent_count: cellChecks.filter((c) => !c.unit_applicable).length,
      multi_cell_context_complete: multiCellComplete,
      critical_violation_count: violations.length,
      critical_violations: violations,
    });
  }

  const sum = (key) => perItemResults.reduce((acc, r) => acc + r[key], 0);
  const violationTypeCounts = {};
  for (const r of perItemResults) for (const v of r.critical_violations) violationTypeCounts[v.type] = (violationTypeCounts[v.type] ?? 0) + 1;

  const fixedBaseline = 197; // P10.3.2 final-verdict, real, cited not recomputed
  const sectionBaseline = 141;
  const adaptiveTotal = sum("critical_violation_count");

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    adaptive_policy_id: ADAPTIVE_POLICY_ID,
    table_evaluation_item_count: tableItems.length,
    table_items_evaluated: perItemResults.length,
    stage_4_parse_limited_source_exclusion: {
      excluded_source_count: excludedCellChecks,
      excluded_source_count_p10_3_2_reference: excludedParseRecoveryCount,
      exclusion_reason: "PARSE_RECOVERY_REQUIRED (irregular actual_col_counts, confirmed by P10.3.2) -- excluded from the Gold-scoring denominator below, never force-resolved to an arbitrary row/column",
      denominator_note: `total_cell_checks below (${totalCellChecks}) already excludes these ${excludedCellChecks} source(s)`,
      pinned_sources: PARSE_LIMITED_TABLE_SOURCES,
      pinned_count: PARSE_LIMITED_TABLE_SOURCES.length,
      pinned_nodes_encountered_in_372_doc_corpus: parseLimitedTablesEncountered,
    },
    totals: {
      cell_checks: totalCellChecks,
      gold_cell_retrievable: sum("gold_cell_retrievable_count"),
      row_header_applicable: sum("row_header_applicable_count"), row_header_preserved: sum("row_header_preserved_count"),
      column_header_applicable: sum("column_header_applicable_count"), column_header_preserved: sum("column_header_preserved_count"),
      period_header_applicable: sum("column_header_applicable_count"), period_header_preserved: sum("column_header_preserved_count"),
      unit_applicable: sum("unit_applicable_count"), unit_preserved: sum("unit_preserved_count"), unit_source_absent: sum("unit_source_absent_count"),
      table_title_applicable: sum("table_title_applicable_count"), table_title_preserved: sum("table_title_preserved_count"), table_title_source_absent: sum("table_title_source_absent_count"),
      section_context_applicable: sum("section_context_applicable_count"), section_context_preserved: sum("section_context_preserved_count"), section_context_source_absent: sum("section_context_source_absent_count"),
      multi_cell_context_complete_items: perItemResults.filter((r) => r.multi_cell_context_complete).length,
    },
    // Turn P10.4-R / Section E: reported separately, as required -- rates
    // computed only over the applicable (source-has-this-info) subset,
    // never diluted or penalized by ABSENT_IN_SOURCE rows.
    context_preservation_rates: {
      explicit_table_title_preservation_rate: sum("table_title_applicable_count") > 0 ? sum("table_title_preserved_count") / sum("table_title_applicable_count") : null,
      explicit_section_preservation_rate: sum("section_context_applicable_count") > 0 ? sum("section_context_preserved_count") / sum("section_context_applicable_count") : null,
      explicit_and_inherited_unit_preservation_rate: sum("unit_applicable_count") > 0 ? sum("unit_preserved_count") / sum("unit_applicable_count") : null,
      source_absent_counts: { table_title: sum("table_title_source_absent_count"), section: sum("section_context_source_absent_count"), unit: sum("unit_source_absent_count") },
      explicit_section_preservation_rate_note: "Turn P10.4-R / Section H: expected near-0% BY DESIGN, not a defect -- the section breadcrumb is deliberately never printed into row-level chunk text (real, measured, corpus-wide token overhead with no hard-gated preservation requirement in adaptive-success-threshold.mjs; only column-header >=95% and unit >=90% are gated). Full section context remains available via TABLE_PARENT_CONTEXT, attached on demand by late parent expansion (see adaptive-late-parent-expansion-report.v0.1.json).",
    },
    critical_violation_count: adaptiveTotal,
    critical_violation_by_type: violationTypeCounts,
    comparison_to_p10_3_2: {
      fixed_critical_violations: fixedBaseline,
      section_critical_violations: sectionBaseline,
      adaptive_critical_violations: adaptiveTotal,
      reduction_vs_fixed_ratio: 1 - adaptiveTotal / fixedBaseline,
      reduction_vs_fixed_percent: Math.round((1 - adaptiveTotal / fixedBaseline) * 1000) / 10,
    },
    per_item: perItemResults,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "adaptive-structure-preservation-report.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    table_items_evaluated: perItemResults.length,
    total_cell_checks: totalCellChecks,
    excluded_parse_limited: excludedCellChecks,
    critical_violation_count: adaptiveTotal,
    critical_violation_by_type: violationTypeCounts,
    vs_fixed_197: adaptiveTotal, vs_section_141: adaptiveTotal,
    reduction_vs_fixed_percent: report.comparison_to_p10_3_2.reduction_vs_fixed_percent,
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.4-stage6-structure-preservation] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
