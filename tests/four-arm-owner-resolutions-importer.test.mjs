import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateOwnerResolutionsArtifact, deriveHardGateFromOwnerResolutions,
  OwnerResolutionsValidationError, RESOLUTION_CLASSES,
} from "../domain/agent-comparison/four-arm-ac/four-arm-owner-resolutions-importer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/official");
const EXPECTED_FILE_SHA256 = "90940c7d514220169c2873d14a3aecd1dda328b8782b808697f65036b6cceeba";
const EXPECTED_PACKET_COMBINED_SHA256 = "e65cf7f5372cb007f4e94ef70542a0492ee147d980dea5d56f22c7ffc0c3b2a4";
const EXPECTED_CRITICAL_IDS = ["u-1b6cd184a87f", "u-8564414f6080"];

function buildFixture({ packetCount = 17, criticalCount = 2, unknownCount = 15, commonSourceCount = 0, rejectEquivalentEvidence = true } = {}) {
  const resolutions = {};
  for (let i = 0; i < criticalCount; i += 1) resolutions[`crit_${i}`] = { classification: "ARM_SPECIFIC", critical: true, note: "x" };
  for (let i = 0; i < unknownCount; i += 1) resolutions[`unk_${i}`] = { classification: "UNKNOWN", critical: false, note: "x" };
  for (let i = 0; i < commonSourceCount; i += 1) resolutions[`common_${i}`] = { classification: "COMMON_SOURCE", critical: false, note: "x" };
  const total = Object.keys(resolutions).length;
  return {
    review: {
      packet_combined_sha256: "f".repeat(64),
      adjudicated_at: "2026-09-05T06:08:29Z",
      method: "arm-blind review",
      superseded_file_rejected: rejectEquivalentEvidence ? "resolutions.proposed.json used EQUIVALENT_EVIDENCE, not defined in spec -- rejected" : "nothing rejected",
      adjudicator: "someone@example.com",
    },
    resolutions,
    distribution: { total, critical: criticalCount, ARM_SPECIFIC: criticalCount, COMMON_SOURCE: commonSourceCount, UNKNOWN: unknownCount },
  };
}

function toBuffer(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8");
}

test("real imported artifact: resolutions.owner.json matches the pinned file SHA and packet_combined_sha256 exactly", async () => {
  const raw = await readFile(path.join(OFFICIAL_DIR, "resolutions.owner.json"));
  const result = validateOwnerResolutionsArtifact(raw, {
    expectedFileSha256: EXPECTED_FILE_SHA256,
    expectedPacketCombinedSha256: EXPECTED_PACKET_COMBINED_SHA256,
    expectedDistribution: { critical: 2, ARM_SPECIFIC: 2, COMMON_SOURCE: 0, UNKNOWN: 15 },
    expectedCriticalPacketIds: EXPECTED_CRITICAL_IDS,
  });
  assert.equal(result.file_sha256, EXPECTED_FILE_SHA256);
  assert.equal(result.packet_combined_sha256, EXPECTED_PACKET_COMBINED_SHA256);
  assert.equal(result.official_execution_ready, true);
  assert.deepEqual(result.critical_packet_ids, EXPECTED_CRITICAL_IDS);
  assert.equal(result.unknown_packet_ids.length, 15);
  assert.equal(result.distribution.critical, 2);
});

test("real imported artifact never exposes the adjudicator field in its validated output", async () => {
  const raw = await readFile(path.join(OFFICIAL_DIR, "resolutions.owner.json"));
  const result = validateOwnerResolutionsArtifact(raw, { expectedFileSha256: EXPECTED_FILE_SHA256 });
  assert.equal(Object.prototype.hasOwnProperty.call(result, "adjudicator"), false);
  assert.equal(JSON.stringify(result).includes("@"), false);
});

test("fail-closed: wrong file sha256 (Owner file SHA mismatch)", () => {
  assert.throws(
    () => validateOwnerResolutionsArtifact(toBuffer(buildFixture()), { expectedFileSha256: "0".repeat(64) }),
    (e) => e instanceof OwnerResolutionsValidationError && e.code === "OWNER_RESOLUTIONS_SHA256_MISMATCH",
  );
});

test("fail-closed: packet_combined_sha256 mismatch against the externally known packet set", () => {
  assert.throws(
    () => validateOwnerResolutionsArtifact(toBuffer(buildFixture()), { expectedPacketCombinedSha256: "0".repeat(64) }),
    (e) => e.code === "OWNER_RESOLUTIONS_PACKET_COMBINED_SHA_MISMATCH",
  );
});

test("fail-closed: EQUIVALENT_EVIDENCE not explicitly rejected in review notes", () => {
  assert.throws(
    () => validateOwnerResolutionsArtifact(toBuffer(buildFixture({ rejectEquivalentEvidence: false }))),
    (e) => e.code === "OWNER_RESOLUTIONS_EQUIVALENT_EVIDENCE_NOT_REJECTED",
  );
});

test("fail-closed: an invalid classification outside RESOLUTION_CLASSES is rejected -- no automatic UNKNOWN resolution reads through", () => {
  const fixture = buildFixture();
  fixture.resolutions.crit_0.classification = "EQUIVALENT_EVIDENCE";
  fixture.resolutions.crit_0.critical = false;
  assert.throws(
    () => validateOwnerResolutionsArtifact(toBuffer(fixture)),
    (e) => e.code === "OWNER_RESOLUTIONS_INVALID_CLASSIFICATION",
  );
});

test("fail-closed: critical=true on a non-ARM_SPECIFIC packet is a contradiction", () => {
  const fixture = buildFixture();
  fixture.resolutions.unk_0.critical = true;
  fixture.distribution.critical += 1;
  assert.throws(
    () => validateOwnerResolutionsArtifact(toBuffer(fixture)),
    (e) => e.code === "OWNER_RESOLUTIONS_CRITICAL_ON_NON_ARM_SPECIFIC",
  );
});

test("fail-closed: distribution counts must match the recomputed counts exactly", () => {
  const fixture = buildFixture();
  fixture.distribution.UNKNOWN = 14; // real count is 15
  assert.throws(
    () => validateOwnerResolutionsArtifact(toBuffer(fixture)),
    (e) => e.code === "OWNER_RESOLUTIONS_DISTRIBUTION_MISMATCH",
  );
});

test("fail-closed: wrong packet count", () => {
  assert.throws(
    () => validateOwnerResolutionsArtifact(toBuffer(buildFixture({ unknownCount: 14 })), { expectedPacketCount: 17 }),
    (e) => e.code === "OWNER_RESOLUTIONS_PACKET_COUNT_MISMATCH",
  );
});

test("fail-closed: unexpected critical packet id set", () => {
  assert.throws(
    () => validateOwnerResolutionsArtifact(toBuffer(buildFixture()), { expectedCriticalPacketIds: ["u-does-not-exist"] }),
    (e) => e.code === "OWNER_RESOLUTIONS_CRITICAL_PACKET_SET_MISMATCH",
  );
});

test("every RESOLUTION_CLASSES entry round-trips through a valid fixture", () => {
  assert.deepEqual(RESOLUTION_CLASSES, ["COMMON_SOURCE", "ARM_SPECIFIC", "UNKNOWN"]);
  const fixture = buildFixture({ criticalCount: 1, unknownCount: 1, commonSourceCount: 1 });
  const result = validateOwnerResolutionsArtifact(toBuffer(fixture), { expectedPacketCount: 3 });
  assert.equal(result.distribution.ARM_SPECIFIC, 1);
  assert.equal(result.distribution.UNKNOWN, 1);
  assert.equal(result.distribution.COMMON_SOURCE, 1);
});

test("deriveHardGateFromOwnerResolutions: critical>0 fails the hard gate and marks ineligible", async () => {
  const raw = await readFile(path.join(OFFICIAL_DIR, "resolutions.owner.json"));
  const summary = validateOwnerResolutionsArtifact(raw, { expectedFileSha256: EXPECTED_FILE_SHA256 });
  const gate = deriveHardGateFromOwnerResolutions(summary);
  assert.equal(gate.hard_gate_state, "HARD_GATE_FAILED");
  assert.equal(gate.selection_eligible, false);
  assert.equal(gate.failure_reason, "ARM_SPECIFIC_CRITICAL_2");
  assert.equal(gate.unknown_packet_count, 15);
  assert.deepEqual(gate.critical_packet_ids, EXPECTED_CRITICAL_IDS);
});

test("deriveHardGateFromOwnerResolutions: zero critical packets passes the hard gate", () => {
  const summary = validateOwnerResolutionsArtifact(toBuffer(buildFixture({ criticalCount: 0, unknownCount: 17 })));
  const gate = deriveHardGateFromOwnerResolutions(summary);
  assert.equal(gate.hard_gate_state, "HARD_GATE_PASSED");
  assert.equal(gate.selection_eligible, true);
  assert.equal(gate.failure_reason, null);
});

test("UNKNOWN packets never fail the hard gate by themselves -- they stay provisional info", () => {
  const summary = validateOwnerResolutionsArtifact(toBuffer(buildFixture({ criticalCount: 0, unknownCount: 17 })));
  const gate = deriveHardGateFromOwnerResolutions(summary);
  assert.equal(gate.hard_gate_state, "HARD_GATE_PASSED");
  assert.equal(gate.unknown_packet_count, 17);
  assert.equal(gate.unknown_disposition, "PROVISIONAL_OWNER_ARM_BLIND_ADJUDICATION_PENDING");
});
