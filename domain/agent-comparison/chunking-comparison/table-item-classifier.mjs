// Turn P10.3-TABLE / Stage 1: mechanical TABLE_EVALUATION_ITEM
// classification. Never reads item.question or item.expected_answer --
// only structural fields (required_evidence_slots' document_id/
// source_locator/evidence_span) and the real DocumentIR node each locator
// resolves to (node.kind, node.normalized_rows, node.header_row_indices).
import { findNodeById, resolveTableCell, findUnitDeclaringRows } from "./table-evidence-resolver.mjs";

export const TABLE_ITEM_TAGS = Object.freeze([
  "SINGLE_CELL_LOOKUP",
  "ROW_HEADER_VALUE",
  "COLUMN_PERIOD_VALUE",
  "UNIT_SENSITIVE",
  "MULTI_ROW_CALCULATION",
  "MULTI_COLUMN_COMPARISON",
  "CROSS_TABLE",
  "CROSS_DOCUMENT_TABLE",
  "TABLE_WITH_REPEATED_BOILERPLATE",
]);

const BOILERPLATE_DUPLICATE_ROW_RATIO_THRESHOLD = 0.15;

function normalizeForDup(text) {
  return String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

// Mechanical, structural proxy for "table rows dominated by repeated
// boilerplate" -- the fraction of rows whose joined cell text exactly
// duplicates another row's. This does not reproduce chunker.mjs's private
// isAuxiliaryTableText regex (not exported); it is an independent,
// code-grounded signal over the same normalized_rows grid.
export function tableBoilerplateDuplicateRowRatio(node) {
  const rows = node?.normalized_rows ?? [];
  if (rows.length === 0) return 0;
  const joined = rows.map((row) => normalizeForDup(row.join(" | "))).filter((text) => text.length > 0);
  if (joined.length === 0) return 0;
  const counts = new Map();
  for (const text of joined) counts.set(text, (counts.get(text) ?? 0) + 1);
  const duplicateCount = joined.filter((text) => counts.get(text) > 1).length;
  return duplicateCount / rows.length;
}

// Resolves ONE acceptable_source against the real DocumentIR. Returns a
// structural-only record (document_id/node_id/row/col indices/flags) --
// never the evidence_span text itself, never question/answer text.
function resolveSource(documentId, sourceLocator, evidenceSpanText, rawRecordByDocId) {
  const rawRecord = rawRecordByDocId.get(documentId);
  if (!rawRecord) {
    return { document_id: documentId, node_id: sourceLocator, node_found: false, is_table: false };
  }
  const node = findNodeById(rawRecord, sourceLocator);
  if (!node) {
    return { document_id: documentId, node_id: sourceLocator, node_found: false, is_table: false };
  }
  if (node.kind !== "table") {
    return { document_id: documentId, node_id: sourceLocator, node_found: true, is_table: false, node_kind: node.kind };
  }
  const resolved = resolveTableCell(node, evidenceSpanText);
  return {
    document_id: documentId,
    node_id: sourceLocator,
    node_found: true,
    is_table: true,
    cell_resolved: resolved.matched,
    ambiguous: resolved.ambiguous,
    is_multi_row_span: resolved.is_multi_row_span,
    matched_row_indices: resolved.matched_row_indices,
    primary_row_index: resolved.primary_row_index,
    col_indices: resolved.col_indices,
    precise_col_indices: resolved.precise_col_indices,
    col_resolution: resolved.col_resolution,
    header_row_indices: resolved.header_row_indices,
    n_rows: resolved.n_rows,
    n_cols: resolved.n_cols,
    has_unit_declaring_row: findUnitDeclaringRows(node).length > 0,
    boilerplate_duplicate_row_ratio: tableBoilerplateDuplicateRowRatio(node),
  };
}

// Classifies ONE Gold item. `rawRecordByDocId` is a Map(document_id ->
// raw parsed DocumentIR record), e.g. built from the P10.1 evaluation
// corpus's .raw-corpus-cache.v0.1.jsonl.
export function classifyGoldItemForTables(item, rawRecordByDocId) {
  const sourceResolutions = [];
  for (const slot of item.required_evidence_slots ?? []) {
    for (const source of slot.acceptable_sources ?? []) {
      sourceResolutions.push({
        slot_name: slot.slot_name,
        ...resolveSource(source.document_id, source.source_locator, source.evidence_span, rawRecordByDocId),
      });
    }
  }

  const tableResolutions = sourceResolutions.filter((r) => r.is_table);
  const isTableItem = tableResolutions.length > 0;

  const result = {
    question_id: item.question_id,
    question_type: item.question_type,
    is_table_item: isTableItem,
    table_source_count: tableResolutions.length,
    non_table_source_count: sourceResolutions.length - tableResolutions.length,
    unresolvable_source_count: sourceResolutions.filter((r) => !r.node_found).length,
    unresolvable_table_cell_count: tableResolutions.filter((r) => !r.cell_resolved).length,
    tags: [],
  };
  if (!isTableItem) return result;

  const resolvedCells = tableResolutions.filter((r) => r.cell_resolved);
  const tags = new Set();

  const rowKeys = new Set();
  const cellKeys = new Set();
  const nodeIds = new Set();
  const docIds = new Set();
  const perRowColCount = new Map(); // `${nodeId}#${row}` -> Set(colIndex)
  let anyUnitDeclaring = false;
  let anyColumnPeriodValue = false;
  let anyMultiRowSpan = false;
  let anyBoilerplate = false;

  for (const r of resolvedCells) {
    nodeIds.add(r.node_id);
    docIds.add(r.document_id);
    if (r.has_unit_declaring_row) anyUnitDeclaring = true;
    if (r.boilerplate_duplicate_row_ratio >= BOILERPLATE_DUPLICATE_ROW_RATIO_THRESHOLD) anyBoilerplate = true;
    if (r.is_multi_row_span) anyMultiRowSpan = true;
    for (const rowIndex of r.matched_row_indices) {
      const rowKey = `${r.node_id}#${rowIndex}`;
      rowKeys.add(rowKey);
      if (r.header_row_indices.length > 0 && !r.header_row_indices.includes(rowIndex)) anyColumnPeriodValue = true;
      // `col_indices` (fallback-inclusive) only feeds cellKeys, a reporting
      // count -- never a tag decision, since a ROW_FALLBACK resolution
      // means the specific column is genuinely unknown, not "compared".
      const cols = perRowColCount.get(rowKey) ?? new Set();
      for (const colIndex of r.col_indices) cellKeys.add(`${rowKey}#${colIndex}`);
      if (r.col_resolution === "PRECISE") {
        for (const colIndex of r.precise_col_indices) {
          cols.add(colIndex);
          if (colIndex > 0) tags.add("ROW_HEADER_VALUE");
        }
      }
      perRowColCount.set(rowKey, cols);
    }
  }

  const singleRowPreciseSingleCell = rowKeys.size === 1 && !anyMultiRowSpan
    && [...perRowColCount.values()].every((cols) => cols.size === 1)
    && [...perRowColCount.values()].some((cols) => cols.size === 1);
  if (singleRowPreciseSingleCell) tags.add("SINGLE_CELL_LOOKUP");
  if (anyColumnPeriodValue) tags.add("COLUMN_PERIOD_VALUE");
  if (anyUnitDeclaring) tags.add("UNIT_SENSITIVE");
  if (rowKeys.size >= 2) tags.add("MULTI_ROW_CALCULATION");
  if ([...perRowColCount.values()].some((cols) => cols.size >= 2)) tags.add("MULTI_COLUMN_COMPARISON");
  if (nodeIds.size >= 2 && docIds.size === 1) tags.add("CROSS_TABLE");
  if (docIds.size >= 2) tags.add("CROSS_DOCUMENT_TABLE");
  if (anyBoilerplate) tags.add("TABLE_WITH_REPEATED_BOILERPLATE");

  result.tags = [...tags].sort();
  result.distinct_rows_touched = rowKeys.size;
  result.distinct_cells_touched = cellKeys.size;
  result.distinct_table_nodes_touched = nodeIds.size;
  result.distinct_documents_touched = docIds.size;
  result.any_multi_row_span = anyMultiRowSpan;
  return result;
}
