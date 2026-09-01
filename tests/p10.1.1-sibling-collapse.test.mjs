import test from "node:test";
import assert from "node:assert/strict";
import { collapseSiblings, siblingCrowdingDiagnostics } from "../domain/agent-comparison/chunking-comparison/sibling-collapse.mjs";

function chunk(id, parentChunkId, chunkType = "PARAGRAPH_CHILD", documentId = "d1") {
  return { chunk_id: id, parent_chunk_id: parentChunkId, chunk_type: chunkType, document_id: documentId };
}

test("collapseSiblings: groups children sharing the same parent_chunk_id, keeping only the highest-scoring representative", () => {
  const chunkById = new Map([
    ["c1", chunk("c1", "p1")],
    ["c2", chunk("c2", "p1")],
    ["c3", chunk("c3", "p1")],
  ]);
  const ranked = [{ id: "c2", score: 0.9 }, { id: "c1", score: 0.5 }, { id: "c3", score: 0.7 }];
  const collapsed = collapseSiblings(ranked, chunkById);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].id, "c2");
  assert.deepEqual(collapsed[0].memberIds.sort(), ["c1", "c2", "c3"]);
});

test("collapseSiblings: a chunk with no parent_chunk_id is its own singleton group", () => {
  const chunkById = new Map([["c1", chunk("c1", null)], ["c2", chunk("c2", null)]]);
  const ranked = [{ id: "c1", score: 0.5 }, { id: "c2", score: 0.4 }];
  const collapsed = collapseSiblings(ranked, chunkById);
  assert.equal(collapsed.length, 2);
});

test("collapseSiblings: exact score ties within a group break by chunk_id ascending", () => {
  const chunkById = new Map([["c_b", chunk("c_b", "p1")], ["c_a", chunk("c_a", "p1")]]);
  const ranked = [{ id: "c_b", score: 0.5 }, { id: "c_a", score: 0.5 }];
  const collapsed = collapseSiblings(ranked, chunkById);
  assert.equal(collapsed[0].id, "c_a");
});

test("collapseSiblings: group score is the representative's own score, never the sum/aggregate of members", () => {
  const chunkById = new Map([
    ["strong", chunk("strong", "p1")], ["weak1", chunk("weak1", "p1")], ["weak2", chunk("weak2", "p1")],
    ["single", chunk("single", "p2")],
  ]);
  // 3 weak-ish siblings under p1 (best among them 0.4) vs 1 strong single (0.35) under p2.
  const ranked = [{ id: "strong", score: 0.4 }, { id: "weak1", score: 0.39 }, { id: "weak2", score: 0.38 }, { id: "single", score: 0.35 }];
  const collapsed = collapseSiblings(ranked, chunkById);
  // p1's group score must be 0.4 (the representative alone), not 0.4+0.39+0.38=1.17
  const p1Group = collapsed.find((g) => g.groupKey === "p1");
  assert.equal(p1Group.score, 0.4);
  assert.equal(collapsed[0].id, "strong"); // still ranks first since 0.4 > 0.35, but on the REPRESENTATIVE's own score
});

test("collapseSiblings: sorts collapsed groups by score descending, tie-break by representative chunk_id", () => {
  const chunkById = new Map([["a", chunk("a", null)], ["b", chunk("b", null)], ["c", chunk("c", null)]]);
  const ranked = [{ id: "c", score: 0.9 }, { id: "a", score: 0.9 }, { id: "b", score: 0.1 }];
  const collapsed = collapseSiblings(ranked, chunkById);
  assert.deepEqual(collapsed.map((g) => g.id), ["a", "c", "b"]);
});

test("siblingCrowdingDiagnostics: counts crowded slots and unique-parent shrinkage within a top-N prefix", () => {
  const chunkById = new Map([
    ["c1", chunk("c1", "p1")], ["c2", chunk("c2", "p1")], ["c3", chunk("c3", "p1")],
    ["c4", chunk("c4", "p2")], ["c5", chunk("c5", null)],
  ]);
  const ranked = [
    { id: "c1", score: 0.9 }, { id: "c2", score: 0.8 }, { id: "c3", score: 0.7 },
    { id: "c4", score: 0.6 }, { id: "c5", score: 0.5 },
  ];
  const diag = siblingCrowdingDiagnostics(ranked, chunkById, 5);
  assert.equal(diag.unique_parent_count_before, 3); // p1, p2, c5(singleton)
  assert.equal(diag.unique_parent_count_after, 3); // collapse reduces the LIST but the same 3 groups remain within top-5 after collapse
  assert.equal(diag.sibling_crowded_slot_count, 2); // c2, c3 are extra members of p1's group within this prefix
});

test("siblingCrowdingDiagnostics: same_document_slot_count counts slots beyond the first per document", () => {
  const chunkById = new Map([
    ["c1", chunk("c1", null, "PARAGRAPH_CHILD", "docA")],
    ["c2", chunk("c2", null, "PARAGRAPH_CHILD", "docA")],
    ["c3", chunk("c3", null, "PARAGRAPH_CHILD", "docB")],
  ]);
  const ranked = [{ id: "c1", score: 0.9 }, { id: "c2", score: 0.8 }, { id: "c3", score: 0.7 }];
  const diag = siblingCrowdingDiagnostics(ranked, chunkById, 3);
  assert.equal(diag.same_document_slot_count, 1); // 3 slots, 2 unique documents -> 1 "extra"
});
