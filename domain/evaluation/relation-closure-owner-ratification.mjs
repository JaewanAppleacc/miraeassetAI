// Turn N4.12: pure verification of an Owner batch-ratification decision
// (downloaded from Turn N4.11's priority-wave-1-owner-ratification.html)
// against the live consensus/graph artifacts it claims to reference, plus a
// pure builder for the resulting "owner-ratified" consensus record.
//
// Ratifying the 13-row E/F consensus is NOT the same gate as official split
// eligibility or Gold authoring authorization -- both stay false/blocked
// regardless of this decision's own disposition, and this module never
// writes to the official 326-row relation-closure-candidate-ledger.v0.2
// .jsonl. It only produces a clearly-labeled, still-unofficial record that
// the Owner has co-signed the ALREADY-COMPUTED E/F agreement for exactly
// these 13 rows.
const ALLOWED_DISPOSITIONS = new Set(["APPROVE_DUAL_REVIEW_CONSENSUS", "FIX_REQUIRED", "REJECT_BATCH"]);
const REQUIRED_FIELDS = [
  "schema_version", "decision_id", "owner", "decided_at", "owner_disposition", "owner_note",
  "consensus_manifest_path", "consensus_manifest_sha256",
  "reviewer_e_decision_path", "reviewer_e_decision_sha256",
  "reviewer_f_decision_path", "reviewer_f_decision_sha256",
  "reviewed_relation_candidate_ids", "confirm_count", "reject_count", "needs_more_review_count",
  "prospective_graph_report_path", "prospective_graph_report_sha256",
  "official_split_eligible", "gold_authoring_authorized",
];

export function verifyOwnerRatificationDecision({
  decision,
  expectedConsensusManifestPath, expectedConsensusManifestCanonicalSha256,
  expectedReviewerEDecisionPath, expectedReviewerEDecisionSha256,
  expectedReviewerFDecisionPath, expectedReviewerFDecisionSha256,
  expectedReviewedRelationCandidateIds,
  expectedConfirmCount, expectedRejectCount, expectedNeedsMoreReviewCount,
  expectedProspectiveGraphReportPath, expectedProspectiveGraphReportSha256,
}) {
  const violations = [];
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(decision ?? {}, field)) violations.push({ type: "MISSING_FIELD", field });
  }
  if (violations.length > 0) return Object.freeze({ ok: false, violations });

  if (typeof decision.decision_id !== "string" || decision.decision_id.trim().length === 0) violations.push({ type: "EMPTY_DECISION_ID" });
  if (typeof decision.owner !== "string" || decision.owner.trim().length === 0) violations.push({ type: "EMPTY_OWNER" });
  if (Number.isNaN(Date.parse(decision.decided_at))) violations.push({ type: "INVALID_DECIDED_AT", value: decision.decided_at });
  if (!ALLOWED_DISPOSITIONS.has(decision.owner_disposition)) violations.push({ type: "DISALLOWED_OWNER_DISPOSITION", value: decision.owner_disposition });

  const requiresNote = decision.owner_disposition === "FIX_REQUIRED" || decision.owner_disposition === "REJECT_BATCH";
  const hasNote = typeof decision.owner_note === "string" && decision.owner_note.trim().length > 0;
  if (requiresNote && !hasNote) violations.push({ type: "MISSING_REQUIRED_OWNER_NOTE", disposition: decision.owner_disposition });

  if (decision.consensus_manifest_path !== expectedConsensusManifestPath) violations.push({ type: "CONSENSUS_MANIFEST_PATH_MISMATCH" });
  if (decision.consensus_manifest_sha256 !== expectedConsensusManifestCanonicalSha256) violations.push({ type: "CONSENSUS_MANIFEST_SHA_MISMATCH", expected: expectedConsensusManifestCanonicalSha256, actual: decision.consensus_manifest_sha256 });
  if (decision.reviewer_e_decision_path !== expectedReviewerEDecisionPath) violations.push({ type: "REVIEWER_E_PATH_MISMATCH" });
  if (decision.reviewer_e_decision_sha256 !== expectedReviewerEDecisionSha256) violations.push({ type: "REVIEWER_E_SHA_MISMATCH" });
  if (decision.reviewer_f_decision_path !== expectedReviewerFDecisionPath) violations.push({ type: "REVIEWER_F_PATH_MISMATCH" });
  if (decision.reviewer_f_decision_sha256 !== expectedReviewerFDecisionSha256) violations.push({ type: "REVIEWER_F_SHA_MISMATCH" });
  if (decision.prospective_graph_report_path !== expectedProspectiveGraphReportPath) violations.push({ type: "PROSPECTIVE_REPORT_PATH_MISMATCH" });
  if (decision.prospective_graph_report_sha256 !== expectedProspectiveGraphReportSha256) violations.push({ type: "PROSPECTIVE_REPORT_SHA_MISMATCH" });

  const actualIds = Array.isArray(decision.reviewed_relation_candidate_ids) ? [...decision.reviewed_relation_candidate_ids].sort() : [];
  const expectedIds = [...expectedReviewedRelationCandidateIds].sort();
  if (new Set(actualIds).size !== actualIds.length) violations.push({ type: "DUPLICATE_REVIEWED_ID" });
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) violations.push({ type: "REVIEWED_ID_SET_MISMATCH", expected: expectedIds, actual: actualIds });

  if (decision.confirm_count !== expectedConfirmCount) violations.push({ type: "CONFIRM_COUNT_MISMATCH", expected: expectedConfirmCount, actual: decision.confirm_count });
  if (decision.reject_count !== expectedRejectCount) violations.push({ type: "REJECT_COUNT_MISMATCH", expected: expectedRejectCount, actual: decision.reject_count });
  if (decision.needs_more_review_count !== expectedNeedsMoreReviewCount) violations.push({ type: "NEEDS_MORE_REVIEW_COUNT_MISMATCH", expected: expectedNeedsMoreReviewCount, actual: decision.needs_more_review_count });
  const countSum = (decision.confirm_count ?? 0) + (decision.reject_count ?? 0) + (decision.needs_more_review_count ?? 0);
  if (countSum !== actualIds.length) violations.push({ type: "COUNT_SUM_DOES_NOT_MATCH_ID_COUNT", count_sum: countSum, id_count: actualIds.length });

  // Hard invariants: NEVER true, regardless of disposition or anything else
  // in the decision. A decision claiming otherwise is a fabricated/tampered
  // record and must fail closed.
  if (decision.official_split_eligible !== false) violations.push({ type: "OFFICIAL_SPLIT_ELIGIBLE_NOT_FALSE", value: decision.official_split_eligible });
  if (decision.gold_authoring_authorized !== false) violations.push({ type: "GOLD_AUTHORING_AUTHORIZED_NOT_FALSE", value: decision.gold_authoring_authorized });

  return Object.freeze({ ok: violations.length === 0, violations });
}

// Produces the ratified consensus record for each of the 13 rows -- ONLY
// called after verifyOwnerRatificationDecision returns ok:true. Marks
// consensus_status distinctly from "PENDING_OWNER" but keeps
// official_relation_status explicitly non-official; this is a procedural
// co-sign of the E/F agreement, never an official Relation promotion.
export function buildOwnerRatifiedConsensusRows({ consensusRows, decision }) {
  const approved = decision.owner_disposition === "APPROVE_DUAL_REVIEW_CONSENSUS";
  return consensusRows.map((row) => ({
    ...row,
    consensus_status: approved ? "DUAL_REVIEW_CONSENSUS_OWNER_RATIFIED" : row.consensus_status,
    official_relation_status: "NOT_YET_OFFICIALLY_PROMOTED",
    owner_ratification: {
      decision_id: decision.decision_id,
      owner: decision.owner,
      decided_at: decision.decided_at,
      owner_disposition: decision.owner_disposition,
      owner_note: decision.owner_note,
    },
    auto_promoted_to_official_relation: false,
    official_split_eligible: false,
  }));
}
