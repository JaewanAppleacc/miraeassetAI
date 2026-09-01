import test from "node:test";
import assert from "node:assert/strict";
import { classifyGoldItemForTables, TABLE_ITEM_TAGS, tableBoilerplateDuplicateRowRatio } from "../domain/agent-comparison/chunking-comparison/table-item-classifier.mjs";

function makeCache({ tableNodeId = "doc1::f.xml::n0", rows = [["항목", "값"], ["매출액", "1,234"]], headerRowIndices = [], kind = "table", docId = "doc1" } = {}) {
  const nodes = [{ node_id: tableNodeId, kind, normalized_rows: rows, header_row_indices: headerRowIndices }];
  return new Map([[docId, { doc_id: docId, nodes }]]);
}

function item({ questionId = "q1", slots }) {
  return { question_id: questionId, question_type: "NUMERIC_LOOKUP", required_evidence_slots: slots };
}

test("classifyGoldItemForTables: real block_type (node.kind==='table') + source_locator resolution drives is_table_item, never the question text", () => {
  const cache = makeCache();
  const goldItem = item({ slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "1,234" }] }] });
  const result = classifyGoldItemForTables(goldItem, cache);
  assert.equal(result.is_table_item, true);
  assert.equal(result.table_source_count, 1);
});

test("classifyGoldItemForTables: a paragraph-kind node is NOT a table item (mechanical, not by question_type name)", () => {
  const cache = makeCache({ kind: "paragraph" });
  const goldItem = item({ question_type: "NUMERIC_LOOKUP", slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "값" }] }] });
  const result = classifyGoldItemForTables(goldItem, cache);
  assert.equal(result.is_table_item, false);
  assert.deepEqual(result.tags, []);
});

test("classifyGoldItemForTables: SINGLE_CELL_LOOKUP fires only for one row, one precisely-resolved cell", () => {
  const cache = makeCache({ rows: [["항목", "값"], ["매출액", "1,234"]] });
  const goldItem = item({ slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "1,234" }] }] });
  const result = classifyGoldItemForTables(goldItem, cache);
  assert.ok(result.tags.includes("SINGLE_CELL_LOOKUP"));
  assert.ok(result.tags.includes("ROW_HEADER_VALUE"));
});

test("classifyGoldItemForTables: MULTI_ROW_CALCULATION fires when 2+ distinct rows are resolved for one item", () => {
  const cache = makeCache({ rows: [["항목", "값"], ["매출액", "100"], ["영업이익", "20"]] });
  const goldItem = item({
    slots: [
      { slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "100" }] },
      { slot_name: "s2", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "20" }] },
    ],
  });
  const result = classifyGoldItemForTables(goldItem, cache);
  assert.ok(result.tags.includes("MULTI_ROW_CALCULATION"));
  assert.equal(result.distinct_rows_touched, 2);
});

test("classifyGoldItemForTables: CROSS_TABLE (same doc, 2 table nodes) vs CROSS_DOCUMENT_TABLE (2 docs)", () => {
  const nodes1 = [
    { node_id: "doc1::f.xml::n0", kind: "table", normalized_rows: [["a", "1"]], header_row_indices: [] },
    { node_id: "doc1::f.xml::n1", kind: "table", normalized_rows: [["b", "2"]], header_row_indices: [] },
  ];
  const cache = new Map([["doc1", { doc_id: "doc1", nodes: nodes1 }]]);
  const crossTableItem = item({
    slots: [
      { slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "1" }] },
      { slot_name: "s2", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n1", evidence_span: "2" }] },
    ],
  });
  assert.ok(classifyGoldItemForTables(crossTableItem, cache).tags.includes("CROSS_TABLE"));

  const cache2 = makeCache({ docId: "doc1", tableNodeId: "doc1::f.xml::n0" });
  const nodesDoc2 = [{ node_id: "doc2::f.xml::n0", kind: "table", normalized_rows: [["c", "3"]], header_row_indices: [] }];
  cache2.set("doc2", { doc_id: "doc2", nodes: nodesDoc2 });
  const crossDocItem = item({
    slots: [
      { slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "1,234" }] },
      { slot_name: "s2", acceptable_sources: [{ document_id: "doc2", source_locator: "doc2::f.xml::n0", evidence_span: "3" }] },
    ],
  });
  assert.ok(classifyGoldItemForTables(crossDocItem, cache2).tags.includes("CROSS_DOCUMENT_TABLE"));
});

test("classifyGoldItemForTables: an unresolvable node_id is counted, never silently dropped or crashed on", () => {
  const cache = makeCache();
  const goldItem = item({ slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n999", evidence_span: "x" }] }] });
  const result = classifyGoldItemForTables(goldItem, cache);
  assert.equal(result.is_table_item, false);
  assert.equal(result.unresolvable_source_count, 1);
});

test("classifyGoldItemForTables: an unresolvable CELL within a real table node counts separately from a missing node", () => {
  const cache = makeCache({ rows: [["항목", "값"]] });
  const goldItem = item({ slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "이 텍스트는 표에 없음" }] }] });
  const result = classifyGoldItemForTables(goldItem, cache);
  assert.equal(result.is_table_item, true);
  assert.equal(result.unresolvable_table_cell_count, 1);
});

test("classifyGoldItemForTables: is DETERMINISTIC -- identical input twice produces byte-identical output", () => {
  const cache = makeCache({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"], ["영업이익", "10", "20"]], headerRowIndices: [0] });
  const goldItem = item({
    slots: [
      { slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "200" }] },
      { slot_name: "s2", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "20" }] },
    ],
  });
  const r1 = classifyGoldItemForTables(goldItem, cache);
  const r2 = classifyGoldItemForTables(goldItem, cache);
  assert.deepEqual(r1, r2);
});

test("classifyGoldItemForTables: never reads item.question or item.expected_answer -- absent fields do not change or break classification", () => {
  const cache = makeCache();
  const bareItem = { question_id: "q1", question_type: "NUMERIC_LOOKUP", required_evidence_slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "1,234" }] }] };
  assert.doesNotThrow(() => classifyGoldItemForTables(bareItem, cache));
  const richItem = { ...bareItem, question: "질문 원문", expected_answer: "정답 원문" };
  assert.deepEqual(classifyGoldItemForTables(bareItem, cache), classifyGoldItemForTables(richItem, cache));
});

test("TABLE_ITEM_TAGS lists exactly the 9 tags this Turn's brief names", () => {
  assert.deepEqual([...TABLE_ITEM_TAGS].sort(), [
    "COLUMN_PERIOD_VALUE", "CROSS_DOCUMENT_TABLE", "CROSS_TABLE", "MULTI_COLUMN_COMPARISON", "MULTI_ROW_CALCULATION",
    "ROW_HEADER_VALUE", "SINGLE_CELL_LOOKUP", "TABLE_WITH_REPEATED_BOILERPLATE", "UNIT_SENSITIVE",
  ].sort());
});

test("tableBoilerplateDuplicateRowRatio: exact-duplicate rows raise the ratio, unique rows keep it at 0", () => {
  const dupNode = { normalized_rows: [["a", "1"], ["a", "1"], ["b", "2"]] };
  assert.ok(tableBoilerplateDuplicateRowRatio(dupNode) > 0);
  const uniqueNode = { normalized_rows: [["a", "1"], ["b", "2"], ["c", "3"]] };
  assert.equal(tableBoilerplateDuplicateRowRatio(uniqueNode), 0);
});
