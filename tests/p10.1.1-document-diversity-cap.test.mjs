import test from "node:test";
import assert from "node:assert/strict";
import { applyDocumentDiversityCap, MAX_GROUPS_PER_DOCUMENT } from "../domain/agent-comparison/chunking-comparison/document-diversity-cap.mjs";

test("MAX_GROUPS_PER_DOCUMENT is fixed at 4 (this Turn's brief)", () => {
  assert.equal(MAX_GROUPS_PER_DOCUMENT, 4);
});

test("keeps at most 4 groups per document, in the input's existing order", () => {
  const chunkById = new Map(Array.from({ length: 6 }, (_, i) => [`g${i}`, { document_id: "docA" }]));
  const entries = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, score: 1 - i * 0.1 }));
  const { kept, excludedCount } = applyDocumentDiversityCap(entries, chunkById);
  assert.equal(kept.length, 4);
  assert.equal(excludedCount, 2);
  assert.deepEqual(kept.map((e) => e.id), ["g0", "g1", "g2", "g3"]);
});

test("does not cap groups from different documents", () => {
  const chunkById = new Map([
    ["a1", { document_id: "docA" }], ["a2", { document_id: "docA" }], ["a3", { document_id: "docA" }], ["a4", { document_id: "docA" }], ["a5", { document_id: "docA" }],
    ["b1", { document_id: "docB" }],
  ]);
  const entries = ["a1", "a2", "a3", "a4", "a5", "b1"].map((id, i) => ({ id, score: 1 - i * 0.1 }));
  const { kept, excludedCount } = applyDocumentDiversityCap(entries, chunkById);
  assert.equal(excludedCount, 1); // only a5 is excluded
  assert.ok(kept.some((e) => e.id === "b1"));
  assert.equal(kept.length, 5);
});

test("never pads or fabricates groups when a document has fewer than 4", () => {
  const chunkById = new Map([["a1", { document_id: "docA" }]]);
  const { kept, excludedCount } = applyDocumentDiversityCap([{ id: "a1", score: 1 }], chunkById);
  assert.equal(kept.length, 1);
  assert.equal(excludedCount, 0);
});
