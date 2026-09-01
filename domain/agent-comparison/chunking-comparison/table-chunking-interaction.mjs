// Turn P10.3-TABLE / Stage 4: chunking x embedding interaction over the
// TABLE-only evidence, reusing the P10.2 follow-up's corrected principle
// (grid-interaction-analysis.mjs) that a rank-order/near-tie swap must
// never be reported as a material interaction. Pure function over
// already-computed Stage 2 (structural) and Stage 3 (retrieval, partial)
// numbers -- no retrieval, no embedding, no file I/O.
const TOLERANCE = 0.01;
const TIE_EPSILON = 1e-9;

// modelDeltas: [{ frozen_candidate_id, fixed_table_recall_at_10, section_table_recall_at_10 }]
export function computeTableRecallDeltasByModel(modelDeltas) {
  return modelDeltas.map((m) => {
    const delta = m.section_table_recall_at_10 - m.fixed_table_recall_at_10;
    return {
      frozen_candidate_id: m.frozen_candidate_id,
      fixed_table_recall_at_10: m.fixed_table_recall_at_10,
      section_table_recall_at_10: m.section_table_recall_at_10,
      section_minus_fixed: delta,
      is_tie: Math.abs(delta) < TIE_EPSILON,
      section_wins: delta >= TOLERANCE,
      fixed_wins: delta <= -TOLERANCE,
      within_tolerance: Math.abs(delta) < TOLERANCE,
    };
  });
}

// Chunking-structural deltas are NOT model-dependent (chunk structure is
// identical regardless of which embedding model later searches it) --
// reported once, separately from the per-model retrieval deltas, so the
// two evidence sources are never silently averaged together.
export function computeStructuralDelta({ fixedCriticalViolations, sectionCriticalViolations, fixedMultiCellOk, sectionMultiCellOk, fixedItemCount, sectionItemCount }) {
  return {
    critical_violation_delta_section_minus_fixed: sectionCriticalViolations - fixedCriticalViolations,
    fixed_critical_violation_count: fixedCriticalViolations,
    section_critical_violation_count: sectionCriticalViolations,
    section_has_fewer_critical_violations: sectionCriticalViolations < fixedCriticalViolations,
    fixed_multi_cell_completeness_rate: fixedItemCount > 0 ? fixedMultiCellOk / fixedItemCount : null,
    section_multi_cell_completeness_rate: sectionItemCount > 0 ? sectionMultiCellOk / sectionItemCount : null,
  };
}

// Classifies the whole picture: does chunking dominate, does the embedding
// model dominate, is there a genuine interaction, or did retrieval succeed
// while structural preservation failed (or vice versa)?
export function classifyTableInteraction({ recallDeltasByModel, structuralDelta }) {
  const anySectionRecallWins = recallDeltasByModel.some((d) => d.section_wins);
  const anyFixedRecallWins = recallDeltasByModel.some((d) => d.fixed_wins);
  const allTiedOrFixedWins = recallDeltasByModel.every((d) => !d.section_wins);
  const materialRecallInteraction = anySectionRecallWins && anyFixedRecallWins;

  // "검색은 성공했지만 문맥 보존에는 실패한 경우": retrieval (Stage 3) shows
  // Fixed at least matching Section on table recall, while structure
  // (Stage 2) shows Fixed has MORE critical violations -- retrieval
  // succeeding does not mean the returned chunk's context was trustworthy.
  const retrievalSucceededButContextFailed = allTiedOrFixedWins && structuralDelta.section_has_fewer_critical_violations;

  return {
    model_recall_deltas: recallDeltasByModel,
    any_model_where_section_recall_wins: anySectionRecallWins,
    any_model_where_fixed_recall_wins: anyFixedRecallWins,
    material_recall_interaction: materialRecallInteraction,
    chunking_structural_advantage: structuralDelta.section_has_fewer_critical_violations ? "SECTION" : (structuralDelta.critical_violation_delta_section_minus_fixed > 0 ? "FIXED" : "TIE"),
    retrieval_succeeded_but_context_preservation_failed: retrievalSucceededButContextFailed,
  };
}
