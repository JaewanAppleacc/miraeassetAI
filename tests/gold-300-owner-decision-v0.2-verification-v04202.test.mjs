// Turn N4.20.2 (corrected): regression coverage for the real Owner
// decision INGESTION + verification/recording script. The core fix this
// Turn makes: a decision must be ingested from an explicit sourcePath on
// disk (never accepted as inline/pasted text) before it can be verified
// or recorded. Runs against the REAL, actually-downloaded decision file
// and the real, read-only N4.20 outputs. Never trusts the decision's own
// self-reported counts or SHAs -- everything is independently recomputed
// from live data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ingestGold300OwnerDecisionV02,
  verifyAndRecordGold300OwnerDecisionV02,
  REAL_DECISION_PATH,
  VERIFICATION_STATUS_PATH,
} from "../scripts/build-gold-300-owner-decision-v0.2-verification-v04202.mjs";
import { TEMPLATE_STATUS_PATH } from "../scripts/build-gold-300-owner-review-v0.2-v04201.mjs";
import { ACTIVE_DECISION_PIN } from "../domain/evaluation/gold-300-owner-decision-provenance.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

const OWNER_REVIEW_V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/owner-review-v0.2");
const INGESTION_PROVENANCE_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision-ingestion-provenance.v0.2.json");

// Snapshot the genuine, already-ingested real decision's bytes AND its
// persisted ingestion-provenance record once at module load. A fixture
// ingestion (in the tests below) overwrites BOTH files -- restoring only
// the decision bytes and not the provenance record would leave the
// provenance record permanently pointing at the fixture's (non-download)
// evidence even after the decision content itself was restored.
const GENUINE_DECISION_BYTES = readFileSync(REAL_DECISION_PATH);
const GENUINE_PROVENANCE_BYTES = readFileSync(INGESTION_PROVENANCE_PATH);
function restoreGenuineDecision() {
  writeFileSync(REAL_DECISION_PATH, GENUINE_DECISION_BYTES);
  writeFileSync(INGESTION_PROVENANCE_PATH, GENUINE_PROVENANCE_BYTES);
  return verifyAndRecordGold300OwnerDecisionV02();
}
test.after(() => { restoreGenuineDecision(); });

// -- ingestGold300OwnerDecisionV02 -----------------------------------------

test("ingestGold300OwnerDecisionV02: requires an explicit sourcePath -- throws if omitted or pointing at a nonexistent file (never accepts inline/pasted content as a substitute)", () => {
  assert.throws(() => ingestGold300OwnerDecisionV02({}), /sourcePath is required/);
  assert.throws(() => ingestGold300OwnerDecisionV02({ sourcePath: "/definitely/does/not/exist.json" }), /does not exist/);
});

test("ingestGold300OwnerDecisionV02: copies a real source file byte-for-byte and verifies the copy's SHA-256 matches the source exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "gold300-ingest-test-"));
  const fixturePath = join(dir, "fixture-decision.json");
  const fixtureBytes = Buffer.from(`${JSON.stringify({ hello: "world", n: 1 })}\n`, "utf8");
  writeFileSync(fixturePath, fixtureBytes);
  try {
    const result = ingestGold300OwnerDecisionV02({ sourcePath: fixturePath });
    assert.equal(result.sha256, sha256(fixtureBytes));
    assert.equal(sha256(readFileSync(REAL_DECISION_PATH)), sha256(fixtureBytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreGenuineDecision();
  }
});

test("ingestGold300OwnerDecisionV02: a locally-created fixture file (never downloaded through a browser) correctly reports has_quarantine_marker=false -- the provenance check is real, not a rubber stamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "gold300-ingest-test-"));
  const fixturePath = join(dir, "fixture-decision.json");
  writeFileSync(fixturePath, `${JSON.stringify({ a: 1 })}\n`);
  try {
    const result = ingestGold300OwnerDecisionV02({ sourcePath: fixturePath });
    assert.equal(result.provenance.checked, true);
    assert.equal(result.provenance.has_quarantine_marker, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreGenuineDecision();
  }
});

test("ingestGold300OwnerDecisionV02: rejects a source file that is not valid JSON before ever copying it", () => {
  const dir = mkdtempSync(join(tmpdir(), "gold300-ingest-test-"));
  const fixturePath = join(dir, "not-json.json");
  writeFileSync(fixturePath, "this is not json {{{");
  const before = readFileSync(REAL_DECISION_PATH);
  try {
    assert.throws(() => ingestGold300OwnerDecisionV02({ sourcePath: fixturePath }));
    assert.deepEqual(readFileSync(REAL_DECISION_PATH), before, "REAL_DECISION_PATH must be untouched when ingestion fails validation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- verifyAndRecordGold300OwnerDecisionV02 (real, already-ingested) ------

test("verifyAndRecordGold300OwnerDecisionV02: the real, genuinely-downloaded decision independently re-verifies as a genuine approval, with zero domain or provenance violations, and reports quarantine provenance evidence", () => {
  restoreGenuineDecision();
  const result = verifyAndRecordGold300OwnerDecisionV02();
  assert.equal(result.allOk, true);
  assert.equal(result.isGenuineApproval, true);
  assert.deepEqual(result.verificationReport.domain_verification.violations, []);
  assert.deepEqual(result.verificationReport.provenance_verification.violations, []);
  assert.equal(result.verificationReport.ingestion_provenance.has_quarantine_marker, true);
});

test("verifyAndRecordGold300OwnerDecisionV02: writes its OWN status filename, distinct from the v0.2 UI builder's PENDING-default template-status file -- the two must never collide", () => {
  restoreGenuineDecision();
  assert.notEqual(VERIFICATION_STATUS_PATH, TEMPLATE_STATUS_PATH);
  const recorded = readJson(VERIFICATION_STATUS_PATH);
  assert.equal(recorded.gold_300_plan_authorized, true);
});

test("verifyAndRecordGold300OwnerDecisionV02: the recorded gate status reflects gold_300_plan_authorized/eligible_authoring_authorized/holdout_authoring_authorized=true while every other authorization stays false", () => {
  const result = restoreGenuineDecision();
  const gate = result.recordedGateStatus;
  assert.equal(gate.gold_300_plan_authorized, true);
  assert.equal(gate.eligible_authoring_authorized, true);
  assert.equal(gate.holdout_authoring_authorized, true);
  assert.equal(gate.blocked_authoring_authorized, false);
  assert.equal(gate.holdout_agent_access_authorized, false);
  assert.equal(gate.holdout_evaluation_authorized, false);
  assert.equal(gate.production_wiring_authorized, false);
  assert.equal(gate.agent_ranking_authorized, false);
  assert.equal(gate.relation_decisions_authorized, false);
  assert.equal(gate.actual_official_promotion_applied, false);
  assert.equal(gate.status, "GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING_RECORDED");
});

test("verifyAndRecordGold300OwnerDecisionV02: the written verification report on disk matches the returned report exactly, and pins the real decision file's own SHA-256 and decision_id", () => {
  restoreGenuineDecision();
  const onDisk = readJson(resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision-verification-report.v0.2.json"));
  assert.equal(onDisk.all_checks_passed, true);
  assert.equal(onDisk.decision_sha256, sha256(readFileSync(REAL_DECISION_PATH)));
  assert.equal(onDisk.decision_id, "93c5b69c-6e37-46fd-b319-17179a0d6402");
  assert.equal(onDisk.owner, "최재완");
});

test("verifyAndRecordGold300OwnerDecisionV02: a decision whose packet_a_sha256 disagrees with the real packet file on disk fails provenance verification and is NOT recorded as authorized", () => {
  const realBytes = readFileSync(REAL_DECISION_PATH);
  const tampered = JSON.parse(realBytes.toString("utf8"));
  tampered.packet_a_sha256 = "0".repeat(64);
  try {
    writeFileSync(REAL_DECISION_PATH, `${JSON.stringify(tampered, null, 2)}\n`);
    const result = verifyAndRecordGold300OwnerDecisionV02();
    assert.equal(result.allOk, false);
    assert.equal(result.isGenuineApproval, false);
    assert.ok(result.verificationReport.provenance_verification.violations.some((v) => v.type === "PACKET_A_SHA_MISMATCH"));
    assert.equal(result.recordedGateStatus.gold_300_plan_authorized, false);
  } finally {
    restoreGenuineDecision();
  }
});

test("verifyAndRecordGold300OwnerDecisionV02: a decision with blocked_authoring_authorized=true is rejected outright and never recorded as authorized", () => {
  const realBytes = readFileSync(REAL_DECISION_PATH);
  const tampered = JSON.parse(realBytes.toString("utf8"));
  tampered.blocked_authoring_authorized = true;
  try {
    writeFileSync(REAL_DECISION_PATH, `${JSON.stringify(tampered, null, 2)}\n`);
    const result = verifyAndRecordGold300OwnerDecisionV02();
    assert.equal(result.allOk, false);
    assert.ok(result.verificationReport.domain_verification.violations.some((v) => v.type === "BLOCKED_AUTHORING_AUTHORIZED_NOT_FALSE"));
  } finally {
    restoreGenuineDecision();
  }
});

// -- Turn N4.22 hard gates -------------------------------------------

test("Turn N4.22: a decision that is domain-valid in every other respect (real counts, real packet SHAs, real official-split id) but was ingested from a source lacking the com.apple.quarantine marker is HARD REJECTED, not merely flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "gold300-n422-quarantine-test-"));
  const fixturePath = join(dir, "not-really-downloaded.json");
  try {
    writeFileSync(fixturePath, readFileSync(REAL_DECISION_PATH)); // byte-identical content, but this copy was never through a browser download
    const ingestion = ingestGold300OwnerDecisionV02({ sourcePath: fixturePath });
    assert.equal(ingestion.provenance.has_quarantine_marker, false);
    const result = verifyAndRecordGold300OwnerDecisionV02({ ingestion });
    assert.equal(result.allOk, false);
    assert.equal(result.isGenuineApproval, false);
    assert.ok(result.verificationReport.provenance_verification.violations.some((v) => v.type === "NO_QUARANTINE_MARKER_PROVENANCE"));
    assert.equal(result.recordedGateStatus.gold_300_plan_authorized, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreGenuineDecision();
  }
});

test("Turn N4.22: the superseded chat-reconstructed decision_id (e266789a...) is rejected even when every other field (counts, packet SHAs, official-split id) is otherwise domain-valid", () => {
  const realBytes = readFileSync(REAL_DECISION_PATH);
  const tampered = JSON.parse(realBytes.toString("utf8"));
  tampered.decision_id = "e266789a-5263-4015-9dc1-7fa8e6eb36c2";
  try {
    writeFileSync(REAL_DECISION_PATH, `${JSON.stringify(tampered, null, 2)}\n`);
    const result = verifyAndRecordGold300OwnerDecisionV02();
    assert.equal(result.allOk, false);
    assert.equal(result.isGenuineApproval, false);
    assert.ok(result.verificationReport.provenance_verification.violations.some((v) => v.type === "DECISION_ID_IS_SUPERSEDED"));
    assert.ok(result.verificationReport.provenance_verification.violations.some((v) => v.type === "DECISION_ID_NOT_ACTIVE_PIN"));
  } finally {
    restoreGenuineDecision();
  }
});

test("Turn N4.22: a decision file whose bytes were altered (breaking the pinned SHA-256) even while decision_id stays the real active id is rejected -- id alone is never sufficient", () => {
  const realBytes = readFileSync(REAL_DECISION_PATH);
  const tampered = JSON.parse(realBytes.toString("utf8"));
  tampered.owner_note = "a single harmless-looking added character changes the file's SHA-256";
  try {
    writeFileSync(REAL_DECISION_PATH, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.notEqual(sha256(readFileSync(REAL_DECISION_PATH)), ACTIVE_DECISION_PIN.sha256);
    const result = verifyAndRecordGold300OwnerDecisionV02();
    assert.equal(result.allOk, false);
    assert.ok(result.verificationReport.provenance_verification.violations.some((v) => v.type === "DECISION_SHA256_NOT_ACTIVE_PIN"));
  } finally {
    restoreGenuineDecision();
  }
});

test("Turn N4.22 Part E.9: ingestion copies the source's raw BYTES, never a JSON.parse/re-serialize round-trip -- a fixture with nonstandard whitespace/key order stays byte-identical after copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "gold300-n422-byte-copy-test-"));
  const fixturePath = join(dir, "nonstandard-formatting.json");
  // Deliberately NOT what JSON.stringify(parsed, null, 2) would produce:
  // compact, single-line, keys in an unusual order, trailing spaces.
  const oddBytes = Buffer.from('{"n":1,   "hello":"world","z":true}   \n', "utf8");
  writeFileSync(fixturePath, oddBytes);
  try {
    const result = ingestGold300OwnerDecisionV02({ sourcePath: fixturePath });
    const copiedBytes = readFileSync(REAL_DECISION_PATH);
    assert.deepEqual(copiedBytes, oddBytes, "the copy must be byte-identical to the source, not a re-serialized normalization of its parsed content");
    assert.notDeepEqual(copiedBytes, Buffer.from(`${JSON.stringify(JSON.parse(oddBytes.toString("utf8")), null, 2)}\n`, "utf8"));
    assert.equal(result.sha256, sha256(oddBytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreGenuineDecision();
  }
});

test("verifyAndRecordGold300OwnerDecisionV02 never modifies the real N4.20 selection/author-allocation/v0.1-packet files", () => {
  restoreGenuineDecision();
  const inputs = [
    "work/handoff/anchor-dev-tune-v0.2/gold-300-v0.1/gold-300-selection-candidate.v0.1.jsonl",
    "work/handoff/anchor-dev-tune-v0.2/gold-300-v0.1/gold-300-author-allocation-candidate.v0.1.jsonl",
    "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1/author-a-gold-150-authoring-packet.v0.1.jsonl",
    "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1/author-b-gold-150-authoring-packet.v0.1.jsonl",
  ].map((p) => resolve(REPO_ROOT, p));
  const before = inputs.map((p) => sha256(readFileSync(p)));
  verifyAndRecordGold300OwnerDecisionV02();
  const after = inputs.map((p) => sha256(readFileSync(p)));
  assert.deepEqual(after, before);
});
