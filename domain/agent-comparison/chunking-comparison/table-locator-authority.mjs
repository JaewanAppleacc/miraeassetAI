// Turn P10.3.1: locator authority policy. Real Gold data (dev-tune-
// gold.v0.1.jsonl) uses THREE distinct source_locator shapes, discovered
// by direct inspection of all 345 acceptable_sources across the 101
// DEV_TUNE items:
//   CELL_QUALIFIED   "docId/relPath#node=N&row=R&col=C"  (260/345, 75.4%)
//   NODE_ONLY_HASH   "docId/relPath#node=N"                (6/345,  1.7%)
//   NODE_ONLY_COLON  "docId::relPath::nodeId"             (79/345, 22.9%)
//
// P10.3's resolver (table-evidence-resolver.mjs) only ever attempted an
// EXACT node_id string match, which only the NODE_ONLY_COLON shape
// satisfies -- it silently treated every CELL_QUALIFIED and
// NODE_ONLY_HASH locator as "node not found", even though CELL_QUALIFIED
// locators are the MOST authoritative evidence Gold provides (an explicit
// row+col, not a text-matched guess). This module implements this Turn's
// mandated authority order:
//   1. source_locator's own document_id/node_id/row/column (CELL_QUALIFIED)
//   2. extensions.evidence_verification or other cell-qualified provenance
//      (verified NOT PRESENT anywhere in this Gold release's schema --
//      acceptable_source only ever has {document_id, source_locator,
//      evidence_span}; item-level `extensions` carries authoring/workflow
//      fields, never cell provenance -- checked exhaustively across all
//      345 sources and all 101 items' extensions objects)
//   3. node_id + table structure (NODE_ONLY_HASH: node resolved by
//      rel_path + order_index, no row/col of its own)
//   4. evidence_span exact/broad text match against normalized_rows
//      (NODE_ONLY_COLON, and NODE_ONLY_HASH once the node is found)
import { resolveTableCell as textResolveTableCell } from "./table-evidence-resolver.mjs";

export const LOCATOR_SCHEME = Object.freeze({
  CELL_QUALIFIED: "CELL_QUALIFIED",
  NODE_ONLY_HASH: "NODE_ONLY_HASH",
  NODE_ONLY_COLON: "NODE_ONLY_COLON",
  UNRECOGNIZED: "UNRECOGNIZED",
});

export const ROOT_CAUSE = Object.freeze({
  GOLD_LOCATOR_EXACT: "GOLD_LOCATOR_EXACT",
  GOLD_LOCATOR_AMBIGUOUS: "GOLD_LOCATOR_AMBIGUOUS",
  GOLD_LOCATOR_UNRESOLVABLE: "GOLD_LOCATOR_UNRESOLVABLE",
  RESOLVER_IMPLEMENTATION_BUG: "RESOLVER_IMPLEMENTATION_BUG",
  CHUNK_BOUNDARY_CONTEXT_LOSS: "CHUNK_BOUNDARY_CONTEXT_LOSS",
  CHUNK_METADATA_LOSS: "CHUNK_METADATA_LOSS",
  SOURCE_PARSE_LIMITATION: "SOURCE_PARSE_LIMITATION",
  NOT_A_VIOLATION: "NOT_A_VIOLATION",
});

const CELL_QUALIFIED_PATTERN = /^([^/]+)\/([^#]+)#node=(\d+)&row=(\d+)&col=(\d+)$/;
const NODE_ONLY_HASH_PATTERN = /^([^/]+)\/([^#]+)#node=(\d+)$/;
const NODE_ONLY_COLON_PATTERN = /^([^:]+)::([^:]+)::(.+)$/;

export function classifyLocatorScheme(locator) {
  if (CELL_QUALIFIED_PATTERN.test(locator)) return LOCATOR_SCHEME.CELL_QUALIFIED;
  if (NODE_ONLY_HASH_PATTERN.test(locator)) return LOCATOR_SCHEME.NODE_ONLY_HASH;
  if (NODE_ONLY_COLON_PATTERN.test(locator)) return LOCATOR_SCHEME.NODE_ONLY_COLON;
  return LOCATOR_SCHEME.UNRECOGNIZED;
}

// Resolves the DocumentIR node a locator names, using the addressing
// scheme that locator shape actually uses -- order_index+rel_path for the
// hash-based schemes (chunker.mjs's own node-addressing convention), exact
// node_id string equality for the double-colon scheme.
export function resolveNodeForLocator(rawRecord, locator) {
  if (!rawRecord || !Array.isArray(rawRecord.nodes)) return { node: null, scheme: classifyLocatorScheme(locator) };
  const scheme = classifyLocatorScheme(locator);
  if (scheme === LOCATOR_SCHEME.CELL_QUALIFIED) {
    const m = CELL_QUALIFIED_PATTERN.exec(locator);
    const [, , relPath, orderIndexStr, rowStr, colStr] = m;
    const orderIndex = Number(orderIndexStr);
    const node = rawRecord.nodes.find((n) => n.source?.rel_path === relPath && n.source?.order_index === orderIndex) ?? null;
    return { node, scheme, row: Number(rowStr), col: Number(colStr) };
  }
  if (scheme === LOCATOR_SCHEME.NODE_ONLY_HASH) {
    const m = NODE_ONLY_HASH_PATTERN.exec(locator);
    const [, , relPath, orderIndexStr] = m;
    const orderIndex = Number(orderIndexStr);
    const node = rawRecord.nodes.find((n) => n.source?.rel_path === relPath && n.source?.order_index === orderIndex) ?? null;
    return { node, scheme };
  }
  if (scheme === LOCATOR_SCHEME.NODE_ONLY_COLON) {
    const node = rawRecord.nodes.find((n) => n.node_id === locator) ?? null;
    return { node, scheme };
  }
  return { node: null, scheme };
}

// The full priority-ordered resolution. Returns a structural-only result
// (no Gold text is copied into the return value beyond what the caller
// already passed in transiently) describing WHICH authority level
// resolved the cell, and the resulting root-cause candidate.
export function resolveAuthoritativeCell({ rawRecord, locator, evidenceSpanText, extensions = null }) {
  const { node, scheme, row, col } = resolveNodeForLocator(rawRecord, locator);

  if (scheme === LOCATOR_SCHEME.CELL_QUALIFIED) {
    if (!node) {
      return { authority_level: 1, scheme, authoritative_locator_available: true, root_cause: ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE, node: null, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0 };
    }
    if (node.kind !== "table") {
      return { authority_level: 1, scheme, authoritative_locator_available: true, root_cause: ROOT_CAUSE.SOURCE_PARSE_LIMITATION, node, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0, node_kind: node.kind };
    }
    const rows = node.normalized_rows ?? [];
    const inRange = row < rows.length && col < (rows[row]?.length ?? 0);
    if (!inRange) {
      return { authority_level: 1, scheme, authoritative_locator_available: true, root_cause: ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE, node, row_index: row, col_indices: [col], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0 };
    }
    // Priority 1 resolved cleanly: authoritative, deterministic, no text
    // search or disambiguation needed at all.
    return { authority_level: 1, scheme, authoritative_locator_available: true, root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node, row_index: row, col_indices: [col], ambiguous: false, exact_match_count: 1, ambiguous_match_count: 0 };
  }

  // Priority 2: cell-qualified provenance in `extensions` (e.g.
  // evidence_verification). Verified absent from this Gold release's
  // schema for every one of the 345 acceptable_sources and all 101
  // items' extensions objects -- implemented for forward-compatibility,
  // never fires here (disclosed explicitly, not silently skipped).
  if (extensions?.evidence_verification?.row !== undefined && extensions?.evidence_verification?.col !== undefined && node?.kind === "table") {
    const rows = node.normalized_rows ?? [];
    const r = extensions.evidence_verification.row;
    const c = extensions.evidence_verification.col;
    if (r < rows.length && c < (rows[r]?.length ?? 0)) {
      return { authority_level: 2, scheme, authoritative_locator_available: true, root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node, row_index: r, col_indices: [c], ambiguous: false, exact_match_count: 1, ambiguous_match_count: 0 };
    }
  }

  // Priority 3/4: node resolved by structure (NODE_ONLY_HASH /
  // NODE_ONLY_COLON), no row/col of its own -- fall back to evidence_span
  // text matching against the node's own cell grid.
  if (!node) {
    return { authority_level: 3, scheme, authoritative_locator_available: false, root_cause: ROOT_CAUSE.SOURCE_PARSE_LIMITATION, node: null, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0 };
  }
  if (node.kind !== "table") {
    return { authority_level: 3, scheme, authoritative_locator_available: false, root_cause: ROOT_CAUSE.NOT_A_VIOLATION, node, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0, node_kind: node.kind, is_table: false };
  }

  const textResolved = textResolveTableCell(node, evidenceSpanText);
  if (!textResolved.matched) {
    return { authority_level: 4, scheme, authoritative_locator_available: false, root_cause: ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE, node, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0 };
  }
  // A TIGHT match with >1 row is a genuine ambiguity: the same span text
  // recurs in multiple distinct rows with no authoritative signal to pick
  // one -- fail-closed, never guess using question/answer semantics.
  if (textResolved.ambiguous) {
    return { authority_level: 4, scheme, authoritative_locator_available: false, root_cause: ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS, node, row_index: textResolved.primary_row_index, col_indices: textResolved.col_indices, ambiguous: true, exact_match_count: 1, ambiguous_match_count: textResolved.matched_row_indices.length };
  }
  return {
    authority_level: 4, scheme, authoritative_locator_available: false, root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT,
    node, row_index: textResolved.primary_row_index, col_indices: textResolved.col_indices, ambiguous: false,
    exact_match_count: 1, ambiguous_match_count: 0, matched_row_indices: textResolved.matched_row_indices, is_multi_row_span: textResolved.is_multi_row_span,
  };
}
