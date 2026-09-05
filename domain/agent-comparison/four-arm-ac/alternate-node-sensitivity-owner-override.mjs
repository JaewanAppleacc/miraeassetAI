export const OWNER_OVERRIDE_SCHEMA_VERSION = "fourarm.alternate-node-owner-overrides.v1";

const ALLOWED_OUTCOMES = new Set([
  "SUPPORTED_ALTERNATE_NODE",
  "ARM_SPECIFIC_CRITICAL",
  "ARM_SPECIFIC_NON_CRITICAL",
  "UNKNOWN",
]);

export class OwnerOverrideError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "OwnerOverrideError";
    this.code = code;
  }
}

export function applyOwnerOverrides(comparison, ownerArtifact, {
  expectedPolicySha256,
  expectedPacketCombinedSha256,
} = {}) {
  if (!comparison || !Array.isArray(comparison.per_packet)) {
    throw new OwnerOverrideError("comparison.per_packet is required", "OWNER_OVERRIDE_INVALID_COMPARISON");
  }
  if (!ownerArtifact || ownerArtifact.schema_version !== OWNER_OVERRIDE_SCHEMA_VERSION) {
    throw new OwnerOverrideError("invalid owner override schema", "OWNER_OVERRIDE_SCHEMA_MISMATCH");
  }
  if (ownerArtifact.owner_confirmed !== true) {
    throw new OwnerOverrideError("owner confirmation is required", "OWNER_OVERRIDE_NOT_CONFIRMED");
  }
  if (ownerArtifact.policy_sha256 !== expectedPolicySha256
      || ownerArtifact.packet_combined_sha256 !== expectedPacketCombinedSha256) {
    throw new OwnerOverrideError("owner override pins do not match", "OWNER_OVERRIDE_PIN_MISMATCH");
  }
  if (!Array.isArray(ownerArtifact.overrides)) {
    throw new OwnerOverrideError("overrides must be an array", "OWNER_OVERRIDE_NOT_ARRAY");
  }

  const pending = new Set(comparison.per_packet
    .filter((entry) => entry.status === "OWNER_REVIEW_REQUIRED")
    .map((entry) => entry.packet_id));
  const overrides = new Map();
  for (const entry of ownerArtifact.overrides) {
    if (!pending.has(entry.packet_id)) {
      throw new OwnerOverrideError(`override is not an unresolved reviewer disagreement: ${entry.packet_id}`, "OWNER_OVERRIDE_UNEXPECTED_PACKET");
    }
    if (overrides.has(entry.packet_id)) {
      throw new OwnerOverrideError(`duplicate override: ${entry.packet_id}`, "OWNER_OVERRIDE_DUPLICATE_PACKET");
    }
    if (!ALLOWED_OUTCOMES.has(entry.sensitivity_outcome)) {
      throw new OwnerOverrideError(`invalid outcome for ${entry.packet_id}`, "OWNER_OVERRIDE_INVALID_OUTCOME");
    }
    overrides.set(entry.packet_id, entry.sensitivity_outcome);
  }
  if (overrides.size !== pending.size) {
    throw new OwnerOverrideError("every reviewer disagreement requires an Owner override", "OWNER_OVERRIDE_INCOMPLETE");
  }

  const perPacket = comparison.per_packet.map((entry) => {
    if (entry.status === "CONSENSUS") return entry;
    return Object.freeze({
      ...entry,
      status: "CONSENSUS",
      agreed_outcome: overrides.get(entry.packet_id),
      resolution_source: "HUMAN_OWNER_OVERRIDE",
    });
  });
  return Object.freeze({
    ...comparison,
    consensus_count: perPacket.length,
    owner_review_required_count: 0,
    per_packet: Object.freeze(perPacket),
    consensus_packet_ids: Object.freeze(perPacket.map((entry) => entry.packet_id)),
    owner_review_required_packet_ids: Object.freeze([]),
    owner_override_count: overrides.size,
    owner_confirmed: true,
    auto_converted_to_owner_decision_file: false,
  });
}
