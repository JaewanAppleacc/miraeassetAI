// Turn N4.11: synthetic-fixture unit tests for
// domain/evaluation/relation-closure-prospective-consensus-graph.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyReviewerDecisionSet,
  compareReviewerAgreement,
  buildProspectiveGraph,
  selectProspectiveCandidates,
} from "../domain/evaluation/relation-closure-prospective-consensus-graph.mjs";

function decision({ id, role, disposition, target = null, considered = [], note = "note" }) {
  return { relation_candidate_id: id, reviewer_role: role, owner_disposition: disposition, confirmed_target_document_id: target, considered_target_document_ids: considered, note, input_packet_sha256: "PKT_SHA" };
}
function packetRow({ id, source, sourceComponent, candidates }) {
  return { relation_candidate_id: id, source_document_id: source, source_component_id: sourceComponent, candidates: candidates.map((c) => ({ target_document_id: c.target, target_component_id: c.targetComponent ?? null, score: c.score ?? 0.3 })) };
}
function ledgerRow({ id, authority, disposition, confirmedTarget = null }) {
  return { relation_candidate_id: id, decision_authority: authority, final_disposition: disposition, confirmed_target_document_id: confirmedTarget };
}

// -- verifyReviewerDecisionSet ----------------------------------------------
test("verifyReviewerDecisionSet: a clean 2-row set passes with zero violations", () => {
  const packetById = new Map([
    ["r1", { candidates: [{ target_document_id: "t1" }, { target_document_id: "t2" }] }],
    ["r2", { candidates: [{ target_document_id: "t3" }] }],
  ]);
  const decisions = [
    decision({ id: "r1", role: "REVIEWER_E", disposition: "CONFIRM", target: "t1", considered: ["t1", "t2"] }),
    decision({ id: "r2", role: "REVIEWER_E", disposition: "REJECT", considered: ["t3"] }),
  ];
  const result = verifyReviewerDecisionSet({ decisions, expectedRelationCandidateIds: ["r1", "r2"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test("verifyReviewerDecisionSet: catches duplicate id, missing id, extra id, wrong row count", () => {
  const packetById = new Map([["r1", { candidates: [{ target_document_id: "t1" }] }]]);
  const decisions = [
    decision({ id: "r1", role: "REVIEWER_E", disposition: "REJECT", considered: ["t1"] }),
    decision({ id: "r1", role: "REVIEWER_E", disposition: "REJECT", considered: ["t1"] }),
    decision({ id: "r_extra", role: "REVIEWER_E", disposition: "REJECT", considered: [] }),
  ];
  const result = verifyReviewerDecisionSet({ decisions, expectedRelationCandidateIds: ["r1", "r2"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.equal(result.ok, false);
  const types = result.violations.map((v) => v.type);
  assert.ok(types.includes("ROW_COUNT_MISMATCH"));
  assert.ok(types.includes("DUPLICATE_RELATION_CANDIDATE_ID"));
  assert.ok(types.includes("MISSING_RELATION_CANDIDATE_IDS"));
  assert.ok(types.includes("UNEXPECTED_EXTRA_RELATION_CANDIDATE_IDS"));
});

test("verifyReviewerDecisionSet: catches disallowed disposition, CONFIRM target not in considered set, CONFIRM target not a real packet candidate, non-CONFIRM row with a target, empty note, packet sha mismatch, role mismatch", () => {
  const packetById = new Map([["r1", { candidates: [{ target_document_id: "t1" }] }]]);
  const decisions = [
    decision({ id: "r1", role: "REVIEWER_E", disposition: "MAYBE", considered: ["t1"] }),
  ];
  const r1 = verifyReviewerDecisionSet({ decisions, expectedRelationCandidateIds: ["r1"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.ok(r1.violations.some((v) => v.type === "DISALLOWED_DISPOSITION"));

  const d2 = decision({ id: "r1", role: "REVIEWER_E", disposition: "CONFIRM", target: "t_not_considered", considered: ["t1"] });
  const r2 = verifyReviewerDecisionSet({ decisions: [d2], expectedRelationCandidateIds: ["r1"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.ok(r2.violations.some((v) => v.type === "CONFIRM_TARGET_NOT_IN_CONSIDERED_SET"));

  const d3 = decision({ id: "r1", role: "REVIEWER_E", disposition: "CONFIRM", target: "t_fake", considered: ["t_fake"] });
  const r3 = verifyReviewerDecisionSet({ decisions: [d3], expectedRelationCandidateIds: ["r1"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.ok(r3.violations.some((v) => v.type === "CONFIRM_TARGET_NOT_A_REAL_PACKET_CANDIDATE"));

  const d4 = decision({ id: "r1", role: "REVIEWER_E", disposition: "REJECT", target: "t1", considered: ["t1"] });
  const r4 = verifyReviewerDecisionSet({ decisions: [d4], expectedRelationCandidateIds: ["r1"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.ok(r4.violations.some((v) => v.type === "NON_CONFIRM_ROW_HAS_TARGET"));

  const d5 = decision({ id: "r1", role: "REVIEWER_E", disposition: "REJECT", note: "   ", considered: ["t1"] });
  const r5 = verifyReviewerDecisionSet({ decisions: [d5], expectedRelationCandidateIds: ["r1"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.ok(r5.violations.some((v) => v.type === "EMPTY_NOTE"));

  const d6 = { ...decision({ id: "r1", role: "REVIEWER_E", disposition: "REJECT", considered: ["t1"] }), input_packet_sha256: "WRONG" };
  const r6 = verifyReviewerDecisionSet({ decisions: [d6], expectedRelationCandidateIds: ["r1"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.ok(r6.violations.some((v) => v.type === "PACKET_SHA_MISMATCH"));

  const d7 = decision({ id: "r1", role: "REVIEWER_F", disposition: "REJECT", considered: ["t1"] });
  const r7 = verifyReviewerDecisionSet({ decisions: [d7], expectedRelationCandidateIds: ["r1"], expectedPacketSha256: "PKT_SHA", expectedReviewerRole: "REVIEWER_E", packetById });
  assert.ok(r7.violations.some((v) => v.type === "REVIEWER_ROLE_MISMATCH"));
});

// -- compareReviewerAgreement -------------------------------------------
test("compareReviewerAgreement: full agreement on disposition AND target across all rows", () => {
  const eDecisions = [decision({ id: "r1", role: "REVIEWER_E", disposition: "CONFIRM", target: "t1", considered: ["t1"] }), decision({ id: "r2", role: "REVIEWER_E", disposition: "REJECT", considered: ["t2"] })];
  const fDecisions = [decision({ id: "r1", role: "REVIEWER_F", disposition: "CONFIRM", target: "t1", considered: ["t1"] }), decision({ id: "r2", role: "REVIEWER_F", disposition: "REJECT", considered: ["t2"] })];
  const result = compareReviewerAgreement({ eDecisions, fDecisions });
  assert.equal(result.exactAgreementCount, 2);
  assert.equal(result.disagreementCount, 0);
  assert.deepEqual(result.distribution, { CONFIRM: 1, REJECT: 1, NEEDS_MORE_REVIEW: 0 });
});

test("compareReviewerAgreement: same disposition but DIFFERENT target is a disagreement, never silently treated as agreement", () => {
  const eDecisions = [decision({ id: "r1", role: "REVIEWER_E", disposition: "CONFIRM", target: "tA", considered: ["tA", "tB"] })];
  const fDecisions = [decision({ id: "r1", role: "REVIEWER_F", disposition: "CONFIRM", target: "tB", considered: ["tA", "tB"] })];
  const result = compareReviewerAgreement({ eDecisions, fDecisions });
  assert.equal(result.exactAgreementCount, 0);
  assert.equal(result.disagreementCount, 1);
  assert.equal(result.rows[0].consensus_disposition, null);
});

test("compareReviewerAgreement: different disposition entirely is a disagreement", () => {
  const eDecisions = [decision({ id: "r1", role: "REVIEWER_E", disposition: "CONFIRM", target: "tA", considered: ["tA"] })];
  const fDecisions = [decision({ id: "r1", role: "REVIEWER_F", disposition: "REJECT", considered: ["tA"] })];
  const result = compareReviewerAgreement({ eDecisions, fDecisions });
  assert.equal(result.disagreementCount, 1);
});

// -- buildProspectiveGraph / selectProspectiveCandidates -----------------
test("selectProspectiveCandidates: a Wave-1 CONFIRM consensus produces exactly the ONE consensus-target edge, even though the packet lists other candidates", () => {
  const row = packetRow({ id: "w1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }, { target: "C", targetComponent: "compC" }] });
  const consensusMap = new Map([["w1", { consensus_disposition: "CONFIRM", consensus_target_document_id: "B" }]]);
  const selected = selectProspectiveCandidates({ packetRow: row, ledgerRow: ledgerRow({ id: "w1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }), consensusByRelationCandidateId: consensusMap });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].target_document_id, "B");
});

test("selectProspectiveCandidates: a Wave-1 REJECT consensus produces ZERO edges", () => {
  const row = packetRow({ id: "w1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] });
  const consensusMap = new Map([["w1", { consensus_disposition: "REJECT", consensus_target_document_id: null }]]);
  const selected = selectProspectiveCandidates({ packetRow: row, ledgerRow: ledgerRow({ id: "w1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }), consensusByRelationCandidateId: consensusMap });
  assert.deepEqual(selected, []);
});

test("selectProspectiveCandidates: a non-Wave-1 row falls through UNCHANGED to the real N4.9 rule (Owner REJECT still zero edges, provisional still all candidates)", () => {
  const rejectRow = packetRow({ id: "other-reject", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] });
  const rejectLedger = ledgerRow({ id: "other-reject", authority: "OWNER_V03", disposition: "REJECT" });
  const selectedReject = selectProspectiveCandidates({ packetRow: rejectRow, ledgerRow: rejectLedger, consensusByRelationCandidateId: new Map() });
  assert.deepEqual(selectedReject, []);

  const provRow = packetRow({ id: "other-prov", source: "C", sourceComponent: "compC", candidates: [{ target: "D", targetComponent: "compD" }, { target: "E", targetComponent: "compE" }] });
  const provLedger = ledgerRow({ id: "other-prov", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" });
  const selectedProv = selectProspectiveCandidates({ packetRow: provRow, ledgerRow: provLedger, consensusByRelationCandidateId: new Map() });
  assert.equal(selectedProv.length, 2);
});

test("buildProspectiveGraph: a Priority Wave 1 CONFIRM overlay creates the consensus edge, and untouched provisional rows still merge via ALL their candidates", () => {
  const packetRows = [
    packetRow({ id: "w1", source: "wA", sourceComponent: "compWA", candidates: [{ target: "wB", targetComponent: "compWB" }, { target: "wC", targetComponent: "compWC" }] }),
    packetRow({ id: "other-prov", source: "oA", sourceComponent: "compOA", candidates: [{ target: "oB", targetComponent: "compOB" }] }),
  ];
  const ledgerRows = [
    ledgerRow({ id: "w1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
    ledgerRow({ id: "other-prov", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
  ];
  const consensusMap = new Map([["w1", { consensus_disposition: "CONFIRM", consensus_target_document_id: "wB" }]]);
  const graph = buildProspectiveGraph({ packetRows, ledgerRows, consensusByRelationCandidateId: consensusMap });
  assert.equal(graph.resolveMaximalComponentId("compWA"), graph.resolveMaximalComponentId("compWB"));
  assert.notEqual(graph.resolveMaximalComponentId("compWA"), graph.resolveMaximalComponentId("compWC"), "the non-consensus candidate wC must NOT be merged");
  assert.equal(graph.resolveMaximalComponentId("compOA"), graph.resolveMaximalComponentId("compOB"), "untouched provisional row still merges normally");
});

test("buildProspectiveGraph: a Priority Wave 1 REJECT overlay never merges its component, even though the SAME candidates were plausible under plain N4.9 provisional treatment", () => {
  const packetRows = [packetRow({ id: "w-reject", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] })];
  const ledgerRows = [ledgerRow({ id: "w-reject", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" })];
  const consensusMap = new Map([["w-reject", { consensus_disposition: "REJECT", consensus_target_document_id: null }]]);
  const graph = buildProspectiveGraph({ packetRows, ledgerRows, consensusByRelationCandidateId: consensusMap });
  assert.notEqual(graph.resolveMaximalComponentId("compA"), graph.resolveMaximalComponentId("compB"));
  assert.equal(graph.totalCandidateEdgeCount, 0);
});

test("buildProspectiveGraph: excludeRelationCandidateIds drops that row's contribution entirely -- used by the Wave 2 individually-decisive rebuild", () => {
  const packetRows = [
    packetRow({ id: "p1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] }),
    packetRow({ id: "p2", source: "B", sourceComponent: "compB", candidates: [{ target: "C", targetComponent: "compC" }] }),
  ];
  const ledgerRows = [
    ledgerRow({ id: "p1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
    ledgerRow({ id: "p2", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
  ];
  const full = buildProspectiveGraph({ packetRows, ledgerRows, consensusByRelationCandidateId: new Map() });
  assert.equal(full.resolveMaximalComponentId("compA"), full.resolveMaximalComponentId("compC"));
  const withoutP2 = buildProspectiveGraph({ packetRows, ledgerRows, consensusByRelationCandidateId: new Map(), excludeRelationCandidateIds: new Set(["p2"]) });
  assert.notEqual(withoutP2.resolveMaximalComponentId("compA"), withoutP2.resolveMaximalComponentId("compC"));
  assert.equal(withoutP2.totalCandidateEdgeCount, 1);
});

test("buildProspectiveGraph: Owner REJECT and quarantined rows are still ZERO-edge exactly like plain N4.9 -- the overlay never re-activates them", () => {
  const packetRows = [
    packetRow({ id: "owner-reject", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] }),
    packetRow({ id: "quarantined", source: "C", sourceComponent: "compC", candidates: [{ target: "D", targetComponent: "compD" }] }),
  ];
  const ledgerRows = [
    ledgerRow({ id: "owner-reject", authority: "OWNER_V03", disposition: "REJECT" }),
    ledgerRow({ id: "quarantined", authority: "QUARANTINED_UNRESOLVED", disposition: "NEEDS_MORE_REVIEW" }),
  ];
  const graph = buildProspectiveGraph({ packetRows, ledgerRows, consensusByRelationCandidateId: new Map() });
  assert.equal(graph.totalCandidateEdgeCount, 0);
});
