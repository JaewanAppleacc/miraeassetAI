import test from "node:test";
import assert from "node:assert/strict";
import { computeTableRecallDeltasByModel, computeStructuralDelta, classifyTableInteraction } from "../domain/agent-comparison/chunking-comparison/table-chunking-interaction.mjs";

test("computeTableRecallDeltasByModel: within-tolerance deltas are ties, not wins for either side", () => {
  const deltas = computeTableRecallDeltasByModel([{ frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.90, section_table_recall_at_10: 0.90 }]);
  assert.equal(deltas[0].is_tie, true);
  assert.equal(deltas[0].section_wins, false);
  assert.equal(deltas[0].fixed_wins, false);
});

test("computeTableRecallDeltasByModel: a real 0.03+ Section advantage is section_wins", () => {
  const deltas = computeTableRecallDeltasByModel([{ frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.80, section_table_recall_at_10: 0.85 }]);
  assert.equal(deltas[0].section_wins, true);
});

test("classifyTableInteraction: material_recall_interaction requires genuine, non-tied direction disagreement across models (P10.2's corrected principle)", () => {
  const deltas = computeTableRecallDeltasByModel([
    { frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.70, section_table_recall_at_10: 0.90 }, // section wins
    { frozen_candidate_id: "m2", fixed_table_recall_at_10: 0.90, section_table_recall_at_10: 0.70 }, // fixed wins
  ]);
  const structuralDelta = computeStructuralDelta({ fixedCriticalViolations: 10, sectionCriticalViolations: 5, fixedMultiCellOk: 4, sectionMultiCellOk: 4, fixedItemCount: 5, sectionItemCount: 5 });
  const result = classifyTableInteraction({ recallDeltasByModel: deltas, structuralDelta });
  assert.equal(result.material_recall_interaction, true);
});

test("classifyTableInteraction: a tie or Fixed-only lead across all models is NOT a material interaction", () => {
  const deltas = computeTableRecallDeltasByModel([
    { frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.90, section_table_recall_at_10: 0.87 },
    { frozen_candidate_id: "m2", fixed_table_recall_at_10: 0.88, section_table_recall_at_10: 0.88 },
  ]);
  const structuralDelta = computeStructuralDelta({ fixedCriticalViolations: 10, sectionCriticalViolations: 5, fixedMultiCellOk: 4, sectionMultiCellOk: 4, fixedItemCount: 5, sectionItemCount: 5 });
  const result = classifyTableInteraction({ recallDeltasByModel: deltas, structuralDelta });
  assert.equal(result.material_recall_interaction, false);
});

test("classifyTableInteraction: retrieval_succeeded_but_context_preservation_failed fires exactly for the real P10.3 shape -- Fixed ties/wins recall while Section has fewer structural violations", () => {
  const deltas = computeTableRecallDeltasByModel([
    { frozen_candidate_id: "kure_v1", fixed_table_recall_at_10: 0.9286, section_table_recall_at_10: 0.8980 },
    { frozen_candidate_id: "bge_m3", fixed_table_recall_at_10: 0.8980, section_table_recall_at_10: 0.8980 },
    { frozen_candidate_id: "pixie_rune", fixed_table_recall_at_10: 0.9286, section_table_recall_at_10: 0.9184 },
  ]);
  const structuralDelta = computeStructuralDelta({ fixedCriticalViolations: 162, sectionCriticalViolations: 108, fixedMultiCellOk: 45, sectionMultiCellOk: 45, fixedItemCount: 45, sectionItemCount: 45 });
  const result = classifyTableInteraction({ recallDeltasByModel: deltas, structuralDelta });
  assert.equal(result.retrieval_succeeded_but_context_preservation_failed, true);
  assert.equal(result.chunking_structural_advantage, "SECTION");
});

test("computeStructuralDelta: reports which side has fewer critical violations without silently averaging the two evidence types together", () => {
  const delta = computeStructuralDelta({ fixedCriticalViolations: 162, sectionCriticalViolations: 108, fixedMultiCellOk: 45, sectionMultiCellOk: 45, fixedItemCount: 45, sectionItemCount: 45 });
  assert.equal(delta.section_has_fewer_critical_violations, true);
  assert.equal(delta.critical_violation_delta_section_minus_fixed, -54);
});
