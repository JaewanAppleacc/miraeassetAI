// Turn P9: self-supervised smoke metrics tests -- Recall@K, MRR, stable
// tie-break, ranking reproducibility, corp_code metadata-filter accuracy.
// All synthetic embeddings; no bundle, no adapter, no network.
import assert from "node:assert/strict";
import test from "node:test";
import {
  cosineSimilarity, rankBySimilarity, computeRecallAtK, computeMRR, rankingIsReproducible, corpCodeFilterAccuracy,
} from "../domain/agent-comparison/embedding-calibration/metrics.mjs";

function item(id, corpCode) {
  return { calibrationItemId: id, expectedSelfMatchId: id, corpCode };
}

test("cosineSimilarity of a vector with itself is 1, and of orthogonal vectors is 0", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test("rankBySimilarity puts the item most similar to the query first, and is stably tie-broken by calibration_item_id ascending", () => {
  const items = [item("c", "corp"), item("a", "corp"), item("b", "corp")];
  const embeddingByItemId = new Map([
    ["a", [1, 0]], ["b", [1, 0]], ["c", [0, 1]], // a and b are identical vectors (a tie), c is orthogonal
  ]);
  const ranked = rankBySimilarity(item("a", "corp"), items, embeddingByItemId);
  assert.deepEqual(ranked, ["a", "b", "c"], "a and b tie in score; 'a' must sort before 'b' by id ascending, and both must outrank orthogonal 'c'");
});

test("computeRecallAtK: a perfectly separable synthetic set has recall@1 = 1", () => {
  const items = [item("x1", "c"), item("x2", "c"), item("x3", "c")];
  const embeddingByItemId = new Map([["x1", [1, 0, 0]], ["x2", [0, 1, 0]], ["x3", [0, 0, 1]]]);
  assert.equal(computeRecallAtK(items, embeddingByItemId, 1), 1);
});

test("computeRecallAtK: when two items share an IDENTICAL embedding, the LOSER of the tie-break has recall@1 = 0 for itself but recall@5 = 1", () => {
  const items = [item("a", "c"), item("b", "c")];
  const embeddingByItemId = new Map([["a", [1, 0]], ["b", [1, 0]]]);
  // "a" wins every tie (sorts first): querying with "b" ranks ["a","b"] --
  // "b" itself is NOT rank 1, so recall@1 across {a,b} must be < 1.
  assert.equal(computeRecallAtK(items, embeddingByItemId, 1), 0.5);
  assert.equal(computeRecallAtK(items, embeddingByItemId, 5), 1);
});

test("computeMRR: perfect self-match set has MRR = 1; a tied loser contributes 1/2", () => {
  const perfectItems = [item("x1", "c"), item("x2", "c")];
  const perfectEmbeddings = new Map([["x1", [1, 0]], ["x2", [0, 1]]]);
  assert.equal(computeMRR(perfectItems, perfectEmbeddings), 1);

  const tiedItems = [item("a", "c"), item("b", "c")];
  const tiedEmbeddings = new Map([["a", [1, 0]], ["b", [1, 0]]]);
  // "a" ranks itself #1 (MRR contribution 1); "b" ranks behind "a" at #2 (contribution 1/2).
  assert.equal(computeMRR(tiedItems, tiedEmbeddings), (1 + 0.5) / 2);
});

test("rankingIsReproducible is true for a pure function of (items, embeddings) -- ranking twice yields identical order", () => {
  const items = [item("a", "c"), item("b", "c"), item("c", "c")];
  const embeddingByItemId = new Map([["a", [1, 0.1]], ["b", [0.9, 0.2]], ["c", [0, 1]]]);
  assert.equal(rankingIsReproducible(items, embeddingByItemId), true);
});

test("corpCodeFilterAccuracy: perfectly separated companies -- no cross-company leak, accuracy 1", () => {
  const items = [item("a1", "corpA"), item("a2", "corpA"), item("b1", "corpB")];
  const embeddingByItemId = new Map([["a1", [1, 0]], ["a2", [0.9, 0.1]], ["b1", [0, 1]]]);
  const result = corpCodeFilterAccuracy(items, embeddingByItemId);
  assert.equal(result.accuracy, 1);
  assert.deepEqual(result.violations, []);
});

test("corpCodeFilterAccuracy never includes a different company's item in a same-corp filtered ranking, even when that item is the closest OVERALL match", () => {
  // b1's closest OVERALL neighbor is a1 (same vector) -- but corp-filtering
  // must restrict a1's own ranking to ONLY corpA candidates, so b1 (corpB)
  // can never appear in a1's filtered ranking at all.
  const items = [item("a1", "corpA"), item("a2", "corpA"), item("b1", "corpB")];
  const embeddingByItemId = new Map([["a1", [1, 0]], ["a2", [0.5, 0.5]], ["b1", [1, 0]]]);
  const ranked = rankBySimilarity(item("a1", "corpA"), items.filter((i) => i.corpCode === "corpA"), embeddingByItemId);
  assert.ok(!ranked.includes("b1"), "a filtered ranking restricted to corpA must never surface a corpB id, regardless of raw similarity");
  const result = corpCodeFilterAccuracy(items, embeddingByItemId);
  assert.equal(result.accuracy, 1);
});

test("computeRecallAtK/computeMRR return neutral values (0) for an empty item list rather than throwing or NaN", () => {
  assert.equal(computeRecallAtK([], new Map(), 1), 0);
  assert.equal(computeMRR([], new Map()), 0);
  assert.ok(!Number.isNaN(computeRecallAtK([], new Map(), 1)));
});
