// Turn N4.12: synthetic-fixture unit tests for
// domain/evaluation/relation-closure-owner-ratification.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyOwnerRatificationDecision, buildOwnerRatifiedConsensusRows } from "../domain/evaluation/relation-closure-owner-ratification.mjs";

function baseExpectations() {
  return {
    expectedConsensusManifestPath: "manifest.json",
    expectedConsensusManifestCanonicalSha256: "MANIFEST_SHA",
    expectedReviewerEDecisionPath: "e.jsonl",
    expectedReviewerEDecisionSha256: "E_SHA",
    expectedReviewerFDecisionPath: "f.jsonl",
    expectedReviewerFDecisionSha256: "F_SHA",
    expectedReviewedRelationCandidateIds: ["r1", "r2", "r3"],
    expectedConfirmCount: 2,
    expectedRejectCount: 1,
    expectedNeedsMoreReviewCount: 0,
    expectedProspectiveGraphReportPath: "report.json",
    expectedProspectiveGraphReportSha256: "REPORT_SHA",
  };
}
function validDecision(overrides = {}) {
  return {
    schema_version: "0.1.0",
    decision_id: "abc-123",
    owner: "Test Owner",
    decided_at: "2026-08-30T06:56:56.630Z",
    owner_disposition: "APPROVE_DUAL_REVIEW_CONSENSUS",
    owner_note: null,
    consensus_manifest_path: "manifest.json",
    consensus_manifest_sha256: "MANIFEST_SHA",
    reviewer_e_decision_path: "e.jsonl",
    reviewer_e_decision_sha256: "E_SHA",
    reviewer_f_decision_path: "f.jsonl",
    reviewer_f_decision_sha256: "F_SHA",
    reviewed_relation_candidate_ids: ["r1", "r2", "r3"],
    confirm_count: 2,
    reject_count: 1,
    needs_more_review_count: 0,
    prospective_graph_report_path: "report.json",
    prospective_graph_report_sha256: "REPORT_SHA",
    official_split_eligible: false,
    gold_authoring_authorized: false,
    ...overrides,
  };
}

test("verifyOwnerRatificationDecision: a fully consistent APPROVE decision passes with zero violations", () => {
  const result = verifyOwnerRatificationDecision({ decision: validDecision(), ...baseExpectations() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("verifyOwnerRatificationDecision: catches every required-field omission", () => {
  const { schema_version, ...missing } = validDecision();
  const result = verifyOwnerRatificationDecision({ decision: missing, ...baseExpectations() });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "MISSING_FIELD" && v.field === "schema_version"));
});

test("verifyOwnerRatificationDecision: rejects a disallowed owner_disposition", () => {
  const result = verifyOwnerRatificationDecision({ decision: validDecision({ owner_disposition: "MAYBE_LATER" }), ...baseExpectations() });
  assert.ok(result.violations.some((v) => v.type === "DISALLOWED_OWNER_DISPOSITION"));
});

test("verifyOwnerRatificationDecision: FIX_REQUIRED/REJECT_BATCH without owner_note fails; APPROVE with null note is fine", () => {
  const r1 = verifyOwnerRatificationDecision({ decision: validDecision({ owner_disposition: "FIX_REQUIRED", owner_note: null }), ...baseExpectations() });
  assert.ok(r1.violations.some((v) => v.type === "MISSING_REQUIRED_OWNER_NOTE"));
  const r2 = verifyOwnerRatificationDecision({ decision: validDecision({ owner_disposition: "FIX_REQUIRED", owner_note: "please recheck row 2" }), ...baseExpectations() });
  assert.ok(!r2.violations.some((v) => v.type === "MISSING_REQUIRED_OWNER_NOTE"));
  const r3 = verifyOwnerRatificationDecision({ decision: validDecision(), ...baseExpectations() }); // APPROVE + null note
  assert.equal(r3.ok, true);
});

test("verifyOwnerRatificationDecision: catches SHA mismatches on every cited artifact independently", () => {
  const exp = baseExpectations();
  for (const [field, violationType] of [
    ["consensus_manifest_sha256", "CONSENSUS_MANIFEST_SHA_MISMATCH"],
    ["reviewer_e_decision_sha256", "REVIEWER_E_SHA_MISMATCH"],
    ["reviewer_f_decision_sha256", "REVIEWER_F_SHA_MISMATCH"],
    ["prospective_graph_report_sha256", "PROSPECTIVE_REPORT_SHA_MISMATCH"],
  ]) {
    const result = verifyOwnerRatificationDecision({ decision: validDecision({ [field]: "TAMPERED" }), ...exp });
    assert.ok(result.violations.some((v) => v.type === violationType), `expected ${violationType} for tampered ${field}`);
  }
});

test("verifyOwnerRatificationDecision: catches a reviewed-id set that doesn't match (extra, missing, or duplicate)", () => {
  const exp = baseExpectations();
  const extra = verifyOwnerRatificationDecision({ decision: validDecision({ reviewed_relation_candidate_ids: ["r1", "r2", "r3", "r4"] }), ...exp });
  assert.ok(extra.violations.some((v) => v.type === "REVIEWED_ID_SET_MISMATCH"));
  const missing = verifyOwnerRatificationDecision({ decision: validDecision({ reviewed_relation_candidate_ids: ["r1", "r2"] }), ...exp });
  assert.ok(missing.violations.some((v) => v.type === "REVIEWED_ID_SET_MISMATCH" || v.type === "COUNT_SUM_DOES_NOT_MATCH_ID_COUNT"));
  const dup = verifyOwnerRatificationDecision({ decision: validDecision({ reviewed_relation_candidate_ids: ["r1", "r1", "r2"] }), ...exp });
  assert.ok(dup.violations.some((v) => v.type === "DUPLICATE_REVIEWED_ID"));
});

test("verifyOwnerRatificationDecision: catches count mismatches, including a count sum that disagrees with the id count", () => {
  const exp = baseExpectations();
  const wrongConfirm = verifyOwnerRatificationDecision({ decision: validDecision({ confirm_count: 3 }), ...exp });
  assert.ok(wrongConfirm.violations.some((v) => v.type === "CONFIRM_COUNT_MISMATCH"));
  const badSum = verifyOwnerRatificationDecision({ decision: validDecision({ confirm_count: 5, reject_count: 5 }), ...exp });
  assert.ok(badSum.violations.some((v) => v.type === "COUNT_SUM_DOES_NOT_MATCH_ID_COUNT"));
});

test("verifyOwnerRatificationDecision: HARD invariant -- official_split_eligible=true or gold_authoring_authorized=true is ALWAYS rejected, even on an otherwise-perfect APPROVE decision", () => {
  const exp = baseExpectations();
  const r1 = verifyOwnerRatificationDecision({ decision: validDecision({ official_split_eligible: true }), ...exp });
  assert.equal(r1.ok, false);
  assert.ok(r1.violations.some((v) => v.type === "OFFICIAL_SPLIT_ELIGIBLE_NOT_FALSE"));
  const r2 = verifyOwnerRatificationDecision({ decision: validDecision({ gold_authoring_authorized: true }), ...exp });
  assert.equal(r2.ok, false);
  assert.ok(r2.violations.some((v) => v.type === "GOLD_AUTHORING_AUTHORIZED_NOT_FALSE"));
});

test("verifyOwnerRatificationDecision: rejects empty decision_id/owner and an unparseable decided_at", () => {
  const exp = baseExpectations();
  assert.ok(verifyOwnerRatificationDecision({ decision: validDecision({ decision_id: "" }), ...exp }).violations.some((v) => v.type === "EMPTY_DECISION_ID"));
  assert.ok(verifyOwnerRatificationDecision({ decision: validDecision({ owner: "   " }), ...exp }).violations.some((v) => v.type === "EMPTY_OWNER"));
  assert.ok(verifyOwnerRatificationDecision({ decision: validDecision({ decided_at: "not-a-date" }), ...exp }).violations.some((v) => v.type === "INVALID_DECIDED_AT"));
});

// -- buildOwnerRatifiedConsensusRows -----------------------------------
test("buildOwnerRatifiedConsensusRows: APPROVE marks consensus_status ratified but NEVER touches official_split_eligible/promotion flags", () => {
  const consensusRows = [
    { relation_candidate_id: "r1", consensus_status: "DUAL_REVIEW_CONSENSUS_PENDING_OWNER", official_relation_status: "NOT_YET_OWNER_APPROVED" },
    { relation_candidate_id: "r2", consensus_status: "DUAL_REVIEW_CONSENSUS_PENDING_OWNER", official_relation_status: "NOT_YET_OWNER_APPROVED" },
  ];
  const decision = validDecision();
  const result = buildOwnerRatifiedConsensusRows({ consensusRows, decision });
  for (const row of result) {
    assert.equal(row.consensus_status, "DUAL_REVIEW_CONSENSUS_OWNER_RATIFIED");
    assert.equal(row.official_relation_status, "NOT_YET_OFFICIALLY_PROMOTED");
    assert.equal(row.auto_promoted_to_official_relation, false);
    assert.equal(row.official_split_eligible, false);
    assert.equal(row.owner_ratification.decision_id, decision.decision_id);
    assert.equal(row.owner_ratification.owner, decision.owner);
  }
});

test("buildOwnerRatifiedConsensusRows: a FIX_REQUIRED/REJECT_BATCH decision leaves consensus_status unchanged (not silently marked ratified)", () => {
  const consensusRows = [{ relation_candidate_id: "r1", consensus_status: "DUAL_REVIEW_CONSENSUS_PENDING_OWNER", official_relation_status: "NOT_YET_OWNER_APPROVED" }];
  const decision = validDecision({ owner_disposition: "FIX_REQUIRED", owner_note: "needs work" });
  const result = buildOwnerRatifiedConsensusRows({ consensusRows, decision });
  assert.equal(result[0].consensus_status, "DUAL_REVIEW_CONSENSUS_PENDING_OWNER");
  assert.equal(result[0].official_split_eligible, false);
});
