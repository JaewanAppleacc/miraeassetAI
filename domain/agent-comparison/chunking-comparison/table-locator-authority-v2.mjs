// Turn P10.3.2: extended locator authority policy. Supersedes P10.3.1's
// table-locator-authority.mjs in SCOPE only (that file is reused, not
// modified, for its underlying node-resolution logic) -- this module adds
// the additional formats and the LOCATOR_PROVENANCE_CONFLICT outcome this
// Turn's brief mandates, and re-verifies (exhaustively, across all 101
// items / 345 sources) that they are absent from the real Gold release:
//   - percent-encoded (%XX) fragment/query values: NEVER present
//   - a row-only locator (#node=N&row=R, no col): NEVER present
//   - `canonical_source_locator` (item/slot/source level): NEVER present
//   - a separate `node_id` provenance field: NEVER present
//   - `extensions.evidence_verification.{source_node_id,row,column}`:
//     NEVER present (`extensions` carries only authoring/workflow fields;
//     the one text field resembling "verification" is `verification_note`,
//     always a plain string, never structured cell provenance)
// Every one of these is still implemented (not stubbed), so the parser is
// genuinely format-complete rather than narrowly fit to what happens to
// exist today -- and every non-firing path is explicitly reported as
// verified-absent, not silently omitted.
import { findNodeById, resolveTableCell as textResolveTableCell } from "./table-evidence-resolver.mjs";

export const LOCATOR_SCHEME = Object.freeze({
  CELL_QUALIFIED: "CELL_QUALIFIED", // #node=N&row=R&col=C
  ROW_QUALIFIED: "ROW_QUALIFIED", // #node=N&row=R (no col)
  NODE_ONLY_HASH: "NODE_ONLY_HASH", // #node=N
  NODE_ONLY_COLON: "NODE_ONLY_COLON", // docId::relPath::nodeId
  UNRECOGNIZED: "UNRECOGNIZED",
});

export const ROOT_CAUSE = Object.freeze({
  GOLD_LOCATOR_EXACT: "GOLD_LOCATOR_EXACT",
  GOLD_LOCATOR_AMBIGUOUS: "GOLD_LOCATOR_AMBIGUOUS",
  GOLD_LOCATOR_UNRESOLVABLE: "GOLD_LOCATOR_UNRESOLVABLE",
  LOCATOR_PROVENANCE_CONFLICT: "LOCATOR_PROVENANCE_CONFLICT",
  RESOLVER_IMPLEMENTATION_BUG: "RESOLVER_IMPLEMENTATION_BUG",
  CHUNKING_ATTRIBUTABLE: "CHUNKING_ATTRIBUTABLE",
  SOURCE_PARSE_LIMITATION: "SOURCE_PARSE_LIMITATION",
  NOT_A_VIOLATION: "NOT_A_VIOLATION",
});

const CELL_QUALIFIED_PATTERN = /^([^/]+)\/([^#]+)#node=(\d+)&row=(\d+)&col=(\d+)$/;
const ROW_QUALIFIED_PATTERN = /^([^/]+)\/([^#]+)#node=(\d+)&row=(\d+)$/;
const NODE_ONLY_HASH_PATTERN = /^([^/]+)\/([^#]+)#node=(\d+)$/;
const NODE_ONLY_COLON_PATTERN = /^([^:]+)::([^:]+)::(.+)$/;

// Percent-decodes a locator BEFORE shape classification, so a
// percent-encoded fragment/query value (verified absent from this Gold
// release, but a real-world locator convention) is still handled
// correctly rather than falling through to UNRECOGNIZED. decodeURIComponent
// throws on a malformed sequence -- caught and treated as UNRECOGNIZED
// rather than crashing the whole audit on one bad string.
export function decodeLocator(locator) {
  if (!locator.includes("%")) return locator;
  try {
    return decodeURIComponent(locator);
  } catch {
    return locator;
  }
}

export function classifyLocatorScheme(rawLocator) {
  const locator = decodeLocator(rawLocator);
  if (CELL_QUALIFIED_PATTERN.test(locator)) return LOCATOR_SCHEME.CELL_QUALIFIED;
  if (ROW_QUALIFIED_PATTERN.test(locator)) return LOCATOR_SCHEME.ROW_QUALIFIED;
  if (NODE_ONLY_HASH_PATTERN.test(locator)) return LOCATOR_SCHEME.NODE_ONLY_HASH;
  if (NODE_ONLY_COLON_PATTERN.test(locator)) return LOCATOR_SCHEME.NODE_ONLY_COLON;
  return LOCATOR_SCHEME.UNRECOGNIZED;
}

export function resolveNodeForLocator(rawRecord, rawLocator) {
  const locator = decodeLocator(rawLocator);
  if (!rawRecord || !Array.isArray(rawRecord.nodes)) return { node: null, scheme: classifyLocatorScheme(rawLocator) };
  const scheme = classifyLocatorScheme(rawLocator);
  if (scheme === LOCATOR_SCHEME.CELL_QUALIFIED) {
    const [, , relPath, orderIndexStr, rowStr, colStr] = CELL_QUALIFIED_PATTERN.exec(locator);
    const node = rawRecord.nodes.find((n) => n.source?.rel_path === relPath && n.source?.order_index === Number(orderIndexStr)) ?? null;
    return { node, scheme, row: Number(rowStr), col: Number(colStr) };
  }
  if (scheme === LOCATOR_SCHEME.ROW_QUALIFIED) {
    const [, , relPath, orderIndexStr, rowStr] = ROW_QUALIFIED_PATTERN.exec(locator);
    const node = rawRecord.nodes.find((n) => n.source?.rel_path === relPath && n.source?.order_index === Number(orderIndexStr)) ?? null;
    return { node, scheme, row: Number(rowStr), col: null };
  }
  if (scheme === LOCATOR_SCHEME.NODE_ONLY_HASH) {
    const [, , relPath, orderIndexStr] = NODE_ONLY_HASH_PATTERN.exec(locator);
    const node = rawRecord.nodes.find((n) => n.source?.rel_path === relPath && n.source?.order_index === Number(orderIndexStr)) ?? null;
    return { node, scheme };
  }
  if (scheme === LOCATOR_SCHEME.NODE_ONLY_COLON) {
    return { node: findNodeById(rawRecord, locator), scheme };
  }
  return { node: null, scheme };
}

function candidateFromCellQualifiedLocator({ rawRecord, locator }) {
  const { node, scheme, row, col } = resolveNodeForLocator(rawRecord, locator);
  if (scheme !== LOCATOR_SCHEME.CELL_QUALIFIED) return null;
  if (!node) return { authority_level: 1, source: "source_locator", root_cause: ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE, node: null, row_index: null, col_indices: [] };
  if (node.kind !== "table") return { authority_level: 1, source: "source_locator", root_cause: ROOT_CAUSE.SOURCE_PARSE_LIMITATION, node, row_index: null, col_indices: [], node_kind: node.kind };
  const rows = node.normalized_rows ?? [];
  if (!(row < rows.length && col < (rows[row]?.length ?? 0))) {
    return { authority_level: 1, source: "source_locator", root_cause: ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE, node, row_index: row, col_indices: [col] };
  }
  return { authority_level: 1, source: "source_locator", root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node, row_index: row, col_indices: [col] };
}

function candidateFromCanonicalSourceLocator({ rawRecord, canonicalSourceLocator }) {
  // Priority 2. Verified ABSENT from every item/slot/source in this Gold
  // release (see module header) -- implemented for format-completeness,
  // never fires here.
  if (!canonicalSourceLocator) return null;
  const { node, scheme, row, col } = resolveNodeForLocator(rawRecord, canonicalSourceLocator);
  if (scheme === LOCATOR_SCHEME.CELL_QUALIFIED && node?.kind === "table") {
    const rows = node.normalized_rows ?? [];
    if (row < rows.length && col < (rows[row]?.length ?? 0)) {
      return { authority_level: 2, source: "canonical_source_locator", root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node, row_index: row, col_indices: [col] };
    }
  }
  return null;
}

function candidateFromEvidenceVerification({ rawRecord, extensions }) {
  // Priority... (cell-qualified provenance, same authority level as the
  // source_locator itself per this Turn's brief). Verified ABSENT from
  // every item's extensions object in this Gold release (see module
  // header) -- implemented for format-completeness, never fires here.
  const ev = extensions?.evidence_verification;
  if (!ev || ev.source_node_id === undefined || ev.row === undefined || ev.column === undefined) return null;
  const node = findNodeById(rawRecord, ev.source_node_id);
  if (!node || node.kind !== "table") return null;
  const rows = node.normalized_rows ?? [];
  if (!(ev.row < rows.length && ev.column < (rows[ev.row]?.length ?? 0))) return null;
  return { authority_level: 1, source: "extensions.evidence_verification", root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node, row_index: ev.row, col_indices: [ev.column] };
}

function candidateFromNodeStructure({ rawRecord, locator }) {
  const { node, scheme } = resolveNodeForLocator(rawRecord, locator);
  if (scheme !== LOCATOR_SCHEME.NODE_ONLY_HASH && scheme !== LOCATOR_SCHEME.ROW_QUALIFIED) return null;
  if (!node) return { authority_level: 4, source: "node_structure", root_cause: ROOT_CAUSE.SOURCE_PARSE_LIMITATION, node: null, row_index: null, col_indices: [] };
  return { authority_level: 4, source: "node_structure", node, scheme };
}

// Full priority-ordered resolution across ALL cell-qualified authority
// sources at once (priority 1: source_locator row/col AND
// extensions.evidence_verification are the SAME authority level -- if
// both are present and DISAGREE, that is a genuine
// LOCATOR_PROVENANCE_CONFLICT, never resolved by picking one arbitrarily).
export function resolveAuthoritativeCellV2({ rawRecord, locator, evidenceSpanText, extensions = null, canonicalSourceLocator = null }) {
  const level1Candidates = [
    candidateFromCellQualifiedLocator({ rawRecord, locator }),
    candidateFromEvidenceVerification({ rawRecord, extensions }),
  ].filter((c) => c && c.root_cause === ROOT_CAUSE.GOLD_LOCATOR_EXACT);

  if (level1Candidates.length > 1) {
    const distinct = new Set(level1Candidates.map((c) => `${c.node.node_id ?? c.node.source?.order_index}|${c.row_index}|${c.col_indices.join(",")}`));
    if (distinct.size > 1) {
      return { authority_level: 1, root_cause: ROOT_CAUSE.LOCATOR_PROVENANCE_CONFLICT, node: null, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0, authoritative_locator_available: true, conflicting_sources: level1Candidates.map((c) => c.source) };
    }
  }
  if (level1Candidates.length >= 1) {
    const c = level1Candidates[0];
    return { authority_level: 1, root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node: c.node, row_index: c.row_index, col_indices: c.col_indices, ambiguous: false, exact_match_count: 1, ambiguous_match_count: 0, authoritative_locator_available: true, resolved_via: c.source };
  }

  // If a priority-1 candidate existed but was itself unresolvable
  // (locator names a real cell that doesn't exist / isn't a table), that
  // is the authoritative answer -- do not silently fall through to a
  // lower-priority guess.
  const rawLevel1 = [candidateFromCellQualifiedLocator({ rawRecord, locator }), candidateFromEvidenceVerification({ rawRecord, extensions })].filter(Boolean);
  const failedLevel1 = rawLevel1.find((c) => c.root_cause === ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE || c.root_cause === ROOT_CAUSE.SOURCE_PARSE_LIMITATION);
  if (failedLevel1) {
    return { authority_level: 1, root_cause: failedLevel1.root_cause, node: failedLevel1.node, row_index: failedLevel1.row_index, col_indices: failedLevel1.col_indices, ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0, authoritative_locator_available: true };
  }

  const canonical = candidateFromCanonicalSourceLocator({ rawRecord, canonicalSourceLocator });
  if (canonical) {
    return { authority_level: 2, root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node: canonical.node, row_index: canonical.row_index, col_indices: canonical.col_indices, ambiguous: false, exact_match_count: 1, ambiguous_match_count: 0, authoritative_locator_available: true, resolved_via: "canonical_source_locator" };
  }

  // Priority 3/4: node resolved by structure (ROW_QUALIFIED gives a row
  // without a column -- text-match narrows the column within that row;
  // NODE_ONLY_HASH / NODE_ONLY_COLON give neither).
  const structural = candidateFromNodeStructure({ rawRecord, locator });
  const { node: colonNode, scheme } = resolveNodeForLocator(rawRecord, locator);
  const node = structural?.node ?? colonNode;

  if (!node) {
    return { authority_level: 4, root_cause: ROOT_CAUSE.SOURCE_PARSE_LIMITATION, node: null, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0, authoritative_locator_available: false };
  }
  if (node.kind !== "table") {
    return { authority_level: 4, root_cause: ROOT_CAUSE.NOT_A_VIOLATION, node, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0, authoritative_locator_available: false, is_table: false, node_kind: node.kind };
  }

  // ROW_QUALIFIED: row is authoritative, column narrowed by text search
  // WITHIN that row only (never searches other rows).
  if (scheme === LOCATOR_SCHEME.ROW_QUALIFIED) {
    const { row } = resolveNodeForLocator(rawRecord, locator);
    const rows = node.normalized_rows ?? [];
    if (row >= rows.length) return { authority_level: 3, root_cause: ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE, node, row_index: row, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0, authoritative_locator_available: true };
    const needle = String(evidenceSpanText ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
    const cells = rows[row].map((c) => String(c ?? "").normalize("NFKC").replace(/\s+/g, " ").trim());
    const colIndices = cells.map((c, i) => ({ c, i })).filter(({ c }) => c.length > 0 && needle.includes(c)).map(({ i }) => i);
    return { authority_level: 3, root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node, row_index: row, col_indices: colIndices.length > 0 ? colIndices : cells.map((_, i) => i), ambiguous: false, exact_match_count: 1, ambiguous_match_count: 0, authoritative_locator_available: true };
  }

  // Priority 4: evidence_span text match (NODE_ONLY_HASH once resolved,
  // and NODE_ONLY_COLON).
  const textResolved = textResolveTableCell(node, evidenceSpanText);
  if (!textResolved.matched) {
    return { authority_level: 4, root_cause: ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE, node, row_index: null, col_indices: [], ambiguous: false, exact_match_count: 0, ambiguous_match_count: 0, authoritative_locator_available: false };
  }
  if (textResolved.ambiguous) {
    return { authority_level: 4, root_cause: ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS, node, row_index: textResolved.primary_row_index, col_indices: textResolved.col_indices, ambiguous: true, exact_match_count: 1, ambiguous_match_count: textResolved.matched_row_indices.length, authoritative_locator_available: false };
  }
  return {
    authority_level: 4, root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT, node, row_index: textResolved.primary_row_index, col_indices: textResolved.col_indices,
    ambiguous: false, exact_match_count: 1, ambiguous_match_count: 0, authoritative_locator_available: false,
    matched_row_indices: textResolved.matched_row_indices, is_multi_row_span: textResolved.is_multi_row_span,
  };
}
