import test from "node:test";
import assert from "node:assert/strict";
import { hasIrregularColumnCounts, classifyUnresolvableSource, classifyRecordedViolation, buildAuditFields } from "../domain/agent-comparison/chunking-comparison/table-audit-classifier.mjs";
import { ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority.mjs";

test("hasIrregularColumnCounts: detects varying per-row column counts (real signal found in all 4 P10.3 unresolvable sources)", () => {
  assert.equal(hasIrregularColumnCounts({ actual_col_counts: [4, 4, 4, 3, 3] }), true);
  assert.equal(hasIrregularColumnCounts({ actual_col_counts: [4, 4, 4, 4] }), false);
  assert.equal(hasIrregularColumnCounts({ actual_col_counts: [] }), false);
  assert.equal(hasIrregularColumnCounts({}), false);
});

test("classifyUnresolvableSource: parser limitation classification when column counts are irregular", () => {
  const node = { actual_col_counts: [4, 4, 3, 3] };
  assert.equal(classifyUnresolvableSource({ node }), ROOT_CAUSE.SOURCE_PARSE_LIMITATION);
});

test("classifyUnresolvableSource: falls back to GOLD_LOCATOR_UNRESOLVABLE when no parser irregularity explains it", () => {
  const node = { actual_col_counts: [4, 4, 4, 4] };
  assert.equal(classifyUnresolvableSource({ node }), ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE);
});

test("classifyUnresolvableSource: no node at all is a parse limitation, never silently swallowed", () => {
  assert.equal(classifyUnresolvableSource({ node: null }), ROOT_CAUSE.SOURCE_PARSE_LIMITATION);
});

test("classifyRecordedViolation: GOLD_LOCATOR_AMBIGUOUS cell -> the violation is reclassified as ambiguity, not a chunking defect (chunk boundary loss reproduction guard)", () => {
  const rootCause = classifyRecordedViolation({ violationType: "PERIOD_COLUMN_VALUE_MISMATCH", authoritativeResult: { root_cause: ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS } });
  assert.equal(rootCause, ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS);
});

test("classifyRecordedViolation: an unambiguous, authoritatively-resolved cell with a real violation IS a chunk boundary loss (reproduces P10.3's genuine violations)", () => {
  for (const violationType of ["LOCATOR_RESOLVES_TO_WRONG_CELL", "PERIOD_COLUMN_VALUE_MISMATCH", "UNIT_MISSING_OR_MISCOMBINED", "ROW_HEADER_VALUE_MISMATCH"]) {
    const rootCause = classifyRecordedViolation({ violationType, authoritativeResult: { root_cause: ROOT_CAUSE.GOLD_LOCATOR_EXACT } });
    assert.equal(rootCause, ROOT_CAUSE.CHUNK_BOUNDARY_CONTEXT_LOSS, `${violationType} should be chunk-attributable when the cell is unambiguous`);
  }
});

test("classifyRecordedViolation: an inconsistent state (violation recorded but underlying cell not exact/ambiguous) fails closed to RESOLVER_IMPLEMENTATION_BUG rather than guessing", () => {
  const rootCause = classifyRecordedViolation({ violationType: "UNIT_MISSING_OR_MISCOMBINED", authoritativeResult: { root_cause: ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE } });
  assert.equal(rootCause, ROOT_CAUSE.RESOLVER_IMPLEMENTATION_BUG);
});

test("buildAuditFields: chunk_attributable is true ONLY for CHUNK_BOUNDARY_CONTEXT_LOSS / CHUNK_METADATA_LOSS, mutually exclusive from gold/parser/resolver attribution", () => {
  const chunkFields = buildAuditFields({ authoritativeResult: {}, rootCause: ROOT_CAUSE.CHUNK_BOUNDARY_CONTEXT_LOSS });
  assert.equal(chunkFields.chunk_attributable, true);
  assert.equal(chunkFields.gold_attributable, false);
  assert.equal(chunkFields.parser_attributable, false);
  assert.equal(chunkFields.resolver_attributable, false);

  const goldFields = buildAuditFields({ authoritativeResult: {}, rootCause: ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS });
  assert.equal(goldFields.gold_attributable, true);
  assert.equal(goldFields.chunk_attributable, false);

  const parserFields = buildAuditFields({ authoritativeResult: {}, rootCause: ROOT_CAUSE.SOURCE_PARSE_LIMITATION });
  assert.equal(parserFields.parser_attributable, true);
  assert.equal(parserFields.chunk_attributable, false);

  const resolverFields = buildAuditFields({ authoritativeResult: {}, rootCause: ROOT_CAUSE.RESOLVER_IMPLEMENTATION_BUG });
  assert.equal(resolverFields.resolver_attributable, true);
  assert.equal(resolverFields.chunk_attributable, false);
});

test("buildAuditFields: CHUNK_METADATA_LOSS also counts as chunk_attributable (Stage 3 excludes it from neither category)", () => {
  const fields = buildAuditFields({ authoritativeResult: {}, rootCause: ROOT_CAUSE.CHUNK_METADATA_LOSS });
  assert.equal(fields.chunk_attributable, true);
});
