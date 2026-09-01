import test from "node:test";
import assert from "node:assert/strict";
import { classifyLocatorScheme, resolveNodeForLocator, resolveAuthoritativeCell, LOCATOR_SCHEME, ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority.mjs";

function rawRecord(nodes) { return { doc_id: "doc1", nodes }; }
function tableNode({ relPath = "f.xml", orderIndex = 0, rows = [["항목", "값"], ["매출액", "1,234"]], headerRowIndices = [] } = {}) {
  return { node_id: `doc1::${relPath}::n${orderIndex}`, kind: "table", source: { rel_path: relPath, order_index: orderIndex }, normalized_rows: rows, header_row_indices: headerRowIndices };
}

test("classifyLocatorScheme: correctly identifies all 3 real Gold shapes", () => {
  assert.equal(classifyLocatorScheme("holding_20240403000410::20240403000410.xml::n0"), LOCATOR_SCHEME.NODE_ONLY_COLON);
  assert.equal(classifyLocatorScheme("holding_20240620000340/20240620000340.xml#node=0&row=4&col=2"), LOCATOR_SCHEME.CELL_QUALIFIED);
  assert.equal(classifyLocatorScheme("major_20241128001098/20241128001098.xml#node=9"), LOCATOR_SCHEME.NODE_ONLY_HASH);
  assert.equal(classifyLocatorScheme("garbage"), LOCATOR_SCHEME.UNRECOGNIZED);
});

test("resolveNodeForLocator: CELL_QUALIFIED resolves by rel_path+order_index, never by node_id string equality", () => {
  const node = tableNode({ relPath: "f.xml", orderIndex: 3 });
  const raw = rawRecord([node]);
  const { node: resolved, scheme } = resolveNodeForLocator(raw, "doc1/f.xml#node=3&row=1&col=1");
  assert.equal(scheme, LOCATOR_SCHEME.CELL_QUALIFIED);
  assert.equal(resolved, node);
});

test("cell-qualified locator takes PRIORITY over text search -- an authoritative row/col is used even when evidence_span text would resolve to a DIFFERENT row", () => {
  const node = tableNode({ rows: [["항목", "값"], ["매출액", "100"], ["영업이익", "100"]] }); // "100" appears in both row 1 and row 2
  const raw = rawRecord([node]);
  // locator explicitly points at row=2, col=1 -- even though evidence_span
  // text "100" would tight-match BOTH rows 1 and 2 (ambiguous by text
  // alone), the authoritative locator resolves it deterministically.
  const result = resolveAuthoritativeCell({ rawRecord: raw, locator: "doc1/f.xml#node=0&row=2&col=1", evidenceSpanText: "100" });
  assert.equal(result.authority_level, 1);
  assert.equal(result.root_cause, ROOT_CAUSE.GOLD_LOCATOR_EXACT);
  assert.equal(result.row_index, 2);
  assert.equal(result.ambiguous, false, "authoritative locator resolution is never ambiguous even when the text alone would be");
});

test("exact locator vs text search conflict: when they disagree, the locator wins and no text search is even attempted", () => {
  const node = tableNode({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"]] });
  const raw = rawRecord([node]);
  // evidence_span text ("200") would tight-match row 1 col 2 via text
  // search, but the locator explicitly names row=1,col=1 ("100") --
  // authority wins, the result must reflect the LOCATOR's cell.
  const result = resolveAuthoritativeCell({ rawRecord: raw, locator: "doc1/f.xml#node=0&row=1&col=1", evidenceSpanText: "200" });
  assert.equal(result.row_index, 1);
  assert.deepEqual(result.col_indices, [1]);
});

test("GOLD_LOCATOR_AMBIGUOUS: same evidence_span text appears in 2+ distinct rows with NO cell-qualified locator -- fail-closed, never guesses using an arbitrary first match", () => {
  const node = tableNode({ rows: [["항목A", "0"], ["항목B", "0"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCell({ rawRecord: raw, locator: node.node_id, evidenceSpanText: "0" });
  assert.equal(result.root_cause, ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS);
  assert.equal(result.ambiguous, true);
  assert.equal(result.ambiguous_match_count, 2);
});

test("a CELL_QUALIFIED locator with an out-of-range row/col is GOLD_LOCATOR_UNRESOLVABLE, never silently clamped", () => {
  const node = tableNode({ rows: [["항목", "값"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCell({ rawRecord: raw, locator: "doc1/f.xml#node=0&row=99&col=99", evidenceSpanText: "값" });
  assert.equal(result.root_cause, ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE);
});

test("a NODE_ONLY locator whose evidence_span matches nothing is GOLD_LOCATOR_UNRESOLVABLE (via priority-4 text search)", () => {
  const node = tableNode({ rows: [["항목", "값"]] });
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCell({ rawRecord: raw, locator: node.node_id, evidenceSpanText: "이 텍스트는 표에 없음" });
  assert.equal(result.root_cause, ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE);
});

test("extensions.evidence_verification (priority 2) is honored when present, ahead of text search", () => {
  const node = tableNode({ rows: [["항목", "100"], ["항목", "100"]] }); // ambiguous by text alone
  const raw = rawRecord([node]);
  const result = resolveAuthoritativeCell({
    rawRecord: raw, locator: node.node_id, evidenceSpanText: "100",
    extensions: { evidence_verification: { row: 1, col: 1 } },
  });
  assert.equal(result.authority_level, 2);
  assert.equal(result.row_index, 1);
  assert.equal(result.ambiguous, false);
});
