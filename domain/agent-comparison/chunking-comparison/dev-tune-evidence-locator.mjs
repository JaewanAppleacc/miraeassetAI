// Turn P10.1: parses required_evidence_slots[].acceptable_sources[].
// source_locator into {document_id, order_index, row, col} so retrieved
// chunks can be scored for evidence coverage WITHOUT ever touching
// expected_answer or evidence_span TEXT as a matching signal (only
// document_id/order_index/row/col -- structural provenance, never
// content). Two locator conventions are present in this Gold release:
//
//   1. "docId/relPath#node=N&row=R&col=C"   (URL-query-param style)
//   2. "docId::relPath::nN"                 (raw A-parser node_id, literal)
//
// For (2), A's raw parser assigns node_id suffixes "nN" where N IS the
// node's own source.order_index (verified empirically against real
// a-document-ir/source/*.jsonl records: node_id "..::n5" always has
// source.order_index === 5) -- this module asserts that invariant at
// parse time rather than silently trusting it.
const QUERY_STYLE = /^([a-z]+_\d{14})\/[^#]+#node=(\d+)(?:&row=(\d+))?(?:&col=(\d+))?$/;
const NODE_ID_STYLE = /^([a-z]+_\d{14})::[^:]+::n(\d+)$/;

export class UnrecognizedLocatorError extends Error {
  constructor(locator) {
    super(`dev-tune-evidence-locator: unrecognized source_locator format: ${locator}`);
    this.name = "UnrecognizedLocatorError";
  }
}

export function parseEvidenceLocator(sourceLocator, expectedDocumentId) {
  const queryMatch = QUERY_STYLE.exec(sourceLocator);
  if (queryMatch) {
    const [, documentId, orderIndex, row, col] = queryMatch;
    return {
      documentId,
      orderIndex: Number(orderIndex),
      row: row !== undefined ? Number(row) : null,
      col: col !== undefined ? Number(col) : null,
      rawNodeId: null,
    };
  }
  const nodeIdMatch = NODE_ID_STYLE.exec(sourceLocator);
  if (nodeIdMatch) {
    const [, documentId, orderIndex] = nodeIdMatch;
    return { documentId, orderIndex: Number(orderIndex), row: null, col: null, rawNodeId: sourceLocator };
  }
  throw new UnrecognizedLocatorError(sourceLocator);
}

// A chunk "covers" a parsed evidence locator when: same document_id, AND
// at least one of the chunk's source_spans has the same order_index, AND
// (when the locator specifies row/col) that span's row/col range contains
// the locator's row/col -- but ONLY when the span itself carries row
// information (a non-table span's row_start is null; in that case
// order_index equality alone is treated as coverage -- span-level
// granularity, never a hard requirement stricter than what the chunking
// strategy is structurally able to express).
export function chunkCoversLocator(chunk, parsedLocator) {
  if (chunk.document_id !== parsedLocator.documentId) return false;
  return chunk.source_spans.some((span) => {
    if (span.order_index !== parsedLocator.orderIndex) return false;
    if (parsedLocator.row === null && parsedLocator.col === null) return true;
    if (span.row_start === null) return true; // span can't express row/col -- order_index match is the best available signal
    const rowOk = parsedLocator.row === null || (span.row_start <= parsedLocator.row && parsedLocator.row <= span.row_end);
    const colOk = parsedLocator.col === null || (span.col_start <= parsedLocator.col && parsedLocator.col <= span.col_end);
    return rowOk && colOk;
  });
}
