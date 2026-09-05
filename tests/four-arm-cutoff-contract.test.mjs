import test from "node:test";
import assert from "node:assert/strict";
import {
  RETRIEVAL_OUTPUT_K, PRIMARY_EVALUATION_K, REPORTED_CUTOFFS,
  deriveCutoffRanking, computeRecallAtK, summarizeRecallAcrossKs, CutoffContractViolationError,
} from "../domain/agent-comparison/four-arm-ac/four-arm-cutoff-contract.mjs";

test("contract constants match vFINAL section E / config.A.json's pinned values", () => {
  assert.equal(RETRIEVAL_OUTPUT_K, 20);
  assert.equal(PRIMARY_EVALUATION_K, 10);
  assert.deepEqual(REPORTED_CUTOFFS, [5, 10, 20]);
});

test("deriveCutoffRanking slices a single pool, never re-queries", () => {
  const pool = Array.from({ length: 20 }, (_, i) => `chunk_${i}`);
  assert.deepEqual(deriveCutoffRanking(pool, 5), pool.slice(0, 5));
  assert.deepEqual(deriveCutoffRanking(pool, 10), pool.slice(0, 10));
  assert.deepEqual(deriveCutoffRanking(pool, 20), pool.slice(0, 20));
});

test("rejects a pool larger than RETRIEVAL_OUTPUT_K=20 -- a second, bigger retrieval is not allowed", () => {
  const oversized = Array.from({ length: 21 }, (_, i) => `chunk_${i}`);
  assert.throws(
    () => deriveCutoffRanking(oversized, 10),
    (err) => err instanceof CutoffContractViolationError && err.code === "CUTOFF_POOL_EXCEEDS_RETRIEVAL_OUTPUT_K",
  );
});

test("rejects a k outside REPORTED_CUTOFFS", () => {
  const pool = Array.from({ length: 20 }, (_, i) => `chunk_${i}`);
  assert.throws(() => deriveCutoffRanking(pool, 7), (err) => err.code === "CUTOFF_K_NOT_IN_CONTRACT");
  assert.throws(() => deriveCutoffRanking(pool, 100), (err) => err.code === "CUTOFF_K_NOT_IN_CONTRACT");
});

test("computeRecallAtK: exact-fraction recall against a synthetic relevant set", () => {
  const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t"];
  const relevant = ["c", "z"]; // z never appears in the pool
  assert.equal(computeRecallAtK(pool, relevant, 5), 0.5); // c is within top5, z is not found at all
  assert.equal(computeRecallAtK(pool, relevant, 20), 0.5);
});

test("computeRecallAtK returns null for an empty relevant set (undefined, not zero)", () => {
  const pool = ["a", "b"];
  assert.equal(computeRecallAtK(pool, [], 5), null);
});

test("summarizeRecallAcrossKs derives all three cutoffs from ONE pool and flags primary=10", () => {
  const pool = Array.from({ length: 20 }, (_, i) => `chunk_${i}`);
  const relevant = ["chunk_0", "chunk_9", "chunk_19"];
  const summary = summarizeRecallAcrossKs(pool, relevant);
  assert.equal(summary.retrieval_output_k, 20);
  assert.equal(summary.primary_evaluation_k, 10);
  assert.deepEqual(summary.reported_cutoffs, [5, 10, 20]);
  assert.equal(summary.recall_at_k[5], 1 / 3); // only chunk_0 in top5
  assert.equal(summary.recall_at_k[10], 2 / 3); // chunk_0, chunk_9 in top10
  assert.equal(summary.recall_at_k[20], 1); // all three in top20
  assert.equal(summary.primary_recall, summary.recall_at_k[10]);
});
