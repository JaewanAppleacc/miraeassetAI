// Turn P10.3.1 / Stage 2: given the authoritative resolution result for a
// Gold acceptable_source (from table-locator-authority.mjs) and, where
// applicable, P10.3's ORIGINAL recorded critical_violation for the same
// (node_id, row_index) cell, decides the final root_cause classification.
import { ROOT_CAUSE } from "./table-locator-authority.mjs";

// A table node's row-to-row column-count irregularity (actual_col_counts
// varying across rows) is a real, code-checkable parser signal -- when an
// evidence_span's words are all present in the best-matching row's text
// but simple substring containment still fails, this irregularity is the
// most defensible, evidence-grounded explanation (vs. guessing at Gold
// intent or blaming the resolver for logic that works correctly on
// regular tables elsewhere in the same corpus).
export function hasIrregularColumnCounts(node) {
  const counts = node?.actual_col_counts ?? [];
  if (counts.length < 2) return false;
  return new Set(counts).size > 1;
}

// Classifies an UNRESOLVABLE source (evidence_span matched no row at all
// under the text-matching fallback). Distinguishes a genuine parser
// structural limitation from an unexplained Gold-side gap.
export function classifyUnresolvableSource({ node }) {
  if (!node) return ROOT_CAUSE.SOURCE_PARSE_LIMITATION;
  if (hasIrregularColumnCounts(node)) return ROOT_CAUSE.SOURCE_PARSE_LIMITATION;
  return ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE;
}

// Classifies ONE of P10.3's originally-recorded critical_violations
// (violationType + the underlying authoritative resolution for that same
// cell). Only reached for cells P10.3 successfully resolved and recorded
// a violation against -- so authoritativeResult.root_cause is always
// GOLD_LOCATOR_EXACT or GOLD_LOCATOR_AMBIGUOUS here.
export function classifyRecordedViolation({ violationType, authoritativeResult }) {
  if (authoritativeResult.root_cause === ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS) {
    return ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS;
  }
  if (authoritativeResult.root_cause !== ROOT_CAUSE.GOLD_LOCATOR_EXACT) {
    // Should not happen for a cell P10.3 already resolved and recorded a
    // violation for -- fail closed rather than silently mislabeling.
    return ROOT_CAUSE.RESOLVER_IMPLEMENTATION_BUG;
  }
  // The underlying cell is unambiguous and authoritatively resolved. Every
  // one of P10.3's 3 recordable violation types is, by construction of
  // table-structure-preservation.mjs, a literal TEXT-containment failure
  // in the chunk's raw_text (never a metadata-only check) -- so a real
  // violation on an unambiguous cell is a genuine chunking artifact.
  if (violationType === "LOCATOR_RESOLVES_TO_WRONG_CELL" || violationType === "PERIOD_COLUMN_VALUE_MISMATCH" || violationType === "UNIT_MISSING_OR_MISCOMBINED" || violationType === "ROW_HEADER_VALUE_MISMATCH" || violationType === "GOLD_CELLS_NOT_RECOVERABLE") {
    return ROOT_CAUSE.CHUNK_BOUNDARY_CONTEXT_LOSS;
  }
  return ROOT_CAUSE.NOT_A_VIOLATION;
}

export function buildAuditFields({ authoritativeResult, rootCause }) {
  const chunkAttributable = rootCause === ROOT_CAUSE.CHUNK_BOUNDARY_CONTEXT_LOSS || rootCause === ROOT_CAUSE.CHUNK_METADATA_LOSS;
  const goldAttributable = rootCause === ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS || rootCause === ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE;
  const parserAttributable = rootCause === ROOT_CAUSE.SOURCE_PARSE_LIMITATION;
  const resolverAttributable = rootCause === ROOT_CAUSE.RESOLVER_IMPLEMENTATION_BUG;
  return {
    authoritative_locator_available: authoritativeResult.authoritative_locator_available,
    exact_match_count: authoritativeResult.exact_match_count,
    ambiguous_match_count: authoritativeResult.ambiguous_match_count,
    chunk_attributable: chunkAttributable,
    gold_attributable: goldAttributable,
    parser_attributable: parserAttributable,
    resolver_attributable: resolverAttributable,
  };
}
