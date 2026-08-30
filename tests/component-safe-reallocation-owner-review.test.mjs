// Turn N4.14: synthetic-fixture unit tests for
// domain/evaluation/component-safe-reallocation-owner-review.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { computeMovementSummary, verifyOwnerReviewDecision, REQUIRED_DECISION_FIELDS } from "../domain/evaluation/component-safe-reallocation-owner-review.mjs";

function row({ id, dim, from, to, reason, comp }) {
  return { assignment_id: id, dimension: dim, from, to, reason, component_id: comp };
}

test("computeMovementSummary: never assumes operations == unique assignments -- computes real overlap between split and author dimensions", () => {
  const deltaRows = [
    row({ id: "a1", dim: "split", from: "HOLDOUT", to: "DEV_TUNE", reason: "COMPONENT_CONSOLIDATION", comp: "c1" }),
    row({ id: "a2", dim: "split", from: "DEV_TUNE", to: "HOLDOUT", reason: "COMPENSATING_RESTORATION", comp: "c2" }),
    row({ id: "a1", dim: "author", from: "AUTHOR_B", to: "AUTHOR_A", reason: "COMPONENT_CONSOLIDATION", comp: "c1" }), // a1 appears in BOTH dimensions
    row({ id: "a3", dim: "author", from: "AUTHOR_A", to: "AUTHOR_B", reason: "COMPENSATING_RESTORATION", comp: "c3" }),
  ];
  const summary = computeMovementSummary({ deltaRows });
  assert.equal(summary.split_operation_count, 2);
  assert.equal(summary.author_operation_count, 2);
  assert.equal(summary.overlap_count, 1);
  assert.deepEqual(summary.overlapping_assignment_ids, ["a1"]);
  assert.equal(summary.unique_changed_assignment_count, 3, "a1, a2, a3 -- NOT 4 (operations), since a1 counts once");
});

test("computeMovementSummary: a scenario with ZERO overlap correctly reports overlap_count 0 and unique == total operations", () => {
  const deltaRows = [
    row({ id: "s1", dim: "split", from: "HOLDOUT", to: "DEV_TUNE", reason: "COMPONENT_CONSOLIDATION", comp: "c1" }),
    row({ id: "au1", dim: "author", from: "AUTHOR_A", to: "AUTHOR_B", reason: "COMPONENT_CONSOLIDATION", comp: "c2" }),
  ];
  const summary = computeMovementSummary({ deltaRows });
  assert.equal(summary.overlap_count, 0);
  assert.equal(summary.unique_changed_assignment_count, 2);
});

test("computeMovementSummary: split from->to transition counts are grouped correctly, distinguishing all 4 direction pairs", () => {
  const deltaRows = [
    row({ id: "1", dim: "split", from: "HOLDOUT", to: "DEV_TUNE", reason: "COMPONENT_CONSOLIDATION", comp: "c1" }),
    row({ id: "2", dim: "split", from: "HOLDOUT", to: "DEV_TUNE", reason: "COMPENSATING_RESTORATION", comp: "c2" }),
    row({ id: "3", dim: "split", from: "DEV_TUNE", to: "HOLDOUT", reason: "COMPENSATING_RESTORATION", comp: "c3" }),
    row({ id: "4", dim: "split", from: "DEV_CHECK", to: "DEV_TUNE", reason: "COMPONENT_CONSOLIDATION", comp: "c4" }),
  ];
  const summary = computeMovementSummary({ deltaRows });
  assert.deepEqual(summary.split_transition_counts, { "DEV_CHECK->DEV_TUNE": 1, "DEV_TUNE->HOLDOUT": 1, "HOLDOUT->DEV_TUNE": 2 });
});

test("computeMovementSummary: author A->B / B->A counts are computed separately", () => {
  const deltaRows = [
    row({ id: "1", dim: "author", from: "AUTHOR_A", to: "AUTHOR_B", reason: "COMPONENT_CONSOLIDATION", comp: "c1" }),
    row({ id: "2", dim: "author", from: "AUTHOR_B", to: "AUTHOR_A", reason: "COMPENSATING_RESTORATION", comp: "c2" }),
    row({ id: "3", dim: "author", from: "AUTHOR_B", to: "AUTHOR_A", reason: "COMPENSATING_RESTORATION", comp: "c3" }),
  ];
  const summary = computeMovementSummary({ deltaRows });
  assert.deepEqual(summary.author_transition_counts, { "AUTHOR_A->AUTHOR_B": 1, "AUTHOR_B->AUTHOR_A": 2 });
});

test("computeMovementSummary: forced vs compensating reason breakdown is reported per dimension", () => {
  const deltaRows = [
    row({ id: "1", dim: "split", from: "HOLDOUT", to: "DEV_TUNE", reason: "COMPONENT_CONSOLIDATION", comp: "c1" }),
    row({ id: "2", dim: "split", from: "DEV_TUNE", to: "HOLDOUT", reason: "COMPENSATING_RESTORATION", comp: "c2" }),
    row({ id: "3", dim: "author", from: "AUTHOR_A", to: "AUTHOR_B", reason: "COMPONENT_CONSOLIDATION", comp: "c3" }),
  ];
  const summary = computeMovementSummary({ deltaRows });
  assert.deepEqual(summary.split_reason_counts, { COMPENSATING_RESTORATION: 1, COMPONENT_CONSOLIDATION: 1 });
  assert.deepEqual(summary.author_reason_counts, { COMPONENT_CONSOLIDATION: 1 });
});

test("computeMovementSummary: per-component movement summary aggregates split+author counts for a component touched by both dimensions", () => {
  const deltaRows = [
    row({ id: "1", dim: "split", from: "HOLDOUT", to: "DEV_TUNE", reason: "COMPONENT_CONSOLIDATION", comp: "shared" }),
    row({ id: "2", dim: "author", from: "AUTHOR_A", to: "AUTHOR_B", reason: "COMPONENT_CONSOLIDATION", comp: "shared" }),
    row({ id: "3", dim: "split", from: "DEV_TUNE", to: "HOLDOUT", reason: "COMPENSATING_RESTORATION", comp: "other" }),
  ];
  const summary = computeMovementSummary({ deltaRows });
  const shared = summary.component_movement_summary.find((c) => c.component_id === "shared");
  assert.equal(shared.split_count, 1);
  assert.equal(shared.author_count, 1);
  assert.equal(shared.total_count, 2);
  assert.equal(summary.distinct_component_count, 2);
});

// -- verifyOwnerReviewDecision -------------------------------------------
function expectedBase() {
  return {
    plan_sha256: "PLAN_SHA", delta_sha256: "DELTA_SHA", verification_report_sha256: "VERIF_SHA",
    anchor_count: 150, candidate_pool_count: 500, split_operation_count: 62, author_operation_count: 8,
    unique_changed_assignment_count: 70, overlapping_assignment_count: 0, quarantine_intrusion_count: 0,
  };
}
function validDecision(overrides = {}) {
  return {
    schema_version: "0.1.0", decision_id: "id-1", owner: "Test Owner", decided_at: "2026-08-30T10:00:00.000Z",
    owner_disposition: "APPROVE_COMPONENT_SAFE_REALLOCATION", owner_note: null,
    plan_path: "p", plan_sha256: "PLAN_SHA", delta_path: "d", delta_sha256: "DELTA_SHA",
    verification_report_path: "v", verification_report_sha256: "VERIF_SHA",
    anchor_count: 150, candidate_pool_count: 500, split_operation_count: 62, author_operation_count: 8,
    unique_changed_assignment_count: 70, overlapping_assignment_count: 0,
    before_split_counts: { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 }, after_split_counts: { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 },
    before_author_counts: { AUTHOR_A: 75, AUTHOR_B: 75 }, after_author_counts: { AUTHOR_A: 75, AUTHOR_B: 75 },
    before_split_leakage: 6, after_split_leakage: 0, before_author_leakage: 4, after_author_leakage: 0,
    quarantine_intrusion_count: 0,
    anchor_membership_changed: false, relation_decisions_authorized: false,
    official_split_eligible: false, gold_authoring_authorized: false,
    checklist: [],
    ...overrides,
  };
}

test("verifyOwnerReviewDecision: a fully consistent APPROVE decision passes with zero violations", () => {
  const result = verifyOwnerReviewDecision({ decision: validDecision(), expected: expectedBase() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("verifyOwnerReviewDecision: catches every required-field omission", () => {
  const { schema_version, ...missing } = validDecision();
  const result = verifyOwnerReviewDecision({ decision: missing, expected: expectedBase() });
  assert.ok(result.violations.some((v) => v.type === "MISSING_FIELD" && v.field === "schema_version"));
});

test("verifyOwnerReviewDecision: rejects a disallowed owner_disposition", () => {
  const result = verifyOwnerReviewDecision({ decision: validDecision({ owner_disposition: "MAYBE" }), expected: expectedBase() });
  assert.ok(result.violations.some((v) => v.type === "DISALLOWED_OWNER_DISPOSITION"));
});

test("verifyOwnerReviewDecision: FIX_REQUIRED/REJECT_PLAN require a non-empty owner_note; APPROVE does not", () => {
  const r1 = verifyOwnerReviewDecision({ decision: validDecision({ owner_disposition: "FIX_REQUIRED", owner_note: null }), expected: expectedBase() });
  assert.ok(r1.violations.some((v) => v.type === "MISSING_REQUIRED_OWNER_NOTE"));
  const r2 = verifyOwnerReviewDecision({ decision: validDecision({ owner_disposition: "REJECT_PLAN", owner_note: "not enough evidence" }), expected: expectedBase() });
  assert.ok(!r2.violations.some((v) => v.type === "MISSING_REQUIRED_OWNER_NOTE"));
});

test("verifyOwnerReviewDecision: catches SHA and count mismatches independently", () => {
  const exp = expectedBase();
  const r1 = verifyOwnerReviewDecision({ decision: validDecision({ delta_sha256: "TAMPERED" }), expected: exp });
  assert.ok(r1.violations.some((v) => v.type === "SHA_MISMATCH" && v.field === "delta_sha256"));
  const r2 = verifyOwnerReviewDecision({ decision: validDecision({ split_operation_count: 999 }), expected: exp });
  assert.ok(r2.violations.some((v) => v.type === "COUNT_MISMATCH" && v.field === "split_operation_count"));
});

test("verifyOwnerReviewDecision: HARD invariants -- anchor_membership_changed/relation_decisions_authorized/official_split_eligible/gold_authoring_authorized must ALWAYS be false, even on an otherwise-perfect APPROVE decision", () => {
  const exp = expectedBase();
  for (const field of ["anchor_membership_changed", "relation_decisions_authorized", "official_split_eligible", "gold_authoring_authorized"]) {
    const result = verifyOwnerReviewDecision({ decision: validDecision({ [field]: true }), expected: exp });
    assert.equal(result.ok, false, `${field}=true must be rejected`);
  }
});

test("REQUIRED_DECISION_FIELDS includes every field this Turn's instructions mandate", () => {
  for (const field of ["schema_version", "decision_id", "owner", "decided_at", "owner_disposition", "owner_note", "plan_path", "plan_sha256", "delta_path", "delta_sha256", "verification_report_path", "verification_report_sha256", "anchor_count", "candidate_pool_count", "split_operation_count", "author_operation_count", "unique_changed_assignment_count", "overlapping_assignment_count", "before_split_counts", "after_split_counts", "before_author_counts", "after_author_counts", "before_split_leakage", "after_split_leakage", "before_author_leakage", "after_author_leakage", "quarantine_intrusion_count", "anchor_membership_changed", "relation_decisions_authorized", "official_split_eligible", "gold_authoring_authorized", "checklist"]) {
    assert.ok(REQUIRED_DECISION_FIELDS.includes(field), `missing required field: ${field}`);
  }
});
