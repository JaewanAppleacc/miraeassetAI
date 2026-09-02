#!/usr/bin/env node
// Turn P10.4 / Stage 8 + Stage 9: applies the FIXED, pre-registered
// success-threshold gate to Stage 5/6/7's already-computed real results,
// then writes the final status. Never lowers a threshold, never re-runs
// anything to force a different outcome.
//
// Turn P10.4-R / Section K addition: Stage 7's real KURE evaluation is
// deliberately gated on the cost ratio -- per this Turn's explicit
// sequencing, it is run at most once, and only after the cost ratio
// (computed from real, independently-available Stage 5 data) is already
// <=1.5 and Stage 6 shows 0 structural violations. When
// adaptive-kure-dev-tune-comparison.v0.1.json does not exist (Stage 7 was
// never run), this script reports that outcome honestly using only the
// real Stage 5/6 data available -- it never fabricates Stage-7-dependent
// recall inputs to force evaluateSuccessThresholds() to produce a status.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { evaluateSuccessThresholds, FINAL_STATUS, COST_RATIO_MAX } from "../domain/chunking/adaptive-success-threshold.mjs";
import { ADAPTIVE_POLICY_ID, ADAPTIVE_POLICY_VERSION, BASE_FIXED_CONFIG_ID, PARENT_EXPANSION_POLICY } from "../domain/chunking/adaptive-chunking-policy.mjs";
import { getFrozenCandidateById } from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.4-adaptive-table-chunking");
const P10_3_2_DISPOSITION_PATH = path.join(ROOT, "work/p10.3.2-table-full-population-audit/parse-limited-source-disposition.v0.1.json");
const KURE_COMPARISON_PATH = path.join(OUT_DIR, "adaptive-kure-dev-tune-comparison.v0.1.json");

// Fixed's real full-corpus baseline (P10.2, unique embed texts) -- cited
// from that Turn's own committed result, never recomputed here.
const FIXED_FULL_CORPUS_UNIQUE_EMBED_TEXTS = 441879;

// Turn P10.4-R: a candidate design proposed for future evaluation but
// deliberately NOT implemented or scored this Turn -- recorded as a
// proposal only, per explicit instruction.
const FOLLOW_UP_CANDIDATES_NOT_IMPLEMENTED_THIS_TURN = [
  {
    name: "FIXED_INDEX_WITH_TABLE_AWARE_LATE_EXPANSION",
    description: "검색 인덱스는 기존 Fixed-512를 유지한다. 검색된 Fixed chunk가 표와 겹칠 때만 질의 시점에 정확한 행·열·기간·단위 context를 재구성한다. table child 전체를 사전 임베딩하지 않는다. 서로 다른 표를 하나의 embedding chunk로 섞지 않는다.",
    status: "PROPOSED_NOT_IMPLEMENTED_OR_EVALUATED_THIS_TURN",
  },
];
const NEXT_TURN_NOTE = "P11-F proceeds with the already-selected KURE-v1 x Fixed-512 condition (P10.2's committed baseline) -- this Turn's Adaptive candidate did not clear its own pre-registered cost gate and was not selected.";

async function readJson(p) { return JSON.parse(await readFile(p, "utf8")); }

function criticalViolationCountsFrom(structureReport) {
  return {
    LOCATOR_RESOLVES_TO_WRONG_CELL: structureReport.critical_violation_by_type.LOCATOR_RESOLVES_TO_WRONG_CELL ?? 0,
    ROW_HEADER_VALUE_MISMATCH: structureReport.critical_violation_by_type.ROW_HEADER_VALUE_MISMATCH ?? 0,
    PERIOD_COLUMN_VALUE_MISMATCH: structureReport.critical_violation_by_type.PERIOD_COLUMN_VALUE_MISMATCH ?? 0,
    LOCATOR_PROVENANCE_LOST: structureReport.critical_violation_by_type.LOCATOR_PROVENANCE_LOST ?? 0,
    INHERITED_CONTEXT_WITHOUT_PROVENANCE: structureReport.critical_violation_by_type.INHERITED_CONTEXT_WITHOUT_PROVENANCE ?? 0,
  };
}

// Turn P10.4-R / Section K: cost-gate-only precheck path, used when Stage
// 7 was deliberately never run. Uses ONLY real, already-computed Stage
// 5/6 data -- no Stage-7-dependent value is read or fabricated.
async function runCostGatePrecheck({ countReport, structureReport, disposition }) {
  const adaptiveUniqueEmbedTexts = countReport.pass_1.unique_embeddable_text_count;
  const costRatio = adaptiveUniqueEmbedTexts / FIXED_FULL_CORPUS_UNIQUE_EMBED_TEXTS;
  const costGatePass = costRatio <= COST_RATIO_MAX;
  const t = structureReport.totals;
  const headerPeriodRate = t.column_header_applicable > 0 ? t.column_header_preserved / t.column_header_applicable : 1;
  const unitRate = t.unit_applicable > 0 ? t.unit_preserved / t.unit_applicable : 1;
  const parseRecoveryBlockingCount = disposition.final_status_distribution?.PARSE_RECOVERY_REQUIRED ?? 0;
  const criticalViolationCounts = criticalViolationCountsFrom(structureReport);

  const status = costGatePass ? FINAL_STATUS.INCONCLUSIVE : FINAL_STATUS.REQUIRES_FIX_COST_GATE;
  return {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    status,
    note: costGatePass
      ? "Cost gate passes on real Stage 5/6 data, but Stage 7's real KURE evaluation has not been run yet -- status is INCONCLUSIVE pending Stage 7, never a selection by itself."
      : "Stage 7's real KURE evaluation was deliberately NOT run: the cost gate already fails on real, independently-available Stage 5 data alone. Per explicit instruction, the 1.5 cost threshold (adaptive-success-threshold.mjs's COST_RATIO_MAX, imported not re-declared) is never lowered or bypassed to force a different outcome.",
    full_corpus: {
      documents_processed: countReport.pass_1.documents_processed,
      documents_total_in_metadata_index: countReport.input?.total_documents_in_metadata_index ?? null,
      deterministic_rebuild: countReport.deterministic_rebuild,
      double_pass_streaming_sha_identical: countReport.pass_1.canonical_chunk_stream_sha256 === countReport.pass_2.canonical_chunk_stream_sha256,
    },
    parse_limited_exclusions: {
      pinned: countReport.pass_1.parse_limited_table_sources_excluded.pinned_count,
      encountered_and_excluded: countReport.pass_1.parse_limited_table_sources_excluded.encountered_count,
    },
    critical_violations: {
      fixed: structureReport.comparison_to_p10_3_2.fixed_critical_violations,
      adaptive: structureReport.critical_violation_count,
      by_type: criticalViolationCounts,
    },
    row_header: { preserved: t.row_header_preserved, applicable: t.row_header_applicable },
    column_period_header: { preserved: t.column_header_preserved, applicable: t.column_header_applicable },
    unit: { preserved: t.unit_preserved, applicable: t.unit_applicable },
    locator_regression_count: (structureReport.critical_violation_by_type.LOCATOR_RESOLVES_TO_WRONG_CELL ?? 0) + (structureReport.critical_violation_by_type.LOCATOR_PROVENANCE_LOST ?? 0),
    cost_gate: {
      unique_embedding_cost_ratio: costRatio,
      required_maximum_ratio: COST_RATIO_MAX,
      result: costGatePass ? "PASS" : "FAIL",
    },
    stage_7_real_kure_evaluation_performed: false,
    adaptive_chunking_selected: false,
    threshold_modified: false,
    production_applied: false,
    parse_recovery_blocking_count: parseRecoveryBlockingCount,
    header_period_preservation_rate: headerPeriodRate,
    unit_preservation_rate: unitRate,
    follow_up_candidates_not_implemented_this_turn: FOLLOW_UP_CANDIDATES_NOT_IMPLEMENTED_THIS_TURN,
    next_turn_note: NEXT_TURN_NOTE,
  };
}

// The full evaluation path -- unchanged in behavior, used only once Stage
// 7 has actually produced a real KURE comparison report.
async function runFullEvaluation({ countReport, structureReport, disposition }) {
  const kureComparison = await readJson(KURE_COMPARISON_PATH);
  const expansionReport = await readJson(path.join(OUT_DIR, "adaptive-late-parent-expansion-report.v0.1.json"));

  const fixedCombo = kureComparison.combinations.find((c) => c.kind === "fixed");
  const adaptiveCombo = kureComparison.combinations.find((c) => c.kind === "adaptive");
  const fixedTable = kureComparison.combinations_table_only.find((c) => c.kind === "fixed");
  const adaptiveTable = kureComparison.combinations_table_only.find((c) => c.kind === "adaptive");

  const criticalViolationCounts = criticalViolationCountsFrom(structureReport);
  const t = structureReport.totals;
  const headerPeriodRate = t.column_header_applicable > 0 ? t.column_header_preserved / t.column_header_applicable : 1;
  const unitRate = t.unit_applicable > 0 ? t.unit_preserved / t.unit_applicable : 1;

  const decision = evaluateSuccessThresholds({
    overallRecallAt10Adaptive: adaptiveCombo.macro_evidence_recall_at_k["10"],
    overallRecallAt10Fixed: fixedCombo.macro_evidence_recall_at_k["10"],
    tableRecallAt10Adaptive: adaptiveTable.table_recall_at_10,
    tableRecallAt10Fixed: fixedTable.table_recall_at_10,
    nonTableRegressionDetected: kureComparison.non_table_comparison.regression_detected,
    criticalViolationCounts,
    explicitHeaderPeriodPreservationRate: headerPeriodRate,
    explicitUnitPreservationRate: unitRate,
    fixedChunkingAttributableViolations: structureReport.comparison_to_p10_3_2.fixed_critical_violations,
    adaptiveChunkingAttributableViolations: structureReport.critical_violation_count,
    adaptiveUniqueSearchEligibleTextCount: countReport.pass_1.unique_embeddable_text_count,
    fixedUniqueSearchEligibleTextCount: FIXED_FULL_CORPUS_UNIQUE_EMBED_TEXTS,
    peakRssWithinBudget: countReport.pass_1.peak_rss_bytes < 8 * 1024 ** 3,
    parentContextExcludedFromIndex: expansionReport.invariants.context_only_chunks_in_results_count_total === 0,
    lateExpansionNeverAddsResultSlots: expansionReport.invariants.result_slot_count_mismatches_total === 0 && expansionReport.invariants.rank_slot_invariant_violations_total === 0,
    parseRecoveryBlockingCount: disposition.final_status_distribution?.PARSE_RECOVERY_REQUIRED ?? 0,
  });

  const finalReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    status: decision.status,
    reason_trail: decision.reasonTrail,
    gates: decision.gates,
    failed_gates: decision.failed_gates,
    stage_7_real_kure_evaluation_performed: true,
    adaptive_chunking_selected: decision.status === FINAL_STATUS.SELECTED,
    threshold_modified: false,
    production_applied: false,
    inputs_summary: {
      overall_recall_at_10: { fixed: fixedCombo.macro_evidence_recall_at_k["10"], adaptive: adaptiveCombo.macro_evidence_recall_at_k["10"] },
      table_recall_at_10: { fixed: fixedTable.table_recall_at_10, adaptive: adaptiveTable.table_recall_at_10 },
      critical_violations: { fixed: structureReport.comparison_to_p10_3_2.fixed_critical_violations, adaptive: structureReport.critical_violation_count, by_type: criticalViolationCounts },
      header_period_preservation_rate: headerPeriodRate,
      unit_preservation_rate: unitRate,
      cost_ratio: countReport.pass_1.unique_embeddable_text_count / FIXED_FULL_CORPUS_UNIQUE_EMBED_TEXTS,
      parse_recovery_blocking_count: disposition.final_status_distribution?.PARSE_RECOVERY_REQUIRED ?? 0,
      late_parent_expansion: expansionReport.invariants,
    },
  };

  if (decision.status === FINAL_STATUS.SELECTED) {
    const kure = getFrozenCandidateById("kure_v1");
    finalReport.pins = {
      adaptive_policy_id: ADAPTIVE_POLICY_ID,
      adaptive_policy_version: ADAPTIVE_POLICY_VERSION,
      fixed_policy_id: BASE_FIXED_CONFIG_ID,
      kure_repository_id: kure.repository_id,
      kure_revision: kure.immutable_revision,
      kure_dimension: kure.embedding_dimension,
      query_prefix: kure.query_prefix,
      document_prefix: kure.document_prefix,
      parent_expansion_policy: PARENT_EXPANSION_POLICY,
      full_corpus_count_only_canonical_sha256: countReport.canonical_result_sha256,
      dev_tune_result_generated_at: kureComparison.generated_at,
    };
  } else {
    finalReport.follow_up_candidates_not_implemented_this_turn = FOLLOW_UP_CANDIDATES_NOT_IMPLEMENTED_THIS_TURN;
    finalReport.next_turn_note = NEXT_TURN_NOTE;
  }

  return finalReport;
}

async function main() {
  const countReport = await readJson(path.join(OUT_DIR, "adaptive-full-corpus-count-report.v0.1.json"));
  const structureReport = await readJson(path.join(OUT_DIR, "adaptive-structure-preservation-report.v0.1.json"));
  const disposition = await readJson(P10_3_2_DISPOSITION_PATH);

  const stage7Run = existsSync(KURE_COMPARISON_PATH);
  const finalReport = stage7Run
    ? await runFullEvaluation({ countReport, structureReport, disposition })
    : await runCostGatePrecheck({ countReport, structureReport, disposition });

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "adaptive-final-selection-status.v0.1.json"), `${JSON.stringify(finalReport, null, 2)}\n`);

  console.log(JSON.stringify({ status: finalReport.status, stage_7_real_kure_evaluation_performed: finalReport.stage_7_real_kure_evaluation_performed }, null, 2));
}

main().catch((error) => {
  console.error("[p10.4-stage8-9-final-selection] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
