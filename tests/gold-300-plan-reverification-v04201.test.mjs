// Turn N4.20.1: regression coverage for the plan-vs-row-authoring
// separation (domain/evaluation/gold-300-authorization.mjs), the
// read-only re-verification builder, and the v0.1-UI-supersede marker.
// Runs the real builders against real N4.20 outputs (read-only) and
// writes only under new gold-authoring-300-v0.2/ paths / the single new
// gate-status.v0.2.json inside the existing gold-authoring-300-v0.1/ dir.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ROW_AUTHORING_STATUS,
  rowAuthoringStatus,
  summarizeEligibilityByAuthor,
  verifyAuthorSplitMatchesTotal,
  verifyGold300PlanDecisionV02,
  REQUIRED_DECISION_FIELDS_V02,
} from "../domain/evaluation/gold-300-authorization.mjs";
import { buildGold300PlanReverification, OUT_DIR as REVERIFICATION_OUT_DIR } from "../scripts/build-gold-300-plan-reverification-v04201.mjs";
import { buildGold300V01UiSupersede } from "../scripts/build-gold-300-v01-ui-supersede-v04201.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function readJsonl(p) { return readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)); }
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

const GOLD_300_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gold-300-v0.1");
const AUTHORING_V01_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1");
const SELECTION_PATH = resolve(GOLD_300_DIR, "gold-300-selection-candidate.v0.1.jsonl");
const AUTHOR_ALLOC_PATH = resolve(GOLD_300_DIR, "gold-300-author-allocation-candidate.v0.1.jsonl");
const PACKET_A_PATH = resolve(AUTHORING_V01_DIR, "author-a-gold-150-authoring-packet.v0.1.jsonl");
const PACKET_B_PATH = resolve(AUTHORING_V01_DIR, "author-b-gold-150-authoring-packet.v0.1.jsonl");

function hashN420Inputs() {
  return {
    selection: sha256(readFileSync(SELECTION_PATH)),
    authorAlloc: sha256(readFileSync(AUTHOR_ALLOC_PATH)),
    packetA: sha256(readFileSync(PACKET_A_PATH)),
    packetB: sha256(readFileSync(PACKET_B_PATH)),
  };
}

// -- rowAuthoringStatus (pure) ---------------------------------------------

test("rowAuthoringStatus: before plan approval, every eligibility maps to PLAN_NOT_YET_APPROVED regardless of eligibility category", () => {
  for (const key of Object.keys(ROW_AUTHORING_STATUS)) {
    assert.equal(rowAuthoringStatus({ authoringEligibility: key, planApproved: false }), "PLAN_NOT_YET_APPROVED");
  }
});

test("rowAuthoringStatus: after plan approval, ELIGIBLE_* map to AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL, NEEDS_MANUAL_SOURCE_REVIEW maps to MANUAL_REVIEW_REQUIRED_BEFORE_AUTHORING, BLOCKED_* map to AUTHORING_BLOCKED", () => {
  assert.equal(rowAuthoringStatus({ authoringEligibility: "ELIGIBLE_DOCUMENT_LOCAL", planApproved: true }), "AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL");
  assert.equal(rowAuthoringStatus({ authoringEligibility: "ELIGIBLE_VERIFIED_RELATION", planApproved: true }), "AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL");
  assert.equal(rowAuthoringStatus({ authoringEligibility: "NEEDS_MANUAL_SOURCE_REVIEW", planApproved: true }), "MANUAL_REVIEW_REQUIRED_BEFORE_AUTHORING");
  assert.equal(rowAuthoringStatus({ authoringEligibility: "BLOCKED_PROVISIONAL_RELATION", planApproved: true }), "AUTHORING_BLOCKED");
  assert.equal(rowAuthoringStatus({ authoringEligibility: "BLOCKED_PARSE_FAILED", planApproved: true }), "AUTHORING_BLOCKED");
});

test("rowAuthoringStatus: an unknown eligibility value throws rather than silently defaulting", () => {
  assert.throws(() => rowAuthoringStatus({ authoringEligibility: "NOT_A_REAL_CATEGORY", planApproved: true }));
});

// -- summarizeEligibilityByAuthor / verifyAuthorSplitMatchesTotal (pure) --

test("summarizeEligibilityByAuthor: A/B totals sum exactly to the combined total, and verifyAuthorSplitMatchesTotal confirms it", () => {
  const rows = [
    { assignment_id: "a1", author_allocation: "AUTHOR_A", planned_split: "DEV_TUNE", gold_pool_role: "EXISTING_ANCHOR", authoring_eligibility: "ELIGIBLE_DOCUMENT_LOCAL" },
    { assignment_id: "a2", author_allocation: "AUTHOR_A", planned_split: "DEV_CHECK", gold_pool_role: "EXPANSION", authoring_eligibility: "BLOCKED_PARSE_FAILED" },
    { assignment_id: "b1", author_allocation: "AUTHOR_B", planned_split: "HOLDOUT", gold_pool_role: "EXPANSION", authoring_eligibility: "NEEDS_MANUAL_SOURCE_REVIEW" },
  ];
  const summary = summarizeEligibilityByAuthor(rows);
  assert.equal(summary.perAuthor.AUTHOR_A.total, 2);
  assert.equal(summary.perAuthor.AUTHOR_A.eligible_count, 1);
  assert.equal(summary.perAuthor.AUTHOR_A.blocked_count, 1);
  assert.equal(summary.perAuthor.AUTHOR_B.manual_review_count, 1);
  assert.equal(summary.combined.total, 3);

  const crossCheck = verifyAuthorSplitMatchesTotal({ summary, expectedCombined: { total: 3, eligible_count: 2, blocked_count: 1 } });
  assert.equal(crossCheck.ok, true);
});

test("verifyAuthorSplitMatchesTotal: reports a mismatch rather than silently passing when the expected total disagrees", () => {
  const rows = [{ assignment_id: "a1", author_allocation: "AUTHOR_A", planned_split: "DEV_TUNE", gold_pool_role: "EXISTING_ANCHOR", authoring_eligibility: "ELIGIBLE_DOCUMENT_LOCAL" }];
  const summary = summarizeEligibilityByAuthor(rows);
  const crossCheck = verifyAuthorSplitMatchesTotal({ summary, expectedCombined: { total: 999, eligible_count: 1, blocked_count: 0 } });
  assert.equal(crossCheck.ok, false);
  assert.ok(crossCheck.violations.some((v) => v.type === "TOTAL_MISMATCH"));
});

// -- verifyGold300PlanDecisionV02 (pure) -----------------------------------

function fullyCheckedDecision(overrides = {}) {
  const checklist = ["a", "b", "c"].map((id) => ({ id, label: id, checked: true }));
  return {
    schema_version: "0.2.0", decision_id: "d1", decided_at: new Date().toISOString(), owner: "Test Owner",
    owner_disposition: "APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING", owner_note: null, checklist,
    total_plan_count: 300, author_a_assigned_count: 150, author_b_assigned_count: 150,
    immediately_authorizable_count: 207, manual_review_required_count: 12, blocked_count: 81,
    author_a_immediately_authorizable_count: 120, author_b_immediately_authorizable_count: 87,
    author_a_blocked_count: 21, author_b_blocked_count: 60,
    gold_300_plan_authorized: true, eligible_authoring_authorized: true, blocked_authoring_authorized: false,
    holdout_authoring_authorized: true, holdout_agent_access_authorized: false, holdout_evaluation_authorized: false,
    production_wiring_authorized: false, agent_ranking_authorized: false, relation_decisions_authorized: false,
    actual_official_promotion_applied: false,
    ...overrides,
  };
}
const EXPECTED = {
  total_plan_count: 300, author_a_assigned_count: 150, author_b_assigned_count: 150,
  immediately_authorizable_count: 207, manual_review_required_count: 12, blocked_count: 81,
  author_a_immediately_authorizable_count: 120, author_b_immediately_authorizable_count: 87,
  author_a_blocked_count: 21, author_b_blocked_count: 60,
};

test("verifyGold300PlanDecisionV02: a fully-checklisted genuine APPROVE with matching counts passes and is a genuine approval", () => {
  const result = verifyGold300PlanDecisionV02({ decision: fullyCheckedDecision(), expected: EXPECTED });
  assert.equal(result.ok, true);
  assert.equal(result.is_genuine_approval, true);
});

test("verifyGold300PlanDecisionV02: blocked_authoring_authorized=true is ALWAYS rejected, even on an otherwise-perfect APPROVE", () => {
  const result = verifyGold300PlanDecisionV02({ decision: fullyCheckedDecision({ blocked_authoring_authorized: true }), expected: EXPECTED });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "BLOCKED_AUTHORING_AUTHORIZED_NOT_FALSE"));
});

test("verifyGold300PlanDecisionV02: holdout_agent_access_authorized/holdout_evaluation_authorized/production_wiring_authorized/agent_ranking_authorized/relation_decisions_authorized/actual_official_promotion_applied are ALWAYS rejected if true", () => {
  const fields = ["holdout_agent_access_authorized", "holdout_evaluation_authorized", "production_wiring_authorized", "agent_ranking_authorized", "relation_decisions_authorized", "actual_official_promotion_applied"];
  for (const field of fields) {
    const result = verifyGold300PlanDecisionV02({ decision: fullyCheckedDecision({ [field]: true }), expected: EXPECTED });
    assert.equal(result.ok, false, `${field}=true must be rejected`);
  }
});

test("verifyGold300PlanDecisionV02: gold_300_plan_authorized/eligible_authoring_authorized/holdout_authoring_authorized must be false for a non-genuine disposition (FIX_REQUIRED)", () => {
  const decision = fullyCheckedDecision({ owner_disposition: "FIX_REQUIRED", owner_note: "needs work", gold_300_plan_authorized: false, eligible_authoring_authorized: false, holdout_authoring_authorized: false });
  const result = verifyGold300PlanDecisionV02({ decision, expected: EXPECTED });
  assert.equal(result.ok, true);
  assert.equal(result.is_genuine_approval, false);
});

test("verifyGold300PlanDecisionV02: a partially-checked checklist on an APPROVE disposition is not a genuine approval, and the conditional fields must reflect that (false)", () => {
  const checklist = [{ id: "a", label: "a", checked: true }, { id: "b", label: "b", checked: false }];
  const decision = fullyCheckedDecision({ checklist, gold_300_plan_authorized: false, eligible_authoring_authorized: false, holdout_authoring_authorized: false });
  const result = verifyGold300PlanDecisionV02({ decision, expected: EXPECTED });
  assert.equal(result.ok, true);
  assert.equal(result.is_genuine_approval, false);
});

test("verifyGold300PlanDecisionV02: a count mismatch against the real recomputed expected values is rejected", () => {
  const result = verifyGold300PlanDecisionV02({ decision: fullyCheckedDecision({ blocked_count: 999 }), expected: EXPECTED });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "COUNT_MISMATCH" && v.field === "blocked_count"));
});

test("verifyGold300PlanDecisionV02: FIX_REQUIRED/REJECT_GOLD_300_PLAN without owner_note is rejected", () => {
  const result = verifyGold300PlanDecisionV02({ decision: fullyCheckedDecision({ owner_disposition: "REJECT_GOLD_300_PLAN", owner_note: null, gold_300_plan_authorized: false, eligible_authoring_authorized: false, holdout_authoring_authorized: false }), expected: EXPECTED });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "MISSING_REQUIRED_OWNER_NOTE"));
});

test("REQUIRED_DECISION_FIELDS_V02 does not include any of the deprecated ambiguous v0.1 field names", () => {
  for (const deprecated of ["gold_authoring_authorized", "authorized_scope", "holdout_access_authorized", "phase2_authoring_authorized"]) {
    assert.equal(REQUIRED_DECISION_FIELDS_V02.includes(deprecated), false, `${deprecated} must not be a required v0.2 field`);
  }
});

// -- buildGold300PlanReverification (real, read-only) ----------------------

test("buildGold300PlanReverification never modifies any real N4.20 selection/author-allocation/packet file", () => {
  const before = hashN420Inputs();
  buildGold300PlanReverification();
  const after = hashN420Inputs();
  assert.deepEqual(after, before);
});

test("buildGold300PlanReverification: A+B eligible/blocked sums exactly match N4.20's own combined totals (207 eligible incl. manual review category separated, 81 blocked)", () => {
  const result = buildGold300PlanReverification();
  assert.equal(result.report.total_plan_count, 300);
  assert.equal(result.report.author_a_assigned_count, 150);
  assert.equal(result.report.author_b_assigned_count, 150);
  assert.equal(result.report.immediately_authorizable_count + result.report.manual_review_required_count, 219);
  assert.equal(result.report.blocked_count, 81);
  assert.equal(
    result.report.author_a_immediately_authorizable_count + result.report.author_b_immediately_authorizable_count,
    result.report.immediately_authorizable_count,
  );
  assert.equal(result.report.author_a_blocked_count + result.report.author_b_blocked_count, result.report.blocked_count);
  assert.equal(result.report.cross_check_against_n4_20_gate_status.ok, true);
});

test("buildGold300PlanReverification: each author's Anchor+Expansion pool_role_counts still sum to 75/75", () => {
  const result = buildGold300PlanReverification();
  for (const author of ["AUTHOR_A", "AUTHOR_B"]) {
    assert.equal(result.report.per_author[author].pool_role_counts.EXISTING_ANCHOR, 75, `${author} EXISTING_ANCHOR`);
    assert.equal(result.report.per_author[author].pool_role_counts.EXPANSION, 75, `${author} EXPANSION`);
  }
});

test("buildGold300PlanReverification: no evaluation_group_id or (non-null) chain_component_id is split across authors, and duplicate/intersection counts are exactly 0", () => {
  const result = buildGold300PlanReverification();
  assert.equal(result.report.no_group_or_component_split_across_authors, true);
  assert.equal(result.report.duplicate_assignment_ids, 0);
  assert.equal(result.report.packet_intersection_count, 0);
});

test("buildGold300PlanReverification: the written report file on disk matches the returned report exactly", () => {
  buildGold300PlanReverification();
  const onDisk = readJson(resolve(REVERIFICATION_OUT_DIR, "gold-300-eligibility-by-author-v0.2.json"));
  assert.equal(onDisk.n4_20_inputs_unmodified, true);
  assert.equal(onDisk.total_plan_count, 300);
});

// -- buildGold300V01UiSupersede (real) -------------------------------------

test("buildGold300V01UiSupersede: writes gate-status.v0.2.json inside the EXISTING gold-authoring-300-v0.1 directory, marks previous_ui_status superseded, and never touches the real v0.1 UI/packet files", () => {
  const beforeHtml = sha256(readFileSync(resolve(AUTHORING_V01_DIR, "owner-review-v0.1/ui/v0.1/gold-300-authoring-owner-review.html")));
  const beforePacketA = sha256(readFileSync(PACKET_A_PATH));

  const result = buildGold300V01UiSupersede();
  assert.equal(result.gateStatusV02.previous_ui_status, "SUPERSEDED_DO_NOT_USE_FOR_OWNER_DECISION");
  assert.equal(result.gateStatusV02.previous_decision_accepted, false);
  assert.equal(result.gateStatusV02.real_v01_decision_file_found, false);
  assert.ok(result.path.includes("gold-authoring-300-v0.1/"));
  assert.ok(result.path.endsWith("gate-status.v0.2.json"));

  const afterHtml = sha256(readFileSync(resolve(AUTHORING_V01_DIR, "owner-review-v0.1/ui/v0.1/gold-300-authoring-owner-review.html")));
  const afterPacketA = sha256(readFileSync(PACKET_A_PATH));
  assert.equal(afterHtml, beforeHtml, "v0.1 UI HTML must be byte-unmodified");
  assert.equal(afterPacketA, beforePacketA, "AUTHOR_A packet must be byte-unmodified");
});

test("buildGold300V01UiSupersede: no real (non-template) v0.1 decision file exists in this repo right now -- if this ever fails, STOP, do not auto-supersede, and report instead", () => {
  const realDecisionPath = resolve(AUTHORING_V01_DIR, "owner-review-v0.1/gold-300-authoring-owner-decision.v0.1.json");
  assert.equal(existsSync(realDecisionPath), false);
});

test("buildGold300V01UiSupersede: fails closed (throws, writes nothing) when a real v0.1 decision file IS present -- verified by planting a clearly-fake one and guaranteeing its removal in finally", () => {
  const realDecisionPath = resolve(AUTHORING_V01_DIR, "owner-review-v0.1/gold-300-authoring-owner-decision.v0.1.json");
  assert.equal(existsSync(realDecisionPath), false, "precondition: must not already exist");
  writeFileSync(realDecisionPath, JSON.stringify({ schema_version: "0.1.0", decision_id: "TEST-FIXTURE-NOT-A-REAL-DECISION", owner_disposition: "PENDING" }, null, 2));
  try {
    assert.throws(() => buildGold300V01UiSupersede(), /a real v0\.1 Owner decision file exists/);
  } finally {
    rmSync(realDecisionPath, { force: true });
  }
  assert.equal(existsSync(realDecisionPath), false, "the planted fixture must be gone after this test");
});
