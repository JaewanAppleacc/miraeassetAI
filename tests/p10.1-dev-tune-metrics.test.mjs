import test from "node:test";
import assert from "node:assert/strict";
import { computeItemMetrics, aggregateStrategyMetrics } from "../domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs";

function slot(name, sources) {
  return { slot_name: name, description: "d", acceptable_sources: sources };
}
function source(documentId, orderIndex) {
  return { document_id: documentId, source_locator: `${documentId}::x.xml::n${orderIndex}`, evidence_span: "unused" };
}
function chunk(documentId, orderIndex, chunkId) {
  return {
    chunk_id: chunkId, document_id: documentId,
    source_spans: [{ order_index: orderIndex, row_start: null, row_end: null, col_start: null, col_end: null }],
  };
}

test("computeItemMetrics: a single-slot item is fully covered when the relevant chunk is at rank 1", () => {
  const item = {
    question_id: "q1", expected_answerability: "SUPPORTED",
    gold_document_ids: ["major_20231026000201"],
    required_evidence_slots: [slot("s1", [source("major_20231026000201", 2)])],
  };
  const ranked = [chunk("major_20231026000201", 2, "chunk_a"), chunk("major_20231026000201", 3, "chunk_b")];
  const m = computeItemMetrics(item, ranked);
  assert.equal(m.has_required_slots, true);
  assert.equal(m.evidence_slot_coverage_fraction_at_k[5], 1);
  assert.equal(m.evidence_slot_coverage_fraction_at_k[10], 1);
  assert.equal(m.reciprocal_rank, 1);
  assert.equal(m.document_hit_at_10, true);
  assert.equal(m.node_hit_at_10, true);
  assert.equal(m.locator_hit_at_10, true);
});

test("computeItemMetrics: a relevant chunk outside top-k does not count", () => {
  const item = {
    question_id: "q2", expected_answerability: "SUPPORTED",
    gold_document_ids: ["major_20231026000201"],
    required_evidence_slots: [slot("s1", [source("major_20231026000201", 2)])],
  };
  const ranked = [chunk("d9", 0, "chunk_x"), chunk("major_20231026000201", 2, "chunk_a")];
  const m = computeItemMetrics(item, ranked);
  assert.equal(m.evidence_slot_coverage_fraction_at_k[5], 1); // rank 2 is within top-5
  assert.equal(m.reciprocal_rank, 0.5);
});

test("computeItemMetrics: a 2-slot item is half-covered when only one slot's evidence is retrieved", () => {
  const item = {
    question_id: "q3", expected_answerability: "SUPPORTED",
    gold_document_ids: ["major_20231026000201", "holding_20231110000478"],
    required_evidence_slots: [slot("s1", [source("major_20231026000201", 0)]), slot("s2", [source("holding_20231110000478", 0)])],
  };
  const ranked = [chunk("major_20231026000201", 0, "chunk_a")];
  const m = computeItemMetrics(item, ranked);
  assert.equal(m.evidence_slot_coverage_fraction_at_k[10], 0.5);
});

test("computeItemMetrics: an item with zero required_evidence_slots reports has_required_slots=false and null recall/mrr/ndcg", () => {
  const item = { question_id: "q4", expected_answerability: "NOT_FOUND", gold_document_ids: [], required_evidence_slots: [] };
  const m = computeItemMetrics(item, [chunk("d9", 0, "chunk_z")]);
  assert.equal(m.has_required_slots, false);
  assert.equal(m.reciprocal_rank, null);
  assert.equal(m.ndcg_at_10, null);
  assert.deepEqual(m.evidence_slot_coverage_fraction_at_k, { 5: null, 10: null, 20: null });
  assert.equal(m.returned_at_least_one_at_10, true);
});

test("computeItemMetrics: an OR slot is covered if ANY of its acceptable_sources is retrieved", () => {
  const item = {
    question_id: "q5", expected_answerability: "SUPPORTED",
    gold_document_ids: ["major_20231026000201", "holding_20231110000478"],
    required_evidence_slots: [slot("s1", [source("major_20231026000201", 0), source("holding_20231110000478", 0)])],
  };
  const ranked = [chunk("holding_20231110000478", 0, "chunk_b")]; // covers via the second acceptable_source
  const m = computeItemMetrics(item, ranked);
  assert.equal(m.evidence_slot_coverage_fraction_at_k[10], 1);
});

test("aggregateStrategyMetrics: macro recall/MRR/nDCG average only over items WITH required slots; NOT_FOUND false-positive rate isolates NOT_FOUND items", () => {
  const supportedItem = {
    question_id: "q1", expected_answerability: "SUPPORTED", gold_document_ids: ["major_20231026000201"],
    required_evidence_slots: [slot("s1", [source("major_20231026000201", 0)])],
  };
  const notFoundItem = { question_id: "q2", expected_answerability: "NOT_FOUND", gold_document_ids: [], required_evidence_slots: [] };
  const perItem = [
    computeItemMetrics(supportedItem, [chunk("major_20231026000201", 0, "c1")]),
    computeItemMetrics(notFoundItem, [chunk("d9", 0, "c9")]), // NOT_FOUND item still gets SOME retrieved chunk
  ];
  const agg = aggregateStrategyMetrics(perItem);
  assert.equal(agg.item_count, 2);
  assert.equal(agg.items_with_required_slots, 1);
  assert.equal(agg.macro_evidence_recall_at_k[10], 1); // only the supported item counts
  assert.equal(agg.not_found_item_count, 1);
  assert.equal(agg.not_found_false_positive_rate_at_10, 1); // the NOT_FOUND item DID get a non-empty top-10
});

test("aggregateStrategyMetrics: not_found_false_positive_rate_at_10 is null when there are zero NOT_FOUND items", () => {
  const supportedItem = {
    question_id: "q1", expected_answerability: "SUPPORTED", gold_document_ids: ["major_20231026000201"],
    required_evidence_slots: [slot("s1", [source("major_20231026000201", 0)])],
  };
  const agg = aggregateStrategyMetrics([computeItemMetrics(supportedItem, [chunk("major_20231026000201", 0, "c1")])]);
  assert.equal(agg.not_found_item_count, 0);
  assert.equal(agg.not_found_false_positive_rate_at_10, null);
});
