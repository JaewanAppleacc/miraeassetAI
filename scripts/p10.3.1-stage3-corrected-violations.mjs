#!/usr/bin/env node
// Turn P10.3.1 / Stage 3: re-aggregates P10.3's critical violations,
// counting toward "chunking-attributable" ONLY the ones Stage 2's audit
// classified as CHUNK_BOUNDARY_CONTEXT_LOSS or CHUNK_METADATA_LOSS --
// GOLD_LOCATOR_AMBIGUOUS/UNRESOLVABLE, SOURCE_PARSE_LIMITATION, and
// RESOLVER_IMPLEMENTATION_BUG instances are excluded and reported
// separately. No chunking or embedding is (re-)run; this reads only
// Stage 2's already-computed audit and P10.3's already-materialized
// report (neither modified).
//
// table_title_preserved and multi_cell_colocation were recorded by P10.3
// only as per-item AGGREGATE rates, not per-cell violation instances (they
// were never one of P10.3's 5 named critical_violation "type" values), so
// there is no per-cell root_cause to reclassify for those two categories
// -- they carry forward from P10.3 exactly as-is, with this noted
// explicitly rather than silently treated as "corrected".
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.1-table-locator-audit");
const P10_3_PRESERVATION_PATH = path.join(ROOT, "work/p10.3-table-diagnostic/table-structure-preservation-report.v0.1.json");
const FIXED_ID = "fixed-token-512-o64.v0.1.0";
const SECTION_ID = "section-aware-flat-512-o64.v0.1.0";
const CHUNKING_ATTRIBUTABLE_CAUSES = new Set(["CHUNK_BOUNDARY_CONTEXT_LOSS", "CHUNK_METADATA_LOSS"]);
const VIOLATION_TYPE_TO_CATEGORY = {
  ROW_HEADER_VALUE_MISMATCH: "row_header_loss",
  PERIOD_COLUMN_VALUE_MISMATCH: "column_period_header_loss",
  UNIT_MISSING_OR_MISCOMBINED: "unit_loss",
  LOCATOR_RESOLVES_TO_WRONG_CELL: "locator_provenance_loss",
  GOLD_CELLS_NOT_RECOVERABLE: "gold_cells_not_recoverable",
};

async function main() {
  const preservation = JSON.parse(await readFile(P10_3_PRESERVATION_PATH, "utf8"));
  const audit = JSON.parse(await readFile(path.join(OUT_DIR, "table-locator-root-cause-audit.v0.1.json"), "utf8"));

  // Build a lookup from (strategy, audit_item_id, violation_type,
  // node_id_hash, row_index) -> root_cause, using Stage 2's own records.
  const rootCauseByKey = new Map();
  for (const rec of audit.audit_records) {
    if (!rec.strategy) continue; // the 4 unresolvable-source records carry no strategy
    const key = `${rec.strategy}|${rec.audit_item_id}|${rec.violation_type}|${rec.node_id_hash}|${rec.row_index}`;
    rootCauseByKey.set(key, rec.root_cause);
  }

  function anonymizeId(questionId) { return `audit_item_${createHash("sha256").update(questionId, "utf8").digest("hex").slice(0, 16)}`; }
  function hashNodeId(nodeId) { return createHash("sha256").update(nodeId, "utf8").digest("hex").slice(0, 16); }

  const perStrategy = {};
  for (const strategyId of [FIXED_ID, SECTION_ID]) {
    const strategyReport = preservation.strategies.find((s) => s.chunking_config_id === strategyId);
    const byCategory = { row_header_loss: 0, column_period_header_loss: 0, unit_loss: 0, gold_cells_not_recoverable: 0, locator_provenance_loss: 0 };
    const excludedByCategory = { row_header_loss: 0, column_period_header_loss: 0, unit_loss: 0, gold_cells_not_recoverable: 0, locator_provenance_loss: 0 };
    let originalTotal = 0;

    for (const item of strategyReport.per_item) {
      const auditItemId = anonymizeId(item.question_id);
      for (const violation of item.critical_violations) {
        originalTotal += 1;
        const category = VIOLATION_TYPE_TO_CATEGORY[violation.type];
        const key = `${strategyId}|${auditItemId}|${violation.type}|${hashNodeId(violation.node_id)}|${violation.row_index}`;
        const rootCause = rootCauseByKey.get(key);
        if (rootCause && CHUNKING_ATTRIBUTABLE_CAUSES.has(rootCause)) {
          byCategory[category] += 1;
        } else {
          excludedByCategory[category] += 1;
        }
      }
    }

    const correctedTotal = Object.values(byCategory).reduce((a, b) => a + b, 0);
    perStrategy[strategyId] = {
      original_critical_violation_count: originalTotal,
      corrected_chunking_attributable_count: correctedTotal,
      excluded_count: originalTotal - correctedTotal,
      by_category_corrected: byCategory,
      by_category_excluded: excludedByCategory,
      // Carried forward AS-IS from P10.3 -- no per-cell root_cause exists
      // to reclassify for these two (aggregate-rate-only categories).
      table_title_loss_carried_forward: { preserved: strategyReport.totals.table_title_preserved, applicable: strategyReport.totals.table_title_applicable, loss_count: strategyReport.totals.table_title_applicable - strategyReport.totals.table_title_preserved },
      multi_cell_context_loss_carried_forward: { items_ok: strategyReport.totals.multi_cell_colocation_items_ok, items_evaluated: strategyReport.table_items_evaluated, loss_count: strategyReport.table_items_evaluated - strategyReport.totals.multi_cell_colocation_items_ok },
    };
  }

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    note: "table_title_loss and multi_cell_context_loss are carried forward from P10.3 as aggregate rates (no per-cell violation record existed to audit for root cause); all other categories are re-derived from Stage 2's per-cell root-cause audit.",
    strategies: perStrategy,
    side_by_side: {
      [FIXED_ID]: { original_162_or_actual: perStrategy[FIXED_ID].original_critical_violation_count, corrected: perStrategy[FIXED_ID].corrected_chunking_attributable_count },
      [SECTION_ID]: { original_108_or_actual: perStrategy[SECTION_ID].original_critical_violation_count, corrected: perStrategy[SECTION_ID].corrected_chunking_attributable_count },
    },
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "corrected-table-critical-violations.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify(report.side_by_side, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.1-stage3-corrected-violations] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
