import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateReviewerArtifact } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-reviewer-artifact-validator.mjs";
import {
  compareReviewerArtifacts,
  ReviewerComparisonError,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-reviewer-comparison.mjs";
import {
  buildSyntheticPopulationTemplate,
  buildSyntheticReviewerArtifact,
  syntheticPacketId,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-fixture.mjs";

const SOURCE_HEAD = "8678fea7255dde2a399a233a299f0d984966e42b";
const POLICY_SHA256 = createHash("sha256").update("synthetic-policy-bytes").digest("hex");
const N = 26;

function validated(population, { reviewerLabel, outcomesByPacketId }) {
  const built = buildSyntheticReviewerArtifact(population, {
    reviewerLabel, sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256, outcomesByPacketId,
  });
  return validateReviewerArtifact(built.bytes, {
    expectedReviewerLabel: reviewerLabel,
    expectedSourceHead: SOURCE_HEAD,
    expectedPolicySha256: POLICY_SHA256,
    expectedPacketCombinedSha256: population.template.packet_combined_sha256,
    expectedPacketIds: population.template.resolutions.map((r) => r.packet_id),
    expectedPacketCount: N,
  });
}

test("agreeing packets become CONSENSUS, disagreeing packets become OWNER_REVIEW_REQUIRED", () => {
  const population = buildSyntheticPopulationTemplate(N);
  const outcomesA = {
    [syntheticPacketId(0)]: "SUPPORTED_ALTERNATE_NODE",
    [syntheticPacketId(1)]: "ARM_SPECIFIC_CRITICAL",
    [syntheticPacketId(2)]: "UNKNOWN",
  };
  const outcomesB = {
    [syntheticPacketId(0)]: "SUPPORTED_ALTERNATE_NODE", // agree
    [syntheticPacketId(1)]: "UNKNOWN", // disagree
    [syntheticPacketId(2)]: "UNKNOWN", // agree
  };
  const reviewerA = validated(population, { reviewerLabel: "A", outcomesByPacketId: outcomesA });
  const reviewerB = validated(population, { reviewerLabel: "B", outcomesByPacketId: outcomesB });
  const comparison = compareReviewerArtifacts(reviewerA, reviewerB);

  assert.equal(comparison.packet_count, N);
  const byId = Object.fromEntries(comparison.per_packet.map((e) => [e.packet_id, e]));
  assert.equal(byId[syntheticPacketId(0)].status, "CONSENSUS");
  assert.equal(byId[syntheticPacketId(0)].agreed_outcome, "SUPPORTED_ALTERNATE_NODE");
  assert.equal(byId[syntheticPacketId(1)].status, "OWNER_REVIEW_REQUIRED");
  assert.equal(byId[syntheticPacketId(1)].agreed_outcome, null);
  assert.equal(byId[syntheticPacketId(2)].status, "CONSENSUS");
  assert.ok(comparison.consensus_packet_ids.includes(syntheticPacketId(0)));
  assert.ok(comparison.owner_review_required_packet_ids.includes(syntheticPacketId(1)));
  assert.equal(comparison.owner_confirmed, false);
  assert.equal(comparison.auto_converted_to_owner_decision_file, false);
});

test("never auto-majority-votes -- disagreement always surfaces as OWNER_REVIEW_REQUIRED, never silently resolved", () => {
  const population = buildSyntheticPopulationTemplate(N);
  const reviewerA = validated(population, { reviewerLabel: "A", outcomesByPacketId: { [syntheticPacketId(5)]: "ARM_SPECIFIC_NON_CRITICAL" } });
  const reviewerB = validated(population, { reviewerLabel: "B", outcomesByPacketId: { [syntheticPacketId(5)]: "ARM_SPECIFIC_CRITICAL" } });
  const comparison = compareReviewerArtifacts(reviewerA, reviewerB);
  const entry = comparison.per_packet.find((e) => e.packet_id === syntheticPacketId(5));
  assert.equal(entry.status, "OWNER_REVIEW_REQUIRED");
  assert.equal(entry.agreed_outcome, null);
});

test("consensus counts and disagreement counts always sum to the full population", () => {
  const population = buildSyntheticPopulationTemplate(N);
  const reviewerA = validated(population, { reviewerLabel: "A", outcomesByPacketId: {} });
  const reviewerB = validated(population, { reviewerLabel: "B", outcomesByPacketId: { [syntheticPacketId(10)]: "SUPPORTED_ALTERNATE_NODE" } });
  const comparison = compareReviewerArtifacts(reviewerA, reviewerB);
  assert.equal(comparison.consensus_count + comparison.owner_review_required_count, N);
});

test("rejects comparing reviewer artifacts built against different population snapshots", () => {
  const population = buildSyntheticPopulationTemplate(N);
  const reviewerA = validated(population, { reviewerLabel: "A", outcomesByPacketId: {} });
  const reviewerB = {
    packet_combined_sha256: "0".repeat(64),
    outcomes_by_packet_id: { ...reviewerA.outcomes_by_packet_id },
  };
  assert.throws(
    () => compareReviewerArtifacts(reviewerA, reviewerB),
    (error) => error instanceof ReviewerComparisonError && error.code === "REVIEWER_COMPARISON_COMBINED_SHA_MISMATCH",
  );
});

test("rejects comparing reviewer artifacts that don't cover the identical packet population", () => {
  const population = buildSyntheticPopulationTemplate(N);
  const reviewerA = validated(population, { reviewerLabel: "A", outcomesByPacketId: {} });
  const reviewerBOutcomes = { ...reviewerA.outcomes_by_packet_id };
  delete reviewerBOutcomes[syntheticPacketId(0)];
  reviewerBOutcomes["u-ffffffffffff"] = "UNKNOWN";
  const reviewerB = { packet_combined_sha256: reviewerA.packet_combined_sha256, outcomes_by_packet_id: reviewerBOutcomes };
  assert.throws(
    () => compareReviewerArtifacts(reviewerA, reviewerB),
    (error) => error instanceof ReviewerComparisonError && error.code === "REVIEWER_COMPARISON_POPULATION_MISMATCH",
  );
});
