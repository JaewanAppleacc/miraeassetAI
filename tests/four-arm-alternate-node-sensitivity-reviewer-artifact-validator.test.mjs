import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  validateReviewerArtifact,
  ReviewerArtifactValidationError,
  EXPECTED_POPULATION_PACKET_COUNT,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-reviewer-artifact-validator.mjs";
import {
  buildSyntheticPopulationTemplate,
  buildSyntheticReviewerArtifact,
  syntheticPacketId,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-fixture.mjs";

const SOURCE_HEAD = "8678fea7255dde2a399a233a299f0d984966e42b";
const POLICY_SHA256 = createHash("sha256").update("synthetic-policy-bytes").digest("hex");

function basePopulation() {
  return buildSyntheticPopulationTemplate(EXPECTED_POPULATION_PACKET_COUNT);
}

function baseOptions(population) {
  return {
    expectedReviewerLabel: "A",
    expectedSourceHead: SOURCE_HEAD,
    expectedPolicySha256: POLICY_SHA256,
    expectedPacketCombinedSha256: population.template.packet_combined_sha256,
    expectedPacketIds: population.template.resolutions.map((r) => r.packet_id),
    expectedPacketCount: EXPECTED_POPULATION_PACKET_COUNT,
  };
}

test("accepts a well-formed reviewer artifact covering exactly the frozen population", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256,
    outcomesByPacketId: { [syntheticPacketId(0)]: "SUPPORTED_ALTERNATE_NODE" },
  });
  const result = validateReviewerArtifact(reviewer.bytes, baseOptions(population));
  assert.equal(result.packet_count, EXPECTED_POPULATION_PACKET_COUNT);
  assert.equal(result.owner_confirmed, false);
  assert.equal(result.outcomes_by_packet_id[syntheticPacketId(0)], "SUPPORTED_ALTERNATE_NODE");
});

test("rejects a missing packet id (dropped from the artifact)", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256,
    omitPacketIds: [syntheticPacketId(3)],
    overridePacketCount: EXPECTED_POPULATION_PACKET_COUNT - 1,
  });
  assert.throws(
    () => validateReviewerArtifact(reviewer.bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_PACKET_COUNT_MISMATCH",
  );
});

test("rejects a duplicated packet id even when the declared count matches", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256,
  });
  const parsed = JSON.parse(reviewer.bytes.toString("utf8"));
  // duplicate packet 0's id onto packet 1, keep the array the same length
  parsed.resolutions[1].packet_id = parsed.resolutions[0].packet_id;
  const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
  assert.throws(
    () => validateReviewerArtifact(bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_DUPLICATE_PACKET_ID",
  );
});

test("rejects an extra packet id outside the frozen population, even if it replaces one to keep the count", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256,
    omitPacketIds: [syntheticPacketId(0)],
    extraPacketIds: ["u-ffffffffffff"],
  });
  assert.throws(
    () => validateReviewerArtifact(reviewer.bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_UNKNOWN_PACKET_ID",
  );
});

test("rejects a wrong source_head, policy_sha256, or packet_combined_sha256", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, { reviewerLabel: "A", sourceHead: "deadbeef", policySha256: POLICY_SHA256 });
  assert.throws(
    () => validateReviewerArtifact(reviewer.bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_SOURCE_HEAD_MISMATCH",
  );

  const reviewer2 = buildSyntheticReviewerArtifact(population, { reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: "deadbeef" });
  assert.throws(
    () => validateReviewerArtifact(reviewer2.bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_POLICY_SHA_MISMATCH",
  );

  const reviewer3 = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256, overridePacketCombinedSha256: "deadbeef",
  });
  assert.throws(
    () => validateReviewerArtifact(reviewer3.bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_COMBINED_SHA_MISMATCH",
  );
});

test("rejects only 4 allowed outcomes -- anything else is refused", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, { reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256 });
  const parsed = JSON.parse(reviewer.bytes.toString("utf8"));
  parsed.resolutions[0].sensitivity_outcome = "EQUIVALENT_EVIDENCE";
  const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
  assert.throws(
    () => validateReviewerArtifact(bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_INVALID_OUTCOME",
  );
});

test("rejects acceptance_checks with a missing/extra key", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, { reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256 });
  const parsed = JSON.parse(reviewer.bytes.toString("utf8"));
  delete parsed.resolutions[0].acceptance_checks.ARM_BLIND_REPRODUCIBLE_DECISION;
  const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
  assert.throws(
    () => validateReviewerArtifact(bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_ACCEPTANCE_CHECKS_KEY_MISMATCH",
  );
});

test("SUPPORTED_ALTERNATE_NODE with a false acceptance check is rejected", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256,
    outcomesByPacketId: { [syntheticPacketId(0)]: "SUPPORTED_ALTERNATE_NODE" },
  });
  const parsed = JSON.parse(reviewer.bytes.toString("utf8"));
  const target = parsed.resolutions.find((r) => r.packet_id === syntheticPacketId(0));
  target.acceptance_checks.NO_CONTRADICTORY_VALUE_OR_QUALIFIER = false;
  const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
  assert.throws(
    () => validateReviewerArtifact(bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_SUPPORTED_REQUIRES_ALL_CHECKS_TRUE",
  );
});

test("SUPPORTED_ALTERNATE_NODE with a null acceptance check is rejected", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256,
    outcomesByPacketId: { [syntheticPacketId(0)]: "SUPPORTED_ALTERNATE_NODE" },
  });
  const parsed = JSON.parse(reviewer.bytes.toString("utf8"));
  const target = parsed.resolutions.find((r) => r.packet_id === syntheticPacketId(0));
  target.acceptance_checks.NO_CONTRADICTORY_VALUE_OR_QUALIFIER = null;
  const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
  assert.throws(
    () => validateReviewerArtifact(bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_ACCEPTANCE_CHECK_NOT_BOOLEAN",
  );
});

test("rejects owner_confirmed=true at the top level and at the per-packet level", () => {
  const population = basePopulation();
  const reviewerTop = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256, overrideOwnerConfirmed: true,
  });
  assert.throws(
    () => validateReviewerArtifact(reviewerTop.bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_OWNER_CONFIRMED_FORBIDDEN",
  );

  const reviewerEntry = buildSyntheticReviewerArtifact(population, { reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256 });
  const parsed = JSON.parse(reviewerEntry.bytes.toString("utf8"));
  parsed.resolutions[0].owner_confirmed = true;
  const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
  assert.throws(
    () => validateReviewerArtifact(bytes, baseOptions(population)),
    (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_ENTRY_OWNER_CONFIRMED_FORBIDDEN",
  );
});

test("rejects arm/rank/score/winner fields wherever they appear, including deeply nested", () => {
  const population = basePopulation();
  const reviewer = buildSyntheticReviewerArtifact(population, { reviewerLabel: "A", sourceHead: SOURCE_HEAD, policySha256: POLICY_SHA256 });
  for (const key of ["arm", "rank", "score", "winner"]) {
    const parsed = JSON.parse(reviewer.bytes.toString("utf8"));
    parsed.resolutions[0].note = { nested: { deeper: { [key]: "x" } } };
    const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
    assert.throws(
      () => validateReviewerArtifact(bytes, baseOptions(population)),
      (error) => error instanceof ReviewerArtifactValidationError && error.code === "REVIEWER_ARTIFACT_FORBIDDEN_FIELD",
      `expected rejection for forbidden key ${key}`,
    );
  }
});
