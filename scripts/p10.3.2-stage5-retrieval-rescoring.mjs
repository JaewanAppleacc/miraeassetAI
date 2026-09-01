#!/usr/bin/env node
// Turn P10.3.2 / Stage 5: re-scores P10.2's EXISTING per-item results
// against the CORRECTED 92-item table population (not P10.3's 49). Reads
// ONLY work/p10.2-chunking-embedding-grid/{stage2-grid-results,stage2-
// per-item-results}.v0.1.jsonl from the P10.2 worktree (read-only
// reference, unmodified) -- zero new embedding calls, zero model server
// spawned. Same disclosed granularity gap as P10.3 Stage 3: P10.2 never
// persisted the raw ranked-candidate list per item, only scalar
// aggregates, so cell-level/row-header-aware/etc. metrics stay explicitly
// NOT_COMPUTABLE_WITHOUT_RAW_RANKINGS.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.2-table-full-population-audit");
const P10_2_DIR = "/Users/jaewan/Documents/Codex/worktrees/agent-chunking-embedding-grid-v01/work/p10.2-chunking-embedding-grid";
const FIXED_ID = "fixed-token-512-o64.v0.1.0";
const SECTION_ID = "section-aware-flat-512-o64.v0.1.0";

function mean(values) {
  const filtered = values.filter((v) => v !== null && v !== undefined);
  return filtered.length > 0 ? filtered.reduce((a, b) => a + b, 0) / filtered.length : null;
}

async function main() {
  const stage2ResultsPath = path.join(P10_2_DIR, "stage2-grid-results.v0.1.json");
  const stage2PerItemPath = path.join(P10_2_DIR, "stage2-per-item-results.v0.1.jsonl");
  const inventoryPath = path.join(OUT_DIR, "corrected-table-item-inventory.v0.2.json");

  if (!existsSync(stage2ResultsPath) || !existsSync(stage2PerItemPath)) {
    const failReport = { schema_version: "0.2.0", generated_at: new Date().toISOString(), status: "NOT_COMPUTABLE_WITHOUT_NEW_EMBEDDING", reason: "P10.2 result files not found" };
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "corrected-table-retrieval-metrics.v0.2.json"), `${JSON.stringify(failReport, null, 2)}\n`);
    console.log(JSON.stringify(failReport, null, 2));
    return;
  }

  const stage2Results = JSON.parse(await readFile(stage2ResultsPath, "utf8"));
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const tableQuestionIds = new Set(inventory.per_item.filter((r) => r.is_table_item).map((r) => r.question_id));
  const tagsByQuestionId = new Map(inventory.per_item.filter((r) => r.is_table_item).map((r) => [r.question_id, r.tags]));

  if (stage2Results.combinations_completed !== 6 || stage2Results.combinations.length !== 6) {
    const failReport = { schema_version: "0.2.0", generated_at: new Date().toISOString(), status: "NOT_COMPUTABLE_WITHOUT_NEW_EMBEDDING", reason: `P10.2 combinations incomplete: ${stage2Results.combinations_completed}/6` };
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "corrected-table-retrieval-metrics.v0.2.json"), `${JSON.stringify(failReport, null, 2)}\n`);
    console.log(JSON.stringify(failReport, null, 2));
    return;
  }

  const perItemLines = (await readFile(stage2PerItemPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tableItemLines = perItemLines.filter((r) => tableQuestionIds.has(r.question_id));
  const nonTableItemLines = perItemLines.filter((r) => !tableQuestionIds.has(r.question_id));

  const TAG_LIST = ["SINGLE_CELL_LOOKUP", "ROW_HEADER_VALUE", "COLUMN_PERIOD_VALUE", "UNIT_SENSITIVE", "MULTI_ROW_CALCULATION", "MULTI_COLUMN_COMPARISON", "CROSS_TABLE", "CROSS_DOCUMENT_TABLE", "TABLE_WITH_REPEATED_BOILERPLATE"];

  const combos = [];
  for (const combo of stage2Results.combinations) {
    const rows = tableItemLines.filter((r) => r.frozen_candidate_id === combo.frozen_candidate_id && r.chunking_config_id === combo.chunking_config_id);
    const withSlots = rows.filter((r) => r.has_required_slots);
    const nonTableRows = nonTableItemLines.filter((r) => r.frozen_candidate_id === combo.frozen_candidate_id && r.chunking_config_id === combo.chunking_config_id);

    const byTag = {};
    for (const tag of TAG_LIST) {
      const tagRows = rows.filter((r) => (tagsByQuestionId.get(r.question_id) ?? []).includes(tag));
      byTag[tag] = { item_count: tagRows.length, recall_at_10: tagRows.length > 0 ? mean(tagRows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["10"])) : null };
    }

    combos.push({
      frozen_candidate_id: combo.frozen_candidate_id,
      chunking_config_id: combo.chunking_config_id,
      table_item_count: rows.length,
      computable_from_persisted_results: {
        table_recall_at_5: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["5"])),
        table_recall_at_10: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["10"])),
        table_recall_at_20: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["20"])),
        table_item_hit_rate_at_10: rows.length > 0 ? rows.filter((r) => r.document_hit_at_10).length / rows.length : null,
        table_mrr: mean(withSlots.map((r) => r.reciprocal_rank)),
        table_ndcg_at_10: mean(withSlots.map((r) => r.ndcg_at_10)),
        non_table_recall_at_10: mean(nonTableRows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["10"])),
        table_vs_non_table_recall_at_10_delta: (mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["10"])) ?? 0) - (mean(nonTableRows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["10"])) ?? 0),
        recall_at_10_by_tag: byTag,
      },
      not_computable_without_raw_rankings: {
        cell_level_recall_at_10: null,
        row_header_aware_recall_at_10: null,
        unit_aware_recall_at_10: null,
        period_column_aware_recall_at_10: null,
        table_boilerplate_false_positive_rate: null,
        ambiguous_numeric_collision_rate_retrieval: null,
        reason: "P10.2's per-item results store only item-level scalar aggregates; the raw ranked candidate-chunk list per item was never persisted, and recomputing it requires a new embedding call, which this Turn forbids.",
      },
    });
  }

  const modelIds = [...new Set(combos.map((c) => c.frozen_candidate_id))];
  const modelDeltas = modelIds.map((modelId) => {
    const fixedCombo = combos.find((c) => c.frozen_candidate_id === modelId && c.chunking_config_id === FIXED_ID);
    const sectionCombo = combos.find((c) => c.frozen_candidate_id === modelId && c.chunking_config_id === SECTION_ID);
    return {
      frozen_candidate_id: modelId,
      fixed_table_recall_at_10: fixedCombo.computable_from_persisted_results.table_recall_at_10,
      section_table_recall_at_10: sectionCombo.computable_from_persisted_results.table_recall_at_10,
      section_minus_fixed: sectionCombo.computable_from_persisted_results.table_recall_at_10 - fixedCombo.computable_from_persisted_results.table_recall_at_10,
    };
  });

  const report = {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    status: "COMPUTABLE_FROM_PERSISTED_RESULTS",
    table_evaluation_item_count: tableQuestionIds.size,
    new_embedding_calls: 0,
    new_model_servers_spawned: 0,
    source_p10_2_per_item_results: path.relative(ROOT, stage2PerItemPath),
    model_fixed_minus_section_deltas: modelDeltas,
    combinations: combos,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "corrected-table-retrieval-metrics.v0.2.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    status: "COMPUTABLE_FROM_PERSISTED_RESULTS",
    table_evaluation_item_count: tableQuestionIds.size,
    combinations: combos.map((c) => ({ label: `${c.frozen_candidate_id}x${c.chunking_config_id}`, table_recall_at_10: c.computable_from_persisted_results.table_recall_at_10 })),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.2-stage5-retrieval-rescoring] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
