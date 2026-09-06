#!/usr/bin/env node
// Turn A-PLUS-QA-CONDITION-MAPPING-V1 — structural pass-through report.
//
// Feeds the official 101 conditions (data/eval/devtune101_conditions.v2.jsonl) through the OLD
// (buggy) wire-shape mappers each worker used to have, and through the NEW qa-condition-mapper.mjs,
// and reports counts only. This script reads ONLY each row's `conditions` field — it never reads
// `question`, `question_id`, `segment`, or any Gold-shaped field, and never touches
// DEV_CHECK/HOLDOUT (this artifact is DEV_TUNE-only). No DB, no HCX, no network, no write.
//
// Run with: node scripts/qa_condition_mapping_101_report.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  mapQaOrLegacyConditionsToFilterInput,
  mapQaOrLegacyConditionsToFourArmConditions,
  buildNameToCorpCodeIndexFromUniverseCsv,
  UnresolvedCompanyNameError,
  UnknownDocGroupError,
} from "../domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs";
import { mapOfficialConditionToFilterInput } from "../domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const nameToCorpCodeIndex = buildNameToCorpCodeIndexFromUniverseCsv(
  readFileSync(path.join(REPO_ROOT, "data/corpus/universe.csv"), "utf8"),
);

// ---------- reproduces the OLD (pre-fix) wire-shape mappers, for comparison only ----------
// Byte-for-byte copies of the functions removed from scripts/arm_a_live_worker.mjs and
// scripts/arm_a4_a3_live_worker.mjs by this turn — kept here ONLY to measure "current
// implementation" vs "after" on the same 101 conditions, never imported by any production path.
function oldToArmAConditions(conditions) {
  const c = conditions && typeof conditions === "object" ? conditions : {};
  const out = {};
  if (c.corp_code) out.corp_codes = [c.corp_code];
  if (c.document_group) out.doc_groups = [c.document_group];
  if (c.document_subtype) out.doc_subtypes = [c.document_subtype];
  if (c.period) {
    const yearMonth = /^(\d{4})-(\d{2})$/.exec(c.period);
    const yearOnly = /^(\d{4})$/.exec(c.period);
    if (yearMonth) { out.base_years = [Number(yearMonth[1])]; out.base_months = [Number(yearMonth[2])]; }
    else if (yearOnly) { out.base_years = [Number(yearOnly[1])]; }
  }
  return out;
}

function oldToFourArmConditions(conditions) {
  const c = conditions && typeof conditions === "object" ? conditions : {};
  const out = { corps: [], doc_groups: [], exchange_subtypes: [], periodic_subtypes: [], years: [], year_months: [] };
  if (c.corp_code) out.corps = [c.corp_code];
  if (c.document_group) out.doc_groups = [c.document_group];
  if (c.document_subtype) {
    if (c.document_group === "exchange") out.exchange_subtypes = [c.document_subtype];
    else if (c.document_group === "periodic") out.periodic_subtypes = [c.document_subtype];
  }
  if (c.period) {
    const yearMonth = /^(\d{4})-(\d{2})$/.exec(c.period);
    const yearOnly = /^(\d{4})$/.exec(c.period);
    if (yearMonth) { out.years = [Number(yearMonth[1])]; out.year_months = [[Number(yearMonth[1]), Number(yearMonth[2])]]; }
    else if (yearOnly) { out.years = [Number(yearOnly[1])]; }
  }
  return out;
}
function oldIdentityCorpCodeIndex(corpCode) {
  return new Map(corpCode ? [[corpCode, corpCode]] : []);
}

function isEmptyFilter(filters) {
  return filters.corp_codes.length === 0 && filters.doc_groups.length === 0
    && filters.doc_subtypes.length === 0 && filters.base_years.length === 0
    && filters.base_months.length === 0 && !filters.receipt_date_from && !filters.receipt_date_to
    && filters.is_correction === null;
}

function tally(rows, { mapOld, mapNew }) {
  const report = {
    total: rows.length,
    old: { empty_filter: 0, error: 0 },
    new: { success: 0, empty_filter: 0, unresolved_company: 0, unresolved_doc_group: 0, unresolved_period: 0, error: 0 },
  };
  for (const row of rows) {
    const conditions = row.conditions; // ONLY the conditions field — never question/Gold.

    try {
      const oldFilters = mapOld(conditions);
      if (isEmptyFilter(oldFilters)) report.old.empty_filter += 1;
    } catch {
      report.old.error += 1;
    }

    try {
      const result = mapNew(conditions);
      const filters = result.filters ?? result;
      if (result.diagnostics?.unparsed_periods?.length > 0) report.new.unresolved_period += 1;
      if (isEmptyFilter(filters)) report.new.empty_filter += 1;
      else report.new.success += 1;
    } catch (error) {
      report.new.error += 1;
      if (error instanceof UnresolvedCompanyNameError) report.new.unresolved_company += 1;
      else if (error instanceof UnknownDocGroupError) report.new.unresolved_doc_group += 1;
    }
  }
  return report;
}

function main() {
  const jsonlPath = path.join(REPO_ROOT, "data/eval/devtune101_conditions.v2.jsonl");
  const rows = readFileSync(jsonlPath, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));

  const armAReport = tally(rows, {
    mapOld: (c) => {
      const mapped = oldToArmAConditions(c);
      return { corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [], base_months: [],
        receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true, ...mapped };
    },
    mapNew: (c) => mapQaOrLegacyConditionsToFilterInput(c, { nameToCorpCodeIndex }),
  });

  const a4a3Report = tally(rows, {
    mapOld: (c) => {
      const mapped = oldToFourArmConditions(c);
      const idx = oldIdentityCorpCodeIndex(mapped.corps[0]);
      return mapOfficialConditionToFilterInput(mapped, idx).filters;
    },
    mapNew: (c) => mapQaOrLegacyConditionsToFourArmConditions(c, { nameToCorpCodeIndex }),
  });
  // a4a3Report.new only checked shape validity above (mapQaOrLegacyConditionsToFourArmConditions
  // does not itself compute .filters) — recompute success/empty using the same filter mapper the
  // worker itself calls, for an apples-to-apples comparison with ARM_A_LIVE's report.
  const a4a3New = { success: 0, empty_filter: 0, unresolved_company: 0, unresolved_doc_group: 0, unresolved_period: 0, error: 0 };
  for (const row of rows) {
    try {
      const { conditions, nameToCorpCodeIndex: idx, diagnostics } = mapQaOrLegacyConditionsToFourArmConditions(
        row.conditions, { nameToCorpCodeIndex },
      );
      if (diagnostics.unparsed_periods.length > 0) a4a3New.unresolved_period += 1;
      const mapped = mapOfficialConditionToFilterInput(conditions, idx);
      if (isEmptyFilter(mapped.filters)) a4a3New.empty_filter += 1;
      else a4a3New.success += 1;
    } catch (error) {
      a4a3New.error += 1;
      if (error instanceof UnresolvedCompanyNameError) a4a3New.unresolved_company += 1;
      else if (error instanceof UnknownDocGroupError) a4a3New.unresolved_doc_group += 1;
    }
  }
  a4a3Report.new = a4a3New;

  const report = {
    n_conditions: rows.length,
    ARM_A_LIVE: armAReport,
    ARM_A4_A3_LIVE: a4a3Report,
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
