// FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1: compares two already-
// validated, arm-blind reviewer artifacts (see
// alternate-node-sensitivity-reviewer-artifact-validator.mjs) packet by
// packet. There is no majority vote here -- with exactly two reviewers,
// "compare" means exact per-packet equality, nothing more. A packet where
// both reviewers agree becomes CONSENSUS; any disagreement becomes
// OWNER_REVIEW_REQUIRED. Nothing in this module ever writes, promotes, or
// otherwise converts its output into an Owner-confirmed decision file.
export const REVIEWER_COMPARISON_SCHEMA_VERSION = "fourarm.alternate-node-sensitivity-reviewer-comparison.v1";

export class ReviewerComparisonError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ReviewerComparisonError";
    this.code = code;
    Object.assign(this, details);
  }
}

// reviewerA/reviewerB: the frozen summary objects returned by
// validateReviewerArtifact(...) -- each carrying outcomes_by_packet_id.
export function compareReviewerArtifacts(reviewerA, reviewerB) {
  if (!reviewerA || typeof reviewerA.outcomes_by_packet_id !== "object") {
    throw new ReviewerComparisonError("reviewerA must be a validated reviewer artifact summary", "REVIEWER_COMPARISON_INVALID_REVIEWER_A");
  }
  if (!reviewerB || typeof reviewerB.outcomes_by_packet_id !== "object") {
    throw new ReviewerComparisonError("reviewerB must be a validated reviewer artifact summary", "REVIEWER_COMPARISON_INVALID_REVIEWER_B");
  }
  if (typeof reviewerA.packet_combined_sha256 === "string" && typeof reviewerB.packet_combined_sha256 === "string"
    && reviewerA.packet_combined_sha256 !== reviewerB.packet_combined_sha256) {
    throw new ReviewerComparisonError(
      "reviewer artifacts were built against different population snapshots (packet_combined_sha256 mismatch) -- refusing to compare them",
      "REVIEWER_COMPARISON_COMBINED_SHA_MISMATCH",
    );
  }

  const idsA = Object.keys(reviewerA.outcomes_by_packet_id);
  const idsB = Object.keys(reviewerB.outcomes_by_packet_id);
  const setA = new Set(idsA);
  const setB = new Set(idsB);
  const onlyInA = idsA.filter((id) => !setB.has(id));
  const onlyInB = idsB.filter((id) => !setA.has(id));
  if (onlyInA.length > 0 || onlyInB.length > 0 || setA.size !== setB.size) {
    throw new ReviewerComparisonError(
      "reviewer artifacts do not cover the identical packet population",
      "REVIEWER_COMPARISON_POPULATION_MISMATCH",
      { only_in_reviewer_a: onlyInA.sort(), only_in_reviewer_b: onlyInB.sort() },
    );
  }

  const perPacket = [];
  let consensusCount = 0;
  let ownerReviewRequiredCount = 0;
  for (const packetId of [...setA].sort()) {
    const reviewerAOutcome = reviewerA.outcomes_by_packet_id[packetId];
    const reviewerBOutcome = reviewerB.outcomes_by_packet_id[packetId];
    // Exact equality only. No averaging, no tie-break, no "2 of 2 agree
    // wins" framing that would generalize into a vote with more reviewers.
    const agree = reviewerAOutcome === reviewerBOutcome;
    perPacket.push(Object.freeze({
      packet_id: packetId,
      reviewer_a_outcome: reviewerAOutcome,
      reviewer_b_outcome: reviewerBOutcome,
      status: agree ? "CONSENSUS" : "OWNER_REVIEW_REQUIRED",
      agreed_outcome: agree ? reviewerAOutcome : null,
    }));
    if (agree) consensusCount += 1;
    else ownerReviewRequiredCount += 1;
  }

  return Object.freeze({
    schema_version: REVIEWER_COMPARISON_SCHEMA_VERSION,
    packet_count: perPacket.length,
    consensus_count: consensusCount,
    owner_review_required_count: ownerReviewRequiredCount,
    per_packet: Object.freeze(perPacket),
    consensus_packet_ids: Object.freeze(perPacket.filter((e) => e.status === "CONSENSUS").map((e) => e.packet_id)),
    owner_review_required_packet_ids: Object.freeze(perPacket.filter((e) => e.status === "OWNER_REVIEW_REQUIRED").map((e) => e.packet_id)),
    owner_confirmed: false,
    auto_converted_to_owner_decision_file: false,
  });
}
