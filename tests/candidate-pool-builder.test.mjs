// Turn N4.0: unit/contract tests for domain/evaluation/candidate-pool-builder.mjs
// using a small synthetic manifest -- never the real (ungitted) 4,204-doc
// corpus. Proves the chain-safe connected-component fix, determinism,
// leakage-freedom, and the absence of any Seed-question/company-specific
// hardcoding, all without requiring DISCLOSURE_CORPUS_ROOT to be set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  generateCandidateDrafts,
  buildChainComponents,
  assignEvaluationGroups,
  selectCandidatePool,
  assignProvisionalSplits,
  markParseBlocked,
  computeSliceInventory,
  computeLeakageReport,
  canonicalDigest,
} from "../domain/evaluation/candidate-pool-builder.mjs";

function manifestRow(overrides) {
  return {
    doc_id: "x", corp_code: "00000001", corp_name: "테스트기업", listed_name: "테스트기업",
    stock_code: "000000", industry: "IT", sector: "테스트섹터", doc_group: "exchange", doc_subtype: null,
    report_nm: "테스트보고서", is_correction: false, rcept_no: "20240101000001", rcept_dt: "20240101",
    flr_nm: "테스트기업", base_year: null, base_month: null, file_path: "raw/x", file_format: "xml", n_files: 1,
    ...overrides,
  };
}

// A small synthetic manifest exercising every connectivity type Turn N4.0
// section C requires: same document, AMENDS, TERMINATES, periodic two-period
// pair, cross-company pair, and a zero-document company.
const MANIFEST = [
  // periodic same-company two-period pair (COMPANY_A)
  manifestRow({ doc_id: "periodic_a_2023", corp_code: "COMPANY_A", listed_name: "회사A", doc_group: "periodic", doc_subtype: "annual", base_year: 2023, base_month: 12, rcept_no: "1" }),
  manifestRow({ doc_id: "periodic_a_2025", corp_code: "COMPANY_A", listed_name: "회사A", doc_group: "periodic", doc_subtype: "annual", base_year: 2025, base_month: 12, rcept_no: "2" }),
  // exchange contract + its correction (COMPANY_B) -- correction's own
  // group_key is unrelated to the contract's group_key (matches the real
  // scripts/build-evaluation-authoring-queue.mjs defect), linked only via
  // a relation candidate below.
  manifestRow({ doc_id: "exchange_b_contract", corp_code: "COMPANY_B", listed_name: "회사B", doc_group: "exchange", doc_subtype: "단일판매공급계약체결" }),
  manifestRow({ doc_id: "exchange_b_correction", corp_code: "COMPANY_B", listed_name: "회사B", doc_group: "exchange", is_correction: true, report_nm: "[기재정정]공급계약" }),
  // exchange contract + its termination (COMPANY_C)
  manifestRow({ doc_id: "exchange_c_contract", corp_code: "COMPANY_C", listed_name: "회사C", doc_group: "exchange", doc_subtype: "단일판매공급계약체결" }),
  manifestRow({ doc_id: "exchange_c_termination", corp_code: "COMPANY_C", listed_name: "회사C", doc_group: "exchange", doc_subtype: "단일판매공급계약해지" }),
  // major original + correction (COMPANY_D), same pattern as the real
  // major_20241118000171 -> major_20241115000375 counterexample found
  // during the Turn N4.0 audit.
  manifestRow({ doc_id: "major_d_original", corp_code: "COMPANY_D", listed_name: "회사D", doc_group: "major", is_correction: false, report_nm: "주요사항보고서" }),
  manifestRow({ doc_id: "major_d_correction", corp_code: "COMPANY_D", listed_name: "회사D", doc_group: "major", is_correction: true, report_nm: "[기재정정]주요사항보고서" }),
  // cross-company sector comparison pair (COMPANY_E / COMPANY_F, same sector)
  manifestRow({ doc_id: "periodic_e_2025", corp_code: "COMPANY_E", listed_name: "회사E", doc_group: "periodic", doc_subtype: "annual", base_year: 2025, base_month: 12, sector: "공유섹터", rcept_no: "3" }),
  manifestRow({ doc_id: "periodic_f_2025", corp_code: "COMPANY_F", listed_name: "회사F", doc_group: "periodic", doc_subtype: "annual", base_year: 2025, base_month: 12, sector: "공유섹터", rcept_no: "4" }),
  // COMPANY_G: zero major/exchange/holding documents at all -- exercises
  // the zero-document (LOCKED_BY_COVERAGE) path.
  manifestRow({ doc_id: "periodic_g_2025", corp_code: "COMPANY_G", listed_name: "회사G", doc_group: "periodic", doc_subtype: "annual", base_year: 2025, base_month: 12, rcept_no: "5" }),
];

// Relation candidates -- the SAME shape as the real
// work/domain-seed/relation-review-queue.jsonl this module consumes.
const RELATION_CANDIDATES = [
  { source_document_id: "exchange_b_correction", relation_type: "AMENDS", candidates: [{ target_document_id: "exchange_b_contract", score: 0.45 }] },
  { source_document_id: "exchange_c_termination", relation_type: "TERMINATES", candidates: [{ target_document_id: "exchange_c_contract", score: 0.6 }] },
  { source_document_id: "major_d_correction", relation_type: "AMENDS", candidates: [{ target_document_id: "major_d_original", score: 0.45 }] },
];

function buildPool({ manifestRows = MANIFEST, relationCandidates = RELATION_CANDIDATES, targetMin = 1, targetMax = 100 } = {}) {
  const drafts = generateCandidateDrafts({ manifestRows });
  const { docToComponentId, components } = buildChainComponents({ drafts, relationCandidates });
  const grouped = assignEvaluationGroups({ drafts, docToComponentId });
  const { selected, includedGroupIds } = selectCandidatePool({ groupedDrafts: grouped, targetMin, targetMax });
  const { assigned, used } = assignProvisionalSplits({ selected, targets: { DEV_TUNE: 34, DEV_CHECK: 33, HOLDOUT: 33 } });
  return { drafts, components, grouped, selected, includedGroupIds, assigned, used, docToComponentId };
}

test("Turn N4.0.1: every assignment_id matches the evaluation-split-lifecycle.schema.json pattern ^author_[0-9a-f]{24}$, with zero duplicates", () => {
  const { assigned } = buildPool();
  assert.ok(assigned.length > 0);
  const pattern = /^author_[0-9a-f]{24}$/;
  for (const item of assigned) assert.match(item.assignment_id, pattern, `assignment_id "${item.assignment_id}" does not match ^author_[0-9a-f]{24}$`);
  const ids = assigned.map((item) => item.assignment_id);
  assert.equal(new Set(ids).size, ids.length, "assignment_id must be unique across the Pool");
});

test("generateCandidateDrafts never hardcodes a specific company name or document_id in the module source (structural check)", () => {
  const source = readFileSync(new URL("../domain/evaluation/candidate-pool-builder.mjs", import.meta.url), "utf8");
  // Real Seed-25 document ids follow a fixed prefix+18-digit shape; the
  // module source must never literally reference one, nor any known real
  // company name -- every question is generated purely from manifest
  // fields passed in at call time.
  assert.doesNotMatch(source, /periodic_202[3-6]\d{12}|exchange_202[3-6]\d{12}|major_202[3-6]\d{12}|holding_202[3-6]\d{12}/);
  assert.doesNotMatch(source, /삼성전자|HD현대중공업|삼성중공업/);
  assert.doesNotMatch(source, /question_seed_v0\d/);
});

test("chain components merge a correction into its original's component via an AMENDS relation candidate, even though their group_key strings are unrelated", () => {
  const { drafts, docToComponentId } = buildPool();
  const contractDraft = drafts.find((d) => d.anchor_document_ids.includes("exchange_b_contract"));
  const correctionDraft = drafts.find((d) => d.anchor_document_ids.includes("exchange_b_correction"));
  assert.notEqual(contractDraft.group_key, correctionDraft.group_key, "sanity: the two group_key strings are unrelated, exactly like the real defect");
  assert.equal(docToComponentId.get("exchange_b_contract"), docToComponentId.get("exchange_b_correction"));
});

test("topCandidateOnly (the default) still uses the single highest-scored candidate per source, never dropping a source with only low-scored candidates", () => {
  const relationCandidates = [
    { source_document_id: "exchange_b_correction", relation_type: "AMENDS", candidates: [
      { target_document_id: "exchange_c_contract", score: 0.2 },
      { target_document_id: "exchange_b_contract", score: 0.45 },
    ] },
  ];
  const drafts = generateCandidateDrafts({ manifestRows: MANIFEST });
  const { docToComponentId } = buildChainComponents({ drafts, relationCandidates });
  assert.equal(docToComponentId.get("exchange_b_correction"), docToComponentId.get("exchange_b_contract"), "the higher-scored candidate must win");
  assert.notEqual(docToComponentId.get("exchange_b_correction"), docToComponentId.get("exchange_c_contract"), "the lower-scored candidate must not also merge in when topCandidateOnly is true");
});

test("topCandidateOnly: false restores the fully conservative all-candidates behavior", () => {
  const relationCandidates = [
    { source_document_id: "exchange_b_correction", relation_type: "AMENDS", candidates: [
      { target_document_id: "exchange_c_contract", score: 0.2 },
      { target_document_id: "exchange_b_contract", score: 0.45 },
    ] },
  ];
  const drafts = generateCandidateDrafts({ manifestRows: MANIFEST });
  const { docToComponentId } = buildChainComponents({ drafts, relationCandidates, topCandidateOnly: false });
  assert.equal(docToComponentId.get("exchange_b_correction"), docToComponentId.get("exchange_c_contract"));
});

test("TERMINATES relation candidates merge a contract and its termination into one component", () => {
  const { docToComponentId } = buildPool();
  assert.equal(docToComponentId.get("exchange_c_contract"), docToComponentId.get("exchange_c_termination"));
});

test("a periodic same-company two-period comparison keeps both anchors in the same evaluation_group_id", () => {
  const { grouped } = buildPool();
  const item = grouped.find((g) => g.anchor_document_ids.includes("periodic_a_2023"));
  assert.ok(item.anchor_document_ids.includes("periodic_a_2025"));
});

test("a cross-company sector comparison keeps BOTH companies' anchors in the same evaluation_group_id", () => {
  const { grouped } = buildPool();
  const item = grouped.find((g) => g.tags.includes("cross_company")
    && g.anchor_document_ids.includes("periodic_e_2025") && g.anchor_document_ids.includes("periodic_f_2025"));
  assert.ok(item, "expected a cross-company assignment anchoring both periodic_e_2025 and periodic_f_2025");
});

test("every assignment with at least one anchor is PROVISIONAL_UNTIL_CHAIN_CLOSURE -- never LOCKED_BY_CHAIN in this Turn", () => {
  const { assigned } = buildPool();
  const withAnchors = assigned.filter((item) => item.anchor_document_ids.length > 0);
  assert.ok(withAnchors.length > 0);
  assert.ok(withAnchors.every((item) => item.split_lock_status === "PROVISIONAL_UNTIL_CHAIN_CLOSURE"));
});

test("a zero-anchor (coverage) assignment is LOCKED_BY_COVERAGE, not PROVISIONAL", () => {
  const { assigned } = buildPool();
  const coverageItem = assigned.find((item) => item.tags.includes("zero_document"));
  assert.ok(coverageItem);
  assert.equal(coverageItem.split_lock_status, "LOCKED_BY_COVERAGE");
  assert.equal(coverageItem.anchor_document_ids.length, 0);
});

test("computeLeakageReport finds ZERO violations on the current provisional graph, and its scope field says exactly that -- never a stronger claim", () => {
  const { assigned } = buildPool();
  const report = computeLeakageReport({ assigned });
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.equal(report.scope, "CURRENT_PROVISIONAL_GRAPH_ONLY");
});

test("computeLeakageReport DETECTS a chain-component split leakage if the same component is force-split across two planned_split values", () => {
  const { assigned } = buildPool();
  const withComponent = assigned.filter((item) => item.chain_component_id);
  const target = withComponent[0];
  const poisoned = assigned.map((item) => item.assignment_id === target.assignment_id
    ? { ...item, planned_split: item.planned_split === "DEV_TUNE" ? "HOLDOUT" : "DEV_TUNE" }
    : item);
  const report = computeLeakageReport({ assigned: poisoned });
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.type === "CHAIN_COMPONENT_SPLIT_LEAKAGE" || v.type === "DOCUMENT_SPLIT_LEAKAGE"));
});

test("computeLeakageReport DETECTS a duplicate assignment_id", () => {
  const { assigned } = buildPool();
  const poisoned = [...assigned, { ...assigned[0] }];
  const report = computeLeakageReport({ assigned: poisoned });
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.type === "DUPLICATE_ASSIGNMENT_ID"));
});

test("two independent builds from the same input produce a byte-identical canonical digest", () => {
  const first = buildPool();
  const second = buildPool();
  assert.equal(canonicalDigest(first.assigned), canonicalDigest(second.assigned));
  assert.equal(canonicalDigest(first.assigned).length, 64);
});

test("selectCandidatePool never splits one evaluation_group_id across included and excluded", () => {
  const { drafts, components } = buildPool({ targetMin: 1, targetMax: 2 });
  // With a very small targetMax, some whole groups get excluded -- but
  // never partially.
  const grouped = assignEvaluationGroups({ drafts, docToComponentId: buildChainComponents({ drafts, relationCandidates: RELATION_CANDIDATES }).docToComponentId });
  const { selected } = selectCandidatePool({ groupedDrafts: grouped, targetMin: 1, targetMax: 2 });
  const selectedGroupIds = new Set(selected.map((i) => i.evaluation_group_id));
  for (const groupId of selectedGroupIds) {
    const allWithThisGroup = grouped.filter((i) => i.evaluation_group_id === groupId);
    const selectedWithThisGroup = selected.filter((i) => i.evaluation_group_id === groupId);
    assert.equal(allWithThisGroup.length, selectedWithThisGroup.length, `group ${groupId} was partially selected`);
  }
});

test("criticalTagFloors guarantees a rare-but-real tag's group is included even when a tiny targetMax would otherwise sample it away", () => {
  const drafts = generateCandidateDrafts({ manifestRows: MANIFEST });
  const { docToComponentId } = buildChainComponents({ drafts, relationCandidates: RELATION_CANDIDATES });
  const grouped = assignEvaluationGroups({ drafts, docToComponentId });

  // Without a floor, a targetMax of 1 keeps only whichever single group
  // sorts first -- not guaranteed to be the termination group.
  const withoutFloor = selectCandidatePool({ groupedDrafts: grouped, targetMin: 1, targetMax: 1 });
  const terminationIncludedWithoutFloor = withoutFloor.selected.some((item) => item.tags.includes("termination"));

  // With an explicit floor for "termination", it must be included even at
  // targetMax=1 (the floor pass runs before the general fill).
  const withFloor = selectCandidatePool({ groupedDrafts: grouped, targetMin: 1, targetMax: 1, criticalTagFloors: { termination: 1 } });
  assert.ok(withFloor.selected.some((item) => item.tags.includes("termination")), "termination group must be present when floor=1");
  assert.deepEqual(withFloor.criticalTagShortfalls, {});
  // Sanity: the two runs can legitimately differ, proving the floor pass
  // actually changed the outcome rather than being a no-op.
  if (!terminationIncludedWithoutFloor) {
    assert.notDeepEqual(withoutFloor.includedGroupIds, withFloor.includedGroupIds);
  }
});

test("criticalTagFloors reports an honest shortfall when a tag has fewer real groups than its floor, without fabricating extra ones", () => {
  const drafts = generateCandidateDrafts({ manifestRows: MANIFEST });
  const { docToComponentId } = buildChainComponents({ drafts, relationCandidates: RELATION_CANDIDATES });
  const grouped = assignEvaluationGroups({ drafts, docToComponentId });
  const { criticalTagShortfalls } = selectCandidatePool({
    groupedDrafts: grouped, targetMin: 1, targetMax: 100, criticalTagFloors: { termination: 99 },
  });
  assert.equal(criticalTagShortfalls.termination.floor, 99);
  assert.ok(criticalTagShortfalls.termination.real_groups_available < 99);
});

test("computeSliceInventory counts real slices and honestly reports slices with no manifest-level signal as NOT_YET_CONFIRMED_AT_POOL_STAGE", () => {
  const { assigned } = buildPool();
  const inventory = computeSliceInventory({ assigned, parseCoverageByDocumentId: new Map() });
  assert.ok(inventory.counts.periodic_same_company_different_period >= 1);
  assert.ok(inventory.counts.cross_company_comparison >= 1);
  assert.ok(inventory.counts.original_to_correction >= 1);
  assert.ok(inventory.counts.original_contract_to_termination >= 1);
  assert.equal(inventory.natural_case_not_yet_confirmed.consolidated_vs_separate, "NOT_YET_CONFIRMED_AT_POOL_STAGE");
});

test("markParseBlocked preserves (never deletes) an assignment whose anchor is PARSE_FAILED or PARTIAL_PARSE_FAILURE, marking authoring_status without touching planned_split or evaluation_group_id", () => {
  const { assigned } = buildPool();
  const target = assigned.find((item) => item.anchor_document_ids.includes("exchange_b_contract"));
  const parseCoverageByDocumentId = new Map([["exchange_b_contract", "PARSE_FAILED"]]);
  const marked = markParseBlocked({ assigned, parseCoverageByDocumentId });
  const markedTarget = marked.find((item) => item.assignment_id === target.assignment_id);
  assert.equal(markedTarget.authoring_status, "PARSE_BLOCKED");
  assert.deepEqual(markedTarget.parse_blocked_document_ids, ["exchange_b_contract"]);
  assert.ok(markedTarget.tags.includes("parse_blocked"));
  assert.equal(markedTarget.planned_split, target.planned_split, "parse-blocking must never change the split");
  assert.equal(markedTarget.evaluation_group_id, target.evaluation_group_id, "parse-blocking must never change the group");
  assert.equal(marked.length, assigned.length, "parse-blocked items are marked, never removed from the Pool");
});

test("markParseBlocked leaves assignments with no blocked anchor completely unchanged", () => {
  const { assigned } = buildPool();
  const parseCoverageByDocumentId = new Map(); // nothing blocked
  const marked = markParseBlocked({ assigned, parseCoverageByDocumentId });
  assert.deepEqual(marked, assigned);
});

test("assignProvisionalSplits keeps every assignment of one evaluation_group_id in the SAME planned_split", () => {
  const { assigned } = buildPool();
  const byGroup = new Map();
  for (const item of assigned) {
    const splits = byGroup.get(item.evaluation_group_id) ?? new Set();
    splits.add(item.planned_split);
    byGroup.set(item.evaluation_group_id, splits);
  }
  for (const [groupId, splits] of byGroup) assert.equal(splits.size, 1, `group ${groupId} spans multiple splits`);
});
