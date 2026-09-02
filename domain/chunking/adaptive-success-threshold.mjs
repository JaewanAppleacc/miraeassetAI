// Turn P10.4 / Stage 8: the FIXED, pre-registered success-threshold gate.
// Pure function, no I/O -- never lowers a threshold or auto-confirms on
// failure. Every numeric bound here is named and sourced from this Turn's
// brief, never a silently-chosen value.
export const FINAL_STATUS = Object.freeze({
  SELECTED: "FINAL_CHUNKING_SELECTED_KURE_ADAPTIVE",
  REQUIRES_FIX: "ADAPTIVE_REQUIRES_FIX",
  // Turn P10.4-R: a more specific status for the case where Stage 7's real
  // KURE evaluation was deliberately never run because the cost gate
  // already fails on real, independently-available Stage 5 data alone --
  // additive to the enum above (never replaces REQUIRES_FIX; that status
  // still exists for when evaluateSuccessThresholds() itself runs with
  // full Stage 7 inputs and only the cost gate fails among others).
  REQUIRES_FIX_COST_GATE: "ADAPTIVE_TABLE_CHUNKING_REQUIRES_FIX_COST_GATE",
  REJECTED_FIXED_PROVISIONAL: "ADAPTIVE_REJECTED_FIXED_REMAINS_PROVISIONAL",
  PARSE_RECOVERY_BLOCKS: "PARSE_RECOVERY_BLOCKS_FINAL_SELECTION",
  INCONCLUSIVE: "EVALUATION_INCONCLUSIVE",
});

const RECALL_TOLERANCE = 0.01;
const HEADER_PERIOD_PRESERVATION_MIN = 0.95;
const UNIT_PRESERVATION_MIN = 0.90;
const CHUNKING_VIOLATION_REDUCTION_MIN = 0.75; // vs Fixed's 197
// Exported (Turn P10.4-R) so a cost-gate-only precheck (Stage 8/9, when
// Stage 7 was never run) can reuse this EXACT value rather than
// re-declaring a second copy that could silently drift out of sync.
export const COST_RATIO_MAX = 1.5; // Adaptive unique search-eligible text count <= 1.5x Fixed's

export function evaluateSuccessThresholds({
  overallRecallAt10Adaptive, overallRecallAt10Fixed,
  tableRecallAt10Adaptive, tableRecallAt10Fixed,
  nonTableRegressionDetected,
  criticalViolationCounts, // { LOCATOR_RESOLVES_TO_WRONG_CELL, ROW_HEADER_VALUE_MISMATCH, PERIOD_COLUMN_VALUE_MISMATCH, LOCATOR_PROVENANCE_LOST, INHERITED_CONTEXT_WITHOUT_PROVENANCE }
  explicitHeaderPeriodPreservationRate,
  explicitUnitPreservationRate,
  fixedChunkingAttributableViolations, // 197, cited not recomputed
  adaptiveChunkingAttributableViolations,
  adaptiveUniqueSearchEligibleTextCount,
  fixedUniqueSearchEligibleTextCount,
  peakRssWithinBudget,
  parentContextExcludedFromIndex,
  lateExpansionNeverAddsResultSlots,
  parseRecoveryBlockingCount,
}) {
  const reasonTrail = [];

  if (parseRecoveryBlockingCount > 0) {
    // Explicit, separate status per this Turn's brief -- parse-limited
    // sources block final selection even if every other gate passes,
    // reported distinctly rather than folded into a generic failure.
    reasonTrail.push(`${parseRecoveryBlockingCount} PARSE_RECOVERY_REQUIRED source(s) remain -- flagged separately, does not by itself fail the other gates`);
  }

  const missingInputs = [overallRecallAt10Adaptive, overallRecallAt10Fixed, tableRecallAt10Adaptive, tableRecallAt10Fixed, adaptiveUniqueSearchEligibleTextCount, fixedUniqueSearchEligibleTextCount].some((v) => v === null || v === undefined);
  if (missingInputs) {
    reasonTrail.push("one or more required measurements is missing -- cannot evaluate thresholds");
    return { status: FINAL_STATUS.INCONCLUSIVE, reasonTrail, gates: null };
  }

  const gates = {
    overall_recall_ok: overallRecallAt10Adaptive >= overallRecallAt10Fixed - RECALL_TOLERANCE,
    table_recall_ok: tableRecallAt10Adaptive >= tableRecallAt10Fixed - RECALL_TOLERANCE,
    non_table_no_regression: !nonTableRegressionDetected,
    zero_locator_wrong_cell: (criticalViolationCounts.LOCATOR_RESOLVES_TO_WRONG_CELL ?? 0) === 0,
    zero_row_header_mismatch: (criticalViolationCounts.ROW_HEADER_VALUE_MISMATCH ?? 0) === 0,
    zero_period_column_mismatch: (criticalViolationCounts.PERIOD_COLUMN_VALUE_MISMATCH ?? 0) === 0,
    zero_locator_provenance_lost: (criticalViolationCounts.LOCATOR_PROVENANCE_LOST ?? 0) === 0,
    zero_inherited_without_provenance: (criticalViolationCounts.INHERITED_CONTEXT_WITHOUT_PROVENANCE ?? 0) === 0,
    header_period_preservation_ok: explicitHeaderPeriodPreservationRate >= HEADER_PERIOD_PRESERVATION_MIN,
    unit_preservation_ok: explicitUnitPreservationRate >= UNIT_PRESERVATION_MIN,
    violation_reduction_ok: (1 - adaptiveChunkingAttributableViolations / fixedChunkingAttributableViolations) >= CHUNKING_VIOLATION_REDUCTION_MIN,
    cost_ratio_ok: (adaptiveUniqueSearchEligibleTextCount / fixedUniqueSearchEligibleTextCount) <= COST_RATIO_MAX,
    peak_rss_ok: peakRssWithinBudget,
    parent_context_excluded_ok: parentContextExcludedFromIndex,
    late_expansion_slot_invariant_ok: lateExpansionNeverAddsResultSlots,
  };

  const failedGates = Object.entries(gates).filter(([, ok]) => !ok).map(([name]) => name);
  for (const [name, ok] of Object.entries(gates)) reasonTrail.push(`${name}: ${ok ? "PASS" : "FAIL"}`);

  if (parseRecoveryBlockingCount > 0 && failedGates.length === 0) {
    return { status: FINAL_STATUS.PARSE_RECOVERY_BLOCKS, reasonTrail, gates, failed_gates: [] };
  }
  if (failedGates.length === 0) {
    return { status: FINAL_STATUS.SELECTED, reasonTrail, gates, failed_gates: [] };
  }

  // Structural-safety gates (locator/header/unit correctness) failing is a
  // REJECTION signal (the design itself is unsafe) -- cost/recall gates
  // failing alone is a FIX signal (the design direction may still be
  // right, needs tuning). Never silently lowering a threshold to force a
  // pass either way.
  const structuralSafetyGates = ["zero_locator_wrong_cell", "zero_row_header_mismatch", "zero_period_column_mismatch", "zero_locator_provenance_lost", "zero_inherited_without_provenance", "header_period_preservation_ok", "unit_preservation_ok"];
  const structuralFailure = failedGates.some((g) => structuralSafetyGates.includes(g));
  if (structuralFailure) {
    reasonTrail.push("a structural-safety gate failed -- Fixed remains the provisional default rather than shipping an unsafe Adaptive design");
    return { status: FINAL_STATUS.REJECTED_FIXED_PROVISIONAL, reasonTrail, gates, failed_gates: failedGates };
  }

  reasonTrail.push("only recall/cost/operational gates failed -- the design direction may still be viable with tuning");
  return { status: FINAL_STATUS.REQUIRES_FIX, reasonTrail, gates, failed_gates: failedGates };
}
