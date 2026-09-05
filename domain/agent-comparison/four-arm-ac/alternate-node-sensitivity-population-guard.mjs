// FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1: fail-closed guard for the
// alternate-node sensitivity POPULATION TEMPLATE (the output of
// scripts/p11f0-fourarm-alternate-node-population.mjs). Every downstream
// module (reviewer-artifact-validator, reviewer-comparison, adjudication
// adapter) reads its set of legal packet IDs from THIS module's output --
// never from a literal fixture -- so no packet ID is ever hardcoded or
// allowlisted anywhere in this harness.
//
// This module also enforces "전체 모집단 강제": the template must declare
// itself as the complete A+B+C+D duplicate_evidence_different_node batch
// (population_scope === ALL_A_B_C_D_FULL_BATCH). A template restricted to
// one arm, one question, or the packets that motivated the amendment is
// rejected, not silently accepted as a smaller-but-valid population.
import { createHash } from "node:crypto";

export const POPULATION_TEMPLATE_SCHEMA_VERSION = "fourarm.alternate-node-sensitivity-review-template.v1";
export const EXPECTED_POPULATION_REASON = "duplicate_evidence_different_node";
export const EXPECTED_POPULATION_SCOPE = "ALL_A_B_C_D_FULL_BATCH";
// Frozen fact about this specific sensitivity round -- see the matching
// constant and comment in alternate-node-sensitivity-reviewer-artifact-validator.mjs.
export const EXPECTED_POPULATION_PACKET_COUNT = 26;

const PACKET_ID_RE = /^u-[0-9a-f]{12}$/;
const PACKET_SHA256_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set(["arm", "rank", "score", "winner", "candidate"]);

export class PopulationGuardError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PopulationGuardError";
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

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

// rawBytes: the population template file's actual bytes (never a re-typed
// literal). expectedPacketCount defaults to this round's frozen 26 but can
// be overridden by tests that exercise the guard's logic in isolation from
// this specific round's frozen number.
export function validatePopulationTemplate(rawBytes, { expectedPacketCount = EXPECTED_POPULATION_PACKET_COUNT } = {}) {
  if (!Buffer.isBuffer(rawBytes)) {
    throw new PopulationGuardError("rawBytes must be a Buffer of the population template's actual file contents", "POPULATION_GUARD_NOT_BUFFER");
  }

  const fileSha256 = sha256Hex(rawBytes);
  let parsed;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch (error) {
    throw new PopulationGuardError(`population template is not valid JSON: ${error.message}`, "POPULATION_GUARD_NOT_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PopulationGuardError("population template must be a JSON object", "POPULATION_GUARD_NOT_OBJECT");
  }

  const forbidden = findForbiddenKey(parsed);
  if (forbidden) {
    throw new PopulationGuardError(
      `forbidden field found at ${forbidden} -- the population template must stay arm-blind`,
      "POPULATION_GUARD_FORBIDDEN_FIELD",
      { path: forbidden },
    );
  }

  if (parsed.schema_version !== POPULATION_TEMPLATE_SCHEMA_VERSION) {
    throw new PopulationGuardError(`schema_version must be ${POPULATION_TEMPLATE_SCHEMA_VERSION}`, "POPULATION_GUARD_SCHEMA_VERSION_MISMATCH", { actual: parsed.schema_version });
  }
  if (parsed.reason !== EXPECTED_POPULATION_REASON) {
    throw new PopulationGuardError(`reason must be ${EXPECTED_POPULATION_REASON}`, "POPULATION_GUARD_REASON_MISMATCH", { actual: parsed.reason });
  }
  // The core "no partial population" gate: anything other than the exact
  // full-batch marker is rejected, including a missing field, a per-arm
  // scope, or a motivating-packets-only scope.
  if (parsed.population_scope !== EXPECTED_POPULATION_SCOPE) {
    throw new PopulationGuardError(
      `population_scope must be ${EXPECTED_POPULATION_SCOPE} -- a partial (single-arm or motivating-packet-only) population is not a valid sensitivity population`,
      "POPULATION_GUARD_PARTIAL_POPULATION_REJECTED",
      { actual: parsed.population_scope },
    );
  }
  if (parsed.owner_confirmed !== false) {
    throw new PopulationGuardError("owner_confirmed must be false on a population template", "POPULATION_GUARD_OWNER_CONFIRMED_FORBIDDEN");
  }
  if (!Array.isArray(parsed.resolutions)) {
    throw new PopulationGuardError("resolutions must be an array", "POPULATION_GUARD_RESOLUTIONS_NOT_ARRAY");
  }
  if (parsed.packet_count !== expectedPacketCount || parsed.resolutions.length !== expectedPacketCount) {
    throw new PopulationGuardError(
      `expected exactly ${expectedPacketCount} packets in the full A+B+C+D population, got packet_count=${parsed.packet_count} / resolutions.length=${parsed.resolutions.length}`,
      "POPULATION_GUARD_PACKET_COUNT_MISMATCH",
      { declared_packet_count: parsed.packet_count, resolutions_length: parsed.resolutions.length },
    );
  }
  if (typeof parsed.packet_combined_sha256 !== "string" || !PACKET_SHA256_RE.test(parsed.packet_combined_sha256)) {
    throw new PopulationGuardError("packet_combined_sha256 must be a 64-hex-character sha256 digest", "POPULATION_GUARD_INVALID_COMBINED_SHA");
  }

  const packetIds = [];
  const packetSha256ById = {};
  const seen = new Set();
  for (const entry of parsed.resolutions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PopulationGuardError("each resolutions entry must be an object", "POPULATION_GUARD_INVALID_ENTRY");
    }
    const packetId = entry.packet_id;
    if (typeof packetId !== "string" || !PACKET_ID_RE.test(packetId)) {
      throw new PopulationGuardError(`invalid packet_id ${JSON.stringify(packetId)}`, "POPULATION_GUARD_INVALID_PACKET_ID_FORMAT");
    }
    if (seen.has(packetId)) {
      throw new PopulationGuardError(`duplicate packet_id ${packetId} in population template`, "POPULATION_GUARD_DUPLICATE_PACKET_ID", { packet_id: packetId });
    }
    seen.add(packetId);
    if (typeof entry.packet_sha256 !== "string" || !PACKET_SHA256_RE.test(entry.packet_sha256)) {
      throw new PopulationGuardError(`invalid packet_sha256 for packet ${packetId}`, "POPULATION_GUARD_INVALID_PACKET_SHA256", { packet_id: packetId });
    }
    packetIds.push(packetId);
    packetSha256ById[packetId] = entry.packet_sha256;
  }

  return Object.freeze({
    schema_version: POPULATION_TEMPLATE_SCHEMA_VERSION,
    file_sha256: fileSha256,
    reason: parsed.reason,
    population_scope: parsed.population_scope,
    packet_count: parsed.resolutions.length,
    packet_combined_sha256: parsed.packet_combined_sha256,
    packet_ids: Object.freeze([...packetIds].sort()),
    packet_sha256_by_id: Object.freeze(packetSha256ById),
  });
}
