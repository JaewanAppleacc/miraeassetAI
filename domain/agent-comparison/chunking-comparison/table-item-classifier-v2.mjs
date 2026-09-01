// Turn P10.3.2 / Stage 1-2: mechanical TABLE_EVALUATION_ITEM classification
// over the FULL DEV_TUNE-101 population, using the v2 authority-respecting
// resolver (table-locator-authority-v2.mjs) so CELL_QUALIFIED and
// NODE_ONLY_HASH sources are no longer silently missed the way P10.3's
// original resolver missed them. Same 9-tag taxonomy as P10.3's
// table-item-classifier.mjs (not modified, reimplemented here against the
// v2 resolver's richer per-source result shape). Never reads item.question
// or item.expected_answer.
import { resolveAuthoritativeCellV2, ROOT_CAUSE } from "./table-locator-authority-v2.mjs";

export const TABLE_ITEM_TAGS = Object.freeze([
  "SINGLE_CELL_LOOKUP", "ROW_HEADER_VALUE", "COLUMN_PERIOD_VALUE", "UNIT_SENSITIVE",
  "MULTI_ROW_CALCULATION", "MULTI_COLUMN_COMPARISON", "CROSS_TABLE", "CROSS_DOCUMENT_TABLE",
  "TABLE_WITH_REPEATED_BOILERPLATE",
]);

function normalizeForDup(text) {
  return String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}
export function tableBoilerplateDuplicateRowRatio(node) {
  const rows = node?.normalized_rows ?? [];
  if (rows.length === 0) return 0;
  const joined = rows.map((row) => normalizeForDup(row.join(" | "))).filter((t) => t.length > 0);
  if (joined.length === 0) return 0;
  const counts = new Map();
  for (const t of joined) counts.set(t, (counts.get(t) ?? 0) + 1);
  return joined.filter((t) => counts.get(t) > 1).length / rows.length;
}
const BOILERPLATE_THRESHOLD = 0.15;

export function classifyGoldItemForTablesV2(item, rawRecordByDocId) {
  const sourceResolutions = [];
  for (const slot of item.required_evidence_slots ?? []) {
    for (const source of slot.acceptable_sources ?? []) {
      const raw = rawRecordByDocId.get(source.document_id);
      const result = resolveAuthoritativeCellV2({ rawRecord: raw, locator: source.source_locator, evidenceSpanText: source.evidence_span, extensions: item.extensions });
      sourceResolutions.push({ document_id: source.document_id, ...result });
    }
  }

  const tableResolved = sourceResolutions.filter((r) => r.root_cause === ROOT_CAUSE.GOLD_LOCATOR_EXACT || r.root_cause === ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS);
  const isTableItem = tableResolved.length > 0;

  const result = {
    question_id: item.question_id,
    question_type: item.question_type,
    is_table_item: isTableItem,
    table_source_count: tableResolved.length,
    unresolvable_source_count: sourceResolutions.filter((r) => r.root_cause === ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE).length,
    parse_limited_source_count: sourceResolutions.filter((r) => r.root_cause === ROOT_CAUSE.SOURCE_PARSE_LIMITATION).length,
    ambiguous_source_count: sourceResolutions.filter((r) => r.root_cause === ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS).length,
    conflict_source_count: sourceResolutions.filter((r) => r.root_cause === ROOT_CAUSE.LOCATOR_PROVENANCE_CONFLICT).length,
    tags: [],
  };
  if (!isTableItem) return result;

  const tags = new Set();
  const rowKeys = new Set();
  const cellKeys = new Set();
  const nodeIds = new Set();
  const docIds = new Set();
  const perRowColCount = new Map();
  let anyUnitDeclaring = false;
  let anyColumnPeriodValue = false;
  let anyMultiRowSpan = false;
  let anyBoilerplate = false;

  for (const r of tableResolved) {
    const nodeKey = `${r.document_id}::${r.node.node_id ?? r.node.source?.order_index}`;
    nodeIds.add(nodeKey);
    docIds.add(r.document_id);
    if (tableBoilerplateDuplicateRowRatio(r.node) >= BOILERPLATE_THRESHOLD) anyBoilerplate = true;
    // Unit sensitivity: reuse the same declared-unit-row heuristic as
    // P10.3 (node.unit_text is never populated by this corpus's parser).
    const unitRows = (r.node.normalized_rows ?? []).filter((row, idx) => {
      const joined = normalizeForDup(row.join(" | "));
      return /\(?\s*단위\s*[:：]/.test(joined) && /(?:원|천원|백만원|억원|%|퍼센트|주|천주|만주|배|포인트|bp)/.test(joined);
    });
    if (unitRows.length > 0) anyUnitDeclaring = true;

    const rowIndices = r.matched_row_indices ?? [r.row_index];
    if (r.is_multi_row_span) anyMultiRowSpan = true;
    for (const rowIndex of rowIndices) {
      if (rowIndex === null || rowIndex === undefined) continue;
      const rowKey = `${nodeKey}#${rowIndex}`;
      rowKeys.add(rowKey);
      const headerRowIndices = r.node.header_row_indices ?? [];
      if (headerRowIndices.length > 0 && !headerRowIndices.includes(rowIndex)) anyColumnPeriodValue = true;
      const cols = perRowColCount.get(rowKey) ?? new Set();
      for (const colIndex of r.col_indices ?? []) {
        cols.add(colIndex);
        cellKeys.add(`${rowKey}#${colIndex}`);
        if (colIndex > 0) tags.add("ROW_HEADER_VALUE");
      }
      perRowColCount.set(rowKey, cols);
    }
  }

  const singleRowSingleCell = rowKeys.size === 1 && !anyMultiRowSpan && [...perRowColCount.values()].every((c) => c.size === 1) && [...perRowColCount.values()].some((c) => c.size === 1);
  if (singleRowSingleCell) tags.add("SINGLE_CELL_LOOKUP");
  if (anyColumnPeriodValue) tags.add("COLUMN_PERIOD_VALUE");
  if (anyUnitDeclaring) tags.add("UNIT_SENSITIVE");
  if (rowKeys.size >= 2) tags.add("MULTI_ROW_CALCULATION");
  if ([...perRowColCount.values()].some((c) => c.size >= 2)) tags.add("MULTI_COLUMN_COMPARISON");
  if (nodeIds.size >= 2 && docIds.size === 1) tags.add("CROSS_TABLE");
  if (docIds.size >= 2) tags.add("CROSS_DOCUMENT_TABLE");
  if (anyBoilerplate) tags.add("TABLE_WITH_REPEATED_BOILERPLATE");

  result.tags = [...tags].sort();
  result.distinct_rows_touched = rowKeys.size;
  result.distinct_cells_touched = cellKeys.size;
  result.distinct_table_nodes_touched = nodeIds.size;
  result.distinct_documents_touched = docIds.size;
  return result;
}
