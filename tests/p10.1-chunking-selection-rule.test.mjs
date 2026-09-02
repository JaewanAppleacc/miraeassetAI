import test from "node:test";
import assert from "node:assert/strict";
import { selectChunkingStrategy, SELECTION_STATUS } from "../domain/agent-comparison/chunking-comparison/chunking-selection-rule.mjs";

function strat(id, overrides = {}) {
  return {
    chunking_config_id: id,
    locator_provenance_violations: 0,
    macro_evidence_recall_at_k: { 5: 0.5, 10: 0.5, 20: 0.5 },
    macro_mrr: 0.5,
    total_unique_embed_texts: 100,
    latency_dense_p50_ms: 100,
    total_chunks: 1000,
    ...overrides,
  };
}

test("rule 1: a strategy with any locator/provenance violation is disqualified even if its recall is highest", () => {
  const result = selectChunkingStrategy([
    strat("high-recall-but-violates", { locator_provenance_violations: 1, macro_evidence_recall_at_k: { 5: 0.9, 10: 0.9, 20: 0.9 } }),
    strat("clean", { macro_evidence_recall_at_k: { 5: 0.3, 10: 0.3, 20: 0.3 } }),
  ]);
  assert.equal(result.status, SELECTION_STATUS.SELECTED);
  assert.equal(result.winner, "clean");
});

test("rule 2: a Recall@10 difference >= tolerance decides the winner outright", () => {
  const result = selectChunkingStrategy([
    strat("a", { macro_evidence_recall_at_k: { 5: 0.5, 10: 0.60, 20: 0.5 } }),
    strat("b", { macro_evidence_recall_at_k: { 5: 0.5, 10: 0.80, 20: 0.5 } }),
  ]);
  assert.equal(result.winner, "b");
});

test("rule 3: Recall@10 within tolerance falls through to MRR", () => {
  const result = selectChunkingStrategy([
    strat("a", { macro_evidence_recall_at_k: { 5: 0.5, 10: 0.700, 20: 0.5 }, macro_mrr: 0.3 }),
    strat("b", { macro_evidence_recall_at_k: { 5: 0.5, 10: 0.705, 20: 0.5 }, macro_mrr: 0.6 }),
  ]);
  assert.equal(result.winner, "b");
});

test("rule 4: Recall@10 and MRR both within tolerance falls through to Recall@5", () => {
  const result = selectChunkingStrategy([
    strat("a", { macro_evidence_recall_at_k: { 5: 0.40, 10: 0.700, 20: 0.5 }, macro_mrr: 0.300 }),
    strat("b", { macro_evidence_recall_at_k: { 5: 0.70, 10: 0.705, 20: 0.5 }, macro_mrr: 0.305 }),
  ]);
  assert.equal(result.winner, "b");
});

test("rule 5: an effective quality tie is broken by fewer unique embedding calls, then lower dense latency", () => {
  const embedCountWins = selectChunkingStrategy([
    strat("a", { total_unique_embed_texts: 500, latency_dense_p50_ms: 10 }),
    strat("b", { total_unique_embed_texts: 200, latency_dense_p50_ms: 999 }),
  ]);
  assert.equal(embedCountWins.winner, "b");

  const latencyWins = selectChunkingStrategy([
    strat("a", { total_unique_embed_texts: 200, latency_dense_p50_ms: 999 }),
    strat("b", { total_unique_embed_texts: 200, latency_dense_p50_ms: 10 }),
  ]);
  assert.equal(latencyWins.winner, "b");
});

test("truly indistinguishable strategies (tied on every criterion) yield NO_FINAL_CHUNKING_SELECTION_MARGIN_TOO_SMALL, never an arbitrary winner", () => {
  const result = selectChunkingStrategy([strat("a"), strat("b")]);
  assert.equal(result.status, SELECTION_STATUS.NO_SELECTION);
  assert.equal(result.winner, null);
});

test("every strategy disqualified yields NO_SELECTION, never a forced pick", () => {
  const result = selectChunkingStrategy([
    strat("a", { locator_provenance_violations: 2 }),
    strat("b", { locator_provenance_violations: 1 }),
  ]);
  assert.equal(result.status, SELECTION_STATUS.NO_SELECTION);
  assert.equal(result.winner, null);
});

test("an unstable (non-deterministic-rerun) evaluation forces NO_SELECTION regardless of metrics", () => {
  const result = selectChunkingStrategy(
    [strat("a", { macro_evidence_recall_at_k: { 5: 0.9, 10: 0.9, 20: 0.9 } }), strat("b")],
    { determinismStable: false },
  );
  assert.equal(result.status, SELECTION_STATUS.NO_SELECTION);
  assert.equal(result.winner, null);
});

test("a single qualifying strategy is selected trivially", () => {
  const result = selectChunkingStrategy([
    strat("only-clean"),
    strat("disqualified", { locator_provenance_violations: 5 }),
  ]);
  assert.equal(result.winner, "only-clean");
});

test("rule 6: a chunk-heavy winner's cost is disclosed in the reason trail, never hidden", () => {
  const result = selectChunkingStrategy([
    strat("hierarchical-heavy", { macro_evidence_recall_at_k: { 5: 0.5, 10: 0.90, 20: 0.5 }, total_chunks: 100000 }),
    strat("fixed-light", { macro_evidence_recall_at_k: { 5: 0.5, 10: 0.50, 20: 0.5 }, total_chunks: 10000 }),
  ]);
  assert.equal(result.winner, "hierarchical-heavy");
  assert.ok(result.costNote, "expected a cost-disclosure note when the winner has far more chunks than the runner-up");
  assert.match(result.costNote, /100000/);
});

test("selection is order-independent (same result regardless of input array order)", () => {
  const a = strat("a", { macro_evidence_recall_at_k: { 5: 0.5, 10: 0.60, 20: 0.5 } });
  const b = strat("b", { macro_evidence_recall_at_k: { 5: 0.5, 10: 0.80, 20: 0.5 } });
  const result1 = selectChunkingStrategy([a, b]);
  const result2 = selectChunkingStrategy([b, a]);
  assert.equal(result1.winner, result2.winner);
});
