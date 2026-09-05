import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewerArtifactShape } from "../scripts/p11f0-fourarm-normalize-reviewer-artifact.mjs";

const legacyChecks = {
  same_document_and_real_nodes: true,
  declared_node_text_integrity_verified: true,
  all_required_slot_evidence_present: true,
  semantic_dimensions_compatible: true,
  no_contradiction: true,
  arm_blind_reproducible: true,
};

test("normalizes object resolutions and legacy check names without outcome drift", () => {
  const out = normalizeReviewerArtifactShape({
    reviewer: "A",
    source_head: "a".repeat(40),
    policy_sha256: "b".repeat(64),
    packet_count: 1,
    packet_combined_sha256: "c".repeat(64),
    owner_confirmed: false,
    resolutions: {
      "u-aaaaaaaaaaaa": {
        sensitivity_outcome: "SUPPORTED_ALTERNATE_NODE",
        acceptance_checks: legacyChecks,
        rationale: "same evidence",
      },
    },
  });
  assert.equal(out.schema_version, "fourarm.alternate-node-sensitivity-reviewer-artifact.v1");
  assert.equal(out.reviewer_label, "A");
  assert.equal(out.resolutions[0].sensitivity_outcome, "SUPPORTED_ALTERNATE_NODE");
  assert.deepEqual(Object.values(out.resolutions[0].acceptance_checks), [true, true, true, true, true, true]);
  assert.equal(out.resolutions[0].note, "same evidence");
  assert.equal(out.owner_confirmed, false);
});

test("preserves canonical uppercase checks and array entries", () => {
  const checks = Object.fromEntries(Object.values({
    one: "SAME_DOCUMENT_AND_REAL_NODES",
    two: "DECLARED_NODE_TEXT_INTEGRITY_VERIFIED",
    three: "ALL_REQUIRED_SLOT_EVIDENCE_PRESENT",
    four: "ENTITY_METRIC_SUBTYPE_SCOPE_PERIOD_UNIT_SIGN_CALCULATION_COMPATIBLE",
    five: "NO_CONTRADICTORY_VALUE_OR_QUALIFIER",
    six: "ARM_BLIND_REPRODUCIBLE_DECISION",
  }).map((key) => [key, false]));
  const out = normalizeReviewerArtifactShape({
    reviewer_label: "B",
    source_head: "a".repeat(40),
    policy_sha256: "b".repeat(64),
    packet_count: 1,
    packet_combined_sha256: "c".repeat(64),
    resolutions: [{
      packet_id: "u-aaaaaaaaaaaa",
      sensitivity_outcome: "UNKNOWN",
      acceptance_checks: checks,
      note: "pending",
    }],
  });
  assert.equal(out.reviewer_label, "B");
  assert.equal(out.resolutions[0].sensitivity_outcome, "UNKNOWN");
  assert.deepEqual(out.resolutions[0].acceptance_checks, checks);
});

test("fails closed if the six-check vocabulary is incomplete", () => {
  assert.throws(() => normalizeReviewerArtifactShape({
    reviewer: "A",
    resolutions: {
      "u-aaaaaaaaaaaa": {
        sensitivity_outcome: "UNKNOWN",
        acceptance_checks: { same_document_and_real_nodes: true },
      },
    },
  }), /ACCEPTANCE_CHECKS_MISMATCH/);
});
