import test from "node:test";
import assert from "node:assert/strict";
import { applyOwnerOverrides, OwnerOverrideError } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-owner-override.mjs";

const comparison = {
  per_packet: [
    { packet_id: "u-aaaaaaaaaaaa", status: "CONSENSUS", agreed_outcome: "ARM_SPECIFIC_CRITICAL" },
    { packet_id: "u-bbbbbbbbbbbb", status: "OWNER_REVIEW_REQUIRED", agreed_outcome: null },
  ],
  consensus_count: 1,
  owner_review_required_count: 1,
};

function owner(overrides = [{ packet_id: "u-bbbbbbbbbbbb", sensitivity_outcome: "SUPPORTED_ALTERNATE_NODE" }]) {
  return {
    schema_version: "fourarm.alternate-node-owner-overrides.v1",
    policy_sha256: "p",
    packet_combined_sha256: "c",
    owner_confirmed: true,
    overrides,
  };
}

test("Owner override resolves only the disagreement and preserves reviewer consensus", () => {
  const result = applyOwnerOverrides(comparison, owner(), {
    expectedPolicySha256: "p",
    expectedPacketCombinedSha256: "c",
  });
  assert.equal(result.consensus_count, 2);
  assert.equal(result.owner_review_required_count, 0);
  assert.equal(result.per_packet[0].agreed_outcome, "ARM_SPECIFIC_CRITICAL");
  assert.equal(result.per_packet[1].agreed_outcome, "SUPPORTED_ALTERNATE_NODE");
  assert.equal(result.per_packet[1].resolution_source, "HUMAN_OWNER_OVERRIDE");
  assert.equal(result.owner_override_count, 1);
});

test("fails closed without explicit Owner confirmation", () => {
  const artifact = owner();
  artifact.owner_confirmed = false;
  assert.throws(
    () => applyOwnerOverrides(comparison, artifact, { expectedPolicySha256: "p", expectedPacketCombinedSha256: "c" }),
    (error) => error instanceof OwnerOverrideError && error.code === "OWNER_OVERRIDE_NOT_CONFIRMED",
  );
});

test("fails closed on missing, duplicate, extra, invalid, or wrong-pin overrides", () => {
  const opts = { expectedPolicySha256: "p", expectedPacketCombinedSha256: "c" };
  assert.throws(() => applyOwnerOverrides(comparison, owner([]), opts), /every reviewer disagreement/);
  assert.throws(() => applyOwnerOverrides(comparison, owner([
    { packet_id: "u-bbbbbbbbbbbb", sensitivity_outcome: "SUPPORTED_ALTERNATE_NODE" },
    { packet_id: "u-bbbbbbbbbbbb", sensitivity_outcome: "SUPPORTED_ALTERNATE_NODE" },
  ]), opts), /duplicate override/);
  assert.throws(() => applyOwnerOverrides(comparison, owner([
    { packet_id: "u-aaaaaaaaaaaa", sensitivity_outcome: "SUPPORTED_ALTERNATE_NODE" },
  ]), opts), /not an unresolved reviewer disagreement/);
  assert.throws(() => applyOwnerOverrides(comparison, owner([
    { packet_id: "u-bbbbbbbbbbbb", sensitivity_outcome: "MADE_UP" },
  ]), opts), /invalid outcome/);
  assert.throws(() => applyOwnerOverrides(comparison, owner(), { expectedPolicySha256: "wrong", expectedPacketCombinedSha256: "c" }), /pins do not match/);
});
