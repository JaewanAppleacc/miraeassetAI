// Turn N4.1: unit/contract tests for domain/evaluation/anchor-allocation-builder.mjs
// using small synthetic fixtures -- never the real Candidate Pool or corpus.
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDigest, UNCONFIRMED_SLICE_NAMES } from "../domain/evaluation/candidate-pool-builder.mjs";
import {
  selectAnchorPool,
  allocateAuthors,
  computeAuthorLeakageReport,
  computeAllocationBalanceReport,
  markGoldAuthoringReviewNeeded,
  buildRelationClosurePacket,
} from "../domain/evaluation/anchor-allocation-builder.mjs";

function record(overrides) {
  return {
    assignment_id: `author_${overrides.id ?? "0".repeat(24)}`,
    evaluation_group_id: overrides.group ?? "eval_group_default",
    group_key: overrides.group_key ?? "test-group",
    bucket: "exchange", question_type: "NUMERIC_LOOKUP", difficulty: "MEDIUM", answer_mode: "CLOSED",
    question_draft: "테스트 질문", anchor_document_ids: overrides.anchors ?? [],
    known_chain_ids: [], required_evidence_slot_drafts: [], tags: overrides.tags ?? [],
    authoring_status: "DRAFT_NEEDS_SOURCE_LOCATOR", gold_status: "NOT_STARTED",
    content_dependencies: [], split_dependencies: [],
    chain_component_id: overrides.component ?? null,
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    planned_split: overrides.split ?? "DEV_TUNE",
    ...overrides.extra,
  };
}

// 6 DEV_TUNE groups (component_1..6), one DEV_CHECK, one HOLDOUT.
const POOL = [
  record({ id: "1".repeat(24), group: "g1", component: "c1", anchors: ["doc_a1"], tags: ["correction_chain"] }),
  record({ id: "2".repeat(24), group: "g1", component: "c1", anchors: ["doc_a1", "doc_a2"], tags: ["correction_chain"] }),
  record({ id: "3".repeat(24), group: "g2", component: "c2", anchors: ["doc_b1"], tags: ["termination"] }),
  record({ id: "4".repeat(24), group: "g3", component: "c3", anchors: ["doc_c1"], tags: ["cross_company"] }),
  record({ id: "5".repeat(24), group: "g4", component: "c4", anchors: ["doc_d1"], tags: ["zero_document"] }),
  record({ id: "6".repeat(24), group: "g5", component: "c5", anchors: ["doc_e1"], tags: ["withheld_candidate"] }),
  record({ id: "7".repeat(24), group: "g6", component: "c6", anchors: ["doc_f1"], tags: ["investment_judgement"] }),
  record({ id: "8".repeat(24), group: "g_check", component: "c_check", anchors: ["doc_g1"], split: "DEV_CHECK", tags: [] }),
  record({ id: "9".repeat(24), group: "g_holdout", component: "c_holdout", anchors: ["doc_h1"], split: "HOLDOUT", tags: [] }),
];

test("selectAnchorPool only ever includes planned_split=DEV_TUNE records", () => {
  const { selected } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 5, targetMin: 3, targetMax: 7 });
  assert.ok(selected.every((item) => item.planned_split === "DEV_TUNE"));
  assert.ok(!selected.some((item) => item.evaluation_group_id === "g_check" || item.evaluation_group_id === "g_holdout"));
});

test("selectAnchorPool never splits one evaluation_group_id across included/excluded", () => {
  const { selected } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 3, targetMin: 1, targetMax: 3 });
  // g1 has 2 members sharing component c1 -- either both or neither are present.
  const g1Count = selected.filter((item) => item.evaluation_group_id === "g1").length;
  assert.ok(g1Count === 0 || g1Count === 2, `g1 must be all-or-nothing, got ${g1Count}`);
});

test("selectAnchorPool lands on the ideal count when it is exactly reachable", () => {
  // 7 DEV_TUNE records total across 6 groups (g1 has 2, others have 1 each) -- targetIdeal=7 is exactly reachable.
  const { selected, actualCount, exactTargetReachable } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 7, targetMin: 5, targetMax: 9 });
  assert.equal(actualCount, 7);
  assert.equal(exactTargetReachable, true);
  assert.equal(selected.length, 7);
});

test("selectAnchorPool's criticalTagFloors guarantees a rare tag's group is included even when the ordinary stable-hash walk would otherwise skip it", () => {
  const rarePool = [
    ...POOL,
    record({ id: "a".repeat(24), group: "g_rare", component: "c_rare", anchors: ["doc_rare"], tags: ["facility_investment"] }),
  ];
  const withoutFloor = selectAnchorPool({ poolRecords: rarePool, targetIdeal: 1, targetMin: 1, targetMax: 1 });
  const rareIncludedWithoutFloor = withoutFloor.selected.some((item) => item.tags.includes("facility_investment"));
  const withFloor = selectAnchorPool({ poolRecords: rarePool, targetIdeal: 1, targetMin: 1, targetMax: 1, criticalTagFloors: { facility_investment: 1 } });
  assert.ok(withFloor.selected.some((item) => item.tags.includes("facility_investment")));
  assert.deepEqual(withFloor.criticalTagShortfalls, {});
  if (!rareIncludedWithoutFloor) assert.notDeepEqual(withoutFloor.includedGroupIds, withFloor.includedGroupIds);
});

test("selectAnchorPool's criticalTagFloors reports an honest shortfall when fewer real groups exist than the floor", () => {
  const { criticalTagShortfalls } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 5, targetMin: 3, targetMax: 9, criticalTagFloors: { facility_investment: 5 } });
  assert.equal(criticalTagShortfalls.facility_investment.floor, 5);
  assert.equal(criticalTagShortfalls.facility_investment.real_groups_available, 0);
});

test("allocateAuthors never splits one evaluation_group_id across AUTHOR_A/AUTHOR_B", () => {
  const { selected } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 7, targetMin: 5, targetMax: 9 });
  const { allocated } = allocateAuthors({ selected });
  const byGroup = new Map();
  for (const item of allocated) {
    const authors = byGroup.get(item.evaluation_group_id) ?? new Set();
    authors.add(item.author_allocation);
    byGroup.set(item.evaluation_group_id, authors);
  }
  for (const [groupId, authors] of byGroup) assert.equal(authors.size, 1, `group ${groupId} spans multiple authors`);
});

test("allocateAuthors keeps the A/B count difference small and marks the required status fields", () => {
  const { selected } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 7, targetMin: 5, targetMax: 9 });
  const { allocated, used, difference } = allocateAuthors({ selected });
  assert.equal(used.AUTHOR_A + used.AUTHOR_B, selected.length);
  assert.ok(difference <= 2, `difference ${difference} is larger than expected for 7 single/double-sized groups`);
  for (const item of allocated) {
    assert.ok(["AUTHOR_A", "AUTHOR_B"].includes(item.author_allocation));
    assert.equal(item.assignment_status, "PROVISIONAL_AUTHOR_ALLOCATION");
    assert.equal(item.official_gold_status, "NOT_STARTED");
    assert.equal(item.split_lock_status, "PROVISIONAL_UNTIL_CHAIN_CLOSURE");
  }
});

test("computeAuthorLeakageReport finds zero violations on a correct allocation, and DETECTS a poisoned one", () => {
  const { selected } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 7, targetMin: 5, targetMax: 9 });
  const { allocated } = allocateAuthors({ selected });
  const clean = computeAuthorLeakageReport({ allocated });
  assert.equal(clean.ok, true);
  assert.equal(clean.scope, "CURRENT_PROVISIONAL_GRAPH_ONLY");

  const target = allocated.find((item) => item.evaluation_group_id === "g1");
  const poisoned = allocated.map((item) => item.assignment_id === target.assignment_id
    ? { ...item, author_allocation: item.author_allocation === "AUTHOR_A" ? "AUTHOR_B" : "AUTHOR_A" }
    : item);
  const dirty = computeAuthorLeakageReport({ allocated: poisoned });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.violations.some((v) => v.type === "EVALUATION_GROUP_AUTHOR_SPLIT" || v.type === "DOCUMENT_AUTHOR_SPLIT"));
});

test("computeAllocationBalanceReport reports per-author totals that sum to the whole selection", () => {
  const { selected } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 7, targetMin: 5, targetMax: 9 });
  const { allocated } = allocateAuthors({ selected });
  const report = computeAllocationBalanceReport({ allocated });
  assert.equal(report.AUTHOR_A.total + report.AUTHOR_B.total, selected.length);
  assert.ok(typeof report.AUTHOR_A.by_bucket === "object");
  assert.ok(typeof report.AUTHOR_A.by_slice_tag.correction_chain === "number");
});

test("markGoldAuthoringReviewNeeded marks every record uniformly, never selectively", () => {
  const { selected } = selectAnchorPool({ poolRecords: POOL, targetIdeal: 7, targetMin: 5, targetMax: 9 });
  const marked = markGoldAuthoringReviewNeeded({ allocated: selected, unconfirmedSliceNames: UNCONFIRMED_SLICE_NAMES });
  assert.equal(marked.length, selected.length);
  for (const item of marked) {
    assert.equal(item.manifest_stage_dimension_status, "NEEDS_GOLD_AUTHORING_REVIEW");
    assert.deepEqual(item.unconfirmed_dimension_names, [...UNCONFIRMED_SLICE_NAMES]);
  }
});

test("two independent selectAnchorPool+allocateAuthors runs from the same input produce a byte-identical digest", () => {
  const runA = allocateAuthors({ selected: selectAnchorPool({ poolRecords: POOL, targetIdeal: 7, targetMin: 5, targetMax: 9 }).selected }).allocated;
  const runB = allocateAuthors({ selected: selectAnchorPool({ poolRecords: POOL, targetIdeal: 7, targetMin: 5, targetMax: 9 }).selected }).allocated;
  assert.equal(canonicalDigest(runA), canonicalDigest(runB));
});

// -- Relation closure review packet --------------------------------------

const MANIFEST_BY_DOC = new Map([
  ["doc_a1", { corp_code: "00000001", listed_name: "회사A", doc_group: "exchange", doc_subtype: null, report_nm: "공급계약", rcept_dt: "20240101", is_correction: false }],
  ["doc_a2", { corp_code: "00000001", listed_name: "회사A", doc_group: "exchange", doc_subtype: null, report_nm: "[기재정정]공급계약", rcept_dt: "20240110", is_correction: true }],
  ["doc_x_outside", { corp_code: "00000002", listed_name: "회사X", doc_group: "exchange", doc_subtype: null, report_nm: "공급계약", rcept_dt: "20240115", is_correction: false }],
  ["doc_y_further", { corp_code: "00000003", listed_name: "회사Y", doc_group: "exchange", doc_subtype: null, report_nm: "공급계약", rcept_dt: "20240120", is_correction: false }],
]);

const RELATION_CANDIDATES = [
  {
    relation_candidate_id: "relation_candidate_hop0",
    source_document_id: "doc_a2", relation_type: "AMENDS", source_report_name: "[기재정정]공급계약", source_receipt_date: "2024-01-10",
    candidates: [
      { target_document_id: "doc_a1", score: 0.45, reasons: ["same_normalized_report_name"], target_report_name: "공급계약", target_receipt_date: "2024-01-01" },
      { target_document_id: "doc_x_outside", score: 0.2, reasons: ["within_30_days"], target_report_name: "공급계약", target_receipt_date: "2024-01-15" },
    ],
  },
  {
    relation_candidate_id: "relation_candidate_hop1",
    source_document_id: "doc_x_outside", relation_type: "AMENDS", source_report_name: "공급계약", source_receipt_date: "2024-01-15",
    candidates: [{ target_document_id: "doc_y_further", score: 0.3, reasons: ["within_30_days"], target_report_name: "공급계약", target_receipt_date: "2024-01-20" }],
  },
];

function buildClosureFixture() {
  const docToComponentId = new Map([["doc_a1", "c1"], ["doc_a2", "c1"], ["doc_x_outside", "c_other"]]);
  const authorByDocumentId = new Map([["doc_a1", "AUTHOR_A"], ["doc_a2", "AUTHOR_A"], ["doc_x_outside", "AUTHOR_B"]]);
  const assignmentIdsByDocumentId = new Map([["doc_a1", ["author_1"]], ["doc_a2", ["author_2"]]]);
  return buildRelationClosurePacket({
    anchorDocumentIds: ["doc_a1", "doc_a2"], relationCandidates: RELATION_CANDIDATES,
    docToComponentId, authorByDocumentId, manifestByDocumentId: MANIFEST_BY_DOC, assignmentIdsByDocumentId,
  });
}

test("buildRelationClosurePacket includes hop0 (anchor-touching) rows with ALL candidates, not just the top-scored one", () => {
  const { packet, hop0Count } = buildClosureFixture();
  assert.equal(hop0Count, 1);
  const hop0Row = packet.find((row) => row.relation_candidate_id === "relation_candidate_hop0");
  assert.ok(hop0Row);
  assert.equal(hop0Row.candidates.length, 2, "both the top (0.45) and lower-scored (0.2) candidates must be shown");
});

test("buildRelationClosurePacket includes hop1 (one-step-adjacent) rows, expanding beyond the Anchor's own edges", () => {
  const { packet, hop1Count } = buildClosureFixture();
  assert.equal(hop1Count, 1);
  const hop1Row = packet.find((row) => row.relation_candidate_id === "relation_candidate_hop1");
  assert.ok(hop1Row, "the relation FROM doc_x_outside (touched by hop0 as a target) must appear as a hop1 row");
  assert.equal(hop1Row.hop, 1);
});

test("buildRelationClosurePacket: every row starts owner_disposition PENDING, confirmed_target_document_id null", () => {
  const { packet } = buildClosureFixture();
  assert.ok(packet.length > 0);
  for (const row of packet) {
    assert.equal(row.owner_disposition, "PENDING");
    assert.equal(row.confirmed_target_document_id, null);
  }
});

test("buildRelationClosurePacket correctly flags is_currently_used_edge for the top candidate that formed the component", () => {
  const { packet } = buildClosureFixture();
  const hop0Row = packet.find((row) => row.relation_candidate_id === "relation_candidate_hop0");
  const usedCandidate = hop0Row.candidates.find((c) => c.target_document_id === "doc_a1");
  const unusedCandidate = hop0Row.candidates.find((c) => c.target_document_id === "doc_x_outside");
  assert.equal(usedCandidate.is_currently_used_edge, true);
  assert.equal(unusedCandidate.is_currently_used_edge, false);
});

test("buildRelationClosurePacket flags would_merge_components and would_cross_author_boundary for a candidate that was NOT used to build the current component", () => {
  const { packet } = buildClosureFixture();
  const hop0Row = packet.find((row) => row.relation_candidate_id === "relation_candidate_hop0");
  const unusedCandidate = hop0Row.candidates.find((c) => c.target_document_id === "doc_x_outside");
  assert.equal(unusedCandidate.would_merge_components, true, "confirming this candidate would merge c1 and c_other");
  assert.equal(unusedCandidate.would_cross_author_boundary, true, "c1 is AUTHOR_A, c_other is AUTHOR_B");
});

test("buildRelationClosurePacket records affected_anchor_assignment_ids for hop0 rows", () => {
  const { packet } = buildClosureFixture();
  const hop0Row = packet.find((row) => row.relation_candidate_id === "relation_candidate_hop0");
  assert.deepEqual(new Set(hop0Row.affected_anchor_assignment_ids), new Set(["author_1", "author_2"]));
});

test("Turn N4.1: neither module source hardcodes a specific Seed company name or a real document_id", () => {
  // Reuses the same structural discipline candidate-pool-builder.mjs's own
  // test enforces -- this module must be equally generic.
  return import("node:fs/promises").then(async ({ readFile }) => {
    const source = await readFile(new URL("../domain/evaluation/anchor-allocation-builder.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /periodic_202[3-6]\d{12}|exchange_202[3-6]\d{12}|major_202[3-6]\d{12}|holding_202[3-6]\d{12}/);
    assert.doesNotMatch(source, /삼성전자|HD현대중공업|삼성중공업/);
  });
});
