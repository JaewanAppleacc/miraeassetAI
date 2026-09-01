import test from "node:test";
import assert from "node:assert/strict";
import { decideTableChunkingVerdict, TABLE_VERDICT } from "../domain/agent-comparison/chunking-comparison/table-chunking-verdict-rule.mjs";

const baseInputs = {
  tableItemCount: 45,
  determinismStable: true,
  cacheOrRankingDataMissing: false,
  locatorDeterministicallyResolvable: true,
  modelVerdictsConflictSharply: false,
};

test("FIXED_512_TABLE_SAFE: 0 violations, 0 misattribution, recall never behind, multi-cell equal/better", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs,
    fixedCriticalViolationCount: 0, sectionCriticalViolationCount: 3,
    fixedMisattributionCount: 0, sectionMisattributionCount: 3,
    recallDeltasByModel: [
      { frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.90, section_table_recall_at_10: 0.85, section_wins: false, fixed_wins: true },
    ],
    fixedMultiCellCompletenessRate: 1, sectionMultiCellCompletenessRate: 0.9,
  });
  assert.equal(result.status, TABLE_VERDICT.FIXED_SAFE);
});

test("Fixed is NOT auto-approved when it has ANY critical violation, even with strong recall", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs,
    fixedCriticalViolationCount: 1, sectionCriticalViolationCount: 5,
    fixedMisattributionCount: 1, sectionMisattributionCount: 5,
    recallDeltasByModel: [{ frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.99, section_table_recall_at_10: 0.80, section_wins: false, fixed_wins: true }],
    fixedMultiCellCompletenessRate: 1, sectionMultiCellCompletenessRate: 1,
  });
  assert.notEqual(result.status, TABLE_VERDICT.FIXED_SAFE);
});

test("SECTION_FLAT_PREFERRED_FOR_TABLES: Section beats Fixed by >=0.03 table Recall@10 in 2+ of 3 models", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs,
    fixedCriticalViolationCount: 5, sectionCriticalViolationCount: 5,
    fixedMisattributionCount: 5, sectionMisattributionCount: 5,
    recallDeltasByModel: [
      { frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.80, section_table_recall_at_10: 0.85 },
      { frozen_candidate_id: "m2", fixed_table_recall_at_10: 0.80, section_table_recall_at_10: 0.84 },
      { frozen_candidate_id: "m3", fixed_table_recall_at_10: 0.80, section_table_recall_at_10: 0.81 },
    ],
    fixedMultiCellCompletenessRate: 0.8, sectionMultiCellCompletenessRate: 0.9,
  });
  assert.equal(result.status, TABLE_VERDICT.SECTION_PREFERRED);
});

test("SECTION_FLAT_PREFERRED_FOR_TABLES: Fixed has critical violations and Section has exactly zero", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs,
    fixedCriticalViolationCount: 10, sectionCriticalViolationCount: 0,
    fixedMisattributionCount: 10, sectionMisattributionCount: 0,
    recallDeltasByModel: [{ frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.85, section_table_recall_at_10: 0.85 }],
    fixedMultiCellCompletenessRate: 0.9, sectionMultiCellCompletenessRate: 0.9,
  });
  assert.equal(result.status, TABLE_VERDICT.SECTION_PREFERRED);
});

test("ADAPTIVE_TABLE_CHUNKING_REQUIRED: reproduces the REAL P10.3 shape -- Section structurally better but not by the 0.03 recall margin, Fixed not safe", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs,
    fixedCriticalViolationCount: 162, sectionCriticalViolationCount: 108,
    fixedMisattributionCount: 121, sectionMisattributionCount: 78,
    recallDeltasByModel: [
      { frozen_candidate_id: "kure_v1", fixed_table_recall_at_10: 0.9286, section_table_recall_at_10: 0.8980 },
      { frozen_candidate_id: "bge_m3", fixed_table_recall_at_10: 0.8980, section_table_recall_at_10: 0.8980 },
      { frozen_candidate_id: "pixie_rune", fixed_table_recall_at_10: 0.9286, section_table_recall_at_10: 0.9184 },
    ],
    fixedMultiCellCompletenessRate: 1, sectionMultiCellCompletenessRate: 1,
  });
  assert.equal(result.status, TABLE_VERDICT.ADAPTIVE_REQUIRED);
  assert.ok(result.adaptiveDesign);
  assert.equal(result.adaptiveDesign.paragraph_title, "fixed-token-512-o64.v0.1.0");
});

test("TABLE_DIAGNOSTIC_INCONCLUSIVE: too small a table sample", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs, tableItemCount: 3,
    fixedCriticalViolationCount: 0, sectionCriticalViolationCount: 0,
    fixedMisattributionCount: 0, sectionMisattributionCount: 0,
    recallDeltasByModel: [], fixedMultiCellCompletenessRate: 1, sectionMultiCellCompletenessRate: 1,
  });
  assert.equal(result.status, TABLE_VERDICT.INCONCLUSIVE);
});

test("TABLE_DIAGNOSTIC_INCONCLUSIVE: P10.2 cache/ranking data missing short-circuits before any other criterion", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs, cacheOrRankingDataMissing: true,
    fixedCriticalViolationCount: 0, sectionCriticalViolationCount: 0,
    fixedMisattributionCount: 0, sectionMisattributionCount: 0,
    recallDeltasByModel: [], fixedMultiCellCompletenessRate: null, sectionMultiCellCompletenessRate: null,
  });
  assert.equal(result.status, TABLE_VERDICT.INCONCLUSIVE);
  assert.ok(result.reasonTrail[0].includes("cache/ranking"));
});

test("TABLE_DIAGNOSTIC_INCONCLUSIVE: locator cannot be deterministically resolved", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs, locatorDeterministicallyResolvable: false,
    fixedCriticalViolationCount: 0, sectionCriticalViolationCount: 0,
    fixedMisattributionCount: 0, sectionMisattributionCount: 0,
    recallDeltasByModel: [], fixedMultiCellCompletenessRate: 1, sectionMultiCellCompletenessRate: 1,
  });
  assert.equal(result.status, TABLE_VERDICT.INCONCLUSIVE);
});

test("TABLE_DIAGNOSTIC_INCONCLUSIVE: model verdicts conflict sharply", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs, modelVerdictsConflictSharply: true,
    fixedCriticalViolationCount: 5, sectionCriticalViolationCount: 5,
    fixedMisattributionCount: 5, sectionMisattributionCount: 5,
    recallDeltasByModel: [], fixedMultiCellCompletenessRate: 1, sectionMultiCellCompletenessRate: 1,
  });
  assert.equal(result.status, TABLE_VERDICT.INCONCLUSIVE);
});

test("determinism not stable disqualifies SECTION_FLAT_PREFERRED_FOR_TABLES even with a strong recall margin", () => {
  const result = decideTableChunkingVerdict({
    ...baseInputs, determinismStable: false,
    fixedCriticalViolationCount: 5, sectionCriticalViolationCount: 5,
    fixedMisattributionCount: 5, sectionMisattributionCount: 5,
    recallDeltasByModel: [
      { frozen_candidate_id: "m1", fixed_table_recall_at_10: 0.80, section_table_recall_at_10: 0.90 },
      { frozen_candidate_id: "m2", fixed_table_recall_at_10: 0.80, section_table_recall_at_10: 0.90 },
    ],
    fixedMultiCellCompletenessRate: 0.8, sectionMultiCellCompletenessRate: 0.9,
  });
  assert.notEqual(result.status, TABLE_VERDICT.SECTION_PREFERRED);
});
