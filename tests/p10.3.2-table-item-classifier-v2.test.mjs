import test from "node:test";
import assert from "node:assert/strict";
import { classifyGoldItemForTablesV2 } from "../domain/agent-comparison/chunking-comparison/table-item-classifier-v2.mjs";

function makeCache({ tableNodeId = "doc1::f.xml::n0", relPath = "f.xml", orderIndex = 0, rows = [["항목", "값"], ["매출액", "1,234"]], kind = "table", docId = "doc1" } = {}) {
  const nodes = [{ node_id: tableNodeId, kind, source: { rel_path: relPath, order_index: orderIndex }, normalized_rows: rows, header_row_indices: [] }];
  return new Map([[docId, { doc_id: docId, nodes }]]);
}
function item({ questionId = "q1", slots }) {
  return { question_id: questionId, question_type: "NUMERIC_LOOKUP", required_evidence_slots: slots, extensions: null };
}

test("classifyGoldItemForTablesV2: a CELL_QUALIFIED source alone (no text-matchable evidence_span needed) resolves as a table item", () => {
  const cache = makeCache();
  const goldItem = item({ slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1/f.xml#node=0&row=1&col=1", evidence_span: "anything, unused when the locator is authoritative" }] }] });
  const result = classifyGoldItemForTablesV2(goldItem, cache);
  assert.equal(result.is_table_item, true);
  assert.equal(result.table_source_count, 1);
});

test("classifyGoldItemForTablesV2: a CELL_QUALIFIED source is NEVER silently missed the way P10.3's original resolver missed it", () => {
  const cache = makeCache({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"]] });
  const goldItem = item({ slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1/f.xml#node=0&row=1&col=2", evidence_span: "irrelevant text not present anywhere in the table" }] }] });
  const result = classifyGoldItemForTablesV2(goldItem, cache);
  assert.equal(result.is_table_item, true, "CELL_QUALIFIED authority must resolve regardless of whether evidence_span text-matches anything");
});

test("classifyGoldItemForTablesV2: non-table node kind is correctly excluded", () => {
  const cache = makeCache({ kind: "paragraph" });
  const goldItem = item({ slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1::f.xml::n0", evidence_span: "값" }] }] });
  assert.equal(classifyGoldItemForTablesV2(goldItem, cache).is_table_item, false);
});

test("classifyGoldItemForTablesV2 is deterministic", () => {
  const cache = makeCache({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"]] });
  const goldItem = item({ slots: [{ slot_name: "s1", acceptable_sources: [{ document_id: "doc1", source_locator: "doc1/f.xml#node=0&row=1&col=1", evidence_span: "100" }] }] });
  const r1 = classifyGoldItemForTablesV2(goldItem, cache);
  const r2 = classifyGoldItemForTablesV2(goldItem, cache);
  assert.deepEqual(r1, r2);
});
