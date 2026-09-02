import test from "node:test";
import assert from "node:assert/strict";
import { decideHierarchicalRetention, RETENTION_STATUS } from "../domain/agent-comparison/chunking-comparison/hierarchical-retention-rule.mjs";

const FIXED = { recall_at_10: 0.80, mrr: 0.70, ndcg_at_10: 0.80, search_eligible_chunks: 25000, dense_latency_p50_ms: 10000, peak_rss_bytes: 4e8 };

test("rule 1: D beats Fixed's recall@10 by >= 0.01 -> REHABILITATED_AND_LEADING", () => {
  const d = { ...FIXED, recall_at_10: 0.82 };
  const result = decideHierarchicalRetention(FIXED, d);
  assert.equal(result.status, RETENTION_STATUS.REHABILITATED_AND_LEADING);
});

test("rule 2: recall within tolerance but MRR beats Fixed by >= 0.01 -> REHABILITATED_COMPETITIVE", () => {
  const d = { ...FIXED, recall_at_10: 0.805, mrr: 0.72 };
  const result = decideHierarchicalRetention(FIXED, d);
  assert.equal(result.status, RETENTION_STATUS.REHABILITATED_COMPETITIVE);
});

test("rule 2: recall within tolerance but nDCG@10 beats Fixed by >= 0.01 -> REHABILITATED_COMPETITIVE", () => {
  const d = { ...FIXED, recall_at_10: 0.795, mrr: 0.69, ndcg_at_10: 0.82 };
  const result = decideHierarchicalRetention(FIXED, d);
  assert.equal(result.status, RETENTION_STATUS.REHABILITATED_COMPETITIVE);
});

test("rule 3: Fixed leads by >= 0.03 recall and D exceeds 2x Fixed on chunks + RSS -> ELIMINATED", () => {
  const d = { ...FIXED, recall_at_10: 0.76, mrr: 0.60, ndcg_at_10: 0.60, search_eligible_chunks: 60000, dense_latency_p50_ms: 9000, peak_rss_bytes: 9e8 };
  const result = decideHierarchicalRetention(FIXED, d);
  assert.equal(result.status, RETENTION_STATUS.ELIMINATED);
});

test("rule 3 requires >=2 cost dimensions exceeding 2x -- only 1 exceeding is INCONCLUSIVE, not ELIMINATED", () => {
  const d = { ...FIXED, recall_at_10: 0.76, mrr: 0.60, ndcg_at_10: 0.60, search_eligible_chunks: 60000, dense_latency_p50_ms: 9000, peak_rss_bytes: 4e8 };
  const result = decideHierarchicalRetention(FIXED, d);
  assert.equal(result.status, RETENTION_STATUS.INCONCLUSIVE);
});

test("rule 4: a middling result with no rule triggered -> INCONCLUSIVE", () => {
  const d = { ...FIXED, recall_at_10: 0.77, mrr: 0.68, ndcg_at_10: 0.78, search_eligible_chunks: 26000, dense_latency_p50_ms: 10500, peak_rss_bytes: 4.1e8 };
  const result = decideHierarchicalRetention(FIXED, d);
  assert.equal(result.status, RETENTION_STATUS.INCONCLUSIVE);
});

test("every branch returns a non-empty reason string citing the actual numbers", () => {
  const d = { ...FIXED, recall_at_10: 0.82 };
  const result = decideHierarchicalRetention(FIXED, d);
  assert.match(result.reason, /0\.82/);
});
