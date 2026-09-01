#!/usr/bin/env node
// Turn P10.3-TABLE / Stage 4 + Stage 5: reads Stage 1/2/3's already-written
// results (never re-chunks, never re-scores, never touches retrieval or
// embeddings), computes the chunking x embedding interaction over TABLE
// evidence, then applies the FIXED, pre-registered verdict rule.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { computeTableRecallDeltasByModel, computeStructuralDelta, classifyTableInteraction } from "../domain/agent-comparison/chunking-comparison/table-chunking-interaction.mjs";
import { decideTableChunkingVerdict, TABLE_VERDICT } from "../domain/agent-comparison/chunking-comparison/table-chunking-verdict-rule.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3-table-diagnostic");
const FIXED_ID = "fixed-token-512-o64.v0.1.0";
const SECTION_ID = "section-aware-flat-512-o64.v0.1.0";

async function readJson(p) { return JSON.parse(await readFile(p, "utf8")); }

async function main() {
  const inventory = await readJson(path.join(OUT_DIR, "table-item-inventory.v0.1.json"));
  const preservation = await readJson(path.join(OUT_DIR, "table-structure-preservation-report.v0.1.json"));
  const retrieval = await readJson(path.join(OUT_DIR, "table-retrieval-metrics-by-combination.v0.1.json"));

  const cacheOrRankingDataMissing = retrieval.status === "TABLE_DIAGNOSTIC_INCONCLUSIVE";
  const unresolvedFraction = inventory.total_table_kind_sources > 0 ? inventory.total_unresolvable_table_cells / inventory.total_table_kind_sources : 0;
  const locatorDeterministicallyResolvable = unresolvedFraction < 0.2;

  const fixedPreservation = preservation.strategies.find((s) => s.chunking_config_id === FIXED_ID);
  const sectionPreservation = preservation.strategies.find((s) => s.chunking_config_id === SECTION_ID);

  let interaction = null;
  let verdict;
  if (cacheOrRankingDataMissing) {
    verdict = decideTableChunkingVerdict({
      tableItemCount: inventory.table_evaluation_item_count,
      fixedCriticalViolationCount: fixedPreservation?.critical_violation_count ?? null,
      sectionCriticalViolationCount: sectionPreservation?.critical_violation_count ?? null,
      fixedMisattributionCount: null, sectionMisattributionCount: null,
      recallDeltasByModel: [], fixedMultiCellCompletenessRate: null, sectionMultiCellCompletenessRate: null,
      determinismStable: true, cacheOrRankingDataMissing: true, locatorDeterministicallyResolvable, modelVerdictsConflictSharply: false,
    });
  } else {
    const modelIds = [...new Set(retrieval.combinations.map((c) => c.frozen_candidate_id))];
    const recallDeltasByModelRaw = modelIds.map((modelId) => {
      const fixedCombo = retrieval.combinations.find((c) => c.frozen_candidate_id === modelId && c.chunking_config_id === FIXED_ID);
      const sectionCombo = retrieval.combinations.find((c) => c.frozen_candidate_id === modelId && c.chunking_config_id === SECTION_ID);
      return { frozen_candidate_id: modelId, fixed_table_recall_at_10: fixedCombo.computable.table_recall_at_10, section_table_recall_at_10: sectionCombo.computable.table_recall_at_10 };
    });
    const recallDeltasByModel = computeTableRecallDeltasByModel(recallDeltasByModelRaw);

    const misattributionTypes = new Set(["ROW_HEADER_VALUE_MISMATCH", "PERIOD_COLUMN_VALUE_MISMATCH", "UNIT_MISSING_OR_MISCOMBINED"]);
    const countMisattribution = (strategyReport) => strategyReport.per_item.reduce((sum, item) => sum + item.critical_violations.filter((v) => misattributionTypes.has(v.type)).length, 0);
    const fixedMisattributionCount = countMisattribution(fixedPreservation);
    const sectionMisattributionCount = countMisattribution(sectionPreservation);

    const structuralDelta = computeStructuralDelta({
      fixedCriticalViolations: fixedPreservation.critical_violation_count,
      sectionCriticalViolations: sectionPreservation.critical_violation_count,
      fixedMultiCellOk: fixedPreservation.totals.multi_cell_colocation_items_ok,
      sectionMultiCellOk: sectionPreservation.totals.multi_cell_colocation_items_ok,
      fixedItemCount: fixedPreservation.table_items_evaluated,
      sectionItemCount: sectionPreservation.table_items_evaluated,
    });

    interaction = classifyTableInteraction({ recallDeltasByModel, structuralDelta });

    const anySectionWins = recallDeltasByModel.some((d) => d.section_wins);
    const anyFixedWins = recallDeltasByModel.some((d) => d.fixed_wins);
    const modelVerdictsConflictSharply = anySectionWins && anyFixedWins;

    verdict = decideTableChunkingVerdict({
      tableItemCount: inventory.table_evaluation_item_count,
      fixedCriticalViolationCount: fixedPreservation.critical_violation_count,
      sectionCriticalViolationCount: sectionPreservation.critical_violation_count,
      fixedMisattributionCount, sectionMisattributionCount,
      recallDeltasByModel,
      fixedMultiCellCompletenessRate: structuralDelta.fixed_multi_cell_completeness_rate,
      sectionMultiCellCompletenessRate: structuralDelta.section_multi_cell_completeness_rate,
      determinismStable: true,
      cacheOrRankingDataMissing: false,
      locatorDeterministicallyResolvable,
      modelVerdictsConflictSharply,
    });

    const interactionReport = {
      schema_version: "0.1.0",
      generated_at: new Date().toISOString(),
      structural_delta: structuralDelta,
      retrieval_interaction: interaction,
      fixed_misattribution_count: fixedMisattributionCount,
      section_misattribution_count: sectionMisattributionCount,
    };
    await writeFile(path.join(OUT_DIR, "table-chunking-interaction-report.v0.1.json"), `${JSON.stringify(interactionReport, null, 2)}\n`);
  }

  const verdictReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    status: verdict.status,
    reason_trail: verdict.reasonTrail,
    adaptive_design: verdict.adaptiveDesign,
    inputs_summary: {
      table_evaluation_item_count: inventory.table_evaluation_item_count,
      fixed_critical_violation_count: fixedPreservation?.critical_violation_count ?? null,
      section_critical_violation_count: sectionPreservation?.critical_violation_count ?? null,
      locator_deterministically_resolvable: locatorDeterministicallyResolvable,
      cache_or_ranking_data_missing: cacheOrRankingDataMissing,
    },
  };
  await writeFile(path.join(OUT_DIR, "table-chunking-final-verdict.v0.1.json"), `${JSON.stringify(verdictReport, null, 2)}\n`);

  console.log(JSON.stringify({ status: verdict.status, reason_trail: verdict.reasonTrail }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3-stage4-5-interaction-and-verdict] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
