#!/usr/bin/env node
// Turn P10.2 / Stage 3 + Stage 4: reads Stage 2's already-written results
// (stage2-grid-results.v0.1.json + stage2-per-item-results.v0.1.jsonl,
// never re-embeds anything), computes the per-question-type breakdown and
// chunking x embedding interaction analysis, then applies the FIXED,
// pinned selection rule to the 6 real combinations.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyzeChunkingByModelDelta, analyzeModelRankingByChunking, detectInteraction, detectMacroVsTypeConflict } from "../domain/agent-comparison/chunking-comparison/grid-interaction-analysis.mjs";
import { selectFinalChunkingAndEmbedding, GRID_SELECTION_STATUS } from "../domain/agent-comparison/chunking-comparison/grid-selection-rule.mjs";
import { getFrozenCandidateById } from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.2-chunking-embedding-grid");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const FIXED_CONFIG_ID = "fixed-token-512-o64.v0.1.0";
const SECTION_CONFIG_ID = "section-aware-flat-512-o64.v0.1.0";
const MODEL_ORDER = ["kure_v1", "bge_m3", "pixie_rune"];

function mean(values) {
  const filtered = values.filter((v) => v !== null && v !== undefined);
  return filtered.length > 0 ? filtered.reduce((a, b) => a + b, 0) / filtered.length : null;
}

async function main() {
  const stage2 = JSON.parse(await readFile(path.join(OUT_DIR, "stage2-grid-results.v0.1.json"), "utf8"));
  if (stage2.combinations_completed !== 6) {
    const failReport = { schema_version: "0.1.0", generated_at: new Date().toISOString(), status: GRID_SELECTION_STATUS.CALIBRATION_FAILED, reason: `Stage 2 completed only ${stage2.combinations_completed}/6 combinations` };
    await writeFile(path.join(OUT_DIR, "final-selection.v0.1.json"), `${JSON.stringify(failReport, null, 2)}\n`);
    console.log(JSON.stringify(failReport, null, 2));
    return;
  }

  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const questionTypeById = new Map(goldItems.map((i) => [i.question_id, i.question_type]));
  const docGroupById = new Map(goldItems.map((i) => [i.question_id, i.doc_groups[0]]));

  const perItemLines = (await readFile(path.join(OUT_DIR, "stage2-per-item-results.v0.1.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // --- per-question-type breakdown (recall@10, per combo) ---
  const byQuestionType = {};
  const byDocGroup = {};
  for (const record of perItemLines) {
    const label = `${record.frozen_candidate_id}x${record.chunking_config_id}`;
    const qType = questionTypeById.get(record.question_id);
    const docGroup = docGroupById.get(record.question_id);
    const recall10 = record.evidence_slot_coverage_fraction_at_k?.["10"];
    if (recall10 === null || recall10 === undefined) continue;
    byQuestionType[qType] = byQuestionType[qType] ?? {};
    byQuestionType[qType][label] = byQuestionType[qType][label] ?? [];
    byQuestionType[qType][label].push(recall10);
    byDocGroup[docGroup] = byDocGroup[docGroup] ?? {};
    byDocGroup[docGroup][label] = byDocGroup[docGroup][label] ?? [];
    byDocGroup[docGroup][label].push(recall10);
  }
  const summarize = (groups) => Object.fromEntries(Object.entries(groups).map(([key, byLabel]) => [key, Object.fromEntries(Object.entries(byLabel).map(([label, values]) => [label, { recall_at_10_mean: mean(values), n: values.length }]))]));
  const questionTypeBreakdown = { by_question_type: summarize(byQuestionType), by_doc_group: summarize(byDocGroup) };
  await writeFile(path.join(OUT_DIR, "question-type-breakdown.v0.1.json"), `${JSON.stringify({ schema_version: "0.1.0", ...questionTypeBreakdown }, null, 2)}\n`);

  // --- worst-question-type recall per combo (real data, tie-break input 3) ---
  const worstTypeByCombo = {};
  for (const [, byLabel] of Object.entries(byQuestionType)) {
    for (const [label, values] of Object.entries(byLabel)) {
      const m = mean(values);
      if (worstTypeByCombo[label] === undefined || m < worstTypeByCombo[label]) worstTypeByCombo[label] = m;
    }
  }

  // --- Stage 3: interaction analysis ---
  const comboRecalls = stage2.combinations.map((c) => ({ frozen_candidate_id: c.frozen_candidate_id, chunking_config_id: c.chunking_config_id, recall_at_10: c.rrf.macro_evidence_recall_at_k["10"] }));
  const chunkingByModelDelta = analyzeChunkingByModelDelta(comboRecalls, MODEL_ORDER, FIXED_CONFIG_ID, SECTION_CONFIG_ID);
  const modelRankingByFixed = analyzeModelRankingByChunking(comboRecalls, MODEL_ORDER, FIXED_CONFIG_ID);
  const modelRankingBySection = analyzeModelRankingByChunking(comboRecalls, MODEL_ORDER, SECTION_CONFIG_ID);
  const interaction = detectInteraction(comboRecalls, MODEL_ORDER, FIXED_CONFIG_ID, SECTION_CONFIG_ID);

  const macroFixedMean = mean(comboRecalls.filter((c) => c.chunking_config_id === FIXED_CONFIG_ID).map((c) => c.recall_at_10));
  const macroSectionMean = mean(comboRecalls.filter((c) => c.chunking_config_id === SECTION_CONFIG_ID).map((c) => c.recall_at_10));
  const typeConflictsByModel = {};
  for (const modelId of MODEL_ORDER) {
    const fixedLabel = `${modelId}x${FIXED_CONFIG_ID}`;
    const sectionLabel = `${modelId}x${SECTION_CONFIG_ID}`;
    const modelFixedRecall = comboRecalls.find((c) => c.frozen_candidate_id === modelId && c.chunking_config_id === FIXED_CONFIG_ID).recall_at_10;
    const modelSectionRecall = comboRecalls.find((c) => c.frozen_candidate_id === modelId && c.chunking_config_id === SECTION_CONFIG_ID).recall_at_10;
    typeConflictsByModel[modelId] = detectMacroVsTypeConflict(byQuestionType, fixedLabel, sectionLabel, modelFixedRecall, modelSectionRecall);
  }

  const stage3Report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    chunking_effect_by_model: chunkingByModelDelta,
    model_ranking_by_chunking: { [FIXED_CONFIG_ID]: modelRankingByFixed, [SECTION_CONFIG_ID]: modelRankingBySection },
    interaction: interaction,
    // Promoted to top level (P10.2 follow-up correction) so the corrected
    // interaction reading -- material_performance_interaction: false,
    // rank_order_tie_artifact: true -- is visible without traversing into
    // `interaction`, and so table_diagnostic_status is easy to find.
    material_performance_interaction: interaction.material_performance_interaction,
    rank_order_tie_artifact: interaction.rank_order_tie_artifact,
    table_diagnostic_status: interaction.table_diagnostic_status,
    macro_vs_type_conflicts_by_model: typeConflictsByModel,
    macro_fixed_mean_recall_at_10: macroFixedMean,
    macro_section_mean_recall_at_10: macroSectionMean,
  };
  await writeFile(path.join(OUT_DIR, "stage3-interaction-analysis.v0.1.json"), `${JSON.stringify(stage3Report, null, 2)}\n`);

  // --- Stage 4: final selection ---
  const combosForSelection = stage2.combinations.map((c) => {
    const label = `${c.frozen_candidate_id}x${c.chunking_config_id}`;
    const candidate = getFrozenCandidateById(c.frozen_candidate_id);
    return {
      frozen_candidate_id: c.frozen_candidate_id,
      chunking_config_id: c.chunking_config_id,
      recall_at_10: c.rrf.macro_evidence_recall_at_k["10"],
      ndcg_at_10: c.rrf.macro_ndcg_at_10,
      mrr: c.rrf.macro_mrr,
      worst_question_type_recall: worstTypeByCombo[label],
      // Real per-combo unique embedding calls could not be isolated post-hoc
      // from the SHARED, model-scoped cache (cache.stats() was only
      // snapshotted once, cumulatively, at the end of Stage 2 -- a real
      // gap discovered after the run completed). search_eligible_chunks
      // is used as a documented, honest PROXY (upper bound on embeddable
      // texts for that chunking) for this tie-break dimension; the
      // decisive comparison below in fact resolves before reaching it.
      unique_embedding_calls: c.search_eligible_chunks,
      unique_embedding_calls_is_proxy: true,
      latency_p95_ms: c.latency_ms.dense_p95,
      peak_rss_bytes: c.peak_rss_bytes,
      estimated_storage_bytes: c.search_eligible_chunks * candidate.embedding_dimension * 4,
      locator_provenance_violations: c.locator_provenance_violations,
    };
  });

  const selection = selectFinalChunkingAndEmbedding(combosForSelection, { expectedComboCount: 6, determinismStable: true });

  let finalReport;
  if (selection.status === GRID_SELECTION_STATUS.SELECTED) {
    const winningCandidate = getFrozenCandidateById(selection.winner.frozen_candidate_id);
    finalReport = {
      schema_version: "0.1.0", generated_at: new Date().toISOString(),
      status: selection.status,
      reason_trail: selection.reasonTrail,
      final_chunking_strategy: selection.winner.chunking_config_id,
      final_embedding_repository: winningCandidate.repository_id,
      final_embedding_revision: winningCandidate.immutable_revision,
      final_embedding_dimension: winningCandidate.embedding_dimension,
      final_query_prefix: winningCandidate.query_prefix,
      final_document_prefix: winningCandidate.document_prefix,
      retrieval_combination_fixed_this_turn: "BM25 + dense + RRF (other retrieval combination methods left to a separate Turn)",
      final_embedding_model_selected: true,
    };
  } else {
    finalReport = { schema_version: "0.1.0", generated_at: new Date().toISOString(), status: selection.status, reason_trail: selection.reasonTrail, final_embedding_model_selected: false };
  }
  // P10.2 follow-up correction: the selection above is based on macro
  // recall@10/nDCG@10/MRR, which is table-content-agnostic. Whether the
  // winning chunking (Fixed-512) specifically preserves table row/column/
  // unit/period context is a SEPARATE, still-open question, resolved only
  // by Turn P10.3-TABLE's dedicated table-structure diagnostic.
  finalReport.table_diagnostic_status = interaction.table_diagnostic_status;
  finalReport.all_combinations_ranked = combosForSelection;
  await writeFile(path.join(OUT_DIR, "final-selection.v0.1.json"), `${JSON.stringify(finalReport, null, 2)}\n`);

  console.log(JSON.stringify({ status: selection.status, winner: selection.winner, macro_fixed_mean: macroFixedMean, macro_section_mean: macroSectionMean, has_interaction: interaction.has_interaction, material_performance_interaction: interaction.material_performance_interaction, rank_order_tie_artifact: interaction.rank_order_tie_artifact, table_diagnostic_status: interaction.table_diagnostic_status }, null, 2));
}

main().catch((error) => {
  console.error("[p10.2-stage3-4] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
