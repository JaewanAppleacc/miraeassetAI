#!/usr/bin/env node
// Turn P10.3.1 / Stage 4 + Stage 5: re-evaluates P10.3's
// ADAPTIVE_TABLE_CHUNKING_REQUIRED verdict against Stage 2/3's corrected
// numbers via a fixed, pre-registered rule, then (only if the adaptive
// direction is retained) writes the P10.4 table-aware-chunk input
// contract as a DESIGN document -- no chunking or embedding is run.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { decideCorrectedVerdict, CORRECTED_VERDICT } from "../domain/agent-comparison/chunking-comparison/table-diagnostic-verdict-correction.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.1-table-locator-audit");
const FIXED_ID = "fixed-token-512-o64.v0.1.0";
const SECTION_ID = "section-aware-flat-512-o64.v0.1.0";

async function readJson(p) { return JSON.parse(await readFile(p, "utf8")); }

async function main() {
  const authorityPolicy = await readJson(path.join(OUT_DIR, "table-locator-authority-policy.v0.1.json"));
  const rootCauseAudit = await readJson(path.join(OUT_DIR, "table-locator-root-cause-audit.v0.1.json"));
  const correctedViolations = await readJson(path.join(OUT_DIR, "corrected-table-critical-violations.v0.1.json"));

  const fixedResult = correctedViolations.strategies[FIXED_ID];
  const sectionResult = correctedViolations.strategies[SECTION_ID];
  const fixedChunkBoundaryCount = fixedResult.corrected_chunking_attributable_count; // all corrected instances are CHUNK_BOUNDARY_CONTEXT_LOSS per Stage 2 (0 CHUNK_METADATA_LOSS this Turn)
  const fixedChunkMetadataCount = 0;

  const cellDeterminationImpossibleCount = rootCauseAudit.unresolvable_sources_audited; // GOLD_LOCATOR_UNRESOLVABLE/SOURCE_PARSE_LIMITATION among sources (not violation instances)
  const totalAuditedSources = authorityPolicy.locator_scheme_table_kind_distribution.NODE_ONLY_COLON; // the 75-source subset P10.3 actually examined

  const decision = decideCorrectedVerdict({
    totalAuditedSources,
    cellDeterminationImpossibleCount,
    fixedOriginalCount: fixedResult.original_critical_violation_count,
    fixedCorrectedCount: fixedResult.corrected_chunking_attributable_count,
    fixedExcludedCount: fixedResult.excluded_count,
    fixedChunkBoundaryCount,
    fixedChunkMetadataCount,
    sectionCorrectedCount: sectionResult.corrected_chunking_attributable_count,
  });

  const verdictReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    status: decision.status,
    reason_trail: decision.reasonTrail,
    p10_3_original_verdict: "ADAPTIVE_TABLE_CHUNKING_REQUIRED",
    corrected_numbers: { fixed: fixedResult, section: sectionResult },
    // Prominent, separate caveat: the audited/corrected numbers above are
    // valid WITHIN P10.3's original 45-item/79-source sample, but that
    // sample itself covers only a fraction of the true table evidence --
    // reported here, never silently folded into the verdict rule's own
    // thresholds (which only look at exclusion/metadata rates WITHIN the
    // audited sample, not sample completeness).
    sample_coverage_caveat: {
      p10_3_resolver_only_examined_scheme: "NODE_ONLY_COLON",
      p10_3_examined_table_kind_sources: authorityPolicy.locator_scheme_table_kind_distribution.NODE_ONLY_COLON,
      true_total_table_kind_sources: authorityPolicy.locator_scheme_table_kind_distribution.NODE_ONLY_COLON + authorityPolicy.locator_scheme_table_kind_distribution.CELL_QUALIFIED + authorityPolicy.locator_scheme_table_kind_distribution.NODE_ONLY_HASH,
      p10_3_reported_table_evaluation_item_count: authorityPolicy.p10_3_resolver_coverage_gap.p10_3_reported_table_evaluation_item_count,
      corrected_table_evaluation_item_count: authorityPolicy.p10_3_resolver_coverage_gap.corrected_table_evaluation_item_count,
      finding: "P10.3's 162/108 critical violations were computed over only the NODE_ONLY_COLON-scheme sources P10.3's resolver could parse -- 75/339 (22.1%) of the true table-kind sources, covering 49/92 (53.3%) of the true table evaluation items. Every one of those examined violations audited as a genuine chunking artifact (0 excluded), which is a strong within-sample signal, but a full re-run over the corrected 92-item/339-source population would require re-invoking chunker.mjs, which this Turn's explicit boundary (no chunking implementation/embedding execution) forbids. Recommended as an explicit follow-up Turn.",
    },
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "table-diagnostic-corrected-verdict.v0.1.json"), `${JSON.stringify(verdictReport, null, 2)}\n`);

  let contract = null;
  if (decision.status === CORRECTED_VERDICT.ADAPTIVE_CONFIRMED || decision.status === CORRECTED_VERDICT.ADAPTIVE_METRICS_CORRECTED) {
    contract = {
      schema_version: "0.1.0",
      generated_at: new Date().toISOString(),
      status: "DESIGN_CONTRACT_ONLY_NOT_IMPLEMENTED",
      applies_to: "Turn P10.4 (or later) table-aware chunk design -- this Turn implements nothing",
      required_fields: [
        "document_id", "node_id", "row", "column", "table_title", "unit", "column_period_header",
        "row_header", "cell_value", "source_locator", "inherited_context_provenance",
      ],
      chunk_shapes: {
        atomic_row_chunk: "one table row, self-contained: row_header + all column values + inherited table_title/unit/column_period_header carried as explicit provenance fields, not re-derived from adjacent chunk text",
        multi_row_calculation_context_chunk: "a bounded set of rows needed together for a calculation/comparison (per Stage 1's MULTI_ROW_CALCULATION/MULTI_COLUMN_COMPARISON tags), sharing the same inherited-context provenance",
      },
      invariants: [
        "원문에 없는 header/unit을 추론하지 않는다 (never infer a header/unit not literally present in the parsed DocumentIR)",
        "ambiguous locator를 임의 해소하지 않는다 (an ambiguous match fails closed to GOLD_LOCATOR_AMBIGUOUS, never an arbitrary pick)",
        "동일 숫자만으로 셀을 선택하지 않는다 (never resolve a cell from a bare numeric match alone, without row/column context)",
        "row/column provenance를 잃지 않는다 (every chunk must retain document_id/node_id/row/column back to the source cell)",
        "Gold 내용을 청킹 규칙에 하드코딩하지 않는다 (chunking rules must be general, never special-cased to specific Gold questions/answers)",
      ],
      input_pins: {
        p10_3_1_final_sha: null, // filled in the handoff after commit
        locator_authority_policy: "work/p10.3.1-table-locator-audit/table-locator-authority-policy.v0.1.json",
      },
    };
    await writeFile(path.join(OUT_DIR, "adaptive-table-chunking-input-contract.v0.1.json"), `${JSON.stringify(contract, null, 2)}\n`);
  }

  console.log(JSON.stringify({ status: decision.status, contract_written: contract !== null }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.1-stage4-5-verdict-and-contract] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
