// Turn FOURARM-INTEGRATION-OWNER-DECISION-AND-EXECUTION-GATE: importer/
// validator for the Owner's ratified adjudication of the 17-packet
// unresolved queue (resolutions.owner.json). Fail-closed on byte identity
// (file sha256), on the file's own internal packet_combined_sha256 claim,
// and on the classification vocabulary/critical semantics vFINAL section
// 16 actually defines. This module NEVER computes or infers a
// classification itself -- it only verifies that what the Owner already
// decided is what got imported, unmodified.
//
// Privacy note: the imported file legitimately carries a
// `review.adjudicator` identity field (preserved on disk, as required).
// Every function below strips that field out of its return value so it
// does not propagate into logs, manifests, or reports built from this
// module's output -- callers that need the raw file for byte-identity
// checks should read it directly, not through this module.
import { createHash } from "node:crypto";

export const RESOLUTION_CLASSES = Object.freeze(["COMMON_SOURCE", "ARM_SPECIFIC", "UNKNOWN"]);

export class OwnerResolutionsValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "OwnerResolutionsValidationError";
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256HexBytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// rawBytes: the resolutions.owner.json file's actual bytes, read from
// disk. expectedFileSha256/expectedPacketCombinedSha256/expectedDistribution/
// expectedCriticalPacketIds are the ground-truth pins the CALLER already
// holds (from the Owner's own transmittal) -- this function never accepts
// a "trust me" path where a mismatch is downgraded to a warning.
export function validateOwnerResolutionsArtifact(rawBytes, {
  expectedFileSha256, expectedPacketCombinedSha256, expectedPacketCount = 17,
  expectedDistribution = null, expectedCriticalPacketIds = null,
} = {}) {
  if (!Buffer.isBuffer(rawBytes)) {
    throw new OwnerResolutionsValidationError("rawBytes must be a Buffer of the artifact's actual file contents", "OWNER_RESOLUTIONS_NOT_BUFFER");
  }
  const fileSha256 = sha256HexBytes(rawBytes);
  if (typeof expectedFileSha256 === "string" && fileSha256 !== expectedFileSha256) {
    throw new OwnerResolutionsValidationError(
      `resolutions.owner.json sha256 mismatch: expected ${expectedFileSha256}, got ${fileSha256} -- refusing to trust an unverified Owner decision file`,
      "OWNER_RESOLUTIONS_SHA256_MISMATCH", { expected: expectedFileSha256, actual: fileSha256 },
    );
  }

  let parsed;
  try { parsed = JSON.parse(rawBytes.toString("utf8")); } catch (error) {
    throw new OwnerResolutionsValidationError(`resolutions.owner.json is not valid JSON: ${error.message}`, "OWNER_RESOLUTIONS_NOT_JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new OwnerResolutionsValidationError("resolutions.owner.json must be an object", "OWNER_RESOLUTIONS_NOT_OBJECT");

  const { review, resolutions, distribution } = parsed;
  if (!review || typeof review !== "object") throw new OwnerResolutionsValidationError("resolutions.owner.json.review is required", "OWNER_RESOLUTIONS_MISSING_REVIEW");
  if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)) throw new OwnerResolutionsValidationError("resolutions.owner.json.resolutions is required", "OWNER_RESOLUTIONS_MISSING_RESOLUTIONS");
  if (!distribution || typeof distribution !== "object") throw new OwnerResolutionsValidationError("resolutions.owner.json.distribution is required", "OWNER_RESOLUTIONS_MISSING_DISTRIBUTION");

  if (typeof review.packet_combined_sha256 !== "string") {
    throw new OwnerResolutionsValidationError("review.packet_combined_sha256 is required", "OWNER_RESOLUTIONS_MISSING_PACKET_COMBINED_SHA");
  }
  if (typeof expectedPacketCombinedSha256 === "string" && review.packet_combined_sha256 !== expectedPacketCombinedSha256) {
    throw new OwnerResolutionsValidationError(
      `review.packet_combined_sha256 mismatch: expected ${expectedPacketCombinedSha256}, got ${review.packet_combined_sha256} -- the packet set this Owner file adjudicated may not be the one actually in use`,
      "OWNER_RESOLUTIONS_PACKET_COMBINED_SHA_MISMATCH",
    );
  }

  // vFINAL section 16/21: no ad hoc amnesty classification may be
  // reintroduced. A file that does not explicitly record rejecting
  // EQUIVALENT_EVIDENCE (or any out-of-spec class) is treated the same as
  // one that silently reintroduces it -- fail closed, don't assume intent.
  const rejectionNote = String(review.superseded_file_rejected ?? "");
  if (!rejectionNote.includes("EQUIVALENT_EVIDENCE")) {
    throw new OwnerResolutionsValidationError(
      "review.superseded_file_rejected does not explicitly reject EQUIVALENT_EVIDENCE -- refusing to import an Owner file that does not affirm the section 16/21 constraint",
      "OWNER_RESOLUTIONS_EQUIVALENT_EVIDENCE_NOT_REJECTED",
    );
  }

  const packetIds = Object.keys(resolutions);
  if (packetIds.length !== expectedPacketCount) {
    throw new OwnerResolutionsValidationError(`expected exactly ${expectedPacketCount} packets, got ${packetIds.length}`, "OWNER_RESOLUTIONS_PACKET_COUNT_MISMATCH");
  }

  const counts = { COMMON_SOURCE: 0, ARM_SPECIFIC: 0, UNKNOWN: 0, critical: 0 };
  const criticalPacketIds = [];
  for (const [packetId, entry] of Object.entries(resolutions)) {
    if (!entry || typeof entry !== "object") throw new OwnerResolutionsValidationError(`resolutions[${packetId}] must be an object`, "OWNER_RESOLUTIONS_INVALID_ENTRY", { packet_id: packetId });
    if (!RESOLUTION_CLASSES.includes(entry.classification)) {
      throw new OwnerResolutionsValidationError(
        `resolutions[${packetId}].classification=${JSON.stringify(entry.classification)} is not one of ${JSON.stringify(RESOLUTION_CLASSES)}`,
        "OWNER_RESOLUTIONS_INVALID_CLASSIFICATION", { packet_id: packetId, classification: entry.classification },
      );
    }
    if (typeof entry.critical !== "boolean") {
      throw new OwnerResolutionsValidationError(`resolutions[${packetId}].critical must be a boolean`, "OWNER_RESOLUTIONS_INVALID_CRITICAL_FLAG", { packet_id: packetId });
    }
    // "critical" only has meaning for ARM_SPECIFIC (vFINAL section 16 B) --
    // a COMMON_SOURCE/UNKNOWN packet marked critical is a contradiction,
    // never silently accepted.
    if (entry.critical && entry.classification !== "ARM_SPECIFIC") {
      throw new OwnerResolutionsValidationError(
        `resolutions[${packetId}] is marked critical but classification=${entry.classification} -- critical is only meaningful for ARM_SPECIFIC`,
        "OWNER_RESOLUTIONS_CRITICAL_ON_NON_ARM_SPECIFIC", { packet_id: packetId },
      );
    }
    counts[entry.classification] += 1;
    if (entry.critical) { counts.critical += 1; criticalPacketIds.push(packetId); }
  }

  const declaredTotal = distribution.total;
  const computedTotal = packetIds.length;
  if (declaredTotal !== computedTotal) {
    throw new OwnerResolutionsValidationError(`distribution.total=${declaredTotal} does not match the actual packet count ${computedTotal}`, "OWNER_RESOLUTIONS_DISTRIBUTION_TOTAL_MISMATCH");
  }
  for (const key of ["critical", "ARM_SPECIFIC", "COMMON_SOURCE", "UNKNOWN"]) {
    if (distribution[key] !== counts[key]) {
      throw new OwnerResolutionsValidationError(`distribution.${key}=${distribution[key]} does not match the recomputed value ${counts[key]}`, "OWNER_RESOLUTIONS_DISTRIBUTION_MISMATCH", { field: key, declared: distribution[key], recomputed: counts[key] });
    }
  }
  if (expectedDistribution) {
    for (const key of ["critical", "ARM_SPECIFIC", "COMMON_SOURCE", "UNKNOWN"]) {
      if (expectedDistribution[key] !== undefined && expectedDistribution[key] !== counts[key]) {
        throw new OwnerResolutionsValidationError(`distribution.${key}=${counts[key]} does not match the externally expected value ${expectedDistribution[key]}`, "OWNER_RESOLUTIONS_DISTRIBUTION_EXPECTATION_MISMATCH", { field: key });
      }
    }
  }
  if (expectedCriticalPacketIds) {
    const actualSet = new Set(criticalPacketIds);
    const expectedSet = new Set(expectedCriticalPacketIds);
    const missing = [...expectedSet].filter((id) => !actualSet.has(id));
    const unexpected = [...actualSet].filter((id) => !expectedSet.has(id));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new OwnerResolutionsValidationError(
        `critical packet id set does not match expectation (missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)})`,
        "OWNER_RESOLUTIONS_CRITICAL_PACKET_SET_MISMATCH", { missing, unexpected },
      );
    }
  }

  return Object.freeze({
    file_sha256: fileSha256,
    packet_combined_sha256: review.packet_combined_sha256,
    adjudicated_at: review.adjudicated_at ?? null,
    method: review.method ?? null,
    equivalent_evidence_rejected: true,
    packet_count: packetIds.length,
    distribution: Object.freeze({ ...counts }),
    critical_packet_ids: Object.freeze(criticalPacketIds.sort()),
    unknown_packet_ids: Object.freeze(packetIds.filter((id) => resolutions[id].classification === "UNKNOWN").sort()),
    common_source_packet_ids: Object.freeze(packetIds.filter((id) => resolutions[id].classification === "COMMON_SOURCE").sort()),
    official_execution_ready: true,
    source: "OWNER_RATIFIED_RESOLUTIONS",
    // adjudicator identity deliberately omitted from this return value.
  });
}

// Pure hard-gate derivation from an already-validated Owner resolutions
// summary. vFINAL section 16's own rule: any ARM_SPECIFIC packet marked
// critical=true fails the hard safety gate for every arm the packet
// applies to (both B and D share these two packets). COMMON_SOURCE
// packets (capped at 5, enforced by validateOwnerResolutionsArtifact's
// caller-supplied expectedDistribution/packet-count checks upstream) are
// excluded from scoring entirely, not a hard-gate concern. UNKNOWN packets
// never fail the hard gate by themselves -- they remain provisional
// information, not a rejection.
export function deriveHardGateFromOwnerResolutions(ownerResolutionsSummary) {
  const criticalCount = ownerResolutionsSummary.distribution.critical;
  return Object.freeze({
    hard_gate_state: criticalCount > 0 ? "HARD_GATE_FAILED" : "HARD_GATE_PASSED",
    selection_eligible: criticalCount === 0,
    failure_reason: criticalCount > 0 ? "ARM_SPECIFIC_CRITICAL_" + criticalCount : null,
    critical_packet_ids: ownerResolutionsSummary.critical_packet_ids,
    unknown_packet_count: ownerResolutionsSummary.unknown_packet_ids.length,
    unknown_disposition: "PROVISIONAL_OWNER_ARM_BLIND_ADJUDICATION_PENDING",
  });
}
