import test from "node:test";
import assert from "node:assert/strict";
import { classifyLocatorScheme, resolveNodeForLocator, resolveAuthoritativeCellV2, decodeLocator, LOCATOR_SCHEME, ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority-v2.mjs";

function rawRecord(nodes) { return { doc_id: "doc1", nodes }; }
function tableNode({ relPath = "f.xml", orderIndex = 0, rows = [["항목", "값"], ["매출액", "1,234"]], headerRowIndices = [] } = {}) {
  return { node_id: `doc1::${relPath}::n${orderIndex}`, kind: "table", source: { rel_path: relPath, order_index: orderIndex }, normalized_rows: rows, header_row_indices: headerRowIndices };
}

test("node/row/column locator parsing: all 4 hash-based shapes classify and resolve correctly", () => {
  assert.equal(classifyLocatorScheme("doc1/f.xml#node=0"), LOCATOR_SCHEME.NODE_ONLY_HASH);
  assert.equal(classifyLocatorScheme("doc1/f.xml#node=0&row=2"), LOCATOR_SCHEME.ROW_QUALIFIED);
  assert.equal(classifyLocatorScheme("doc1/f.xml#node=0&row=2&col=1"), LOCATOR_SCHEME.CELL_QUALIFIED);
  assert.equal(classifyLocatorScheme("doc1::f.xml::n0"), LOCATOR_SCHEME.NODE_ONLY_COLON);
});

test("percent-encoded locator parsing: a %XX-encoded fragment decodes before shape classification", () => {
  // "doc1/f.xml#node=0&row=2&col=1" with the '#' percent-encoded as %23
  const encoded = "doc1/f.xml%23node=0&row=2&col=1";
  assert.equal(decodeLocator(encoded), "doc1/f.xml#node=0&row=2&col=1");
  assert.equal(classifyLocatorScheme(encoded), LOCATOR_SCHEME.CELL_QUALIFIED);
});

test("percent-encoded locator parsing: a malformed %-sequence never throws, falls back to the raw string", () => {
  assert.doesNotThrow(() => decodeLocator("doc1/f.xml#node=0%"));
});

test("ROW_QUALIFIED locator: row is authoritative, column narrowed by text search WITHIN that row only", () => {
  const node = tableNode({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCellV2({ rawRecord: raw, locator: "doc1/f.xml#node=0&row=1", evidenceSpanText: "200" });
  assert.equal(result.authority_level, 3);
  assert.equal(result.row_index, 1);
  assert.deepEqual(result.col_indices, [2]);
});

test("extensions.evidence_verification takes priority over evidence_span text search, resolving an otherwise-ambiguous cell", () => {
  const node = tableNode({ rows: [["항목", "100"], ["항목", "100"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCellV2({
    rawRecord: raw, locator: node.node_id, evidenceSpanText: "100",
    extensions: { evidence_verification: { source_node_id: node.node_id, row: 1, column: 1 } },
  });
  assert.equal(result.root_cause, ROOT_CAUSE.GOLD_LOCATOR_EXACT);
  assert.equal(result.row_index, 1);
  assert.equal(result.ambiguous, false);
});

test("canonical_source_locator takes priority when the source_locator itself is only node-level", () => {
  const node = tableNode({ rows: [["항목", "100"], ["항목", "200"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCellV2({
    rawRecord: raw, locator: node.node_id, evidenceSpanText: "100",
    canonicalSourceLocator: "doc1/f.xml#node=0&row=1&col=1",
  });
  assert.equal(result.row_index, 1);
  assert.equal(result.resolved_via ?? "canonical_source_locator", "canonical_source_locator");
});

test("LOCATOR_PROVENANCE_CONFLICT: source_locator and extensions.evidence_verification disagree on the same cell -- fail-closed, never picks either arbitrarily", () => {
  const node = tableNode({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"], ["영업이익", "10", "20"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCellV2({
    rawRecord: raw, locator: "doc1/f.xml#node=0&row=1&col=1", evidenceSpanText: "100",
    extensions: { evidence_verification: { source_node_id: node.node_id, row: 2, column: 1 } }, // disagrees: row 2 vs row 1
  });
  assert.equal(result.root_cause, ROOT_CAUSE.LOCATOR_PROVENANCE_CONFLICT);
  assert.equal(result.row_index, null, "a conflict must never silently resolve to either candidate's cell");
});

test("agreeing priority-1 sources (same cell from both source_locator and evidence_verification) resolve cleanly, not as a conflict", () => {
  const node = tableNode({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCellV2({
    rawRecord: raw, locator: "doc1/f.xml#node=0&row=1&col=1", evidenceSpanText: "100",
    extensions: { evidence_verification: { source_node_id: node.node_id, row: 1, column: 1 } },
  });
  assert.equal(result.root_cause, ROOT_CAUSE.GOLD_LOCATOR_EXACT);
  assert.equal(result.row_index, 1);
});

test("ambiguous span fail-closed: text-only resolution with 2+ tight matches is GOLD_LOCATOR_AMBIGUOUS, never an arbitrary first pick", () => {
  const node = tableNode({ rows: [["항목A", "0"], ["항목B", "0"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCellV2({ rawRecord: raw, locator: node.node_id, evidenceSpanText: "0" });
  assert.equal(result.root_cause, ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS);
});

test("a CELL_QUALIFIED locator naming an out-of-range cell is GOLD_LOCATOR_UNRESOLVABLE, and this is authoritative -- no fallback to text search", () => {
  const node = tableNode({ rows: [["항목", "값"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCellV2({ rawRecord: raw, locator: "doc1/f.xml#node=0&row=99&col=99", evidenceSpanText: "값" });
  assert.equal(result.root_cause, ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE);
});
