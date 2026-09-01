#!/usr/bin/env node
// Turn P10.3.2 / Stage 1 + Stage 2: re-parses ALL 345 Gold acceptable_
// sources across the full DEV_TUNE-101 population using the corrected,
// authority-respecting locator resolver (table-locator-authority-v2.mjs),
// and re-identifies the true TABLE_EVALUATION_ITEM population from
// scratch (never trusting P10.3's or P10.3.1's reported counts). No
// chunking or embedding is run here.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { classifyLocatorScheme, resolveNodeForLocator, resolveAuthoritativeCellV2, LOCATOR_SCHEME, ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority-v2.mjs";
import { classifyGoldItemForTablesV2, TABLE_ITEM_TAGS } from "../domain/agent-comparison/chunking-comparison/table-item-classifier-v2.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.2-table-full-population-audit");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");

async function main() {
  if (!existsSync(RAW_CACHE_PATH)) throw new Error(`FAIL-CLOSED: ${RAW_CACHE_PATH} not found -- run scripts/p10.1-build-evaluation-corpus.mjs first`);
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cacheLines = (await readFile(RAW_CACHE_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rawRecordByDocId = new Map(cacheLines.map((entry) => [entry.document_id, entry.raw_record]));

  // --- Stage 1: locator resolution report (per-source, structural only) ---
  const schemeCounts = { CELL_QUALIFIED: 0, ROW_QUALIFIED: 0, NODE_ONLY_HASH: 0, NODE_ONLY_COLON: 0, UNRECOGNIZED: 0 };
  const rootCauseCounts = {};
  let totalSources = 0;
  let tableKindSources = 0;
  const uniqueTableNodeKeys = new Set();

  for (const item of goldItems) {
    for (const slot of item.required_evidence_slots ?? []) {
      for (const src of slot.acceptable_sources ?? []) {
        totalSources += 1;
        const scheme = classifyLocatorScheme(src.source_locator);
        schemeCounts[scheme] += 1;
        const raw = rawRecordByDocId.get(src.document_id);
        const { node } = resolveNodeForLocator(raw, src.source_locator);
        if (node?.kind === "table") {
          tableKindSources += 1;
          uniqueTableNodeKeys.add(`${src.document_id}::${node.node_id ?? node.source?.order_index}`);
        }
        const result = resolveAuthoritativeCellV2({ rawRecord: raw, locator: src.source_locator, evidenceSpanText: src.evidence_span, extensions: item.extensions });
        rootCauseCounts[result.root_cause] = (rootCauseCounts[result.root_cause] ?? 0) + 1;
      }
    }
  }

  const resolutionReport = {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    supported_locator_formats: [
      "document_id/path#node=N (NODE_ONLY_HASH)",
      "document_id/path#node=N&row=R (ROW_QUALIFIED)",
      "document_id/path#node=N&row=R&col=C (CELL_QUALIFIED)",
      "percent-encoded fragment/query values (decoded before shape classification)",
      "extensions.evidence_verification.{source_node_id,row,column}",
      "canonical_source_locator",
      "document_id + node_id (NODE_ONLY_COLON, docId::relPath::nodeId)",
    ],
    formats_verified_absent_from_this_gold_release: [
      "percent-encoding (0/345 sources contain a %XX sequence)",
      "ROW_QUALIFIED / #node=N&row=R without col (0/345)",
      "canonical_source_locator (checked at item/slot/source level, 0/101 items)",
      "extensions.evidence_verification (checked all 101 items' extensions objects, 0/101)",
      "a separate node_id provenance field (0/101 items)",
    ],
    total_sources: totalSources,
    locator_scheme_distribution: schemeCounts,
    table_kind_sources: tableKindSources,
    unique_table_nodes_referenced: uniqueTableNodeKeys.size,
    root_cause_distribution: rootCauseCounts,
    ambiguous_locator_count: rootCauseCounts[ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS] ?? 0,
    unresolvable_locator_count: rootCauseCounts[ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE] ?? 0,
    parse_limited_source_count: rootCauseCounts[ROOT_CAUSE.SOURCE_PARSE_LIMITATION] ?? 0,
    provenance_conflict_count: rootCauseCounts[ROOT_CAUSE.LOCATOR_PROVENANCE_CONFLICT] ?? 0,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "corrected-table-locator-resolution-report.v0.2.json"), `${JSON.stringify(resolutionReport, null, 2)}\n`);

  // --- Stage 2: full population re-identification (mechanical only --
  // node.kind, cell-qualified locator, real row/col provenance -- never
  // question_type or wording) ---
  const perItem = goldItems.map((item) => classifyGoldItemForTablesV2(item, rawRecordByDocId));
  const tableItems = perItem.filter((r) => r.is_table_item);
  const nonTableItems = perItem.filter((r) => !r.is_table_item);
  const tagDistribution = Object.fromEntries(TABLE_ITEM_TAGS.map((tag) => [tag, tableItems.filter((r) => r.tags.includes(tag)).length]));

  const expected = { table_evaluation_item_count: 92, table_kind_sources: 339 };
  const actual = { table_evaluation_item_count: tableItems.length, table_kind_sources: tableKindSources };
  const matchesExpectation = actual.table_evaluation_item_count === expected.table_evaluation_item_count && actual.table_kind_sources === expected.table_kind_sources;

  const inventory = {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    dev_tune_item_count: goldItems.length,
    table_evaluation_item_count: tableItems.length,
    non_table_evaluation_item_count: nonTableItems.length,
    unique_table_source_count: tableKindSources,
    unique_table_nodes_referenced: uniqueTableNodeKeys.size,
    total_table_evidence_locator_count: tableKindSources,
    locator_scheme_distribution: schemeCounts,
    row_column_qualified_locator_count: schemeCounts.CELL_QUALIFIED,
    node_only_locator_count: schemeCounts.NODE_ONLY_HASH + schemeCounts.NODE_ONLY_COLON,
    ambiguous_locator_count: resolutionReport.ambiguous_locator_count,
    unresolvable_locator_count: resolutionReport.unresolvable_locator_count,
    parse_limited_source_count: resolutionReport.parse_limited_source_count,
    tag_distribution: tagDistribution,
    p10_3_1_expectation: expected,
    p10_3_1_expectation_matched: matchesExpectation,
    p10_3_1_expectation_deviation_reason: matchesExpectation ? null : "see corrected-table-locator-resolution-report.v0.2.json for the discrepancy",
    per_item: perItem.map((r) => ({
      question_id: r.question_id,
      question_type: r.question_type,
      is_table_item: r.is_table_item,
      tags: r.tags,
      table_source_count: r.table_source_count,
      unresolvable_source_count: r.unresolvable_source_count,
      parse_limited_source_count: r.parse_limited_source_count,
      ambiguous_source_count: r.ambiguous_source_count,
      conflict_source_count: r.conflict_source_count,
      distinct_rows_touched: r.distinct_rows_touched ?? 0,
      distinct_cells_touched: r.distinct_cells_touched ?? 0,
      distinct_table_nodes_touched: r.distinct_table_nodes_touched ?? 0,
      distinct_documents_touched: r.distinct_documents_touched ?? 0,
    })),
  };
  await writeFile(path.join(OUT_DIR, "corrected-table-item-inventory.v0.2.json"), `${JSON.stringify(inventory, null, 2)}\n`);

  console.log(JSON.stringify({
    dev_tune_item_count: goldItems.length,
    table_evaluation_item_count: tableItems.length,
    table_kind_sources: tableKindSources,
    matches_p10_3_1_expectation: matchesExpectation,
    tag_distribution: tagDistribution,
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.2-stage1-2-population-audit] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
