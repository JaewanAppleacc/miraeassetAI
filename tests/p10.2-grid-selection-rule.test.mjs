import test from "node:test";
import assert from "node:assert/strict";
import { selectFinalChunkingAndEmbedding, GRID_SELECTION_STATUS } from "../domain/agent-comparison/chunking-comparison/grid-selection-rule.mjs";

function combo(model, chunking, overrides = {}) {
  return {
    frozen_candidate_id: model, chunking_config_id: chunking,
    recall_at_10: 0.7, ndcg_at_10: 0.7, mrr: 0.6, worst_question_type_recall: 0.5,
    unique_embedding_calls: 1000, latency_p95_ms: 5000, peak_rss_bytes: 4e8, estimated_storage_bytes: 1e8,
    locator_provenance_violations: 0,
    ...overrides,
  };
}

function sixCombos(overridesByKey = {}) {
  const models = ["kure_v1", "bge_m3", "pixie_rune"];
  const chunkings = ["fixed", "section"];
  const combos = [];
  for (const m of models) for (const c of chunkings) combos.push(combo(m, c, overridesByKey[`${m}x${c}`] ?? {}));
  return combos;
}

test("fewer than 6 (or more than 6) combinations -> CALIBRATION_FAILED_FAIL_CLOSED, never a partial winner", () => {
  const result = selectFinalChunkingAndEmbedding(sixCombos().slice(0, 5));
  assert.equal(result.status, GRID_SELECTION_STATUS.CALIBRATION_FAILED);
  assert.equal(result.winner, null);
});

test("non-array input -> CALIBRATION_FAILED_FAIL_CLOSED", () => {
  const result = selectFinalChunkingAndEmbedding(null);
  assert.equal(result.status, GRID_SELECTION_STATUS.CALIBRATION_FAILED);
});

test("an unstable (non-deterministic) run forces CALIBRATION_FAILED_FAIL_CLOSED regardless of metrics", () => {
  const combos = sixCombos({ "bge_m3xfixed": { recall_at_10: 0.95 } });
  const result = selectFinalChunkingAndEmbedding(combos, { determinismStable: false });
  assert.equal(result.status, GRID_SELECTION_STATUS.CALIBRATION_FAILED);
});

test("a clear recall@10 winner (>= 0.01 margin) is selected outright", () => {
  const combos = sixCombos({ "bge_m3xfixed": { recall_at_10: 0.90 } });
  const result = selectFinalChunkingAndEmbedding(combos);
  assert.equal(result.status, GRID_SELECTION_STATUS.SELECTED);
  assert.deepEqual(result.winner, { frozen_candidate_id: "bge_m3", chunking_config_id: "fixed" });
});

test("recall within tolerance falls through to nDCG@10, then MRR, then worst-type recall, then embedding count, then p95 latency, then RSS+storage", () => {
  const combos = sixCombos({
    "bge_m3xfixed": { recall_at_10: 0.705, ndcg_at_10: 0.705 }, // recall tie (diff 0.005), ndcg tie too (both defaults 0.70 vs 0.705, diff 0.005) -> falls to mrr
    "bge_m3xsection": { recall_at_10: 0.700 },
  });
  // Force a clear MRR winner for bge_m3xfixed specifically
  combos.find((c) => c.frozen_candidate_id === "bge_m3" && c.chunking_config_id === "fixed").mrr = 0.90;
  const result = selectFinalChunkingAndEmbedding(combos);
  assert.equal(result.status, GRID_SELECTION_STATUS.SELECTED);
  assert.deepEqual(result.winner, { frozen_candidate_id: "bge_m3", chunking_config_id: "fixed" });
});

test("a locator/provenance violation disqualifies a combination even with the best recall", () => {
  const combos = sixCombos({ "bge_m3xfixed": { recall_at_10: 0.99, locator_provenance_violations: 3 } });
  const result = selectFinalChunkingAndEmbedding(combos);
  assert.notDeepEqual(result.winner, { frozen_candidate_id: "bge_m3", chunking_config_id: "fixed" });
});

test("every combination disqualified -> CALIBRATION_FAILED_FAIL_CLOSED", () => {
  const combos = sixCombos().map((c) => ({ ...c, locator_provenance_violations: 1 }));
  const result = selectFinalChunkingAndEmbedding(combos);
  assert.equal(result.status, GRID_SELECTION_STATUS.CALIBRATION_FAILED);
});

test("truly indistinguishable combos (identical on every criterion) -> NO_CLEAR_WINNER_REQUIRES_OWNER_DECISION, never an arbitrary pick", () => {
  const combos = sixCombos(); // all identical metrics
  const result = selectFinalChunkingAndEmbedding(combos);
  assert.equal(result.status, GRID_SELECTION_STATUS.NO_CLEAR_WINNER);
  assert.equal(result.winner, null);
});

test("selection is order-independent (same result regardless of input array order)", () => {
  const combos = sixCombos({ "pixie_runexsection": { recall_at_10: 0.92 } });
  const shuffled = [...combos].reverse();
  const r1 = selectFinalChunkingAndEmbedding(combos);
  const r2 = selectFinalChunkingAndEmbedding(shuffled);
  assert.deepEqual(r1.winner, r2.winner);
});
