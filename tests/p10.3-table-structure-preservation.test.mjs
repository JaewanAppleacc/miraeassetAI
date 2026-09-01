import test from "node:test";
import assert from "node:assert/strict";
import {
  findChunksClaimingRow, rowFullyPresentInChunk, evaluateCellPreservation, evaluateUnitPreservation, evaluateAmbiguousNumericCollision,
} from "../domain/agent-comparison/chunking-comparison/table-structure-preservation.mjs";

const NODE_ID = "doc1::f.xml::n0";
function node(rows, headerRowIndices = []) {
  return { normalized_rows: rows, header_row_indices: headerRowIndices };
}
function chunk({ chunkIndex, rawText, spans, sectionPath = [] }) {
  return { chunk_id: `chunk_${chunkIndex}`, chunk_index: chunkIndex, raw_text: rawText, source_spans: spans, section_path: sectionPath };
}
function span(rowStart, rowEnd) {
  return { node_id: NODE_ID, row_start: rowStart, row_end: rowEnd, col_start: 0, col_end: 1 };
}

test("findChunksClaimingRow: matches by node_id + row overlap, exactly mirroring chunker.mjs's own span semantics", () => {
  const chunks = [
    chunk({ chunkIndex: 0, rawText: "항목 | 값\n매출액 | 100", spans: [span(0, 1)] }),
    chunk({ chunkIndex: 1, rawText: "영업이익 | 10", spans: [span(2, 2)] }),
  ];
  assert.equal(findChunksClaimingRow(chunks, NODE_ID, 1).length, 1);
  assert.equal(findChunksClaimingRow(chunks, NODE_ID, 2)[0].chunk_id, "chunk_1");
  assert.equal(findChunksClaimingRow(chunks, "other-node", 1).length, 0);
});

test("rowFullyPresentInChunk: true when the row's full joined text is literally in raw_text, false when truncated", () => {
  const n = node([["항목", "전기", "당기"], ["매출액", "100", "200"]]);
  const fullChunk = chunk({ chunkIndex: 0, rawText: "매출액 | 100 | 200", spans: [span(1, 1)] });
  const truncatedChunk = chunk({ chunkIndex: 0, rawText: "매출액 | 100", spans: [span(1, 1)] });
  assert.equal(rowFullyPresentInChunk(n, 1, fullChunk), true);
  assert.equal(rowFullyPresentInChunk(n, 1, truncatedChunk), false);
});

test("evaluateCellPreservation: row header co-located with value -> row_header_preserved true", () => {
  const n = node([["매출액", "1,234"]]);
  const chunks = [chunk({ chunkIndex: 0, rawText: "매출액 | 1,234", spans: [span(0, 0)] })];
  const result = evaluateCellPreservation({ node: n, nodeId: NODE_ID, rowIndex: 0, chunks });
  assert.equal(result.gold_cell_retrievable, true);
  assert.equal(result.row_header_applicable, true);
  assert.equal(result.row_header_preserved, true);
});

test("evaluateCellPreservation: a row whose full text never lands in ANY claiming chunk is a real boundary_fracture (row header separation)", () => {
  const n = node([["매출액", "1,234"]]);
  // The chunk claims the row (span says so) but its raw_text was truncated
  // (simulates a Fixed-window boundary cutting mid-row) -- header/value
  // separated from what's actually retrievable.
  const chunks = [chunk({ chunkIndex: 0, rawText: "매출액", spans: [span(0, 0)] })];
  const result = evaluateCellPreservation({ node: n, nodeId: NODE_ID, rowIndex: 0, chunks });
  assert.equal(result.gold_cell_retrievable, false);
  assert.equal(result.boundary_fracture, true);
  assert.equal(result.locator_misrepresentation, true, "the span claims row coverage the raw_text does not support");
});

test("evaluateCellPreservation: column/period header separation -- header row and value row in DIFFERENT chunks -> column_header_preserved false", () => {
  const n = node([["항목", "전기", "당기"], ["매출액", "100", "200"]], [0]);
  const chunks = [
    chunk({ chunkIndex: 0, rawText: "항목 | 전기 | 당기", spans: [span(0, 0)] }),
    chunk({ chunkIndex: 1, rawText: "매출액 | 100 | 200", spans: [span(1, 1)] }),
  ];
  const result = evaluateCellPreservation({ node: n, nodeId: NODE_ID, rowIndex: 1, chunks });
  assert.equal(result.column_header_applicable, true);
  assert.equal(result.column_header_preserved, false);
});

test("evaluateCellPreservation: column/period header co-located in the SAME chunk -> column_header_preserved true", () => {
  const n = node([["항목", "전기", "당기"], ["매출액", "100", "200"]], [0]);
  const chunks = [chunk({ chunkIndex: 0, rawText: "항목 | 전기 | 당기\n매출액 | 100 | 200", spans: [span(0, 1)] })];
  const result = evaluateCellPreservation({ node: n, nodeId: NODE_ID, rowIndex: 1, chunks });
  assert.equal(result.column_header_preserved, true);
});

test("evaluateCellPreservation: section_path context reaching the chunk (what actually flows into embed_text) drives table_title_preserved", () => {
  const n = node([["매출액", "100"]]);
  const withSection = chunk({ chunkIndex: 0, rawText: "매출액 | 100", spans: [span(0, 0)], sectionPath: ["재무제표"] });
  const withoutSection = chunk({ chunkIndex: 0, rawText: "매출액 | 100", spans: [span(0, 0)], sectionPath: [] });
  assert.equal(evaluateCellPreservation({ node: n, nodeId: NODE_ID, rowIndex: 0, chunks: [withSection] }).table_title_preserved, true);
  assert.equal(evaluateCellPreservation({ node: n, nodeId: NODE_ID, rowIndex: 0, chunks: [withoutSection] }).table_title_preserved, false);
});

test("evaluateUnitPreservation: not applicable when no unit-declaring row exists (never fabricates a violation from nothing)", () => {
  const n = node([["매출액", "100"]]);
  const result = evaluateUnitPreservation({ node: n, nodeId: NODE_ID, rowIndex: 0, unitDeclaringRowIndices: [], chunks: [] });
  assert.equal(result.unit_applicable, false);
  assert.equal(result.unit_preserved, null);
});

test("evaluateUnitPreservation: unit row co-located with value row -> preserved true; separated -> false", () => {
  const n = node([["(단위: 백만원)"], ["매출액", "100"]]);
  const together = [chunk({ chunkIndex: 0, rawText: "(단위: 백만원)\n매출액 | 100", spans: [span(0, 1)] })];
  const separated = [
    chunk({ chunkIndex: 0, rawText: "(단위: 백만원)", spans: [span(0, 0)] }),
    chunk({ chunkIndex: 1, rawText: "매출액 | 100", spans: [span(1, 1)] }),
  ];
  assert.equal(evaluateUnitPreservation({ node: n, nodeId: NODE_ID, rowIndex: 1, unitDeclaringRowIndices: [0], chunks: together }).unit_preserved, true);
  assert.equal(evaluateUnitPreservation({ node: n, nodeId: NODE_ID, rowIndex: 1, unitDeclaringRowIndices: [0], chunks: separated }).unit_preserved, false);
});

test("evaluateAmbiguousNumericCollision: the SAME value appearing in a different row is a real collision risk", () => {
  const n = node([["항목A", "0"], ["항목B", "0"]]);
  const collision = evaluateAmbiguousNumericCollision({ node: n, rowIndex: 0, colIndices: [1] });
  assert.equal(collision.applicable, true);
  assert.equal(collision.collision, true);
});

test("evaluateAmbiguousNumericCollision: a value unique to its own row has no collision", () => {
  const n = node([["항목A", "1,234"], ["항목B", "5,678"]]);
  const result = evaluateAmbiguousNumericCollision({ node: n, rowIndex: 0, colIndices: [1] });
  assert.equal(result.collision, false);
});
