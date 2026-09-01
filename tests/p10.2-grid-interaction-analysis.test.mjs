import test from "node:test";
import assert from "node:assert/strict";
import { analyzeChunkingByModelDelta, analyzeModelRankingByChunking, detectInteraction, detectMacroVsTypeConflict } from "../domain/agent-comparison/chunking-comparison/grid-interaction-analysis.mjs";

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
