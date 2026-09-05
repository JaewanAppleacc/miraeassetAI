import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSensitivityView,
  SensitivityAdjudicationError,
  SENSITIVITY_ADAPTER_VERSION,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-adjudication-adapter.v1.mjs";
import { syntheticPacketId } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-fixture.mjs";

function comparisonFixture(entries) {
  return {
    schema_version: "fourarm.alternate-node-sensitivity-reviewer-comparison.v1",
    packet_count: entries.length,
    per_packet: entries,
  };
}

test("SUPPORTED_ALTERNATE_NODE keeps the slot's baseline evidence as-is", () => {
  const packetId = syntheticPacketId(0);
  const comparison = comparisonFixture([{ packet_id: packetId, status: "CONSENSUS", agreed_outcome: "SUPPORTED_ALTERNATE_NODE" }]);
  const baseline = [{ packet_id: packetId, arm: "B", question_id: "q1", slot_name: "s1", baseline_found: true }];
  const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: baseline });
  assert.equal(view.schema_version, SENSITIVITY_ADAPTER_VERSION);
  assert.equal(view.slot_view[0].sensitivity_action, "KEEP_EVIDENCE_ALTERNATE_LOCATOR");
  assert.equal(view.slot_view[0].sensitivity_found, true);
  assert.equal(view.per_arm_hard_gate.B.hard_gate_state, "HARD_GATE_PASSED");
});

test("ARM_SPECIFIC_CRITICAL invalidates the slot and fails that arm's hard gate only", () => {
  const packetId = syntheticPacketId(1);
  const comparison = comparisonFixture([{ packet_id: packetId, status: "CONSENSUS", agreed_outcome: "ARM_SPECIFIC_CRITICAL" }]);
  const baseline = [{ packet_id: packetId, arm: "D", question_id: "q2", slot_name: "s2", baseline_found: true }];
  const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: baseline });
  assert.equal(view.slot_view[0].sensitivity_action, "INVALIDATE_AND_HARD_GATE_FAIL");
  assert.equal(view.slot_view[0].sensitivity_found, false);
  assert.equal(view.per_arm_hard_gate.D.hard_gate_state, "HARD_GATE_FAILED");
  assert.deepEqual(view.per_arm_hard_gate.D.critical_packet_ids, [packetId]);
  assert.equal(view.per_arm_hard_gate.A.hard_gate_state, "HARD_GATE_PASSED");
  assert.equal(view.per_arm_hard_gate.B.hard_gate_state, "HARD_GATE_PASSED");
  assert.equal(view.per_arm_hard_gate.C.hard_gate_state, "HARD_GATE_PASSED");
});

test("ARM_SPECIFIC_NON_CRITICAL invalidates the slot but never adds to the hard gate", () => {
  const packetId = syntheticPacketId(2);
  const comparison = comparisonFixture([{ packet_id: packetId, status: "CONSENSUS", agreed_outcome: "ARM_SPECIFIC_NON_CRITICAL" }]);
  const baseline = [{ packet_id: packetId, arm: "A", question_id: "q3", slot_name: "s3", baseline_found: true }];
  const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: baseline });
  assert.equal(view.slot_view[0].sensitivity_action, "INVALIDATE_ONLY");
  assert.equal(view.slot_view[0].sensitivity_found, false);
  assert.equal(view.per_arm_hard_gate.A.hard_gate_state, "HARD_GATE_PASSED");
  assert.deepEqual(view.per_arm_hard_gate.A.critical_packet_ids, []);
});

test("UNKNOWN marks that arm's selection pending without invalidating the slot", () => {
  const packetId = syntheticPacketId(3);
  const comparison = comparisonFixture([{ packet_id: packetId, status: "CONSENSUS", agreed_outcome: "UNKNOWN" }]);
  const baseline = [{ packet_id: packetId, arm: "C", question_id: "q4", slot_name: "s4", baseline_found: true }];
  const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: baseline });
  assert.equal(view.slot_view[0].sensitivity_action, "SELECTION_PENDING");
  assert.equal(view.slot_view[0].sensitivity_found, true);
  assert.deepEqual(view.per_arm_hard_gate.C.selection_pending_packet_ids, [packetId]);
  assert.equal(view.per_arm_hard_gate.C.hard_gate_state, "HARD_GATE_PASSED");
});

test("reviewer disagreement (OWNER_REVIEW_REQUIRED) leaves the slot untouched and pending, never auto-resolved", () => {
  const packetId = syntheticPacketId(4);
  const comparison = comparisonFixture([{ packet_id: packetId, status: "OWNER_REVIEW_REQUIRED", agreed_outcome: null }]);
  const baseline = [{ packet_id: packetId, arm: "B", question_id: "q5", slot_name: "s5", baseline_found: false }];
  const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: baseline });
  assert.equal(view.slot_view[0].sensitivity_action, "PENDING_OWNER_REVIEW");
  assert.equal(view.slot_view[0].sensitivity_found, false); // unchanged from baseline_found
  assert.equal(view.per_arm_hard_gate.B.hard_gate_state, "HARD_GATE_PASSED");
});

test("a baseline slot for a packet outside this comparison round is left untouched", () => {
  const comparison = comparisonFixture([]);
  const baseline = [{ packet_id: syntheticPacketId(9), arm: "A", question_id: "q6", slot_name: "s6", baseline_found: true }];
  const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: baseline });
  assert.equal(view.slot_view[0].sensitivity_action, "NOT_IN_SENSITIVITY_POPULATION");
  assert.equal(view.slot_view[0].sensitivity_found, true);
});

test("never mutates the frozen scorer or original result files, and never self-promotes", () => {
  const comparison = comparisonFixture([]);
  const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: [] });
  assert.equal(view.frozen_scorer_modified, false);
  assert.equal(view.original_result_run_files_modified, false);
  assert.equal(view.owner_confirmed, false);
  assert.equal(view.official_vfinal_result_mutable, false);
  assert.equal(view.sensitivity_can_auto_replace_official_result, false);
  assert.equal(view.common_source_meaning_unchanged, true);
});

test("rejects malformed baseline evidence entries", () => {
  const comparison = comparisonFixture([]);
  assert.throws(
    () => buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: [{ packet_id: "u-x", arm: "Z", baseline_found: true }] }),
    (error) => error instanceof SensitivityAdjudicationError && error.code === "SENSITIVITY_ADAPTER_INVALID_SLOT_ARM",
  );
  assert.throws(
    () => buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: [{ packet_id: "u-x", arm: "A", baseline_found: "yes" }] }),
    (error) => error instanceof SensitivityAdjudicationError && error.code === "SENSITIVITY_ADAPTER_INVALID_SLOT_BASELINE_FOUND",
  );
});
