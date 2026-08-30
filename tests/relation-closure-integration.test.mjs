// Turn N4.3: unit tests for domain/evaluation/relation-closure-integration.mjs
// using small synthetic fixtures (never the real 326-row packet -- that is
// covered end-to-end by scripts/build-relation-closure-owner-packet-v043.mjs's
// own fail-closed real-data run, exercised by
// tests/relation-closure-owner-packet-v043.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRemediationOverlay, buildComparisonLedger, selectOwnerReviewSet,
  selectProvisionalSet, selectStratifiedSample, validateSampleAuditRow,
  validateSampleAuditorDecision, computeSampleAuditGateStatus, validateSampleAuditInputs,
  validateDualAuditInputs, buildAuditComparisonLedger, selectAuditConflicts,
  detectMultiStepCorrectionRisk, AUDIT_FINAL_STATUSES,
  OWNER_REVIEW_REASONS, PROVISIONAL_DISPOSITIONS, SAMPLE_AUDIT_DISPOSITIONS,
  DEFECT_TYPES, SAMPLE_AUDIT_GATE_STATUSES,
} from "../domain/evaluation/relation-closure-integration.mjs";

function baseRow(id, disposition, target, notes = "n") {
  return { relation_candidate_id: id, source_document_id: "src_" + id, relation_type: "AMENDS", owner_disposition: disposition, confirmed_target_document_id: target, reviewer: "REVIEWER_AGENT_A", reviewed_at: "2026-01-01T00:00:00Z", notes };
}

test("applyRemediationOverlay: rows with no remediation entry keep the base decision exactly", () => {
  const base = [baseRow("r1", "REJECT", null), baseRow("r2", "CONFIRM", "t2")];
  const result = applyRemediationOverlay({ baseDecisions: base, remediationDecisions: [], packetIds: new Set(["r1", "r2"]) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.finalById.get("r1"), { owner_disposition: "REJECT", confirmed_target_document_id: null, reviewer: "REVIEWER_AGENT_A", reviewed_at: "2026-01-01T00:00:00Z", notes: "n", source: "BASE", considered_target_document_ids: [] });
});

test("applyRemediationOverlay: a remediation entry overrides its own row's disposition/target, never touching rows without one", () => {
  const base = [baseRow("r1", "REJECT", null), baseRow("r2", "REJECT", null)];
  const rem = [{ relation_candidate_id: "r1", owner_disposition: "CONFIRM", confirmed_target_document_id: "t1-new", reviewer: "REVIEWER_AGENT_A", reviewed_at: "2026-01-02T00:00:00Z", notes: "remediated", considered_target_document_ids: ["t1-new", "t1-old"] }];
  const result = applyRemediationOverlay({ baseDecisions: base, remediationDecisions: rem, packetIds: new Set(["r1", "r2"]) });
  assert.equal(result.ok, true);
  assert.equal(result.finalById.get("r1").owner_disposition, "CONFIRM");
  assert.equal(result.finalById.get("r1").confirmed_target_document_id, "t1-new");
  assert.equal(result.finalById.get("r1").source, "REMEDIATION");
  assert.equal(result.finalById.get("r2").owner_disposition, "REJECT");
  assert.equal(result.finalById.get("r2").source, "BASE");
});

test("applyRemediationOverlay: fails closed on a duplicate relation_candidate_id in base decisions", () => {
  const base = [baseRow("r1", "REJECT", null), baseRow("r1", "CONFIRM", "t")];
  const result = applyRemediationOverlay({ baseDecisions: base, remediationDecisions: [], packetIds: new Set(["r1"]) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(";"), /duplicate/);
});

test("applyRemediationOverlay: fails closed on a duplicate relation_candidate_id in remediation decisions", () => {
  const base = [baseRow("r1", "REJECT", null)];
  const rem = [
    { relation_candidate_id: "r1", owner_disposition: "CONFIRM", confirmed_target_document_id: "t", reviewer: "x", reviewed_at: "d", notes: "n" },
    { relation_candidate_id: "r1", owner_disposition: "REJECT", confirmed_target_document_id: null, reviewer: "x", reviewed_at: "d", notes: "n" },
  ];
  const result = applyRemediationOverlay({ baseDecisions: base, remediationDecisions: rem, packetIds: new Set(["r1"]) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(";"), /duplicate/);
});

test("applyRemediationOverlay: fails closed when a remediation row's id is absent from this reviewer's own base decisions", () => {
  const base = [baseRow("r1", "REJECT", null)];
  const rem = [{ relation_candidate_id: "r-ghost", owner_disposition: "CONFIRM", confirmed_target_document_id: "t", reviewer: "x", reviewed_at: "d", notes: "n" }];
  const result = applyRemediationOverlay({ baseDecisions: base, remediationDecisions: rem, packetIds: new Set(["r1", "r-ghost"]) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(";"), /not present in this reviewer's own base decisions/);
});

test("applyRemediationOverlay: fails closed when a remediation row's id is absent from the source packet", () => {
  const base = [baseRow("r1", "REJECT", null)];
  const rem = [{ relation_candidate_id: "r1", owner_disposition: "CONFIRM", confirmed_target_document_id: "t", reviewer: "x", reviewed_at: "d", notes: "n" }];
  const result = applyRemediationOverlay({ baseDecisions: base, remediationDecisions: rem, packetIds: new Set(["some-other-id"]) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(";"), /not present in the source packet/);
});

test("applyRemediationOverlay: fails closed on an invalid owner_disposition value in either base or remediation", () => {
  const base = [baseRow("r1", "MAYBE", null)];
  const result = applyRemediationOverlay({ baseDecisions: base, remediationDecisions: [], packetIds: new Set(["r1"]) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(";"), /invalid owner_disposition/);
});

test("applyRemediationOverlay: A's remediation can never be applied to B's ids and vice versa -- caller passes independent base/remediation pairs, this function only ever overlays a reviewer onto themselves", () => {
  // This is a structural guarantee: the function has no notion of "the
  // other reviewer" at all -- it takes exactly one base set and one
  // remediation set. Calling it twice with swapped inputs proves the two
  // resulting maps are independent (a change to one input never leaks
  // into the other call's output).
  const aBase = [baseRow("r1", "REJECT", null)];
  const bBase = [baseRow("r1", "CONFIRM", "t-b")];
  const aResult = applyRemediationOverlay({ baseDecisions: aBase, remediationDecisions: [], packetIds: new Set(["r1"]) });
  const bResult = applyRemediationOverlay({ baseDecisions: bBase, remediationDecisions: [], packetIds: new Set(["r1"]) });
  assert.equal(aResult.finalById.get("r1").owner_disposition, "REJECT");
  assert.equal(bResult.finalById.get("r1").owner_disposition, "CONFIRM");
});

function packetRow(id, relationType, targetIds) {
  return { relation_candidate_id: id, source_document_id: "src_" + id, relation_type: relationType, candidates: targetIds.map((t) => ({ target_document_id: t, would_cross_author_boundary: false })) };
}
function decided(disposition, target, opts = {}) {
  return { owner_disposition: disposition, confirmed_target_document_id: target, reviewer: opts.reviewer ?? "r", reviewed_at: opts.reviewed_at ?? "d", notes: opts.notes ?? "n", source: opts.source ?? "BASE", considered_target_document_ids: opts.considered ?? [] };
}

test("buildComparisonLedger: both CONFIRM on the same target with a non-TERMINATES type -> PROVISIONAL_CONFIRM, owner_review_required false", () => {
  const packetRows = [packetRow("r1", "AMENDS", ["t1"])];
  const aFinalById = new Map([["r1", decided("CONFIRM", "t1")]]);
  const bFinalById = new Map([["r1", decided("CONFIRM", "t1")]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.equal(row.provisional_disposition, PROVISIONAL_DISPOSITIONS.PROVISIONAL_CONFIRM);
  assert.equal(row.owner_review_required, false);
  assert.equal(row.owner_review_reason, null);
  assert.deepEqual(row.consensus, { owner_disposition: "CONFIRM", confirmed_target_document_id: "t1" });
});

test("buildComparisonLedger: both REJECT -> PROVISIONAL_REJECT, consensus target null", () => {
  const packetRows = [packetRow("r1", "AMENDS", ["t1"])];
  const aFinalById = new Map([["r1", decided("REJECT", null)]]);
  const bFinalById = new Map([["r1", decided("REJECT", null)]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.equal(row.provisional_disposition, PROVISIONAL_DISPOSITIONS.PROVISIONAL_REJECT);
  assert.equal(row.owner_review_required, false);
  assert.deepEqual(row.consensus, { owner_disposition: "REJECT", confirmed_target_document_id: null });
});

test("buildComparisonLedger: differing dispositions -> OWNER_REVIEW_REQUIRED with DISAGREEMENT reason, no consensus", () => {
  const packetRows = [packetRow("r1", "AMENDS", ["t1"])];
  const aFinalById = new Map([["r1", decided("CONFIRM", "t1")]]);
  const bFinalById = new Map([["r1", decided("REJECT", null)]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.equal(row.provisional_disposition, PROVISIONAL_DISPOSITIONS.OWNER_REVIEW_REQUIRED);
  assert.equal(row.owner_review_required, true);
  assert.deepEqual(row.owner_review_reason, [OWNER_REVIEW_REASONS.DISAGREEMENT]);
  assert.equal(row.consensus, null);
});

test("buildComparisonLedger: both CONFIRM but on DIFFERENT targets -> counted as disagreement even though dispositions match", () => {
  const packetRows = [packetRow("r1", "AMENDS", ["t1", "t2"])];
  const aFinalById = new Map([["r1", decided("CONFIRM", "t1")]]);
  const bFinalById = new Map([["r1", decided("CONFIRM", "t2")]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.equal(row.disposition_agrees, true);
  assert.equal(row.target_agrees, false);
  assert.equal(row.owner_review_required, true);
  assert.deepEqual(row.owner_review_reason, [OWNER_REVIEW_REASONS.DISAGREEMENT]);
});

test("buildComparisonLedger: both NEEDS_MORE_REVIEW -> provisional_disposition NEEDS_MORE_REVIEW, owner_review_required true", () => {
  const packetRows = [packetRow("r1", "AMENDS", ["t1"])];
  const aFinalById = new Map([["r1", decided("NEEDS_MORE_REVIEW", null)]]);
  const bFinalById = new Map([["r1", decided("NEEDS_MORE_REVIEW", null)]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.equal(row.provisional_disposition, PROVISIONAL_DISPOSITIONS.NEEDS_MORE_REVIEW);
  assert.equal(row.owner_review_required, true);
  assert.deepEqual(row.owner_review_reason, [OWNER_REVIEW_REASONS.BOTH_NEEDS_MORE_REVIEW]);
});

test("buildComparisonLedger: TERMINATES forces owner_review_required even when both reviewers agree", () => {
  const packetRows = [packetRow("r1", "TERMINATES", ["t1"])];
  const aFinalById = new Map([["r1", decided("CONFIRM", "t1")]]);
  const bFinalById = new Map([["r1", decided("CONFIRM", "t1")]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.equal(row.owner_review_required, true);
  assert.deepEqual(row.owner_review_reason, [OWNER_REVIEW_REASONS.TERMINATES]);
  assert.equal(row.provisional_disposition, PROVISIONAL_DISPOSITIONS.OWNER_REVIEW_REQUIRED);
});

test("buildComparisonLedger: TERMINATES + both NEEDS_MORE_REVIEW carries BOTH reasons (the real 1-row overlap case)", () => {
  const packetRows = [packetRow("r1", "TERMINATES", ["t1"])];
  const aFinalById = new Map([["r1", decided("NEEDS_MORE_REVIEW", null)]]);
  const bFinalById = new Map([["r1", decided("NEEDS_MORE_REVIEW", null)]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.equal(row.owner_review_required, true);
  assert.deepEqual(row.owner_review_reason.slice().sort(), [OWNER_REVIEW_REASONS.BOTH_NEEDS_MORE_REVIEW, OWNER_REVIEW_REASONS.TERMINATES].sort());
});

test("buildComparisonLedger: correction-reference-augmented candidates are surfaced only when a reviewer's considered_target_document_ids adds something beyond the original packet candidates", () => {
  const packetRows = [packetRow("r1", "AMENDS", ["t1"])];
  const aFinalById = new Map([["r1", decided("CONFIRM", "t2", { considered: ["t1", "t2", "t3"] })]]);
  const bFinalById = new Map([["r1", decided("REJECT", null)]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.deepEqual(row.original_candidate_target_document_ids, ["t1"]);
  assert.deepEqual(row.correction_reference_augmented_target_document_ids.slice().sort(), ["t2", "t3"]);
});

test("buildComparisonLedger: no augmentation surfaces null, not an empty array", () => {
  const packetRows = [packetRow("r1", "AMENDS", ["t1"])];
  const aFinalById = new Map([["r1", decided("CONFIRM", "t1")]]);
  const bFinalById = new Map([["r1", decided("CONFIRM", "t1")]]);
  const [row] = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  assert.equal(row.correction_reference_augmented_target_document_ids, null);
});

test("selectOwnerReviewSet: unions and dedups disagreement/both-NMR/TERMINATES, and counts a multi-reason row under every reason it qualifies for", () => {
  const packetRows = [
    packetRow("disagree", "AMENDS", ["t1"]),
    packetRow("both-agree", "AMENDS", ["t1"]),
    packetRow("terminates-agree", "TERMINATES", ["t1"]),
    packetRow("terminates-and-nmr", "TERMINATES", ["t1"]),
  ];
  const aFinalById = new Map([
    ["disagree", decided("CONFIRM", "t1")],
    ["both-agree", decided("REJECT", null)],
    ["terminates-agree", decided("CONFIRM", "t1")],
    ["terminates-and-nmr", decided("NEEDS_MORE_REVIEW", null)],
  ]);
  const bFinalById = new Map([
    ["disagree", decided("REJECT", null)],
    ["both-agree", decided("REJECT", null)],
    ["terminates-agree", decided("CONFIRM", "t1")],
    ["terminates-and-nmr", decided("NEEDS_MORE_REVIEW", null)],
  ]);
  const ledgerRows = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  const owner = selectOwnerReviewSet({ ledgerRows });
  assert.deepEqual(owner.ids.slice().sort(), ["disagree", "terminates-agree", "terminates-and-nmr"].sort());
  assert.equal(owner.count, 3);
  assert.equal(owner.byReason.DISAGREEMENT, 1);
  assert.equal(owner.byReason.TERMINATES, 2);
  assert.equal(owner.byReason.BOTH_NEEDS_MORE_REVIEW, 1);
  assert.equal(owner.multiReasonRows.length, 1);
  assert.equal(owner.multiReasonRows[0].relation_candidate_id, "terminates-and-nmr");
});

test("selectProvisionalSet: excludes every owner-review row, splits the rest by disposition", () => {
  const packetRows = [packetRow("prov-confirm", "AMENDS", ["t1"]), packetRow("prov-reject", "AMENDS", ["t1"]), packetRow("owner", "AMENDS", ["t1"])];
  const aFinalById = new Map([["prov-confirm", decided("CONFIRM", "t1")], ["prov-reject", decided("REJECT", null)], ["owner", decided("CONFIRM", "t1")]]);
  const bFinalById = new Map([["prov-confirm", decided("CONFIRM", "t1")], ["prov-reject", decided("REJECT", null)], ["owner", decided("REJECT", null)]]);
  const ledgerRows = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  const prov = selectProvisionalSet({ ledgerRows });
  assert.deepEqual(prov.ids.slice().sort(), ["prov-confirm", "prov-reject"]);
  assert.equal(prov.byDisposition.PROVISIONAL_CONFIRM, 1);
  assert.equal(prov.byDisposition.PROVISIONAL_REJECT, 1);
});

test("selectStratifiedSample: deterministic -- rerunning against identical input produces byte-identical sample ids in the same order", () => {
  const packetRows = Array.from({ length: 40 }, (_, i) => packetRow("r" + i, "AMENDS", ["t1"]));
  const aFinalById = new Map(packetRows.map((r, i) => [r.relation_candidate_id, decided(i % 2 === 0 ? "CONFIRM" : "REJECT", i % 2 === 0 ? "t1" : null)]));
  const bFinalById = new Map(aFinalById);
  const ledgerRows = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  const packetInfoById = new Map(packetRows.map((r, i) => [r.relation_candidate_id, { corp_code: "corp" + (i % 3), doc_subtype: "sub" + (i % 2) }]));
  const s1 = selectStratifiedSample({ ledgerRows, packetInfoById, perBucket: 5, salt: "test-salt" });
  const s2 = selectStratifiedSample({ ledgerRows, packetInfoById, perBucket: 5, salt: "test-salt" });
  assert.deepEqual(s1, s2);
});

test("selectStratifiedSample: a different salt changes the selection (not hardcoded to one specific set)", () => {
  const packetRows = Array.from({ length: 40 }, (_, i) => packetRow("r" + i, "AMENDS", ["t1"]));
  const aFinalById = new Map(packetRows.map((r, i) => [r.relation_candidate_id, decided(i % 2 === 0 ? "CONFIRM" : "REJECT", i % 2 === 0 ? "t1" : null)]));
  const bFinalById = new Map(aFinalById);
  const ledgerRows = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  const packetInfoById = new Map(packetRows.map((r, i) => [r.relation_candidate_id, { corp_code: "corp" + (i % 3), doc_subtype: "sub" + (i % 2) }]));
  const s1 = selectStratifiedSample({ ledgerRows, packetInfoById, perBucket: 5, salt: "salt-a" });
  const s2 = selectStratifiedSample({ ledgerRows, packetInfoById, perBucket: 5, salt: "salt-b" });
  assert.notDeepEqual(s1.ids, s2.ids);
});

test("selectStratifiedSample: exactly perBucket CONFIRM and perBucket REJECT ids, no overlap, only from the provisional (non-owner-review) set", () => {
  const packetRows = [
    ...Array.from({ length: 10 }, (_, i) => packetRow("c" + i, "AMENDS", ["t1"])),
    ...Array.from({ length: 10 }, (_, i) => packetRow("j" + i, "AMENDS", ["t1"])),
    packetRow("owner1", "TERMINATES", ["t1"]),
  ];
  const aFinalById = new Map([
    ...Array.from({ length: 10 }, (_, i) => ["c" + i, decided("CONFIRM", "t1")]),
    ...Array.from({ length: 10 }, (_, i) => ["j" + i, decided("REJECT", null)]),
    ["owner1", decided("CONFIRM", "t1")],
  ]);
  const bFinalById = new Map(aFinalById);
  const ledgerRows = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  const packetInfoById = new Map(packetRows.map((r) => [r.relation_candidate_id, { corp_code: "c0", doc_subtype: "s0" }]));
  const sample = selectStratifiedSample({ ledgerRows, packetInfoById, perBucket: 4, salt: "s" });
  assert.equal(sample.confirmIds.length, 4);
  assert.equal(sample.rejectIds.length, 4);
  assert.equal(new Set(sample.ids).size, 8);
  assert.ok(sample.ids.every((id) => id !== "owner1"));
});

test("selectStratifiedSample: spreads selection across strata rather than piling onto one company/doc-subtype when alternatives exist", () => {
  const packetRows = Array.from({ length: 12 }, (_, i) => packetRow("r" + i, "AMENDS", ["t1"]));
  const aFinalById = new Map(packetRows.map((r) => [r.relation_candidate_id, decided("CONFIRM", "t1")]));
  const bFinalById = new Map(aFinalById);
  const ledgerRows = buildComparisonLedger({ packetRows, aFinalById, bFinalById });
  // 4 companies x 3 rows each -- a good sample should draw from multiple companies, not exhaust one first.
  const packetInfoById = new Map(packetRows.map((r, i) => [r.relation_candidate_id, { corp_code: "corp" + (i % 4), doc_subtype: "s" }]));
  const sample = selectStratifiedSample({ ledgerRows, packetInfoById, perBucket: 4, salt: "spread-test" });
  const companiesUsed = new Set(sample.confirmIds.map((id) => packetInfoById.get(id).corp_code));
  assert.ok(companiesUsed.size >= 3, `expected the 4 picks to span at least 3 of the 4 companies, got ${companiesUsed.size}`);
});

test("validateSampleAuditRow: PASS with a note is valid and carries no defect fields", () => {
  const result = validateSampleAuditRow({ sample_disposition: "PASS", defect_type: null, defect_possible_impact_scope: null, auditor_note: "확인됨" });
  assert.equal(result.valid, true);
});

test("validateSampleAuditRow: rejects a disposition outside PASS/DEFECT_FOUND/NEEDS_MORE_REVIEW", () => {
  const result = validateSampleAuditRow({ sample_disposition: "CONFIRM", auditor_note: "n" });
  assert.equal(result.valid, false);
  assert.match(result.reason, /PASS\/DEFECT_FOUND\/NEEDS_MORE_REVIEW/);
});

test("validateSampleAuditRow: requires a non-empty auditor_note regardless of disposition", () => {
  const result = validateSampleAuditRow({ sample_disposition: "PASS", auditor_note: "  " });
  assert.equal(result.valid, false);
  assert.match(result.reason, /auditor_note/);
});

test("validateSampleAuditRow: DEFECT_FOUND requires both defect_type and defect_possible_impact_scope", () => {
  const missingType = validateSampleAuditRow({ sample_disposition: "DEFECT_FOUND", defect_possible_impact_scope: "scope", auditor_note: "n" });
  assert.equal(missingType.valid, false);
  assert.match(missingType.reason, /defect_type/);
  const missingScope = validateSampleAuditRow({ sample_disposition: "DEFECT_FOUND", defect_type: "type", auditor_note: "n" });
  assert.equal(missingScope.valid, false);
  assert.match(missingScope.reason, /defect_possible_impact_scope/);
  const complete = validateSampleAuditRow({ sample_disposition: "DEFECT_FOUND", defect_type: "type", defect_possible_impact_scope: "scope", auditor_note: "n" });
  assert.equal(complete.valid, true);
});

test("validateSampleAuditRow: PASS/NEEDS_MORE_REVIEW must NOT carry defect fields", () => {
  const result = validateSampleAuditRow({ sample_disposition: "PASS", defect_type: "type", auditor_note: "n" });
  assert.equal(result.valid, false);
  assert.match(result.reason, /must not carry/);
});

test("SAMPLE_AUDIT_DISPOSITIONS is exactly the 3 allowed values, deliberately distinct from the Owner's own CONFIRM/REJECT/NEEDS_MORE_REVIEW vocabulary", () => {
  assert.deepEqual(SAMPLE_AUDIT_DISPOSITIONS, ["PASS", "DEFECT_FOUND", "NEEDS_MORE_REVIEW"]);
  assert.ok(!SAMPLE_AUDIT_DISPOSITIONS.includes("CONFIRM"));
  assert.ok(!SAMPLE_AUDIT_DISPOSITIONS.includes("REJECT"));
});

// -- Turn N4.4: validateSampleAuditorDecision (the richer UI-level schema) --

test("validateSampleAuditorDecision: PASS with a note is valid and carries no defect fields", () => {
  const result = validateSampleAuditorDecision({ audit_disposition: "PASS", audit_note: "확인함" });
  assert.equal(result.valid, true);
});

test("validateSampleAuditorDecision: NEEDS_MORE_REVIEW with a note is valid, no defect fields required", () => {
  const result = validateSampleAuditorDecision({ audit_disposition: "NEEDS_MORE_REVIEW", audit_note: "추가 확인 필요" });
  assert.equal(result.valid, true);
});

test("validateSampleAuditorDecision: requires audit_note regardless of disposition", () => {
  const result = validateSampleAuditorDecision({ audit_disposition: "PASS", audit_note: "" });
  assert.equal(result.valid, false);
  assert.match(result.reason, /audit_note/);
});

test("validateSampleAuditorDecision: DEFECT_FOUND requires a valid defect_type from the fixed list", () => {
  const bad = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: "SOMETHING_ELSE", defect_description: "d", expected_disposition: "REJECT", affected_scope_estimate: "s" });
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /defect_type/);
  for (const dt of DEFECT_TYPES) {
    const ok = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: dt, defect_description: "d", expected_disposition: "REJECT", affected_scope_estimate: "s" });
    assert.equal(ok.valid, true, `defect_type ${dt} should be accepted`);
  }
});

test("validateSampleAuditorDecision: DEFECT_FOUND requires defect_description, expected_disposition, and affected_scope_estimate", () => {
  const missingDesc = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: "WRONG_TARGET", expected_disposition: "REJECT", affected_scope_estimate: "s" });
  assert.equal(missingDesc.valid, false);
  assert.match(missingDesc.reason, /defect_description/);
  const missingExpected = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: "WRONG_TARGET", defect_description: "d", affected_scope_estimate: "s" });
  assert.equal(missingExpected.valid, false);
  assert.match(missingExpected.reason, /expected_disposition/);
  const missingScope = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: "WRONG_TARGET", defect_description: "d", expected_disposition: "REJECT" });
  assert.equal(missingScope.valid, false);
  assert.match(missingScope.reason, /affected_scope_estimate/);
});

test("validateSampleAuditorDecision: expected_disposition CONFIRM requires expected_target_document_id that is one of the row's own candidates", () => {
  const noTarget = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: "WRONG_TARGET", defect_description: "d", expected_disposition: "CONFIRM", affected_scope_estimate: "s" });
  assert.equal(noTarget.valid, false);
  assert.match(noTarget.reason, /expected_target_document_id/);
  const fabricated = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: "WRONG_TARGET", defect_description: "d", expected_disposition: "CONFIRM", expected_target_document_id: "not-a-real-candidate", affected_scope_estimate: "s", candidateIds: ["t1", "t2"] });
  assert.equal(fabricated.valid, false);
  const valid = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: "WRONG_TARGET", defect_description: "d", expected_disposition: "CONFIRM", expected_target_document_id: "t1", affected_scope_estimate: "s", candidateIds: ["t1", "t2"] });
  assert.equal(valid.valid, true);
});

test("validateSampleAuditorDecision: expected_disposition REJECT/NEEDS_MORE_REVIEW must NOT carry expected_target_document_id", () => {
  const result = validateSampleAuditorDecision({ audit_disposition: "DEFECT_FOUND", audit_note: "n", defect_type: "WRONG_TARGET", defect_description: "d", expected_disposition: "REJECT", expected_target_document_id: "t1", affected_scope_estimate: "s" });
  assert.equal(result.valid, false);
  assert.match(result.reason, /must not carry expected_target_document_id/);
});

test("validateSampleAuditorDecision: PASS/NEEDS_MORE_REVIEW must not carry ANY defect field", () => {
  const result = validateSampleAuditorDecision({ audit_disposition: "PASS", audit_note: "n", defect_type: "WRONG_TARGET" });
  assert.equal(result.valid, false);
  assert.match(result.reason, /must not carry defect fields/);
});

test("computeSampleAuditGateStatus: all PASS -> COMPLETED_NO_DEFECT", () => {
  const decisions = Array.from({ length: 30 }, () => ({ audit_disposition: "PASS" }));
  assert.equal(computeSampleAuditGateStatus(decisions), SAMPLE_AUDIT_GATE_STATUSES.COMPLETED_NO_DEFECT);
});

test("computeSampleAuditGateStatus: any NEEDS_MORE_REVIEW (no DEFECT_FOUND) -> ADDITIONAL_REVIEW_REQUIRED", () => {
  const decisions = [{ audit_disposition: "PASS" }, { audit_disposition: "NEEDS_MORE_REVIEW" }];
  assert.equal(computeSampleAuditGateStatus(decisions), SAMPLE_AUDIT_GATE_STATUSES.ADDITIONAL_REVIEW_REQUIRED);
});

test("computeSampleAuditGateStatus: any DEFECT_FOUND -> DEFECT_FOUND, even alongside NEEDS_MORE_REVIEW (the more conservative status wins)", () => {
  const decisions = [{ audit_disposition: "PASS" }, { audit_disposition: "NEEDS_MORE_REVIEW" }, { audit_disposition: "DEFECT_FOUND" }];
  assert.equal(computeSampleAuditGateStatus(decisions), SAMPLE_AUDIT_GATE_STATUSES.DEFECT_FOUND);
});

// -- Turn N4.4: validateSampleAuditInputs (the 7 preconditions) -----------

function sampleRowFixture(id, family) {
  return { relation_candidate_id: id, expected_disposition_family: family };
}

test("validateSampleAuditInputs: valid input (30 rows, 15/15, all in ledger, none overlapping Owner) passes", () => {
  const samplePacketRows = [
    ...Array.from({ length: 15 }, (_, i) => sampleRowFixture("c" + i, "PROVISIONAL_CONFIRM")),
    ...Array.from({ length: 15 }, (_, i) => sampleRowFixture("j" + i, "PROVISIONAL_REJECT")),
  ];
  const ledgerRows = samplePacketRows.map((r) => ({ relation_candidate_id: r.relation_candidate_id }));
  const result = validateSampleAuditInputs({ samplePacketRows, ledgerRows, ownerPacketIds: new Set(["owner1"]) });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateSampleAuditInputs: fails closed when row count is not exactly 30", () => {
  const samplePacketRows = [sampleRowFixture("c0", "PROVISIONAL_CONFIRM")];
  const result = validateSampleAuditInputs({ samplePacketRows, ledgerRows: samplePacketRows, ownerPacketIds: new Set() });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /expected exactly 30/);
});

test("validateSampleAuditInputs: fails closed on duplicate relation_candidate_id", () => {
  const samplePacketRows = [
    ...Array.from({ length: 14 }, (_, i) => sampleRowFixture("c" + i, "PROVISIONAL_CONFIRM")),
    sampleRowFixture("c0", "PROVISIONAL_CONFIRM"), // duplicate
    ...Array.from({ length: 15 }, (_, i) => sampleRowFixture("j" + i, "PROVISIONAL_REJECT")),
  ];
  const result = validateSampleAuditInputs({ samplePacketRows, ledgerRows: samplePacketRows, ownerPacketIds: new Set() });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /duplicate/);
});

test("validateSampleAuditInputs: fails closed when CONFIRM/REJECT counts are not exactly 15/15", () => {
  const samplePacketRows = [
    ...Array.from({ length: 16 }, (_, i) => sampleRowFixture("c" + i, "PROVISIONAL_CONFIRM")),
    ...Array.from({ length: 14 }, (_, i) => sampleRowFixture("j" + i, "PROVISIONAL_REJECT")),
  ];
  const result = validateSampleAuditInputs({ samplePacketRows, ledgerRows: samplePacketRows, ownerPacketIds: new Set() });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /PROVISIONAL_CONFIRM count is 16/);
  assert.match(result.errors.join(";"), /PROVISIONAL_REJECT count is 14/);
});

test("validateSampleAuditInputs: fails closed when a sample row id is missing from the 326-row ledger", () => {
  const samplePacketRows = [
    ...Array.from({ length: 15 }, (_, i) => sampleRowFixture("c" + i, "PROVISIONAL_CONFIRM")),
    ...Array.from({ length: 15 }, (_, i) => sampleRowFixture("j" + i, "PROVISIONAL_REJECT")),
  ];
  const ledgerRows = samplePacketRows.slice(1).map((r) => ({ relation_candidate_id: r.relation_candidate_id })); // drop c0
  const result = validateSampleAuditInputs({ samplePacketRows, ledgerRows, ownerPacketIds: new Set() });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /not present in the 326-row ledger/);
});

test("validateSampleAuditInputs: fails closed when a sample row id overlaps the 29-row Owner review set", () => {
  const samplePacketRows = [
    ...Array.from({ length: 15 }, (_, i) => sampleRowFixture("c" + i, "PROVISIONAL_CONFIRM")),
    ...Array.from({ length: 15 }, (_, i) => sampleRowFixture("j" + i, "PROVISIONAL_REJECT")),
  ];
  const ledgerRows = samplePacketRows.map((r) => ({ relation_candidate_id: r.relation_candidate_id }));
  const result = validateSampleAuditInputs({ samplePacketRows, ledgerRows, ownerPacketIds: new Set(["c0"]) });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /overlap with the 29-row Owner review set/);
});

// -- Turn N4.5: validateDualAuditInputs / buildAuditComparisonLedger / --
// -- selectAuditConflicts / detectMultiStepCorrectionRisk ---------------

function auditorRow(id, disposition, opts = {}) {
  return {
    audit_item_id: "audit_item_" + id, relation_candidate_id: id, auditor_role: opts.auditor_role ?? "SAMPLE_AUDITOR",
    original_provisional_disposition: opts.original_provisional_disposition ?? "PROVISIONAL_REJECT",
    original_confirmed_target_document_id: opts.original_confirmed_target_document_id ?? null,
    audit_disposition: disposition, audit_note: opts.audit_note ?? "note",
    defect_type: disposition === "DEFECT_FOUND" ? (opts.defect_type ?? "WRONG_TARGET") : null,
    defect_description: disposition === "DEFECT_FOUND" ? (opts.defect_description ?? "desc") : null,
    expected_disposition: disposition === "DEFECT_FOUND" ? (opts.expected_disposition ?? "REJECT") : null,
    expected_target_document_id: disposition === "DEFECT_FOUND" ? (opts.expected_target_document_id ?? null) : null,
    affected_scope_estimate: disposition === "DEFECT_FOUND" ? (opts.affected_scope_estimate ?? "scope") : null,
    source_document_id: opts.source_document_id ?? ("src_" + id),
    sample_packet_sha256: opts.sample_packet_sha256 ?? "PSHA",
    comparison_ledger_sha256: opts.comparison_ledger_sha256 ?? "LSHA",
    reviewed_at: opts.reviewed_at ?? "2026-01-01T00:00:00Z",
  };
}

function make30(disposition, opts = {}) {
  return Array.from({ length: 30 }, (_, i) => auditorRow("r" + i, disposition, opts));
}

test("validateDualAuditInputs: two well-formed 30-row results covering the same ids pass", () => {
  const samplePacketIds = new Set(Array.from({ length: 30 }, (_, i) => "r" + i));
  const result = validateDualAuditInputs({
    auditorARows: make30("PASS"), auditorBRows: make30("PASS"),
    samplePacketIds, expectedSamplePacketSha256: "PSHA", expectedLedgerSha256: "LSHA",
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateDualAuditInputs: fails closed when an auditor's row count is not 30", () => {
  const samplePacketIds = new Set(Array.from({ length: 30 }, (_, i) => "r" + i));
  const result = validateDualAuditInputs({
    auditorARows: make30("PASS").slice(0, 29), auditorBRows: make30("PASS"),
    samplePacketIds, expectedSamplePacketSha256: "PSHA", expectedLedgerSha256: "LSHA",
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /auditor A: expected exactly 30/);
});

test("validateDualAuditInputs: fails closed on a duplicate relation_candidate_id within one auditor's result", () => {
  const samplePacketIds = new Set(Array.from({ length: 30 }, (_, i) => "r" + i));
  const dupRows = make30("PASS").slice(0, 29).concat([auditorRow("r0", "PASS")]);
  const result = validateDualAuditInputs({ auditorARows: dupRows, auditorBRows: make30("PASS"), samplePacketIds, expectedSamplePacketSha256: "PSHA", expectedLedgerSha256: "LSHA" });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /duplicate/);
});

test("validateDualAuditInputs: fails closed when packet or ledger SHA cited on a row does not match the expected value", () => {
  const samplePacketIds = new Set(Array.from({ length: 30 }, (_, i) => "r" + i));
  const wrongSha = make30("PASS", { sample_packet_sha256: "WRONG" });
  const result = validateDualAuditInputs({ auditorARows: wrongSha, auditorBRows: make30("PASS"), samplePacketIds, expectedSamplePacketSha256: "PSHA", expectedLedgerSha256: "LSHA" });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /sample_packet_sha256/);
});

test("validateDualAuditInputs: fails closed on auditor_role other than SAMPLE_AUDITOR", () => {
  const samplePacketIds = new Set(Array.from({ length: 30 }, (_, i) => "r" + i));
  const wrongRole = make30("PASS", { auditor_role: "OWNER" });
  const result = validateDualAuditInputs({ auditorARows: wrongRole, auditorBRows: make30("PASS"), samplePacketIds, expectedSamplePacketSha256: "PSHA", expectedLedgerSha256: "LSHA" });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /auditor_role must be uniformly SAMPLE_AUDITOR/);
});

test("validateDualAuditInputs: fails closed on an empty audit_note", () => {
  const samplePacketIds = new Set(Array.from({ length: 30 }, (_, i) => "r" + i));
  const emptyNote = make30("PASS", { audit_note: "" });
  const result = validateDualAuditInputs({ auditorARows: emptyNote, auditorBRows: make30("PASS"), samplePacketIds, expectedSamplePacketSha256: "PSHA", expectedLedgerSha256: "LSHA" });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(";"), /empty audit_note/);
});

test("validateDualAuditInputs: fails closed on an invalid disposition or an incomplete DEFECT_FOUND row", () => {
  const samplePacketIds = new Set(Array.from({ length: 30 }, (_, i) => "r" + i));
  const badDisp = make30("PASS").slice(0, 29).concat([{ ...auditorRow("r29", "SOMETHING_ELSE") }]);
  const r1 = validateDualAuditInputs({ auditorARows: badDisp, auditorBRows: make30("PASS"), samplePacketIds, expectedSamplePacketSha256: "PSHA", expectedLedgerSha256: "LSHA" });
  assert.equal(r1.valid, false);
  assert.match(r1.errors.join(";"), /invalid audit_disposition/);

  const incompleteDefect = make30("PASS").slice(0, 29).concat([{ ...auditorRow("r29", "DEFECT_FOUND"), defect_type: null }]);
  const r2 = validateDualAuditInputs({ auditorARows: incompleteDefect, auditorBRows: make30("PASS"), samplePacketIds, expectedSamplePacketSha256: "PSHA", expectedLedgerSha256: "LSHA" });
  assert.equal(r2.valid, false);
  assert.match(r2.errors.join(";"), /invalid\/missing defect_type/);
});

function samplePacketRowFixture(id, disposition, target) {
  return { relation_candidate_id: id, source_document_id: "src_" + id, relation_type: "AMENDS", provisional_disposition: disposition, consensus: { owner_disposition: disposition === "PROVISIONAL_CONFIRM" ? "CONFIRM" : "REJECT", confirmed_target_document_id: target } };
}
function ledgerRowFixture(id, originalIds, augmentedIds) {
  return { relation_candidate_id: id, original_candidate_target_document_ids: originalIds, correction_reference_augmented_target_document_ids: augmentedIds ?? null };
}

test("buildAuditComparisonLedger: both PASS -> DUAL_AUDIT_PASS, no owner review needed", () => {
  const samplePacketRows = [samplePacketRowFixture("r0", "PROVISIONAL_CONFIRM", "t1")];
  const ledgerRowsById = new Map([["r0", ledgerRowFixture("r0", ["t1"])]]);
  const [row] = buildAuditComparisonLedger({ samplePacketRows, ledgerRowsById, auditorARows: [auditorRow("r0", "PASS")], auditorBRows: [auditorRow("r0", "PASS")] });
  assert.equal(row.final_status, AUDIT_FINAL_STATUSES.DUAL_AUDIT_PASS);
  assert.equal(row.owner_review_required, false);
  assert.equal(row.audit_agreement, true);
});

test("buildAuditComparisonLedger: A DEFECT_FOUND + B PASS -> AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED, no target auto-selected", () => {
  const samplePacketRows = [samplePacketRowFixture("r0", "PROVISIONAL_REJECT", null)];
  const ledgerRowsById = new Map([["r0", ledgerRowFixture("r0", ["t1", "t2"])]]);
  const a = auditorRow("r0", "DEFECT_FOUND", { expected_disposition: "CONFIRM", expected_target_document_id: "t2" });
  const b = auditorRow("r0", "PASS");
  const [row] = buildAuditComparisonLedger({ samplePacketRows, ledgerRowsById, auditorARows: [a], auditorBRows: [b] });
  assert.equal(row.final_status, AUDIT_FINAL_STATUSES.AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED);
  assert.equal(row.owner_review_required, true);
  assert.equal(row.audit_agreement, false);
  assert.equal(row.auditor_a_expected_target, "t2");
  assert.equal(row.auditor_b_expected_target, null);
});

test("buildAuditComparisonLedger: both DEFECT_FOUND with the SAME expected target -> DUAL_AUDIT_DEFECT_AGREEMENT (still owner_review_required, never auto-applied)", () => {
  const samplePacketRows = [samplePacketRowFixture("r0", "PROVISIONAL_REJECT", null)];
  const ledgerRowsById = new Map([["r0", ledgerRowFixture("r0", ["t1"])]]);
  const a = auditorRow("r0", "DEFECT_FOUND", { expected_disposition: "CONFIRM", expected_target_document_id: "t1" });
  const b = auditorRow("r0", "DEFECT_FOUND", { expected_disposition: "CONFIRM", expected_target_document_id: "t1" });
  const [row] = buildAuditComparisonLedger({ samplePacketRows, ledgerRowsById, auditorARows: [a], auditorBRows: [b] });
  assert.equal(row.final_status, AUDIT_FINAL_STATUSES.DUAL_AUDIT_DEFECT_AGREEMENT);
  assert.equal(row.owner_review_required, true);
});

test("buildAuditComparisonLedger: both DEFECT_FOUND with DIFFERENT expected targets -> AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED", () => {
  const samplePacketRows = [samplePacketRowFixture("r0", "PROVISIONAL_REJECT", null)];
  const ledgerRowsById = new Map([["r0", ledgerRowFixture("r0", ["t1", "t2"])]]);
  const a = auditorRow("r0", "DEFECT_FOUND", { expected_disposition: "CONFIRM", expected_target_document_id: "t1" });
  const b = auditorRow("r0", "DEFECT_FOUND", { expected_disposition: "CONFIRM", expected_target_document_id: "t2" });
  const [row] = buildAuditComparisonLedger({ samplePacketRows, ledgerRowsById, auditorARows: [a], auditorBRows: [b] });
  assert.equal(row.final_status, AUDIT_FINAL_STATUSES.AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED);
});

test("buildAuditComparisonLedger: both NEEDS_MORE_REVIEW -> ADDITIONAL_REVIEW_REQUIRED", () => {
  const samplePacketRows = [samplePacketRowFixture("r0", "PROVISIONAL_REJECT", null)];
  const ledgerRowsById = new Map([["r0", ledgerRowFixture("r0", [])]]);
  const [row] = buildAuditComparisonLedger({ samplePacketRows, ledgerRowsById, auditorARows: [auditorRow("r0", "NEEDS_MORE_REVIEW")], auditorBRows: [auditorRow("r0", "NEEDS_MORE_REVIEW")] });
  assert.equal(row.final_status, AUDIT_FINAL_STATUSES.ADDITIONAL_REVIEW_REQUIRED);
  assert.equal(row.owner_review_required, true);
});

test("selectAuditConflicts: returns exactly the owner_review_required rows", () => {
  const samplePacketRows = [samplePacketRowFixture("pass", "PROVISIONAL_CONFIRM", "t1"), samplePacketRowFixture("conflict", "PROVISIONAL_REJECT", null)];
  const ledgerRowsById = new Map([["pass", ledgerRowFixture("pass", ["t1"])], ["conflict", ledgerRowFixture("conflict", ["t1"])]]);
  const auditorARows = [auditorRow("pass", "PASS"), auditorRow("conflict", "DEFECT_FOUND", { expected_disposition: "CONFIRM", expected_target_document_id: "t1" })];
  const auditorBRows = [auditorRow("pass", "PASS"), auditorRow("conflict", "PASS")];
  const ledgerRows = buildAuditComparisonLedger({ samplePacketRows, ledgerRowsById, auditorARows, auditorBRows });
  const conflicts = selectAuditConflicts({ auditComparisonLedgerRows: ledgerRows });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].relation_candidate_id, "conflict");
});

// -- detectMultiStepCorrectionRisk ---------------------------------------

function rejectRow(id, sourceId, originalIds, relationType = "AMENDS") {
  return { relation_candidate_id: id, source_document_id: sourceId, relation_type: relationType, provisional_disposition: "PROVISIONAL_REJECT", original_candidate_target_document_ids: originalIds };
}

test("detectMultiStepCorrectionRisk: flags a row whose correction-reference status is not MATCHED_IN_CORPUS AND already has a non-empty candidate list", () => {
  const rows = [rejectRow("r0", "src0", ["cand1"])];
  const corrRefBySource = new Map([["src0", { reference_status: "TARGET_NOT_IN_CORPUS", referenced_receipt_date: "2021-01-01" }]]);
  const flagged = detectMultiStepCorrectionRisk({ unauditedRejectRows: rows, correctionReferenceBySource: corrRefBySource });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].relation_candidate_id, "r0");
  assert.deepEqual(flagged[0].continuity_signals, ["PARSER_UNCERTAIN"]);
  assert.equal(flagged[0].review_status, "PENDING");
});

test("detectMultiStepCorrectionRisk: does NOT flag a row whose correction-reference status IS MATCHED_IN_CORPUS", () => {
  const rows = [rejectRow("r0", "src0", ["cand1"])];
  const corrRefBySource = new Map([["src0", { reference_status: "MATCHED_IN_CORPUS", referenced_receipt_date: "2021-01-01" }]]);
  const flagged = detectMultiStepCorrectionRisk({ unauditedRejectRows: rows, correctionReferenceBySource: corrRefBySource });
  assert.equal(flagged.length, 0);
});

test("detectMultiStepCorrectionRisk: does NOT flag a row with an empty candidate list, even if status is not MATCHED_IN_CORPUS (condition 4+5 fails)", () => {
  const rows = [rejectRow("r0", "src0", [])];
  const corrRefBySource = new Map([["src0", { reference_status: "TARGET_NOT_IN_CORPUS", referenced_receipt_date: "2021-01-01" }]]);
  const flagged = detectMultiStepCorrectionRisk({ unauditedRejectRows: rows, correctionReferenceBySource: corrRefBySource });
  assert.equal(flagged.length, 0);
});

test("detectMultiStepCorrectionRisk: a row with NO correction-reference record at all is NOT silently dropped -- flagged PARSER_UNCERTAIN", () => {
  const rows = [rejectRow("r0", "src-no-record", ["cand1"])];
  const flagged = detectMultiStepCorrectionRisk({ unauditedRejectRows: rows, correctionReferenceBySource: new Map() });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].risk_reason, "NO_CORRECTION_REFERENCE_RECORD_AVAILABLE_FOR_THIS_DOC_GROUP");
  assert.deepEqual(flagged[0].continuity_signals, ["PARSER_UNCERTAIN"]);
});

test("detectMultiStepCorrectionRisk: never flags TERMINATES or PROVISIONAL_CONFIRM rows (conditions 1/2 enforced, not assumed)", () => {
  const rows = [
    rejectRow("terminates", "src1", ["c1"], "TERMINATES"),
    { relation_candidate_id: "confirm", source_document_id: "src2", relation_type: "AMENDS", provisional_disposition: "PROVISIONAL_CONFIRM", original_candidate_target_document_ids: ["c2"] },
  ];
  const corrRefBySource = new Map([["src1", { reference_status: "TARGET_NOT_IN_CORPUS" }], ["src2", { reference_status: "TARGET_NOT_IN_CORPUS" }]]);
  const flagged = detectMultiStepCorrectionRisk({ unauditedRejectRows: rows, correctionReferenceBySource: corrRefBySource });
  assert.equal(flagged.length, 0);
});

test("detectMultiStepCorrectionRisk: uses only general fields -- the same detection function run on two different rows with unrelated ids/companies produces analogous flags (no per-id hardcoding)", () => {
  const rows = [rejectRow("id_A_totally_different", "src_A", ["candA"]), rejectRow("id_B_unrelated_company", "src_B", ["candB"])];
  const corrRefBySource = new Map([
    ["src_A", { reference_status: "AMBIGUOUS", referenced_receipt_date: "2020-05-01" }],
    ["src_B", { reference_status: "TARGET_NOT_IN_CORPUS", referenced_receipt_date: "2019-03-01" }],
  ]);
  const flagged = detectMultiStepCorrectionRisk({ unauditedRejectRows: rows, correctionReferenceBySource: corrRefBySource });
  assert.equal(flagged.length, 2);
});

test("detectMultiStepCorrectionRisk: returns an empty array (not fabricated rows) when nothing matches", () => {
  const rows = [rejectRow("r0", "src0", ["cand1"])];
  const corrRefBySource = new Map([["src0", { reference_status: "MATCHED_IN_CORPUS" }]]);
  const flagged = detectMultiStepCorrectionRisk({ unauditedRejectRows: rows, correctionReferenceBySource: corrRefBySource });
  assert.deepEqual(flagged, []);
});
