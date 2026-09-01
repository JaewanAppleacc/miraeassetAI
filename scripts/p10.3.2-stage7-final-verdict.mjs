#!/usr/bin/env node
// Turn P10.3.2 / Stage 7: final verdict over the corrected full
// population, plus (only if the adaptive direction is retained) the
// P10.4 table-aware-chunk input contract v0.2 -- design only, not
// implemented.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { decideFullPopulationVerdict, decideP10_4Eligibility, FULL_POPULATION_VERDICT } from "../domain/agent-comparison/chunking-comparison/table-full-population-verdict-rule.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.2-table-full-population-audit");
const FIXED_ID = "fixed-token-512-o64.v0.1.0";
const SECTION_ID = "section-aware-flat-512-o64.v0.1.0";

async function readJson(p) { return JSON.parse(await readFile(p, "utf8")); }

async function main() {
  const inventory = await readJson(path.join(OUT_DIR, "corrected-table-item-inventory.v0.2.json"));
  const violations = await readJson(path.join(OUT_DIR, "full-population-critical-violations.v0.2.json"));
  const disposition = await readJson(path.join(OUT_DIR, "parse-limited-source-disposition.v0.1.json"));

  const fixedV = violations.strategies[FIXED_ID];
  const sectionV = violations.strategies[SECTION_ID];

  const decision = decideFullPopulationVerdict({
    tableItemCount: inventory.table_evaluation_item_count,
    fixedChunkingAttributableCount: fixedV.chunking_attributable_total,
    sectionChunkingAttributableCount: sectionV.chunking_attributable_total,
    fixedChunkMetadataCount: 0, // this Turn's checks never distinguish a metadata-only pathway from text-boundary loss for Fixed/Section-Flat (see Stage 3's note: neither strategy attaches table_metadata at all)
    parseLimitedSourceCount: inventory.parse_limited_source_count,
    totalTableKindSourceCount: inventory.unique_table_source_count,
    determinismStable: true,
  });

  const eligibility = decideP10_4Eligibility({
    verdictStatus: decision.status,
    parseLimitedSourceCount: disposition.unresolvable_source_count,
    unresolvedGoldLocatorCount: disposition.final_status_distribution.PARSE_RECOVERY_REQUIRED ?? 0,
  });

  const verdictReport = {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    status: decision.status,
    reason_trail: decision.reasonTrail,
    p10_3_original_verdict: "ADAPTIVE_TABLE_CHUNKING_REQUIRED",
    p10_3_1_verdict: "ADAPTIVE_TABLE_CHUNKING_CONFIRMED",
    corrected_full_population_summary: {
      table_evaluation_item_count: inventory.table_evaluation_item_count,
      unique_table_source_count: inventory.unique_table_source_count,
      fixed_chunking_attributable_violations: fixedV.chunking_attributable_total,
      section_chunking_attributable_violations: sectionV.chunking_attributable_total,
      parse_limited_source_count: inventory.parse_limited_source_count,
    },
    ...eligibility,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "table-full-population-final-verdict.v0.2.json"), `${JSON.stringify(verdictReport, null, 2)}\n`);

  let contractWritten = false;
  if (eligibility.p10_4_implementation_eligible) {
    const contract = {
      schema_version: "0.2.0",
      generated_at: new Date().toISOString(),
      status: "DESIGN_CONTRACT_ONLY_NOT_IMPLEMENTED",
      applies_to: "Turn P10.4 (or later) table-aware chunk design -- this Turn implements nothing",
      supersedes: "work/p10.3.1-table-locator-audit/adaptive-table-chunking-input-contract.v0.1.json (not modified, kept as historical record)",
      required_fields: eligibility.required_table_context_fields,
      chunk_kinds: {
        ATOMIC_TABLE_ROW: "one table row, self-contained: row_header + all column values, no inherited context needed beyond the row itself",
        TABLE_ROW_WITH_HEADERS: "one table row PLUS its column/period header row and any unit-declaring row, explicitly carried as provenance fields rather than relying on chunk adjacency",
        MULTI_ROW_CONTEXT: "a bounded set of rows needed together for a calculation/comparison (per Stage 1-2's MULTI_ROW_CALCULATION/MULTI_COLUMN_COMPARISON tags), sharing one inherited_context_provenance block",
        TABLE_SUMMARY_CONTEXT: "table_title/section_title only, for retrieval-time context injection without duplicating every row's content",
      },
      invariants: [
        "원문에 없는 header/unit을 추론하지 않는다",
        "ambiguous locator를 임의 해소하지 않는다 (fails closed to GOLD_LOCATOR_AMBIGUOUS)",
        "동일 숫자만으로 셀을 선택하지 않는다",
        "row/column provenance를 잃지 않는다",
        "Gold 내용을 청킹 규칙에 하드코딩하지 않는다",
      ],
      exclusions_pending_parser_recovery: eligibility.required_exclusions,
      input_pins: {
        p10_2_final_sha: "14adb49",
        p10_3_final_sha: "dacf1aa402125d46e62892e97aadc3d51d10141b",
        p10_3_1_final_sha: "3962975adb2b65946650f8543c76575d4593a509",
      },
    };
    await writeFile(path.join(OUT_DIR, "adaptive-table-chunking-input-contract.v0.2.json"), `${JSON.stringify(contract, null, 2)}\n`);
    contractWritten = true;
  }

  console.log(JSON.stringify({ status: decision.status, ...eligibility, contract_written: contractWritten }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.2-stage7-final-verdict] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
