// Turn P10.1.1: root-cause determination, each cause judged independently
// from real measured numbers (never asserted without a supporting figure
// in the returned `evidence` field). Thresholds fixed here, before running,
// and never adjusted after seeing results.
const PARENT_SIZE_TOLERANCE = 0.01;
const BM25_STARVATION_GAP = 0.05; // coverage@100 - coverage@30 material gap
const SIBLING_CROWDING_MEAN_THRESHOLD = 3; // mean sibling_crowded_slot_count@20 across items
const TABLE_ROW_CROWDING_SHARE = 0.5; // >=50% of crowded-out siblings are TABLE_ROW
const LOCATOR_GAP_MATERIAL = 0.05; // (node_hit_rate - locator_hit_rate) gap, hierarchical vs fixed

export function diagnoseHierarchicalCauses({
  fixedMetrics, // { recall_at_10, node_hit_rate_at_10, locator_hit_rate_at_10 }
  hier1536Metrics, // B, same funnel width as C_top30
  cTop30Metrics, // C at top-30 (matched funnel vs B)
  cTop100Metrics, // C at top-100 (raw-flat, official funnel)
  dTop100Metrics, // D at top-100 (parent-aware, official funnel)
  bm25CoverageC, // { at_30, at_100 } -- fraction of items/slots covered by BM25 stage alone
  siblingCrowdingC, // { mean_sibling_crowded_slot_count_at_20, crowded_member_chunk_type_counts: {TABLE_ROW: n, PARAGRAPH_CHILD: n, ...} }
}) {
  const causes = {};

  const parentSizeRecallGain = cTop30Metrics.recall_at_10 - hier1536Metrics.recall_at_10;
  causes.PARENT_SIZE_1536_DEGRADATION = {
    triggered: parentSizeRecallGain >= PARENT_SIZE_TOLERANCE,
    evidence: `C(parent=1024, top-30) recall@10=${cTop30Metrics.recall_at_10} vs B(parent=1536, top-30) recall@10=${hier1536Metrics.recall_at_10}, gain=${parentSizeRecallGain.toFixed(4)} (threshold ${PARENT_SIZE_TOLERANCE})`,
  };

  const bm25Gap = bm25CoverageC.at_100 - bm25CoverageC.at_30;
  causes.BM25_CANDIDATE_STARVATION = {
    triggered: bm25Gap >= BM25_STARVATION_GAP,
    evidence: `BM25 evidence coverage@100=${bm25CoverageC.at_100} vs @30=${bm25CoverageC.at_30}, gap=${bm25Gap.toFixed(4)} (threshold ${BM25_STARVATION_GAP})`,
  };

  causes.SIBLING_RESULT_CROWDING = {
    triggered: siblingCrowdingC.mean_sibling_crowded_slot_count_at_20 >= SIBLING_CROWDING_MEAN_THRESHOLD,
    evidence: `mean sibling-crowded slots in top-20 (raw-flat, top-100 funnel) = ${siblingCrowdingC.mean_sibling_crowded_slot_count_at_20.toFixed(2)} (threshold ${SIBLING_CROWDING_MEAN_THRESHOLD})`,
  };

  const dRecallGainOverCFlat = dTop100Metrics.recall_at_10 - cTop100Metrics.recall_at_10;
  causes.PARENT_EXPANSION_MISSING = {
    // Named for this Turn's cause taxonomy: "missing" parent-aware handling
    // (collapse + document cap) in the raw-flat treatment is what this
    // measures -- triggered when correcting it (D vs C) recovers a real
    // amount of recall.
    triggered: dRecallGainOverCFlat >= PARENT_SIZE_TOLERANCE,
    evidence: `D(parent-aware) recall@10=${dTop100Metrics.recall_at_10} vs C(raw-flat, same top-100 funnel) recall@10=${cTop100Metrics.recall_at_10}, gain=${dRecallGainOverCFlat.toFixed(4)} (threshold ${PARENT_SIZE_TOLERANCE})`,
  };

  const tableRowCounts = siblingCrowdingC.crowded_member_chunk_type_counts ?? {};
  const totalCrowded = Object.values(tableRowCounts).reduce((a, b) => a + b, 0);
  const tableRowShare = totalCrowded > 0 ? (tableRowCounts.TABLE_ROW ?? 0) / totalCrowded : 0;
  causes.TABLE_ROW_CROWDING = {
    triggered: totalCrowded > 0 && tableRowShare >= TABLE_ROW_CROWDING_SHARE,
    evidence: `TABLE_ROW share of crowded-out sibling members = ${tableRowShare.toFixed(3)} of ${totalCrowded} total (threshold ${TABLE_ROW_CROWDING_SHARE})`,
  };

  const fixedLocatorGap = fixedMetrics.node_hit_rate_at_10 - fixedMetrics.locator_hit_rate_at_10;
  const dLocatorGap = dTop100Metrics.node_hit_rate_at_10 - dTop100Metrics.locator_hit_rate_at_10;
  const locatorGapDelta = dLocatorGap - fixedLocatorGap;
  causes.GOLD_LOCATOR_SCORING_MISMATCH = {
    triggered: locatorGapDelta >= LOCATOR_GAP_MATERIAL,
    evidence: `(node_hit - locator_hit) gap: Fixed=${fixedLocatorGap.toFixed(4)}, D=${dLocatorGap.toFixed(4)}, delta=${locatorGapDelta.toFixed(4)} (threshold ${LOCATOR_GAP_MATERIAL})`,
  };

  const anyTriggered = Object.values(causes).some((c) => c.triggered);
  causes.NONE_OF_THE_ABOVE = {
    triggered: !anyTriggered,
    evidence: anyTriggered ? "at least one other cause was triggered above threshold" : "no measured gap exceeded any of the pinned thresholds",
  };

  return causes;
}
