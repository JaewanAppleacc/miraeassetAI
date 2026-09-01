import test from "node:test";
import assert from "node:assert/strict";
import { analyzeChunkingByModelDelta, analyzeModelRankingByChunking, detectInteraction, detectMacroVsTypeConflict, TABLE_DIAGNOSTIC_STATUS } from "../domain/agent-comparison/chunking-comparison/grid-interaction-analysis.mjs";

const FIXED = "fixed-token-512-o64.v0.1.0";
const SECTION = "section-aware-flat-512-o64.v0.1.0";
const MODELS = ["kure_v1", "bge_m3", "pixie_rune"];

function combo(model, chunking, recall) {
  return { frozen_candidate_id: model, chunking_config_id: chunking, recall_at_10: recall };
}

test("analyzeChunkingByModelDelta: computes section-minus-fixed per model and flags winners within tolerance", () => {
  const combos = [
    combo("kure_v1", FIXED, 0.80), combo("kure_v1", SECTION, 0.82), // +0.02 -> section wins
    combo("bge_m3", FIXED, 0.85), combo("bge_m3", SECTION, 0.84), // -0.01, within tolerance boundary (exactly -0.01 -> fixed_wins true since <=-0.01)
    combo("pixie_rune", FIXED, 0.70), combo("pixie_rune", SECTION, 0.705), // within tolerance
  ];
  const result = analyzeChunkingByModelDelta(combos, MODELS, FIXED, SECTION);
  assert.equal(result.kure_v1.section_wins, true);
  assert.equal(result.pixie_rune.within_tolerance, true);
});

test("analyzeChunkingByModelDelta: fixed_minus_section is the exact negation of section_minus_fixed (P10.2 follow-up requirement: Fixed-Section delta recorded)", () => {
  const combos = [combo("kure_v1", FIXED, 0.868), combo("kure_v1", SECTION, 0.834)];
  const result = analyzeChunkingByModelDelta(combos, ["kure_v1"], FIXED, SECTION);
  assert.equal(result.kure_v1.fixed_minus_section, -result.kure_v1.section_minus_fixed);
  assert.ok(Math.abs(result.kure_v1.fixed_minus_section - 0.034) < 1e-9);
});

test("analyzeChunkingByModelDelta throws when a combination is missing (never silently treats it as 0)", () => {
  const combos = [combo("kure_v1", FIXED, 0.8)];
  assert.throws(() => analyzeChunkingByModelDelta(combos, MODELS, FIXED, SECTION));
});

test("analyzeModelRankingByChunking: ranks models descending by recall@10, tie-break by candidate id", () => {
  const combos = [combo("kure_v1", FIXED, 0.80), combo("bge_m3", FIXED, 0.85), combo("pixie_rune", FIXED, 0.70)];
  const ranking = analyzeModelRankingByChunking(combos, MODELS, FIXED);
  assert.deepEqual(ranking.map((r) => r.frozen_candidate_id), ["bge_m3", "kure_v1", "pixie_rune"]);
});

test("detectInteraction: no interaction when both chunkings preserve the same model ranking and direction", () => {
  const combos = [
    combo("kure_v1", FIXED, 0.80), combo("kure_v1", SECTION, 0.79),
    combo("bge_m3", FIXED, 0.85), combo("bge_m3", SECTION, 0.84),
    combo("pixie_rune", FIXED, 0.70), combo("pixie_rune", SECTION, 0.69),
  ];
  const result = detectInteraction(combos, MODELS, FIXED, SECTION);
  assert.equal(result.has_interaction, false);
  assert.equal(result.top_model_changed, false);
});

test("detectInteraction: flags a real interaction when Section reverses the top model", () => {
  const combos = [
    combo("kure_v1", FIXED, 0.70), combo("kure_v1", SECTION, 0.90), // Section makes kure the leader
    combo("bge_m3", FIXED, 0.85), combo("bge_m3", SECTION, 0.80),
    combo("pixie_rune", FIXED, 0.60), combo("pixie_rune", SECTION, 0.55),
  ];
  const result = detectInteraction(combos, MODELS, FIXED, SECTION);
  assert.equal(result.top_model_changed, true);
  assert.equal(result.has_interaction, true);
});

test("detectInteraction: flags interaction when models disagree in DIRECTION even without a top-rank change", () => {
  const combos = [
    combo("kure_v1", FIXED, 0.80), combo("kure_v1", SECTION, 0.90), // kure: section wins
    combo("bge_m3", FIXED, 0.85), combo("bge_m3", SECTION, 0.75), // bge: fixed wins
    combo("pixie_rune", FIXED, 0.60), combo("pixie_rune", SECTION, 0.60),
  ];
  const result = detectInteraction(combos, MODELS, FIXED, SECTION);
  assert.equal(result.any_model_where_section_beats_fixed, true);
  assert.equal(result.any_model_where_fixed_beats_section, true);
  assert.equal(result.has_interaction, true);
  assert.equal(result.material_performance_interaction, true, "a genuine, non-tied direction disagreement IS a material interaction");
  assert.equal(result.rank_order_tie_artifact, false);
});

// Regression test (P10.2 follow-up correction, 2026-09-01): reproduces the
// REAL P10.2 grid data shape -- Fixed clearly favors kure_v1 over bge_m3,
// but under Section the two tie EXACTLY, so the alphabetical id tie-break
// (bge_m3 < kure_v1) swaps their rank order. This must NOT be reported as
// a material chunking x embedding interaction: it carries zero performance
// signal, only an artifact of how ties are broken for display ordering.
test("detectInteraction: a rank-order swap caused ONLY by an exact tie is a tie artifact, not a material interaction", () => {
  const combos = [
    combo("pixie_rune", FIXED, 0.8713333333333334), combo("pixie_rune", SECTION, 0.8489999999999999),
    combo("kure_v1", FIXED, 0.868), combo("kure_v1", SECTION, 0.834),
    combo("bge_m3", FIXED, 0.8521666666666667), combo("bge_m3", SECTION, 0.834), // exact tie with kure_v1 under Section
  ];
  const result = detectInteraction(combos, MODELS, FIXED, SECTION);
  assert.deepEqual(result.fixed_ranking, ["pixie_rune", "kure_v1", "bge_m3"]);
  assert.deepEqual(result.section_ranking, ["pixie_rune", "bge_m3", "kure_v1"]);
  assert.equal(result.ranking_order_changed, true, "the raw rank order DOES change (kure_v1/bge_m3 swap)");
  assert.equal(result.rank_order_tie_artifact, true, "the swap is fully explained by an exact tie");
  assert.equal(result.material_performance_interaction, false, "a tie-driven swap must never be treated as a real interaction");
  // Fixed wins for every model beyond tolerance; Section never wins for any
  // model -- so there is no genuine direction disagreement either.
  assert.equal(result.any_model_where_section_beats_fixed, false);
  assert.equal(result.any_model_where_fixed_beats_section, true);
});

test("detectInteraction: no rank-order change at all means no tie artifact and no material interaction", () => {
  const combos = [
    combo("kure_v1", FIXED, 0.80), combo("kure_v1", SECTION, 0.79),
    combo("bge_m3", FIXED, 0.85), combo("bge_m3", SECTION, 0.84),
    combo("pixie_rune", FIXED, 0.70), combo("pixie_rune", SECTION, 0.69),
  ];
  const result = detectInteraction(combos, MODELS, FIXED, SECTION);
  assert.equal(result.ranking_order_changed, false);
  assert.equal(result.rank_order_tie_artifact, false);
  assert.equal(result.material_performance_interaction, false);
});

test("detectInteraction: always reports TABLE_DIAGNOSTIC_PENDING (cleared only by Turn P10.3-TABLE)", () => {
  const combos = [
    combo("kure_v1", FIXED, 0.80), combo("kure_v1", SECTION, 0.79),
    combo("bge_m3", FIXED, 0.85), combo("bge_m3", SECTION, 0.84),
    combo("pixie_rune", FIXED, 0.70), combo("pixie_rune", SECTION, 0.69),
  ];
  const result = detectInteraction(combos, MODELS, FIXED, SECTION);
  assert.equal(result.table_diagnostic_status, "TABLE_DIAGNOSTIC_PENDING");
  assert.equal(TABLE_DIAGNOSTIC_STATUS, "TABLE_DIAGNOSTIC_PENDING");
});

test("detectMacroVsTypeConflict: flags a question type whose verdict contradicts the macro verdict", () => {
  const typeBreakdown = {
    NUMERIC_LOOKUP: { fixed: { recall_at_10_mean: 0.90, n: 50 }, section: { recall_at_10_mean: 0.70, n: 50 } }, // fixed wins here
    NARRATIVE_MULTI_DOC: { fixed: { recall_at_10_mean: 0.60, n: 20 }, section: { recall_at_10_mean: 0.90, n: 20 } }, // section wins here
  };
  // macro: section wins overall (0.80 vs 0.75)
  const result = detectMacroVsTypeConflict(typeBreakdown, "fixed", "section", 0.75, 0.80);
  assert.equal(result.macro_section_wins, true);
  assert.equal(result.has_conflict, true);
  assert.equal(result.conflicting_question_types.length, 1);
  assert.equal(result.conflicting_question_types[0].question_type, "NUMERIC_LOOKUP");
});

test("detectMacroVsTypeConflict: no conflict when every type agrees with the macro verdict", () => {
  const typeBreakdown = {
    NUMERIC_LOOKUP: { fixed: { recall_at_10_mean: 0.70, n: 50 }, section: { recall_at_10_mean: 0.80, n: 50 } },
  };
  const result = detectMacroVsTypeConflict(typeBreakdown, "fixed", "section", 0.70, 0.80);
  assert.equal(result.has_conflict, false);
});
