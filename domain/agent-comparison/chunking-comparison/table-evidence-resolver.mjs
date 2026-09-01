// Turn P10.3-TABLE: mechanically resolves a Gold acceptable_source
// (document_id + source_locator + evidence_span) onto a concrete
// row/column position inside the real, parsed DocumentIR table node it
// points at. Gold's source_locator is the WHOLE table node id (matching
// chunker.mjs's node_id format exactly, e.g.
// "holding_20240403000410::20240403000410.xml::n0") -- it never carries a
// row/column of its own. evidence_span is the only signal that narrows a
// table-node locator down to a specific cell, so resolution is
// text-containment matching against the node's own normalized_rows grid
// (the SAME grid chunker.mjs reads), never against question/answer text.
//
// This module NEVER reads item.question or item.expected_answer -- only
// the acceptable_source's own evidence_span string (already scoped by
// Gold as the citation for this slot) and the DocumentIR node's cells.

function normalize(text) {
  return String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

// Same declared-unit token set this Turn's brief names explicitly. Two
// separate patterns because the two call sites need different precision:
//   UNIT_TOKEN_PATTERN (bare) is only ever combined with
//   UNIT_DECLARATION_PATTERN below ("단위:" must ALSO be present), which
//   already rules out ordinary prose -- a genuine "단위: 백만원" label row
//   has no digit before the unit word, so a digit-anchored pattern would
//   wrongly miss it.
//   UNIT_VALUE_TOKEN_PATTERN (digit-anchored) is for standalone use
//   (rowHasUnitToken) with no "단위:" gate -- a bare pattern here
//   false-positives on ordinary Korean words containing a unit character
//   (e.g. "원" inside "종업원"; caught by a real test case, not
//   hypothetical), so it requires a digit immediately before the token.
const UNIT_TOKEN_PATTERN = /(?:원|천원|백만원|억원|%|퍼센트|주|천주|만주|배|포인트|bp)/;
const UNIT_VALUE_TOKEN_PATTERN = /[\d,.]\s*(?:천원|백만원|억원|퍼센트|천주|만주|포인트|원|%|주|배|bp)/;
const UNIT_DECLARATION_PATTERN = /\(?\s*단위\s*[:：]/;

export function findNodeById(rawRecord, nodeId) {
  if (!rawRecord || !Array.isArray(rawRecord.nodes)) return null;
  return rawRecord.nodes.find((node) => node.node_id === nodeId) ?? null;
}

// Resolves which row(s)/column(s) of a TABLE node's normalized_rows grid
// the given evidence_span text cites. Two match tiers, checked in order,
// because a real corpus scan showed evidence_span length varies hugely
// (59-2,476 chars, median 538): a citation is often a single row/cell, but
// for MULTI_ROW_CALCULATION/MULTI_COLUMN_COMPARISON items it deliberately
// quotes a multi-row excerpt.
//   TIGHT match: the row's own joined text contains evidence_span (the row
//     is at least as long as what's cited) -- the strongest, most specific
//     signal. If any tight matches exist, they alone determine the result;
//     `ambiguous: true` here means the SAME short span genuinely recurs in
//     multiple distinct rows (a real ambiguous_numeric_collision candidate,
//     e.g. a repeated "0" or "-" placeholder), not a broad citation.
//   BROAD match (only used when no tight match exists): evidence_span
//     contains the row's (non-empty) joined text -- the row is one of
//     SEVERAL rows a longer multi-row citation deliberately spans.
//     Recorded as `is_multi_row_span: true`, distinct from `ambiguous`.
//     No length-fraction floor is applied here: an earlier version filtered
//     out rows below 5% of the span's length to reject spurious matches,
//     but that discarded legitimate SHORT rows (e.g. a bare "합계"/"-"
//     total row) that are genuinely part of a broad citation -- verified
//     against a real-data cross-check where removing the floor took
//     unresolved sources from 19/75 down to the true 4/75.
export function resolveTableCell(node, evidenceSpanText) {
  const rows = node?.normalized_rows ?? [];
  const needle = normalize(evidenceSpanText);
  const result = {
    matched: false,
    ambiguous: false,
    is_multi_row_span: false,
    matched_row_indices: [],
    primary_row_index: null,
    col_indices: [],
    n_rows: rows.length,
    n_cols: rows.length > 0 ? rows[0].length : 0,
    header_row_indices: node?.header_row_indices ?? [],
  };
  if (!needle || rows.length === 0) return result;

  const joinedRows = rows.map((row) => row.map((cell) => normalize(cell)).join(" | "));
  const tightMatches = [];
  const broadMatches = [];
  for (const [rowIndex, joined] of joinedRows.entries()) {
    if (joined.length === 0) continue;
    if (joined.includes(needle)) tightMatches.push(rowIndex);
    else if (needle.includes(joined)) broadMatches.push(rowIndex);
  }

  if (tightMatches.length > 0) {
    result.matched = true;
    result.ambiguous = tightMatches.length > 1;
    result.matched_row_indices = tightMatches;
    result.primary_row_index = tightMatches[0];
  } else if (broadMatches.length > 0) {
    result.matched = true;
    result.is_multi_row_span = broadMatches.length > 1;
    result.matched_row_indices = broadMatches;
    result.primary_row_index = broadMatches[0];
  } else {
    return result;
  }

  const primaryCells = rows[result.primary_row_index].map((cell) => normalize(cell));
  // `precise_col_indices`: columns whose OWN cell text resolves against the
  // citation individually -- the only column signal strong enough to drive
  // column-semantic tags (ROW_HEADER_VALUE, MULTI_COLUMN_COMPARISON,
  // SINGLE_CELL_LOOKUP). `col_indices` additionally falls back to "every
  // column in the row" when no cell resolves precisely (e.g. the citation
  // straddles a " | " join boundary, or is a broad multi-row span with no
  // per-cell signal) -- useful for Stage 2's co-location checks (row
  // header/unit preservation only needs "was this row's chunk kept
  // together", not which exact column), but NEVER used to infer that a
  // specific column was compared or looked up.
  result.precise_col_indices = primaryCells
    .map((cell, colIndex) => ({ cell, colIndex }))
    .filter(({ cell }) => cell.length > 0 && (needle.includes(cell) || cell.includes(needle)))
    .map(({ colIndex }) => colIndex);
  result.col_resolution = result.precise_col_indices.length > 0 ? "PRECISE" : "ROW_FALLBACK";
  result.col_indices = result.precise_col_indices.length > 0
    ? result.precise_col_indices
    : primaryCells.map((_, colIndex) => colIndex);
  return result;
}

// Real, mechanical detection of a declared-unit row/cell within a table
// node -- since node.unit_text is NEVER populated by this corpus's parser
// (verified empirically: 0/32,449 table nodes across the bounded
// evaluation corpus), unit information must be recovered from the
// table's own cell text, exactly as a human reader would.
export function findUnitDeclaringRows(node) {
  const rows = node?.normalized_rows ?? [];
  const declaring = [];
  for (const [rowIndex, row] of rows.entries()) {
    const joined = normalize(row.join(" | "));
    if (UNIT_DECLARATION_PATTERN.test(joined) && UNIT_TOKEN_PATTERN.test(joined)) declaring.push(rowIndex);
  }
  return declaring;
}

export function rowHasUnitToken(node, rowIndex) {
  const rows = node?.normalized_rows ?? [];
  const row = rows[rowIndex];
  if (!row) return false;
  return UNIT_VALUE_TOKEN_PATTERN.test(normalize(row.join(" | ")));
}
