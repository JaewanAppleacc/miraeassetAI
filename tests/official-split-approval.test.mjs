// Turn N4.17: synthetic-fixture unit tests for
// domain/evaluation/official-split-approval.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyOfficialSplitApprovalDecision, REQUIRED_DECISION_FIELDS } from "../domain/evaluation/official-split-approval.mjs";

function expectedBase() {
  return {
    v03_manifest_sha256: "MANIFEST_SHA", v03_pool_sha256: "POOL_SHA", v03_anchor_sha256: "ANCHOR_SHA", v03_author_sha256: "AUTHOR_SHA",
    anchor_count: 150, candidate_pool_count: 500, author_count: 150,
    split_leakage_after: 0, author_leakage_after: 0, quarantine_intrusion_after: 0,
    split_counts: { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 },
    author_counts: { AUTHOR_A: 75, AUTHOR_B: 75 },
  };
}
function fullChecklist(checked = true) {
  return [
    { id: "a", label: "a", checked },
    { id: "b", label: "b", checked },
  ];
}
function validApproveDecision(overrides = {}) {
  return {
    schema_version: "0.1.0", decision_id: "id-1", owner: "Test Owner", decided_at: "2026-08-30T10:00:00.000Z",
    owner_disposition: "APPROVE_OFFICIAL_SPLIT_V0.3", owner_note: null,
    v03_manifest_path: "p", v03_manifest_sha256: "MANIFEST_SHA",
    v03_pool_path: "p", v03_pool_sha256: "POOL_SHA", v03_anchor_path: "p", v03_anchor_sha256: "ANCHOR_SHA", v03_author_path: "p", v03_author_sha256: "AUTHOR_SHA",
    anchor_count: 150, candidate_pool_count: 500, author_count: 150,
    split_counts: { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 },
    author_counts: { AUTHOR_A: 75, AUTHOR_B: 75 },
    split_leakage_after: 0, author_leakage_after: 0, quarantine_intrusion_after: 0,
    critical_slice_floors_preserved: true, anchor_membership_unchanged: true,
    anchor_membership_changed: false, relation_decisions_authorized: false,
    official_split_eligible: true, gold_authoring_authorized: false, actual_official_promotion_applied: false,
    remaining_281_provisional_untouched: true,
    checklist: fullChecklist(true),
    ...overrides,
  };
}

test("a fully-checklisted APPROVE decision with official_split_eligible=true passes with zero violations, and is_genuine_approval is true", () => {
  const result = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision(), expected: expectedBase() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.is_genuine_approval, true);
});

test("catches every required-field omission", () => {
  const { schema_version, ...missing } = validApproveDecision();
  const result = verifyOfficialSplitApprovalDecision({ decision: missing, expected: expectedBase() });
  assert.ok(result.violations.some((v) => v.type === "MISSING_FIELD" && v.field === "schema_version"));
});

test("rejects a disallowed owner_disposition", () => {
  const result = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ owner_disposition: "MAYBE", official_split_eligible: false }), expected: expectedBase() });
  assert.ok(result.violations.some((v) => v.type === "DISALLOWED_OWNER_DISPOSITION"));
});

test("FIX_REQUIRED/REJECT_PLAN require a non-empty owner_note; APPROVE does not", () => {
  const r1 = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ owner_disposition: "FIX_REQUIRED", owner_note: null, official_split_eligible: false }), expected: expectedBase() });
  assert.ok(r1.violations.some((v) => v.type === "MISSING_REQUIRED_OWNER_NOTE"));
  const r2 = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ owner_disposition: "REJECT_PLAN", owner_note: "not enough evidence", official_split_eligible: false }), expected: expectedBase() });
  assert.ok(!r2.violations.some((v) => v.type === "MISSING_REQUIRED_OWNER_NOTE"));
});

test("catches SHA and count/structural mismatches independently", () => {
  const exp = expectedBase();
  const r1 = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ v03_pool_sha256: "TAMPERED" }), expected: exp });
  assert.ok(r1.violations.some((v) => v.type === "SHA_MISMATCH" && v.field === "v03_pool_sha256"));
  const r2 = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ candidate_pool_count: 999 }), expected: exp });
  assert.ok(r2.violations.some((v) => v.type === "COUNT_MISMATCH" && v.field === "candidate_pool_count"));
  const r3 = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ split_counts: { DEV_TUNE: 1, DEV_CHECK: 2, HOLDOUT: 3 } }), expected: exp });
  assert.ok(r3.violations.some((v) => v.type === "STRUCTURAL_MISMATCH" && v.field === "split_counts"));
});

test("UNCONDITIONAL hard invariants -- gold_authoring_authorized/relation_decisions_authorized/actual_official_promotion_applied/anchor_membership_changed must always be false, even on an otherwise-perfect APPROVE decision", () => {
  const exp = expectedBase();
  for (const field of ["gold_authoring_authorized", "relation_decisions_authorized", "actual_official_promotion_applied"]) {
    const result = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ [field]: true }), expected: exp });
    assert.equal(result.ok, false, `${field}=true must be rejected`);
  }
  const r = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ anchor_membership_changed: true }), expected: exp });
  assert.equal(r.ok, false);
});

test("CONDITIONAL invariant -- official_split_eligible must be TRUE for a fully-checklisted APPROVE, and this is checked, not merely copied", () => {
  const exp = expectedBase();
  const result = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ official_split_eligible: false }), expected: exp });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "OFFICIAL_SPLIT_ELIGIBLE_INCONSISTENT" && v.expected === true));
});

test("CONDITIONAL invariant -- official_split_eligible must be FALSE when the disposition is not APPROVE, even if the field claims true", () => {
  const exp = expectedBase();
  const result = verifyOfficialSplitApprovalDecision({
    decision: validApproveDecision({ owner_disposition: "REJECT_PLAN", owner_note: "no", official_split_eligible: true }),
    expected: exp,
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "OFFICIAL_SPLIT_ELIGIBLE_INCONSISTENT" && v.expected === false));
});

test("CONDITIONAL invariant -- official_split_eligible must be FALSE when APPROVE is selected but the checklist is only PARTIALLY checked, even if the field claims true", () => {
  const exp = expectedBase();
  const result = verifyOfficialSplitApprovalDecision({
    decision: validApproveDecision({ checklist: fullChecklist(false), official_split_eligible: true }),
    expected: exp,
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "OFFICIAL_SPLIT_ELIGIBLE_INCONSISTENT" && v.expected === false));
  assert.equal(result.is_genuine_approval, false);
});

test("critical_slice_floors_preserved and anchor_membership_unchanged must both be true, checked independently of other fields", () => {
  const exp = expectedBase();
  const r1 = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ critical_slice_floors_preserved: false }), expected: exp });
  assert.ok(r1.violations.some((v) => v.type === "CRITICAL_SLICE_FLOORS_NOT_PRESERVED"));
  const r2 = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ anchor_membership_unchanged: false }), expected: exp });
  assert.ok(r2.violations.some((v) => v.type === "ANCHOR_MEMBERSHIP_NOT_UNCHANGED"));
});

test("remaining_281_provisional_untouched must be true", () => {
  const exp = expectedBase();
  const result = verifyOfficialSplitApprovalDecision({ decision: validApproveDecision({ remaining_281_provisional_untouched: false }), expected: exp });
  assert.ok(result.violations.some((v) => v.type === "REMAINING_281_PROVISIONAL_UNTOUCHED_NOT_TRUE"));
});

test("REQUIRED_DECISION_FIELDS includes every field this Turn's decision schema mandates", () => {
  for (const field of [
    "schema_version", "decision_id", "owner", "decided_at", "owner_disposition", "owner_note",
    "v03_manifest_sha256", "v03_pool_sha256", "v03_anchor_sha256", "v03_author_sha256",
    "official_split_eligible", "gold_authoring_authorized", "actual_official_promotion_applied",
    "relation_decisions_authorized", "anchor_membership_changed", "checklist",
  ]) {
    assert.ok(REQUIRED_DECISION_FIELDS.includes(field), `missing required field: ${field}`);
  }
});
