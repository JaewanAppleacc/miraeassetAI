// Integration test: TABLE_ROW sibling collapse + Gold row/column locator
// scoring, end to end -- item 7 of this Turn's "Parent-aware 검색 계약".
import test from "node:test";
import assert from "node:assert/strict";
import { collapseSiblings } from "../domain/agent-comparison/chunking-comparison/sibling-collapse.mjs";
import { computeItemMetrics } from "../domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs";

function tableRow(id, parentChunkId, rowStart, rowEnd, colStart, colEnd) {
  return {
    chunk_id: id, document_id: "major_20231026000201", parent_chunk_id: parentChunkId, chunk_type: "TABLE_ROW",
    source_spans: [{ order_index: 2, row_start: rowStart, row_end: rowEnd, col_start: colStart, col_end: colEnd }],
  };
}

const ITEM = {
  question_id: "q1", expected_answerability: "SUPPORTED",
  gold_document_ids: ["major_20231026000201"],
  required_evidence_slots: [{
    slot_name: "s1", description: "d",
    acceptable_sources: [{ document_id: "major_20231026000201", source_locator: "major_20231026000201/x.xml#node=2&row=3&col=1", evidence_span: "unused" }],
  }],
};

test("collapse keeps the highest-scoring TABLE_ROW sibling under the same TABLE_WHOLE parent, and only ITS row range is checked for the Gold hit", () => {
  const chunkById = new Map([
    ["row1", tableRow("row1", "table_p1", 0, 0, 0, 3)], // row 0 -- does not cover Gold row=3
    ["row_gold", tableRow("row_gold", "table_p1", 3, 3, 0, 3)], // row 3 -- covers Gold row=3,col=1
    ["row2", tableRow("row2", "table_p1", 4, 4, 0, 3)], // row 4 -- does not cover
  ]);
  // row_gold is NOT the top-scored sibling here -- row1 outranks it.
  const ranked = [{ id: "row1", score: 0.9 }, { id: "row2", score: 0.6 }, { id: "row_gold", score: 0.5 }];
  const collapsed = collapseSiblings(ranked, chunkById);
  assert.equal(collapsed.length, 1, "all 3 rows share one parent -- must collapse to a single group");
  assert.equal(collapsed[0].id, "row1", "the representative is the highest-scoring sibling (row1), not the Gold-covering one");

  const representativeChunks = collapsed.map((g) => chunkById.get(g.id));
  const metrics = computeItemMetrics(ITEM, representativeChunks);
  assert.equal(metrics.evidence_slot_coverage_fraction_at_k[10], 0, "row1 (the representative) does not itself cover row=3 -- collapse must not credit a hit via a DIFFERENT sibling's range");
});

test("when the Gold-covering row IS the top-scored sibling, it becomes the representative and scores a hit", () => {
  const chunkById = new Map([
    ["row1", tableRow("row1", "table_p1", 0, 0, 0, 3)],
    ["row_gold", tableRow("row_gold", "table_p1", 3, 3, 0, 3)],
  ]);
  const ranked = [{ id: "row_gold", score: 0.95 }, { id: "row1", score: 0.4 }];
  const collapsed = collapseSiblings(ranked, chunkById);
  assert.equal(collapsed[0].id, "row_gold");
  const metrics = computeItemMetrics(ITEM, collapsed.map((g) => chunkById.get(g.id)));
  assert.equal(metrics.evidence_slot_coverage_fraction_at_k[10], 1);
});

test("a representative row whose column range excludes the Gold column still misses, even if the row matches", () => {
  const chunkById = new Map([["row_wrong_col", tableRow("row_wrong_col", "table_p1", 3, 3, 5, 8)]]); // row matches (3) but col range 5-8 excludes Gold col=1
  const metrics = computeItemMetrics(ITEM, [chunkById.get("row_wrong_col")]);
  assert.equal(metrics.evidence_slot_coverage_fraction_at_k[10], 0);
});
