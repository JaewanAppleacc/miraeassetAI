// Turn P10.2 / Stage 4: the FIXED final chunking+embedding selection rule,
// pinned before running and never changed after seeing results.
//
// Primary criterion: macro Evidence Recall@10. A difference >= 0.01
// decides outright; below that, the combos are tied and fall through the
// tie-break chain in this EXACT order:
//   1. nDCG@10
//   2. MRR
//   3. worst-question-type recall (the combo whose WORST question-type
//      score is higher wins -- protects against a combo that wins on
//      average by sacrificing one category)
//   4. fewer unique embedding calls
//   5. lower p95 latency
//   6. lower peak RSS + estimated total storage
export const GRID_SELECTION_STATUS = Object.freeze({
  SELECTED: "FINAL_CHUNKING_AND_EMBEDDING_SELECTED",
  NO_CLEAR_WINNER: "NO_CLEAR_WINNER_REQUIRES_OWNER_DECISION",
  CALIBRATION_FAILED: "CALIBRATION_FAILED_FAIL_CLOSED",
});

const RECALL_TOLERANCE = 0.01;
const GENERIC_TOLERANCE = 0.01;

// combos: [{
//   frozen_candidate_id, chunking_config_id, recall_at_10, ndcg_at_10, mrr,
//   worst_question_type_recall, unique_embedding_calls, latency_p95_ms,
//   peak_rss_bytes, estimated_storage_bytes, locator_provenance_violations,
// }]
export function selectFinalChunkingAndEmbedding(combos, { expectedComboCount = 6, determinismStable = true } = {}) {
  if (!Array.isArray(combos) || combos.length !== expectedComboCount) {
    return { status: GRID_SELECTION_STATUS.CALIBRATION_FAILED, winner: null, reasonTrail: [`expected exactly ${expectedComboCount} combinations, got ${Array.isArray(combos) ? combos.length : "non-array"} -- partial-failure state, refusing to select`] };
  }
  if (!determinismStable) {
    return { status: GRID_SELECTION_STATUS.CALIBRATION_FAILED, winner: null, reasonTrail: ["ranking is not deterministic across reruns -- refusing to select"] };
  }

  const reasonTrail = [];
  const qualified = combos.filter((c) => c.locator_provenance_violations === 0);
  const disqualified = combos.filter((c) => c.locator_provenance_violations > 0);
  if (disqualified.length > 0) reasonTrail.push(`disqualified (locator/provenance violations > 0): ${disqualified.map((c) => `${c.frozen_candidate_id}x${c.chunking_config_id}`).join(", ")}`);
  if (qualified.length === 0) {
    return { status: GRID_SELECTION_STATUS.CALIBRATION_FAILED, winner: null, reasonTrail: [...reasonTrail, "every combination disqualified by locator/provenance violations"] };
  }

  const ranked = [...qualified].sort((a, b) => `${a.frozen_candidate_id}x${a.chunking_config_id}`.localeCompare(`${b.frozen_candidate_id}x${b.chunking_config_id}`));

  function compare(a, b) {
    if (Math.abs(a.recall_at_10 - b.recall_at_10) >= RECALL_TOLERANCE) return b.recall_at_10 - a.recall_at_10;
    if (Math.abs(a.ndcg_at_10 - b.ndcg_at_10) >= GENERIC_TOLERANCE) return b.ndcg_at_10 - a.ndcg_at_10;
    if (Math.abs(a.mrr - b.mrr) >= GENERIC_TOLERANCE) return b.mrr - a.mrr;
    if (Math.abs(a.worst_question_type_recall - b.worst_question_type_recall) >= GENERIC_TOLERANCE) return b.worst_question_type_recall - a.worst_question_type_recall;
    if (a.unique_embedding_calls !== b.unique_embedding_calls) return a.unique_embedding_calls - b.unique_embedding_calls;
    if (a.latency_p95_ms !== b.latency_p95_ms) return a.latency_p95_ms - b.latency_p95_ms;
    const aCost = a.peak_rss_bytes + a.estimated_storage_bytes;
    const bCost = b.peak_rss_bytes + b.estimated_storage_bytes;
    if (aCost !== bCost) return aCost - bCost;
    return 0;
  }

  const sorted = [...ranked].sort(compare);
  const [best, second] = sorted;
  const stillTied = second !== undefined && compare(best, second) === 0;

  if (stillTied) {
    reasonTrail.push(`top combinations (${best.frozen_candidate_id}x${best.chunking_config_id}, ${second.frozen_candidate_id}x${second.chunking_config_id}) remain indistinguishable after every tie-break criterion`);
    return { status: GRID_SELECTION_STATUS.NO_CLEAR_WINNER, winner: null, reasonTrail };
  }

  reasonTrail.push(`selected ${best.frozen_candidate_id}x${best.chunking_config_id} by macro_evidence_recall_at_10=${best.recall_at_10} (tie-break chain applied as needed)`);
  return {
    status: GRID_SELECTION_STATUS.SELECTED,
    winner: { frozen_candidate_id: best.frozen_candidate_id, chunking_config_id: best.chunking_config_id },
    reasonTrail,
  };
}
