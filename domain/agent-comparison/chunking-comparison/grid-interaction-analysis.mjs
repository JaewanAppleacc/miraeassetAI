// Turn P10.2 / Stage 3: chunking x embedding interaction analysis. A pure
// function over the 6 already-computed combination summaries -- never
// re-derives metrics, never reads per-item Gold content.
//
// combos: [{ frozen_candidate_id, chunking_config_id, recall_at_10 }, ...]
// (exactly 6 entries expected: 3 models x 2 chunkings).
const TOLERANCE = 0.01;

function findRecall(combos, candidateId, chunkingConfigId) {
  const match = combos.find((c) => c.frozen_candidate_id === candidateId && c.chunking_config_id === chunkingConfigId);
  if (!match) throw new Error(`grid-interaction-analysis: missing combination for ${candidateId} x ${chunkingConfigId}`);
  return match.recall_at_10;
}

export function analyzeChunkingByModelDelta(combos, modelIds, fixedConfigId, sectionConfigId) {
  return Object.fromEntries(modelIds.map((modelId) => {
    const fixedRecall = findRecall(combos, modelId, fixedConfigId);
    const sectionRecall = findRecall(combos, modelId, sectionConfigId);
    const delta = sectionRecall - fixedRecall;
    return [modelId, { fixed_recall_at_10: fixedRecall, section_recall_at_10: sectionRecall, section_minus_fixed: delta, section_wins: delta >= TOLERANCE, fixed_wins: delta <= -TOLERANCE, within_tolerance: Math.abs(delta) < TOLERANCE }];
  }));
}

export function analyzeModelRankingByChunking(combos, modelIds, chunkingConfigId) {
  const ranked = modelIds
    .map((modelId) => ({ frozen_candidate_id: modelId, recall_at_10: findRecall(combos, modelId, chunkingConfigId) }))
    .sort((a, b) => (b.recall_at_10 - a.recall_at_10) || a.frozen_candidate_id.localeCompare(b.frozen_candidate_id));
  return ranked;
}

// Detects whether the model ranking order itself flips between the two
// chunkings (a real interaction), vs. the two chunkings just producing a
// uniform additive shift (no interaction, same ranking order either way).
export function detectInteraction(combos, modelIds, fixedConfigId, sectionConfigId) {
  const fixedRanking = analyzeModelRankingByChunking(combos, modelIds, fixedConfigId).map((r) => r.frozen_candidate_id);
  const sectionRanking = analyzeModelRankingByChunking(combos, modelIds, sectionConfigId).map((r) => r.frozen_candidate_id);
  const rankingOrderChanged = fixedRanking.join(",") !== sectionRanking.join(",");

  const chunkingByModel = analyzeChunkingByModelDelta(combos, modelIds, fixedConfigId, sectionConfigId);
  const anySectionReversal = Object.values(chunkingByModel).some((d) => d.section_wins);
  const anyFixedReversal = Object.values(chunkingByModel).some((d) => d.fixed_wins);
  // A real interaction: the two chunkings disagree in DIRECTION for at
  // least one model pair (one model favors Section, another favors Fixed
  // beyond tolerance), or the top-ranked model itself changes.
  const hasInteraction = rankingOrderChanged || (anySectionReversal && anyFixedReversal);

  return {
    fixed_ranking: fixedRanking,
    section_ranking: sectionRanking,
    top_model_changed: fixedRanking[0] !== sectionRanking[0],
    ranking_order_changed: rankingOrderChanged,
    any_model_where_section_beats_fixed: anySectionReversal,
    any_model_where_fixed_beats_section: anyFixedReversal,
    has_interaction: hasInteraction,
  };
}

// Checks whether the overall (macro) recall verdict for a chunking pair
// conflicts with the per-question-type verdict for the SAME pair -- e.g.
// Section wins on macro average but loses on NUMERIC_LOOKUP specifically.
// typeBreakdown: { [questionType]: { [comboLabel]: { recall_at_10_mean, n } } }
export function detectMacroVsTypeConflict(typeBreakdown, fixedLabel, sectionLabel, macroFixedRecall, macroSectionRecall) {
  const macroSectionWins = macroSectionRecall - macroFixedRecall >= TOLERANCE;
  const macroFixedWins = macroFixedRecall - macroSectionRecall >= TOLERANCE;
  const conflicts = [];
  for (const [questionType, byLabel] of Object.entries(typeBreakdown)) {
    const fixedVal = byLabel[fixedLabel]?.recall_at_10_mean;
    const sectionVal = byLabel[sectionLabel]?.recall_at_10_mean;
    if (fixedVal === undefined || sectionVal === undefined || fixedVal === null || sectionVal === null) continue;
    const typeDelta = sectionVal - fixedVal;
    const typeSectionWins = typeDelta >= TOLERANCE;
    const typeFixedWins = typeDelta <= -TOLERANCE;
    if ((macroSectionWins && typeFixedWins) || (macroFixedWins && typeSectionWins)) {
      conflicts.push({ question_type: questionType, fixed_recall_at_10: fixedVal, section_recall_at_10: sectionVal, delta: typeDelta });
    }
  }
  return { macro_section_wins: macroSectionWins, macro_fixed_wins: macroFixedWins, conflicting_question_types: conflicts, has_conflict: conflicts.length > 0 };
}
