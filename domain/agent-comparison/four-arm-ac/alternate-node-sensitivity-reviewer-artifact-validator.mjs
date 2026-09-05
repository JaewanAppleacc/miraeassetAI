// FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1: fail-closed validator for a
// single arm-blind reviewer's alternate-node sensitivity artifact. This
// module never reads a real reviewer file itself and never computes a
// classification -- it only verifies that a claimed artifact is byte- and
// shape-consistent with the frozen policy
// (domain/agent-comparison/four-arm-ac/official/alternate-node-sensitivity-policy.v1.json)
// and with the population template the caller already trusts (see
// alternate-node-sensitivity-population-guard.mjs). All "expected" values
// are supplied by the caller from those artifacts -- nothing here is
// hardcoded to a specific packet ID, hash, or reviewer identity.
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "fourarm.alternate-node-sensitivity-reviewer-artifact.v1";

export const SENSITIVITY_OUTCOMES = Object.freeze([
  "SUPPORTED_ALTERNATE_NODE",
  "ARM_SPECIFIC_CRITICAL",
  "ARM_SPECIFIC_NON_CRITICAL",
  "UNKNOWN",
]);

// Mirrors official/alternate-node-sensitivity-policy.v1.json#acceptance_conditions
// verbatim. This vocabulary is a frozen contract, not per-instance data, so
// (like RESOLUTION_CLASSES in four-arm-owner-resolutions-importer.mjs) it is
// a constant here rather than something read out of the artifact itself.
export const ACCEPTANCE_CONDITIONS = Object.freeze([
  "SAME_DOCUMENT_AND_REAL_NODES",
  "DECLARED_NODE_TEXT_INTEGRITY_VERIFIED",
  "ALL_REQUIRED_SLOT_EVIDENCE_PRESENT",
  "ENTITY_METRIC_SUBTYPE_SCOPE_PERIOD_UNIT_SIGN_CALCULATION_COMPATIBLE",
  "NO_CONTRADICTORY_VALUE_OR_QUALIFIER",
  "ARM_BLIND_REPRODUCIBLE_DECISION",
]);

// Frozen fact about this specific sensitivity round (FOURARM-ALTERNATE-NODE-
// SENSITIVITY-V1): the full A+B+C+D duplicate_evidence_different_node
// population is exactly 26 packets. This is a round-level constant, not a
// packet-ID allowlist -- no packet ID ever appears literally in this file.
export const EXPECTED_POPULATION_PACKET_COUNT = 26;

const PACKET_ID_RE = /^u-[0-9a-f]{12}$/;
const FORBIDDEN_KEYS = new Set(["arm", "rank", "score", "winner"]);

export class ReviewerArtifactValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ReviewerArtifactValidationError";
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Recursively scans the entire parsed artifact for arm/rank/score/winner
// keys at any depth or array position -- "arm/rank/score/winner 필드가
// 어디에 있어도 거부". Case-insensitive on the key name.
function findForbiddenKey(value, at = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenKey(value[i], `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) return `${at}.${key}`;
    const found = findForbiddenKey(child, `${at}.${key}`);
    if (found) return found;
  }
  return null;
}

function isBoolean(value) {
  return typeof value === "boolean";
}

// rawBytes: the reviewer artifact file's actual bytes. All `expected*`
// options are ground truth the caller already holds from the frozen policy
// file and the population template -- there is no "trust me" fallback path.
export function validateReviewerArtifact(rawBytes, {
  expectedReviewerLabel = null,
  expectedSourceHead,
  expectedPolicySha256,
  expectedPacketCombinedSha256,
  expectedPacketIds,
  expectedPacketCount = EXPECTED_POPULATION_PACKET_COUNT,
} = {}) {
  if (!Buffer.isBuffer(rawBytes)) {
    throw new ReviewerArtifactValidationError("rawBytes must be a Buffer of the artifact's actual file contents", "REVIEWER_ARTIFACT_NOT_BUFFER");
  }
  if (expectedPacketIds === undefined || expectedPacketIds === null) {
    throw new ReviewerArtifactValidationError(
      "expectedPacketIds must be supplied by the caller from the population template -- this module never hardcodes or infers packet IDs",
      "REVIEWER_ARTIFACT_MISSING_EXPECTED_POPULATION",
    );
  }
  const expectedIdSet = new Set(expectedPacketIds);
  if (expectedIdSet.size !== expectedPacketCount) {
    throw new ReviewerArtifactValidationError(
      `expectedPacketIds must contain exactly ${expectedPacketCount} distinct ids, got ${expectedIdSet.size}`,
      "REVIEWER_ARTIFACT_EXPECTED_POPULATION_SIZE_MISMATCH",
    );
  }

  const fileSha256 = sha256Hex(rawBytes);

  let parsed;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch (error) {
    throw new ReviewerArtifactValidationError(`artifact is not valid JSON: ${error.message}`, "REVIEWER_ARTIFACT_NOT_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReviewerArtifactValidationError("artifact must be a JSON object", "REVIEWER_ARTIFACT_NOT_OBJECT");
  }

  const forbidden = findForbiddenKey(parsed);
  if (forbidden) {
    throw new ReviewerArtifactValidationError(
      `forbidden field found at ${forbidden} -- arm/rank/score/winner must never appear in an arm-blind reviewer artifact`,
      "REVIEWER_ARTIFACT_FORBIDDEN_FIELD",
      { path: forbidden },
    );
  }

  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new ReviewerArtifactValidationError(`schema_version must be ${SCHEMA_VERSION}`, "REVIEWER_ARTIFACT_SCHEMA_VERSION_MISMATCH", { actual: parsed.schema_version });
  }
  if (expectedReviewerLabel !== null && parsed.reviewer_label !== expectedReviewerLabel) {
    throw new ReviewerArtifactValidationError(
      `reviewer_label mismatch: expected ${JSON.stringify(expectedReviewerLabel)}, got ${JSON.stringify(parsed.reviewer_label)}`,
      "REVIEWER_ARTIFACT_LABEL_MISMATCH",
    );
  }
  if (typeof expectedSourceHead === "string" && parsed.source_head !== expectedSourceHead) {
    throw new ReviewerArtifactValidationError(
      `source_head mismatch: expected ${expectedSourceHead}, got ${parsed.source_head} -- this artifact may not have been produced against the frozen source snapshot`,
      "REVIEWER_ARTIFACT_SOURCE_HEAD_MISMATCH",
    );
  }
  if (typeof expectedPolicySha256 === "string" && parsed.policy_sha256 !== expectedPolicySha256) {
    throw new ReviewerArtifactValidationError(
      `policy_sha256 mismatch: expected ${expectedPolicySha256}, got ${parsed.policy_sha256} -- this artifact may have been produced against a different policy version`,
      "REVIEWER_ARTIFACT_POLICY_SHA_MISMATCH",
    );
  }
  if (typeof expectedPacketCombinedSha256 === "string" && parsed.packet_combined_sha256 !== expectedPacketCombinedSha256) {
    throw new ReviewerArtifactValidationError(
      `packet_combined_sha256 mismatch: expected ${expectedPacketCombinedSha256}, got ${parsed.packet_combined_sha256} -- this artifact may not cover the frozen population snapshot`,
      "REVIEWER_ARTIFACT_COMBINED_SHA_MISMATCH",
    );
  }
  if (parsed.owner_confirmed !== false) {
    throw new ReviewerArtifactValidationError(
      "owner_confirmed must be false -- an agent-produced reviewer artifact can never carry Owner confirmation",
      "REVIEWER_ARTIFACT_OWNER_CONFIRMED_FORBIDDEN",
    );
  }
  if (!Array.isArray(parsed.resolutions)) {
    throw new ReviewerArtifactValidationError("resolutions must be an array", "REVIEWER_ARTIFACT_RESOLUTIONS_NOT_ARRAY");
  }
  if (parsed.packet_count !== expectedPacketCount || parsed.resolutions.length !== expectedPacketCount) {
    throw new ReviewerArtifactValidationError(
      `expected exactly ${expectedPacketCount} packets`,
      "REVIEWER_ARTIFACT_PACKET_COUNT_MISMATCH",
      { declared_packet_count: parsed.packet_count, resolutions_length: parsed.resolutions.length },
    );
  }

  const seen = new Set();
  const outcomesByPacketId = {};
  for (const entry of parsed.resolutions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ReviewerArtifactValidationError("each resolutions entry must be an object", "REVIEWER_ARTIFACT_INVALID_ENTRY");
    }
    const packetId = entry.packet_id;
    if (typeof packetId !== "string" || !PACKET_ID_RE.test(packetId)) {
      throw new ReviewerArtifactValidationError(`invalid packet_id ${JSON.stringify(packetId)}`, "REVIEWER_ARTIFACT_INVALID_PACKET_ID_FORMAT");
    }
    if (seen.has(packetId)) {
      throw new ReviewerArtifactValidationError(`duplicate packet_id ${packetId}`, "REVIEWER_ARTIFACT_DUPLICATE_PACKET_ID", { packet_id: packetId });
    }
    if (!expectedIdSet.has(packetId)) {
      throw new ReviewerArtifactValidationError(
        `packet_id ${packetId} is not part of the frozen population template`,
        "REVIEWER_ARTIFACT_UNKNOWN_PACKET_ID",
        { packet_id: packetId },
      );
    }
    seen.add(packetId);

    if (!SENSITIVITY_OUTCOMES.includes(entry.sensitivity_outcome)) {
      throw new ReviewerArtifactValidationError(
        `sensitivity_outcome=${JSON.stringify(entry.sensitivity_outcome)} is not one of ${JSON.stringify(SENSITIVITY_OUTCOMES)}`,
        "REVIEWER_ARTIFACT_INVALID_OUTCOME",
        { packet_id: packetId },
      );
    }

    const checks = entry.acceptance_checks;
    if (!checks || typeof checks !== "object" || Array.isArray(checks)) {
      throw new ReviewerArtifactValidationError(`acceptance_checks must be an object for packet ${packetId}`, "REVIEWER_ARTIFACT_MISSING_ACCEPTANCE_CHECKS", { packet_id: packetId });
    }
    const checkKeys = Object.keys(checks);
    const hasExactKeys = checkKeys.length === ACCEPTANCE_CONDITIONS.length && ACCEPTANCE_CONDITIONS.every((key) => checkKeys.includes(key));
    if (!hasExactKeys) {
      throw new ReviewerArtifactValidationError(
        `acceptance_checks must contain exactly the frozen 6 conditions for packet ${packetId}`,
        "REVIEWER_ARTIFACT_ACCEPTANCE_CHECKS_KEY_MISMATCH",
        { packet_id: packetId, actual_keys: checkKeys },
      );
    }
    for (const key of ACCEPTANCE_CONDITIONS) {
      if (!isBoolean(checks[key])) {
        throw new ReviewerArtifactValidationError(
          `acceptance_checks.${key} must be a boolean for packet ${packetId}`,
          "REVIEWER_ARTIFACT_ACCEPTANCE_CHECK_NOT_BOOLEAN",
          { packet_id: packetId, key },
        );
      }
    }
    if (entry.sensitivity_outcome === "SUPPORTED_ALTERNATE_NODE") {
      const allTrue = ACCEPTANCE_CONDITIONS.every((key) => checks[key] === true);
      if (!allTrue) {
        throw new ReviewerArtifactValidationError(
          `SUPPORTED_ALTERNATE_NODE requires all 6 acceptance_checks to be true for packet ${packetId}`,
          "REVIEWER_ARTIFACT_SUPPORTED_REQUIRES_ALL_CHECKS_TRUE",
          { packet_id: packetId },
        );
      }
    }
    if (entry.owner_confirmed !== false) {
      throw new ReviewerArtifactValidationError(`resolutions entry owner_confirmed must be false for packet ${packetId}`, "REVIEWER_ARTIFACT_ENTRY_OWNER_CONFIRMED_FORBIDDEN", { packet_id: packetId });
    }
    if (typeof entry.note !== "string") {
      throw new ReviewerArtifactValidationError(`note must be a string for packet ${packetId}`, "REVIEWER_ARTIFACT_NOTE_NOT_STRING", { packet_id: packetId });
    }

    outcomesByPacketId[packetId] = entry.sensitivity_outcome;
  }

  const missing = [...expectedIdSet].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new ReviewerArtifactValidationError(
      `missing ${missing.length} packet id(s) from the frozen population`,
      "REVIEWER_ARTIFACT_MISSING_PACKET_IDS",
      { missing: missing.sort() },
    );
  }
  // At this point seen.size === expectedPacketCount === expectedIdSet.size,
  // every seen id is a member of expectedIdSet (unknown-id check above), and
  // every expectedIdSet id is a member of seen (missing check above) -- so
  // seen === expectedIdSet exactly: no duplicates, no omissions, no extras.

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    file_sha256: fileSha256,
    reviewer_label: parsed.reviewer_label ?? null,
    source_head: parsed.source_head,
    policy_sha256: parsed.policy_sha256,
    packet_combined_sha256: parsed.packet_combined_sha256,
    packet_count: parsed.resolutions.length,
    owner_confirmed: false,
    outcomes_by_packet_id: Object.freeze(outcomesByPacketId),
  });
}
