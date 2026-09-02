import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseHierarchicalCauses } from "../domain/agent-comparison/chunking-comparison/hierarchical-cause-diagnosis.mjs";

function baseInput(overrides = {}) {
  return {
    fixedMetrics: { node_hit_rate_at_10: 0.9, locator_hit_rate_at_10: 0.9 },
    hier1536Metrics: { recall_at_10: 0.70 },
    cTop30Metrics: { recall_at_10: 0.70 },
    cTop100Metrics: { recall_at_10: 0.70 },
    dTop100Metrics: { recall_at_10: 0.70, node_hit_rate_at_10: 0.9, locator_hit_rate_at_10: 0.9 },
    bm25CoverageC: { at_30: 0.9, at_100: 0.9 },
    siblingCrowdingC: { mean_sibling_crowded_slot_count_at_20: 0, crowded_member_chunk_type_counts: {} },
    ...overrides,
  };
}

test("PARENT_SIZE_1536_DEGRADATION triggers when C(parent=1024) clears B(parent=1536) by >= 0.01 at the same funnel", () => {
  const causes = diagnoseHierarchicalCauses(baseInput({ cTop30Metrics: { recall_at_10: 0.72 }, hier1536Metrics: { recall_at_10: 0.70 } }));
  assert.equal(causes.PARENT_SIZE_1536_DEGRADATION.triggered, true);
});

test("PARENT_SIZE_1536_DEGRADATION does not trigger on a sub-threshold gap", () => {
  const causes = diagnoseHierarchicalCauses(baseInput({ cTop30Metrics: { recall_at_10: 0.705 }, hier1536Metrics: { recall_at_10: 0.70 } }));
  assert.equal(causes.PARENT_SIZE_1536_DEGRADATION.triggered, false);
});

test("BM25_CANDIDATE_STARVATION triggers on a material coverage gap between top-30 and top-100", () => {
  const causes = diagnoseHierarchicalCauses(baseInput({ bm25CoverageC: { at_30: 0.60, at_100: 0.80 } }));
  assert.equal(causes.BM25_CANDIDATE_STARVATION.triggered, true);
});

test("SIBLING_RESULT_CROWDING triggers when mean crowded slots at top-20 meets the pinned threshold", () => {
  const causes = diagnoseHierarchicalCauses(baseInput({ siblingCrowdingC: { mean_sibling_crowded_slot_count_at_20: 5, crowded_member_chunk_type_counts: {} } }));
  assert.equal(causes.SIBLING_RESULT_CROWDING.triggered, true);
});

test("PARENT_EXPANSION_MISSING triggers when D materially beats C at the SAME top-100 funnel", () => {
  const causes = diagnoseHierarchicalCauses(baseInput({ cTop100Metrics: { recall_at_10: 0.70 }, dTop100Metrics: { recall_at_10: 0.75, node_hit_rate_at_10: 0.9, locator_hit_rate_at_10: 0.9 } }));
  assert.equal(causes.PARENT_EXPANSION_MISSING.triggered, true);
});

test("TABLE_ROW_CROWDING triggers when TABLE_ROW dominates the crowded-out sibling members", () => {
  const causes = diagnoseHierarchicalCauses(baseInput({ siblingCrowdingC: { mean_sibling_crowded_slot_count_at_20: 0, crowded_member_chunk_type_counts: { TABLE_ROW: 8, PARAGRAPH_CHILD: 2 } } }));
  assert.equal(causes.TABLE_ROW_CROWDING.triggered, true);
});

test("TABLE_ROW_CROWDING does not trigger when crowded members are mostly non-table", () => {
  const causes = diagnoseHierarchicalCauses(baseInput({ siblingCrowdingC: { mean_sibling_crowded_slot_count_at_20: 0, crowded_member_chunk_type_counts: { TABLE_ROW: 1, PARAGRAPH_CHILD: 9 } } }));
  assert.equal(causes.TABLE_ROW_CROWDING.triggered, false);
});

test("GOLD_LOCATOR_SCORING_MISMATCH triggers when D's node-vs-locator hit gap is materially worse than Fixed's", () => {
  const causes = diagnoseHierarchicalCauses(baseInput({
    fixedMetrics: { node_hit_rate_at_10: 0.90, locator_hit_rate_at_10: 0.89 }, // gap 0.01
    dTop100Metrics: { recall_at_10: 0.70, node_hit_rate_at_10: 0.90, locator_hit_rate_at_10: 0.75 }, // gap 0.15
  }));
  assert.equal(causes.GOLD_LOCATOR_SCORING_MISMATCH.triggered, true);
});

test("NONE_OF_THE_ABOVE is true only when every other cause is false, and false when any cause triggers", () => {
  const clean = diagnoseHierarchicalCauses(baseInput());
  assert.equal(clean.NONE_OF_THE_ABOVE.triggered, true);

  const withCause = diagnoseHierarchicalCauses(baseInput({ bm25CoverageC: { at_30: 0.5, at_100: 0.9 } }));
  assert.equal(withCause.NONE_OF_THE_ABOVE.triggered, false);
});

test("every cause carries a non-empty numeric evidence string, never asserted without supporting figures", () => {
  const causes = diagnoseHierarchicalCauses(baseInput());
  for (const [name, result] of Object.entries(causes)) {
    assert.ok(typeof result.evidence === "string" && result.evidence.length > 0, `${name} is missing evidence`);
  }
});
