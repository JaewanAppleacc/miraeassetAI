// Turn A2-INTEGRATION-AND-DEVTUNE-V1, Section C: a real, read-only
// `fetchNode` implementation for a2-node-grounded-evidence.mjs's injected
// `fetchNode` dependency.
//
// This is a NEW, separate file. It does not modify, import as a
// replacement for, or change the meaning of arm-retriever-adapter.mjs's
// existing `fetch_node()` (identity-verification only, `node_text_available`
// always false there -- that function's contract is unchanged).
//
// Ground truth about what is actually persisted (locator-provenance.mjs's
// own header, AC_LOCATOR_READY_REPORT.md section B #5, confirmed again this
// Turn by reading the schema directly):
//   - `disclosure_reference.reference_fixed_kure_chunk_staging` persists,
//     per chunk: verbatim chunk-level `raw_text` and the FULL ordered
//     `source_spans` array (node identity: node_id/order_index/row/col/
//     source_locator) -- this is the real NodeStore-adjacent identity
//     sidecar this adapter reads.
//   - Node-local TEXT is NOT persisted independently of chunk-level
//     `raw_text` for the general case. The one exception: a chunk whose
//     `source_spans` has exactly ONE entry is, by construction, exactly one
//     node's text with zero ambiguity -- `raw_text` IS that node's real
//     text in that case (not a guess: chunker.mjs's own tokenWindowsFromSegments
//     only produces >1 span when a window's character range actually
//     overlaps more than one segment).
//   - For a TABLE node/row inside an otherwise-ambiguous (>1 span) chunk,
//     `source_tables.body_rows`/`header_rows` (001_core.sql) are a second,
//     independent real-data source keyed by table row, at finer grain than
//     the chunk -- when a caller wires a reader for it, this adapter uses
//     that instead of trying (and failing) to slice the chunk's raw_text.
//   - Every other case (a non-table node inside a >1-span chunk, or a
//     table row when no source_tables reader is wired) has no real,
//     verified per-node text available in this data model: this adapter
//     fails closed (`found: false`) rather than fabricate or approximate
//     one from the chunk-level text.
//
// This adapter never falls back to a different document_id/node_index than
// the one requested, never accepts Gold or question text as part of the
// lookup key (the only inputs are documentId/nodeIndex/row/col), never
// issues a write (both injected readers are documented as SELECT-only; this
// file itself contains no INSERT/UPDATE/DELETE/CREATE/DROP/TRUNCATE
// statement -- verified by a source-scan test), and never uses the fetched
// text for ranking (it is purely a `fetchNode` implementation; ranking
// happened upstream in the frozen Arm A run).

import { verifyNodeIdentity } from "./locator-provenance.mjs";

export const REAL_NODE_STORE_ADAPTER_VERSION = "fourarm.a2-real-node-store-adapter.v1";

function unresolved(documentId, nodeIndex, row, col, reason) {
  return Object.freeze({
    found: false, documentId, nodeIndex, nodeId: null, sourceLocator: null,
    isTable: false, row: row ?? null, col: col ?? null, text: null, table: null,
    unresolvedReason: reason,
  });
}

// Pre-registered fail-closed default (Section C / A2_DEVTUNE_V1_AMENDMENT.md):
// used whenever no real, populated NodeStore reader is configured for this
// run. Every lookup resolves UNRESOLVED -- this is a fixed fallback chosen
// before any result is seen, never a decision made after observing what a
// live connection would return.
export function createUnavailableFetchNode(reason = "REAL_NODE_STORE_NOT_CONFIGURED") {
  return async function fetchNode({ documentId, nodeIndex, row = null, col = null } = {}) {
    return unresolved(documentId ?? null, Number.isInteger(nodeIndex) ? nodeIndex : null, row, col, reason);
  };
}

// chunkStagingReader({ documentId }) => Promise<Array<{ chunk_id, source_spans }>>
//   Read-only lookup of every chunk-staging row for one document_id (a
//   SELECT chunk_id, source_spans FROM reference_fixed_kure_chunk_staging
//   WHERE document_id = $1 in a real deployment). The caller owns the
//   connection/pool; this module never opens one itself.
// tableRowReader({ documentId, nodeIndex, row, col }) =>
//   Promise<null | { title, period, unit, rowLabels, colLabels, cellText }>
//   Optional. Read-only lookup of one table row's real cell content from
//   source_tables.header_rows/body_rows for the section the resolved node
//   belongs to. When omitted, table rows inside an ambiguous (>1 span)
//   chunk resolve UNRESOLVED rather than approximated from chunk text.
export function createRealNodeStoreFetchNode({ chunkStagingReader, tableRowReader = null } = {}) {
  if (typeof chunkStagingReader !== "function") {
    return createUnavailableFetchNode("REAL_NODE_STORE_NOT_CONFIGURED");
  }

  return async function fetchNode({ documentId, nodeIndex, row = null, col = null } = {}) {
    if (typeof documentId !== "string" || documentId.length === 0 || !Number.isInteger(nodeIndex)) {
      return unresolved(documentId ?? null, Number.isInteger(nodeIndex) ? nodeIndex : null, row, col, "INVALID_LOOKUP_KEY");
    }

    let chunkRows;
    try {
      chunkRows = await chunkStagingReader({ documentId });
    } catch {
      return unresolved(documentId, nodeIndex, row, col, "NODE_STORE_READ_FAILED");
    }
    if (!Array.isArray(chunkRows) || chunkRows.length === 0) {
      return unresolved(documentId, nodeIndex, row, col, "NODE_STORE_READ_FAILED");
    }

    // Identity: fail-closed re-use of the existing verified check -- never
    // a re-implementation of the match rule.
    const identity = verifyNodeIdentity({ documentId, nodeIndex, row, col, chunkRows });
    if (!identity.found || identity.document_id !== documentId || identity.node_index !== nodeIndex) {
      return unresolved(documentId, nodeIndex, row, col, "NODE_NOT_IN_INDEX");
    }

    const representativeMatch = identity.matches[0];
    const span = representativeMatch.span;
    const isTable = span.row_start !== null && span.row_start !== undefined;
    const owningChunk = chunkRows.find((c) => c.chunk_id === representativeMatch.chunk_id) ?? null;
    const owningChunkSpanCount = Array.isArray(owningChunk?.source_spans) ? owningChunk.source_spans.length : null;

    if (isTable) {
      if (typeof tableRowReader !== "function") {
        return unresolved(documentId, nodeIndex, row, col, "TABLE_ROW_TEXT_NOT_CONFIGURED");
      }
      let tableRow;
      try {
        tableRow = await tableRowReader({ documentId, nodeIndex, row: span.row_start, col: span.col_start });
      } catch {
        return unresolved(documentId, nodeIndex, row, col, "NODE_STORE_READ_FAILED");
      }
      if (!tableRow || typeof tableRow.cellText !== "string" || tableRow.cellText.length === 0) {
        return unresolved(documentId, nodeIndex, row, col, "TABLE_ROW_TEXT_NOT_FOUND");
      }
      return Object.freeze({
        found: true, documentId, nodeIndex,
        nodeId: span.node_id ?? null, sourceLocator: span.source_locator ?? null,
        isTable: true, row: span.row_start ?? null, col: span.col_start ?? null,
        text: tableRow.cellText,
        table: Object.freeze({
          title: tableRow.title ?? null, period: tableRow.period ?? null, unit: tableRow.unit ?? null,
          rowLabels: tableRow.rowLabels ?? null, colLabels: tableRow.colLabels ?? null,
        }),
      });
    }

    // Non-table node: only safe to use chunk-level raw_text when that
    // chunk's own source_spans resolves to exactly this one node (no
    // ambiguity to guess through) -- see file header.
    if (owningChunkSpanCount !== 1) {
      return unresolved(documentId, nodeIndex, row, col, "NON_TABLE_TEXT_NOT_ISOLABLE");
    }
    const text = typeof owningChunk?.raw_text === "string" ? owningChunk.raw_text : null;
    if (!text || text.length === 0) {
      return unresolved(documentId, nodeIndex, row, col, "NODE_STORE_READ_FAILED");
    }
    return Object.freeze({
      found: true, documentId, nodeIndex,
      nodeId: span.node_id ?? null, sourceLocator: span.source_locator ?? null,
      isTable: false, row: null, col: null, text, table: null,
    });
  };
}
