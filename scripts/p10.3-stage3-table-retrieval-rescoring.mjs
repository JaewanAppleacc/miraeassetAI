#!/usr/bin/env node
// Turn P10.3-TABLE / Stage 3: table-only rescoring of P10.2's EXISTING
// per-item retrieval results. Reads ONLY
// work/p10.2-chunking-embedding-grid/{stage2-grid-results,stage2-per-item-
// results}.v0.1.jsonl from the P10.2 worktree (read-only reference,
// unmodified) -- zero new embedding calls, zero model server spawned.
//
// GENUINE, DISCLOSED LIMITATION (this Turn's own fail-closed contingency:
// "P10.2 cache/ranking 결과 누락"): P10.2's per-item file stores only
// SCALAR, item-level aggregates (evidence_slot_coverage_fraction_at_k,
// reciprocal_rank, ndcg_at_10) -- the raw ranked candidate-chunk list each
// combination actually returned per item was computed transiently inside
// scripts/p10.2-stage2-embedding-grid.mjs's computeItemMetrics() call but
// was NEVER persisted to disk (verified by reading that script and the
// per-item file's actual keys). Recovering it would require re-running
// dense retrieval, which requires the embedding vectors, which requires a
// new embedding call -- forbidden this Turn. So:
//   COMPUTABLE from existing item-level aggregates, filtered to
//   TABLE_EVALUATION_ITEM question_ids (Stage 1): table Recall@5/10/20,
//   table MRR, table nDCG@10, and multi-cell-complete-evidence Recall@10
//   (operationalized as "ALL required_evidence_slots covered at k=10",
//   i.e. evidence_slot_coverage_fraction_at_k["10"] === 1, for items
//   Stage 1 tagged MULTI_ROW_CALCULATION or MULTI_COLUMN_COMPARISON).
//   NOT COMPUTABLE without a new embedding call: cell-level Recall@10,
//   row-header-aware Recall@10, unit-aware Recall@10, period-column-aware
//   Recall@10, table boilerplate false-positive rate, ambiguous numeric
//   collision rate (retrieval-rank version) -- each needs to know WHICH
//   specific chunk was returned at each rank, not just whether slots were
//   covered. Reported as not_computable with an explicit reason, never
//   fabricated or approximated by silent substitution.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3-table-diagnostic");
const P10_2_DIR = "/Users/jaewan/Documents/Codex/worktrees/agent-chunking-embedding-grid-v01/work/p10.2-chunking-embedding-grid";
const NOT_COMPUTABLE_REASON = "P10.2's per-item results store only item-level scalar aggregates (evidence_slot_coverage_fraction_at_k, reciprocal_rank, ndcg_at_10); the raw ranked candidate-chunk list per item was never persisted, and recomputing it requires a new embedding call, which this Turn forbids. Categorized under this Turn's own TABLE_DIAGNOSTIC_INCONCLUSIVE trigger \"P10.2 cache/ranking 결과 누락\" for this specific sub-metric only.";

function mean(values) {
  const filtered = values.filter((v) => v !== null && v !== undefined);
  return filtered.length > 0 ? filtered.reduce((a, b) => a + b, 0) / filtered.length : null;
}

async function main() {
  const stage2ResultsPath = path.join(P10_2_DIR, "stage2-grid-results.v0.1.json");
  const stage2PerItemPath = path.join(P10_2_DIR, "stage2-per-item-results.v0.1.jsonl");
  const tableInventoryPath = path.join(OUT_DIR, "table-item-inventory.v0.1.json");

  if (!existsSync(stage2ResultsPath) || !existsSync(stage2PerItemPath)) {
    const failReport = {
      schema_version: "0.1.0", generated_at: new Date().toISOString(),
      status: "TABLE_DIAGNOSTIC_INCONCLUSIVE", reason: "P10.2 cache/ranking 결과 누락: stage2-grid-results.v0.1.json or stage2-per-item-results.v0.1.jsonl not found (read-only reference to the P10.2 worktree)",
    };
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "table-retrieval-metrics-by-combination.v0.1.json"), `${JSON.stringify(failReport, null, 2)}\n`);
    console.log(JSON.stringify(failReport, null, 2));
    return;
  }
  if (!existsSync(tableInventoryPath)) {
    throw new Error("FAIL-CLOSED: run scripts/p10.3-stage1-table-item-classification.mjs first");
  }

  const stage2Results = JSON.parse(await readFile(stage2ResultsPath, "utf8"));
  if (stage2Results.combinations_completed !== 6 || stage2Results.combinations.length !== 6) {
    const failReport = {
      schema_version: "0.1.0", generated_at: new Date().toISOString(),
      status: "TABLE_DIAGNOSTIC_INCONCLUSIVE", reason: `P10.2 combinations incomplete: ${stage2Results.combinations_completed}/6`,
    };
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "table-retrieval-metrics-by-combination.v0.1.json"), `${JSON.stringify(failReport, null, 2)}\n`);
    console.log(JSON.stringify(failReport, null, 2));
    return;
  }

  const inventory = JSON.parse(await readFile(tableInventoryPath, "utf8"));
  const tableQuestionIds = new Set(inventory.per_item.filter((r) => r.is_table_item).map((r) => r.question_id));
  const multiCellQuestionIds = new Set(inventory.per_item.filter((r) => r.tags.includes("MULTI_ROW_CALCULATION") || r.tags.includes("MULTI_COLUMN_COMPARISON")).map((r) => r.question_id));

  const perItemLines = (await readFile(stage2PerItemPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tableItemLines = perItemLines.filter((r) => tableQuestionIds.has(r.question_id));

  const combos = [];
  for (const combo of stage2Results.combinations) {
    const label = `${combo.frozen_candidate_id}x${combo.chunking_config_id}`;
    const rows = tableItemLines.filter((r) => r.frozen_candidate_id === combo.frozen_candidate_id && r.chunking_config_id === combo.chunking_config_id);
    const withSlots = rows.filter((r) => r.has_required_slots);
    const multiCellRows = rows.filter((r) => multiCellQuestionIds.has(r.question_id));

    combos.push({
      frozen_candidate_id: combo.frozen_candidate_id,
      chunking_config_id: combo.chunking_config_id,
      table_item_count: rows.length,
      computable: {
        table_recall_at_5: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["5"])),
        table_recall_at_10: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["10"])),
        table_recall_at_20: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["20"])),
        table_mrr: mean(withSlots.map((r) => r.reciprocal_rank)),
        table_ndcg_at_10: mean(withSlots.map((r) => r.ndcg_at_10)),
        multi_cell_complete_evidence_recall_at_10: multiCellRows.length > 0
          ? multiCellRows.filter((r) => (r.evidence_slot_coverage_fraction_at_k?.["10"] ?? 0) === 1).length / multiCellRows.length
          : null,
        multi_cell_item_count: multiCellRows.length,
      },
      not_computable: {
        cell_level_recall_at_10: null,
        row_header_aware_recall_at_10: null,
        unit_aware_recall_at_10: null,
        period_column_aware_recall_at_10: null,
        table_boilerplate_false_positive_rate: null,
        ambiguous_numeric_collision_rate_retrieval: null,
        reason: NOT_COMPUTABLE_REASON,
      },
    });
  }

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    status: "PARTIAL_REAL_DATA",
    table_evaluation_item_count: tableQuestionIds.size,
    multi_cell_evaluation_item_count: multiCellQuestionIds.size,
    source_p10_2_per_item_results: path.relative(ROOT, stage2PerItemPath),
    new_embedding_calls: 0,
    new_model_servers_spawned: 0,
    combinations: combos,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "table-retrieval-metrics-by-combination.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    status: "PARTIAL_REAL_DATA",
    table_evaluation_item_count: tableQuestionIds.size,
    combinations: combos.map((c) => ({ label: `${c.frozen_candidate_id}x${c.chunking_config_id}`, table_recall_at_10: c.computable.table_recall_at_10 })),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3-stage3-table-retrieval-rescoring] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
