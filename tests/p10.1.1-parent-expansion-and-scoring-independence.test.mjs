import test from "node:test";
import assert from "node:assert/strict";
import { expandWithParentContext } from "../domain/agent-comparison/chunking-comparison/parent-expansion.mjs";
import { computeItemMetrics } from "../domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs";

function slot(name, sources) { return { slot_name: name, description: "d", acceptable_sources: sources }; }
function source(documentId, orderIndex) { return { document_id: documentId, source_locator: `${documentId}::x.xml::n${orderIndex}`, evidence_span: "unused" }; }
function chunk(id, documentId, orderIndex, parentChunkId = null) {
  return { chunk_id: id, document_id: documentId, parent_chunk_id: parentChunkId, source_spans: [{ order_index: orderIndex, row_start: null, row_end: null, col_start: null, col_end: null }], raw_text: `child text for ${id}` };
}

test("expandWithParentContext attaches the parent's text when a parent is resolvable", () => {
  const child = chunk("c1", "major_20231026000201", 3, "p1");
  const chunkById = new Map([["c1", child], ["p1", { chunk_id: "p1", raw_text: "parent context text" }]]);
  const result = expandWithParentContext(child, chunkById);
  assert.equal(result.contextSource, "PARENT");
  assert.equal(result.contextText, "parent context text");
  assert.equal(result.child, child);
});

test("expandWithParentContext falls back to the child's own text when there is no parent_chunk_id", () => {
  const child = chunk("c1", "major_20231026000201", 3, null);
  const chunkById = new Map([["c1", child]]);
  const result = expandWithParentContext(child, chunkById);
  assert.equal(result.contextSource, "CHILD_FALLBACK");
  assert.equal(result.contextText, "child text for c1");
});

test("expandWithParentContext falls back to the child's own text when parent_chunk_id does not resolve in this build", () => {
  const child = chunk("c1", "major_20231026000201", 3, "missing_parent");
  const chunkById = new Map([["c1", child]]);
  const result = expandWithParentContext(child, chunkById);
  assert.equal(result.contextSource, "CHILD_FALLBACK");
});

test("parent expansion NEVER awards a Gold locator hit on its own: a chunk whose order_index does not match Gold, but whose PARENT would, still scores as a miss", () => {
  // Gold evidence points at order_index=3. The representative child is at
  // order_index=5 (a MISS on its own) but its parent covers order_index=3
  // (which would be a HIT if parent text/locator were ever substituted in).
  const item = {
    question_id: "q1", expected_answerability: "SUPPORTED",
    gold_document_ids: ["major_20231026000201"],
    required_evidence_slots: [slot("s1", [source("major_20231026000201", 3)])],
  };
  const child = chunk("c1", "major_20231026000201", 5, "p1"); // does NOT cover order_index 3 itself
  // computeItemMetrics is called with the CHILD chunk only (as the real
  // pipeline does) -- the parent object itself is never in this list.
  const m = computeItemMetrics(item, [child]);
  assert.equal(m.evidence_slot_coverage_fraction_at_k[10], 0, "a non-covering child must not be scored as a hit even though its parent would cover the Gold locator");
});

test("parent expansion DOES let scoring succeed when the representative child itself covers the Gold locator (no parent substitution needed)", () => {
  const item = {
    question_id: "q2", expected_answerability: "SUPPORTED",
    gold_document_ids: ["major_20231026000201"],
    required_evidence_slots: [slot("s1", [source("major_20231026000201", 3)])],
  };
  const child = chunk("c1", "major_20231026000201", 3, "p1"); // covers order_index 3 directly
  const m = computeItemMetrics(item, [child]);
  assert.equal(m.evidence_slot_coverage_fraction_at_k[10], 1);
});
