// Turn P10.1.1: the FIXED Hierarchical retain/eliminate rule, pinned
// before running and never changed after seeing results.
//
// Rule order (exactly as specified in this Turn's brief):
//   1. D.recall10 - Fixed.recall10 >= 0.01           -> REHABILITATED_AND_LEADING
//   2. |D.recall10 - Fixed.recall10| < 0.01 AND
//      (D.mrr - Fixed.mrr >= 0.01 OR D.ndcg10 - Fixed.ndcg10 >= 0.01)
//                                                      -> REHABILITATED_COMPETITIVE
//   3. Fixed.recall10 - D.recall10 >= 0.03 AND
//      >=2 of {search_eligible_chunks, latency_p50_ms (dense), peak_rss_bytes}
//      exceed 2x Fixed's own value                    -> ELIMINATED_AFTER_PARENT_AWARE_RETEST
//   4. otherwise                                       -> RESULT_INCONCLUSIVE
export const RETENTION_STATUS = Object.freeze({
  REHABILITATED_AND_LEADING: "HIERARCHICAL_REHABILITATED_AND_LEADING",
  REHABILITATED_COMPETITIVE: "HIERARCHICAL_REHABILITATED_COMPETITIVE",
  ELIMINATED: "HIERARCHICAL_ELIMINATED_AFTER_PARENT_AWARE_RETEST",
  INCONCLUSIVE: "HIERARCHICAL_RESULT_INCONCLUSIVE",
});

const TOLERANCE = 0.01;
const ELIMINATION_MARGIN = 0.03;

// fixedMetrics / dMetrics: { recall_at_10, mrr, ndcg_at_10, search_eligible_chunks, dense_latency_p50_ms, peak_rss_bytes }
export function decideHierarchicalRetention(fixedMetrics, dMetrics) {
  const recallDiff = dMetrics.recall_at_10 - fixedMetrics.recall_at_10;

  if (recallDiff >= TOLERANCE) {
    return { status: RETENTION_STATUS.REHABILITATED_AND_LEADING, reason: `D recall@10 (${dMetrics.recall_at_10}) exceeds Fixed (${fixedMetrics.recall_at_10}) by >= ${TOLERANCE}` };
  }

  if (Math.abs(recallDiff) < TOLERANCE) {
    const mrrDiff = dMetrics.mrr - fixedMetrics.mrr;
    const ndcgDiff = dMetrics.ndcg_at_10 - fixedMetrics.ndcg_at_10;
    if (mrrDiff >= TOLERANCE || ndcgDiff >= TOLERANCE) {
      return { status: RETENTION_STATUS.REHABILITATED_COMPETITIVE, reason: `recall@10 within tolerance (diff=${recallDiff}); MRR diff=${mrrDiff}, nDCG@10 diff=${ndcgDiff}` };
    }
  }

  if (fixedMetrics.recall_at_10 - dMetrics.recall_at_10 >= ELIMINATION_MARGIN) {
    const costFlags = [
      dMetrics.search_eligible_chunks > fixedMetrics.search_eligible_chunks * 2,
      dMetrics.dense_latency_p50_ms > fixedMetrics.dense_latency_p50_ms * 2,
      dMetrics.peak_rss_bytes > fixedMetrics.peak_rss_bytes * 2,
    ];
    const costFlagCount = costFlags.filter(Boolean).length;
    if (costFlagCount >= 2) {
      return { status: RETENTION_STATUS.ELIMINATED, reason: `Fixed leads D by ${(fixedMetrics.recall_at_10 - dMetrics.recall_at_10).toFixed(4)} (>= ${ELIMINATION_MARGIN}) and D exceeds 2x Fixed on ${costFlagCount}/3 cost dimensions (chunks/latency/RSS)` };
    }
  }

  return { status: RETENTION_STATUS.INCONCLUSIVE, reason: `neither the rehabilitation nor the elimination condition was met (recall diff=${recallDiff})` };
}
