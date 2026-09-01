// Turn P10.3-TABLE / Stage 2: checks whether a real, code-produced set of
// chunks (Fixed-512 or Section-Aware-Flat, from domain/chunking/chunker.mjs
// -- never re-implemented here) actually PRESERVES, in the literal
// raw_text a retriever would return, the row header / column header / unit
// / section context a resolved Gold table cell depends on for meaning.
//
// A chunk's source_spans record what a ROW *segment* nominally covers, set
// once when the segment is created -- but chunkFixed/chunkSectionFlat pack
// segments into 512-token windows by slicing the CONCATENATED text at
// token boundaries, so a segment (row) that straddles a window boundary
// can have a span that over-claims coverage relative to what raw_text
// actually contains. Every check here verifies actual TEXT containment in
// raw_text, never trusts a span's claim on its own.
function normalize(text) {
  return String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function rowJoinedText(node, rowIndex) {
  const row = node?.normalized_rows?.[rowIndex];
  if (!row) return "";
  return normalize(row.join(" | "));
}

// Chunks whose source_spans NOMINALLY claim to cover this row (same check
// chunker.mjs's own findParent()/spanOverlap use internally).
export function findChunksClaimingRow(chunks, nodeId, rowIndex) {
  return chunks.filter((chunk) => chunk.source_spans.some((span) => span.node_id === nodeId && span.row_start !== null && span.row_start <= rowIndex && rowIndex <= span.row_end));
}

export function rowFullyPresentInChunk(node, rowIndex, chunk) {
  const rowText = rowJoinedText(node, rowIndex);
  if (!rowText) return false;
  return normalize(chunk.raw_text).includes(rowText);
}

// Full structural-preservation evaluation for ONE resolved table cell
// (from Stage 1's classifier output) against ONE chunking strategy's full,
// real chunk set for the owning document.
export function evaluateCellPreservation({ node, nodeId, rowIndex, chunks }) {
  const claimingChunks = findChunksClaimingRow(chunks, nodeId, rowIndex);
  const fullTextChunks = claimingChunks.filter((chunk) => rowFullyPresentInChunk(node, rowIndex, chunk));
  const goldCellRetrievable = fullTextChunks.length > 0;
  // Deterministic tie-break: lowest chunk_index among chunks that actually
  // contain the row's full text (never an arbitrary/unstable pick).
  const bestChunk = fullTextChunks.length > 0
    ? [...fullTextChunks].sort((a, b) => a.chunk_index - b.chunk_index)[0]
    : null;
  // A claiming chunk whose raw_text does NOT actually contain the row's
  // full text is a locator misrepresentation: its source_spans/
  // source_locator claim row coverage the real content does not support.
  const misrepresentingChunks = claimingChunks.filter((chunk) => !rowFullyPresentInChunk(node, rowIndex, chunk));

  const rowCells = (node?.normalized_rows?.[rowIndex] ?? []).map((cell) => normalize(cell));
  const headerCellText = rowCells[0] ?? "";

  let rowHeaderApplicable = false;
  let rowHeaderPreserved = null;
  if (headerCellText.length > 0 && rowCells.length > 1) {
    rowHeaderApplicable = true;
    rowHeaderPreserved = bestChunk ? normalize(bestChunk.raw_text).includes(headerCellText) : false;
  }

  let columnHeaderApplicable = false;
  let columnHeaderPreserved = null;
  const headerRowIndices = node?.header_row_indices ?? [];
  if (headerRowIndices.length > 0 && !headerRowIndices.includes(rowIndex)) {
    columnHeaderApplicable = true;
    const headerRowText = rowJoinedText(node, headerRowIndices[0]);
    const targetRowText = rowJoinedText(node, rowIndex);
    columnHeaderPreserved = headerRowText.length > 0 && chunks.some((chunk) => {
      const text = normalize(chunk.raw_text);
      return text.includes(headerRowText) && text.includes(targetRowText);
    });
  }

  // "Section/title context" is what actually reaches embed_text (see
  // chunker.mjs's embedText(): `섹션: ${sectionPath.join(" > ")}`) -- a
  // non-empty chunk.section_path is real, code-flowing context, not a
  // cosmetic label.
  const tableTitlePreserved = bestChunk ? (bestChunk.section_path?.length ?? 0) > 0 : null;

  return {
    node_id: nodeId,
    row_index: rowIndex,
    gold_cell_retrievable: goldCellRetrievable,
    best_chunk_id: bestChunk?.chunk_id ?? null,
    claiming_chunk_count: claimingChunks.length,
    row_header_applicable: rowHeaderApplicable,
    row_header_preserved: rowHeaderPreserved,
    column_header_applicable: columnHeaderApplicable,
    column_header_preserved: columnHeaderPreserved,
    table_title_preserved: tableTitlePreserved,
    locator_misrepresentation: misrepresentingChunks.length > 0,
    misrepresenting_chunk_count: misrepresentingChunks.length,
    boundary_fracture: !goldCellRetrievable && claimingChunks.length > 0,
  };
}

// Unit preservation is evaluated at the TABLE level (a unit-declaring row,
// if any, applies to the whole table, not one specific row) -- checks
// whether any chunk co-locates the unit-declaring row's text with the
// target row's text.
export function evaluateUnitPreservation({ node, nodeId, rowIndex, unitDeclaringRowIndices, chunks }) {
  if (!unitDeclaringRowIndices || unitDeclaringRowIndices.length === 0) {
    return { unit_applicable: false, unit_preserved: null };
  }
  const targetRowText = rowJoinedText(node, rowIndex);
  const unitRowText = rowJoinedText(node, unitDeclaringRowIndices[0]);
  const preserved = targetRowText.length > 0 && unitRowText.length > 0 && chunks.some((chunk) => {
    const text = normalize(chunk.raw_text);
    return text.includes(unitRowText) && text.includes(targetRowText);
  });
  return { unit_applicable: true, unit_preserved: preserved };
}

// Ambiguous numeric collision risk: within the SAME chunk that resolves
// this row, does the target cell's normalized text also appear as another
// DIFFERENT row/column's value in that same table -- i.e. could a reader
// (or a downstream model) attribute the number to the wrong row/column
// purely from the chunk's own text, without external disambiguation.
export function evaluateAmbiguousNumericCollision({ node, rowIndex, colIndices }) {
  const rows = node?.normalized_rows ?? [];
  const targetRow = rows[rowIndex] ?? [];
  const targetValues = (colIndices ?? []).map((c) => normalize(targetRow[c])).filter((v) => /\d/.test(v) && v.length > 0);
  if (targetValues.length === 0) return { applicable: false, collision: false };
  let collision = false;
  for (const [otherRowIndex, otherRow] of rows.entries()) {
    if (otherRowIndex === rowIndex) continue;
    for (const cell of otherRow) {
      if (targetValues.includes(normalize(cell))) { collision = true; break; }
    }
    if (collision) break;
  }
  return { applicable: true, collision };
}
