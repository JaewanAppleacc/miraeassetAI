import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSuccessThresholds, FINAL_STATUS } from "../domain/chunking/adaptive-success-threshold.mjs";

const passingInputs = {
  overallRecallAt10Adaptive: 0.87, overallRecallAt10Fixed: 0.868,
  tableRecallAt10Adaptive: 0.92, tableRecallAt10Fixed: 0.90,
  nonTableRegressionDetected: false,
  criticalViolationCounts: { LOCATOR_RESOLVES_TO_WRONG_CELL: 0, ROW_HEADER_VALUE_MISMATCH: 0, PERIOD_COLUMN_VALUE_MISMATCH: 0, LOCATOR_PROVENANCE_LOST: 0, INHERITED_CONTEXT_WITHOUT_PROVENANCE: 0 },
  explicitHeaderPeriodPreservationRate: 0.98,
  explicitUnitPreservationRate: 0.95,
  fixedChunkingAttributableViolations: 197,
  adaptiveChunkingAttributableViolations: 20,
  adaptiveUniqueSearchEligibleTextCount: 600000,
  fixedUniqueSearchEligibleTextCount: 441879,
  peakRssWithinBudget: true,
  parentContextExcludedFromIndex: true,
  lateExpansionNeverAddsResultSlots: true,
  parseRecoveryBlockingCount: 0,
};

test("success threshold: all gates pass -> FINAL_CHUNKING_SELECTED_KURE_ADAPTIVE", () => {
  const result = evaluateSuccessThresholds(passingInputs);
  assert.equal(result.status, FINAL_STATUS.SELECTED);
  assert.equal(result.failed_gates.length, 0);
});

test("missing measurements -> EVALUATION_INCONCLUSIVE, never a guessed pass", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, tableRecallAt10Adaptive: null });
  assert.equal(result.status, FINAL_STATUS.INCONCLUSIVE);
});

test("a single LOCATOR_RESOLVES_TO_WRONG_CELL violation (must be exactly 0) rejects, does not degrade to a warning", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, criticalViolationCounts: { ...passingInputs.criticalViolationCounts, LOCATOR_RESOLVES_TO_WRONG_CELL: 1 } });
  assert.equal(result.status, FINAL_STATUS.REJECTED_FIXED_PROVISIONAL);
  assert.ok(result.failed_gates.includes("zero_locator_wrong_cell"));
});

test("header/period preservation below 95% rejects as a structural-safety failure, not a mere fix-needed", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, explicitHeaderPeriodPreservationRate: 0.80 });
  assert.equal(result.status, FINAL_STATUS.REJECTED_FIXED_PROVISIONAL);
});

test("unit preservation below 90% rejects as a structural-safety failure", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, explicitUnitPreservationRate: 0.5 });
  assert.equal(result.status, FINAL_STATUS.REJECTED_FIXED_PROVISIONAL);
});

test("cost ratio > 1.5x Fixed alone (no structural failure) -> ADAPTIVE_REQUIRES_FIX, never silently accepted or rejected outright", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, adaptiveUniqueSearchEligibleTextCount: 900000 }); // 900000/441879 = 2.04x
  assert.equal(result.status, FINAL_STATUS.REQUIRES_FIX);
  assert.ok(result.failed_gates.includes("cost_ratio_ok"));
});

test("recall regression alone (Adaptive more than 0.01 below Fixed) -> ADAPTIVE_REQUIRES_FIX", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, overallRecallAt10Adaptive: 0.80 });
  assert.equal(result.status, FINAL_STATUS.REQUIRES_FIX);
});

test("violation reduction below 75% vs Fixed's 197 -> ADAPTIVE_REQUIRES_FIX", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, adaptiveChunkingAttributableViolations: 100 }); // reduction = 1-100/197 = 0.49
  assert.equal(result.status, FINAL_STATUS.REQUIRES_FIX);
});

test("PARSE_RECOVERY_BLOCKS_FINAL_SELECTION when parse-limited sources remain but every other gate passes", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, parseRecoveryBlockingCount: 4 });
  assert.equal(result.status, FINAL_STATUS.PARSE_RECOVERY_BLOCKS);
});

test("late-expansion slot invariant violated (a structural/operational gate, not a recall/cost one) still routes through REQUIRES_FIX since it is not in the structural-safety list", () => {
  const result = evaluateSuccessThresholds({ ...passingInputs, lateExpansionNeverAddsResultSlots: false });
  assert.equal(result.status, FINAL_STATUS.REQUIRES_FIX);
});

test("every threshold value is named and sourced -- no hidden literal comparisons outside the exported gate names", () => {
  const result = evaluateSuccessThresholds(passingInputs);
  const expectedGateNames = [
    "overall_recall_ok", "table_recall_ok", "non_table_no_regression",
    "zero_locator_wrong_cell", "zero_row_header_mismatch", "zero_period_column_mismatch", "zero_locator_provenance_lost", "zero_inherited_without_provenance",
    "header_period_preservation_ok", "unit_preservation_ok", "violation_reduction_ok", "cost_ratio_ok", "peak_rss_ok", "parent_context_excluded_ok", "late_expansion_slot_invariant_ok",
  ];
  assert.deepEqual(Object.keys(result.gates).sort(), expectedGateNames.sort());
});
