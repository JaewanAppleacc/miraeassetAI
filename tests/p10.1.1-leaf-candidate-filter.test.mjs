import test from "node:test";
import assert from "node:assert/strict";
import { isLeafCandidateChunk, filterToLeafCandidates, LEAF_CANDIDATE_CHUNK_TYPES } from "../domain/agent-comparison/chunking-comparison/leaf-candidate-filter.mjs";

test("exactly the 4 leaf/child chunk_types from this Turn's brief are allowed", () => {
  assert.deepEqual([...LEAF_CANDIDATE_CHUNK_TYPES].sort(), ["DOCUMENT_FALLBACK", "FIELD_GROUP_CHILD", "PARAGRAPH_CHILD", "TABLE_ROW"].sort());
});

test("parent-role chunk_types are excluded from the candidate pool", () => {
  for (const parentType of ["SECTION_PARENT", "EVENT_PARENT", "HOLDING_STATUS_PARENT", "TABLE_WHOLE"]) {
    assert.equal(isLeafCandidateChunk({ chunk_type: parentType }), false, `${parentType} must never be a leaf candidate`);
  }
});

test("leaf chunk_types are included", () => {
  for (const leafType of ["PARAGRAPH_CHILD", "FIELD_GROUP_CHILD", "TABLE_ROW", "DOCUMENT_FALLBACK"]) {
    assert.equal(isLeafCandidateChunk({ chunk_type: leafType }), true);
  }
});

test("filterToLeafCandidates drops parents but keeps leaves, preserving order", () => {
  const chunks = [{ id: 1, chunk_type: "TABLE_WHOLE" }, { id: 2, chunk_type: "TABLE_ROW" }, { id: 3, chunk_type: "SECTION_PARENT" }, { id: 4, chunk_type: "PARAGRAPH_CHILD" }];
  const filtered = filterToLeafCandidates(chunks);
  assert.deepEqual(filtered.map((c) => c.id), [2, 4]);
});
