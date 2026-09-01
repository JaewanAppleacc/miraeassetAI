// Turn P10.2 / Stage 3: chunking x embedding interaction analysis. A pure
// function over the 6 already-computed combination summaries -- never
// re-derives metrics, never reads per-item Gold content.
//
// combos: [{ frozen_candidate_id, chunking_config_id, recall_at_10 }, ...]
// (exactly 6 entries expected: 3 models x 2 chunkings).
const TOLERANCE = 0.01;
// Two recall@10 values this close are treated as an exact/near-exact tie
// for rank-order purposes, not a real performance difference. Real P10.2
// data produced an EXACT tie (0.834 == 0.834), so this only needs to
// absorb floating-point noise, not a meaningful margin.
const TIE_EPSILON = 1e-9;

// Set unconditionally on every detectInteraction() result as of the
// P10.2 follow-up correction (2026-09-01): whether Fixed-512 preserves
// TABLE row/column/unit/period context specifically (as opposed to the
// macro recall@10 measured here, which is table-content-agnostic) is not
// yet verified. It is cleared only by Turn P10.3-TABLE's dedicated
// table-structure diagnostic -- never by this module.
export const TABLE_DIAGNOSTIC_STATUS = "TABLE_DIAGNOSTIC_PENDING";

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
    return [modelId, { fixed_recall_at_10: fixedRecall, section_recall_at_10: sectionRecall, section_minus_fixed: delta, fixed_minus_section: -delta, section_wins: delta >= TOLERANCE, fixed_wins: delta <= -TOLERANCE, within_tolerance: Math.abs(delta) < TOLERANCE }];
  }));
}

// Finds every pair of models whose RELATIVE order flips between the fixed
// and section rankings, and records whether that specific flip is
// explained by an exact/near-exact tie (in which case it carries no
// performance signal) or by a genuine, non-tied disagreement.
function computeSwappedPairs(combos, fixedConfigId, sectionConfigId, fixedRanking, sectionRanking) {
  const swapped = [];
  for (let i = 0; i < fixedRanking.length; i++) {
    for (let j = i + 1; j < fixedRanking.length; j++) {
      const a = fixedRanking[i];
      const b = fixedRanking[j];
      if (sectionRanking.indexOf(a) > sectionRanking.indexOf(b)) {
        const fixedA = findRecall(combos, a, fixedConfigId);
        const fixedB = findRecall(combos, b, fixedConfigId);
        const sectionA = findRecall(combos, a, sectionConfigId);
        const sectionB = findRecall(combos, b, sectionConfigId);
        const tieDriven = Math.abs(sectionA - sectionB) < TIE_EPSILON || Math.abs(fixedA - fixedB) < TIE_EPSILON;
        swapped.push({ pair: [a, b], fixed_delta: fixedA - fixedB, section_delta: sectionA - sectionB, tie_driven: tieDriven });
      }
    }
  }
  return swapped;
}

export function analyzeModelRankingByChunking(combos, modelIds, chunkingConfigId) {
  const ranked = modelIds
    .map((modelId) => ({ frozen_candidate_id: modelId, recall_at_10: findRecall(combos, modelId, chunkingConfigId) }))
    .sort((a, b) => (b.recall_at_10 - a.recall_at_10) || a.frozen_candidate_id.localeCompare(b.frozen_candidate_id));
  return ranked;
}

// Detects whether the model ranking order itself flips between the two
// chunkings, vs. the two chunkings just producing a uniform additive shift
// (same ranking order either way). `has_interaction` is kept as the raw,
// UNCORRECTED structural signal for audit continuity with prior P10.2
// output; it is true whenever the rank order changes AT ALL, including
// when that change is fully explained by an exact tie between two models
// (no performance signal). `material_performance_interaction` and
// `rank_order_tie_artifact` are the P10.2 follow-up correction: they
// decompose `has_interaction` into "does this reflect an actual,
// non-tied chunking x embedding performance interaction" (the former)
// vs. "is this just an alphabetical tie-break artifact" (the latter).
// Real P10.2 data: has_interaction=true, rank_order_tie_artifact=true,
// material_performance_interaction=false -- the only rank swap is
// bge_m3/kure_v1 tying EXACTLY at 0.834 under Section-Flat.
export function detectInteraction(combos, modelIds, fixedConfigId, sectionConfigId) {
  const fixedRanking = analyzeModelRankingByChunking(combos, modelIds, fixedConfigId).map((r) => r.frozen_candidate_id);
  const sectionRanking = analyzeModelRankingByChunking(combos, modelIds, sectionConfigId).map((r) => r.frozen_candidate_id);
  const rankingOrderChanged = fixedRanking.join(",") !== sectionRanking.join(",");

  const chunkingByModel = analyzeChunkingByModelDelta(combos, modelIds, fixedConfigId, sectionConfigId);
  const anySectionReversal = Object.values(chunkingByModel).some((d) => d.section_wins);
  const anyFixedReversal = Object.values(chunkingByModel).some((d) => d.fixed_wins);
  // Raw structural signal (unchanged since the original P10.2 run): the
  // two chunkings disagree in DIRECTION for at least one model pair, or
  // the rank order changes at all -- including a pure tie-break flip.
  const hasInteraction = rankingOrderChanged || (anySectionReversal && anyFixedReversal);

  const swappedPairs = computeSwappedPairs(combos, fixedConfigId, sectionConfigId, fixedRanking, sectionRanking);
  const rankOrderTieArtifact = rankingOrderChanged && swappedPairs.length > 0 && swappedPairs.every((p) => p.tie_driven);
  // Material interaction requires either a genuine, non-tied direction
  // disagreement across models, or a rank-order change NOT fully
  // explained by a tie. A rank-order change that IS fully tie-driven
  // carries no performance signal and must not count as material.
  const materialPerformanceInteraction = (anySectionReversal && anyFixedReversal) || (rankingOrderChanged && !rankOrderTieArtifact);

  return {
    fixed_ranking: fixedRanking,
    section_ranking: sectionRanking,
    top_model_changed: fixedRanking[0] !== sectionRanking[0],
    ranking_order_changed: rankingOrderChanged,
    any_model_where_section_beats_fixed: anySectionReversal,
    any_model_where_fixed_beats_section: anyFixedReversal,
    has_interaction: hasInteraction,
    swapped_pairs: swappedPairs,
    rank_order_tie_artifact: rankOrderTieArtifact,
    material_performance_interaction: materialPerformanceInteraction,
    table_diagnostic_status: TABLE_DIAGNOSTIC_STATUS,
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
