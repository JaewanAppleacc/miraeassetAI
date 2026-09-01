import test from "node:test";
import assert from "node:assert/strict";
import { resolveTableCell, findNodeById, findUnitDeclaringRows, rowHasUnitToken } from "../domain/agent-comparison/chunking-comparison/table-evidence-resolver.mjs";

function tableNode(rows, headerRowIndices = []) {
  return { kind: "table", node_id: "doc::file.xml::n0", normalized_rows: rows, header_row_indices: headerRowIndices };
}

test("resolveTableCell: tight match resolves a single row + specific column precisely", () => {
  const node = tableNode([["항목", "값"], ["매출액", "1,234"]]);
  const resolved = resolveTableCell(node, "1,234");
  assert.equal(resolved.matched, true);
  assert.equal(resolved.primary_row_index, 1);
  assert.equal(resolved.ambiguous, false);
  assert.equal(resolved.is_multi_row_span, false);
  assert.equal(resolved.col_resolution, "PRECISE");
  assert.deepEqual(resolved.precise_col_indices, [1]);
});

test("resolveTableCell: a broad citation spanning multiple rows is a multi-row span, not ambiguous", () => {
  const node = tableNode([["항목", "전기", "당기"], ["매출액", "100", "200"], ["영업이익", "10", "20"]]);
  const evidenceSpan = "항목 | 전기 | 당기\n매출액 | 100 | 200\n영업이익 | 10 | 20";
  const resolved = resolveTableCell(node, evidenceSpan);
  assert.equal(resolved.matched, true);
  assert.equal(resolved.is_multi_row_span, true);
  assert.equal(resolved.ambiguous, false);
  assert.ok(resolved.matched_row_indices.length >= 2);
});

test("resolveTableCell: the SAME short value repeating in two distinct rows is a genuine tight-match ambiguity", () => {
  const node = tableNode([["항목A", "0"], ["항목B", "0"]]);
  const resolved = resolveTableCell(node, "0");
  assert.equal(resolved.matched, true);
  assert.equal(resolved.ambiguous, true);
  assert.deepEqual(resolved.matched_row_indices, [0, 1]);
});

test("resolveTableCell: a citation with no textual overlap anywhere is unresolved, never silently guessed", () => {
  const node = tableNode([["항목", "값"], ["매출액", "1,234"]]);
  const resolved = resolveTableCell(node, "이 문자열은 표 어디에도 없음");
  assert.equal(resolved.matched, false);
  assert.equal(resolved.primary_row_index, null);
});

test("resolveTableCell: empty normalized_rows never throws, returns unmatched", () => {
  const node = { kind: "table", normalized_rows: [], header_row_indices: [] };
  const resolved = resolveTableCell(node, "anything");
  assert.equal(resolved.matched, false);
});

test("resolveTableCell: header_row_indices is passed through for downstream column/period checks", () => {
  const node = tableNode([["항목", "전기", "당기"], ["매출액", "100", "200"]], [0]);
  const resolved = resolveTableCell(node, "200");
  assert.deepEqual(resolved.header_row_indices, [0]);
});

test("findNodeById: exact node_id match, and null for an absent id (fail-closed, never a fuzzy fallback)", () => {
  const raw = { nodes: [{ node_id: "doc::f.xml::n3", kind: "paragraph" }] };
  assert.equal(findNodeById(raw, "doc::f.xml::n3").kind, "paragraph");
  assert.equal(findNodeById(raw, "doc::f.xml::n999"), null);
  assert.equal(findNodeById(null, "doc::f.xml::n3"), null);
});

test("findUnitDeclaringRows: detects a Korean unit-declaration row (단위: + a unit token)", () => {
  const node = tableNode([["(단위: 백만원)"], ["매출액", "1,234"]]);
  assert.deepEqual(findUnitDeclaringRows(node), [0]);
});

test("findUnitDeclaringRows: a row with a unit token but no explicit 단위 declaration does not count", () => {
  const node = tableNode([["매출액", "100원"], ["영업이익", "20원"]]);
  assert.deepEqual(findUnitDeclaringRows(node), []);
});

test("rowHasUnitToken: true only for a row actually containing a declared unit token", () => {
  const node = tableNode([["매출액", "100백만원"], ["종업원수", "50명"]]);
  assert.equal(rowHasUnitToken(node, 0), true);
  assert.equal(rowHasUnitToken(node, 1), false);
});
