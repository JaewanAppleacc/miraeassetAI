#!/usr/bin/env node
// Turn P10.3.2 / Stage 4: re-examines the 4 sources that resolve to
// GOLD_LOCATOR_UNRESOLVABLE under the v2 resolver (same 4 P10.3.1 found --
// all are NODE_ONLY_COLON scheme, so no CELL_QUALIFIED authority exists
// to rescue them). Records irregular-shape/word-coverage/contiguity/
// recoverability evidence and assigns a final disposition. Never modifies
// the parser or Gold, never forces an arbitrary row/column pick.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveAuthoritativeCellV2, resolveNodeForLocator, classifyLocatorScheme, LOCATOR_SCHEME, ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority-v2.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.2-table-full-population-audit");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");

function normalize(t) { return String(t ?? "").normalize("NFKC").replace(/\s+/g, " ").trim(); }

function hasIrregularColumnCounts(node) {
  const counts = node?.actual_col_counts ?? [];
  if (counts.length < 2) return false;
  return new Set(counts).size > 1;
}

// Word-level coverage check (no external library): does every WORD of the
// best-matching row's text appear somewhere in the evidence_span, even
// though simple substring containment fails (broken contiguity)?
function bestRowWordCoverage(node, evidenceSpanText) {
  const needle = normalize(evidenceSpanText);
  const needleWords = new Set(needle.replace(/\|/g, " ").split(/\s+/).filter(Boolean));
  const rows = node.normalized_rows ?? [];
  let best = { rowIndex: -1, coverage: 0, rowWordCount: 0 };
  for (const [rowIndex, row] of rows.entries()) {
    const rowText = normalize(row.join(" | "));
    if (!rowText) continue;
    const rowWords = rowText.replace(/\|/g, " ").split(/\s+/).filter(Boolean);
    if (rowWords.length === 0) continue;
    const covered = rowWords.filter((w) => needleWords.has(w)).length;
    const coverage = covered / rowWords.length;
    if (coverage > best.coverage) best = { rowIndex, coverage, rowWordCount: rowWords.length };
  }
  return best;
}

async function main() {
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cacheLines = (await readFile(RAW_CACHE_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rawRecordByDocId = new Map(cacheLines.map((entry) => [entry.document_id, entry.raw_record]));

  const dispositions = [];
  for (const item of goldItems) {
    for (const slot of item.required_evidence_slots ?? []) {
      for (const src of slot.acceptable_sources ?? []) {
        const raw = rawRecordByDocId.get(src.document_id);
        const result = resolveAuthoritativeCellV2({ rawRecord: raw, locator: src.source_locator, evidenceSpanText: src.evidence_span, extensions: item.extensions });
        if (result.root_cause !== ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE) continue;
        const scheme = classifyLocatorScheme(src.source_locator);
        const { node } = resolveNodeForLocator(raw, src.source_locator);
        if (!node) {
          dispositions.push({ locator_scheme: scheme, node_found: false, final_status: "EXCLUDE_FROM_TABLE_GOLD_SCORING", reason: "node itself not found in parsed DocumentIR" });
          continue;
        }
        const irregular = hasIrregularColumnCounts(node);
        const bestRow = bestRowWordCoverage(node, src.evidence_span);
        const contiguousSpanPossible = bestRow.coverage >= 0.999; // near-exact would have already tight-matched
        const rowColRecoverable = false; // no CELL_QUALIFIED authority exists for this source (NODE_ONLY_COLON scheme has none)

        let finalStatus;
        if (scheme === LOCATOR_SCHEME.CELL_QUALIFIED) {
          finalStatus = "RESOLVED_BY_CORRECTED_LOCATOR"; // would only reach here if somehow still unresolvable despite CELL_QUALIFIED -- not the case for the real 4, kept for completeness
        } else if (irregular && bestRow.coverage >= 0.9) {
          finalStatus = "PARSE_RECOVERY_REQUIRED";
        } else if (bestRow.coverage >= 0.5) {
          finalStatus = "SAFE_NODE_LEVEL_CONTEXT_ONLY";
        } else {
          finalStatus = "EXCLUDE_FROM_TABLE_GOLD_SCORING";
        }

        dispositions.push({
          locator_scheme: scheme,
          node_found: true,
          irregular_row_column_shape: irregular,
          actual_col_counts_distinct_values: irregular ? [...new Set(node.actual_col_counts)].length : null,
          n_declared_cols: node.n_declared_cols ?? null,
          n_rows: (node.normalized_rows ?? []).length,
          best_matching_row_word_coverage: Math.round(bestRow.coverage * 1000) / 1000,
          best_matching_row_word_count: bestRow.rowWordCount,
          contiguous_span_possible: contiguousSpanPossible,
          row_column_recoverable_without_parser_fix: rowColRecoverable,
          table_aware_chunk_applicable: !irregular, // a table-aware chunk needs a regular row/col grid to attach provenance to
          final_status: finalStatus,
        });
      }
    }
  }

  const statusCounts = {};
  for (const d of dispositions) statusCounts[d.final_status] = (statusCounts[d.final_status] ?? 0) + 1;

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    note: "No parser or Gold modification performed this Turn. No row/column is force-recovered -- every disposition is either PARSE_RECOVERY_REQUIRED (needs an upstream parser fix, not achievable by better matching heuristics alone), SAFE_NODE_LEVEL_CONTEXT_ONLY, EXCLUDE_FROM_TABLE_GOLD_SCORING, or RESOLVED_BY_CORRECTED_LOCATOR.",
    unresolvable_source_count: dispositions.length,
    final_status_distribution: statusCounts,
    dispositions,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "parse-limited-source-disposition.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({ unresolvable_source_count: dispositions.length, final_status_distribution: statusCounts }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.2-stage4-parse-limited-disposition] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
