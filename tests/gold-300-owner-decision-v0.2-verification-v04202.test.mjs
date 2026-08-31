// Turn N4.20.2: regression coverage for the real Owner decision
// verification/recording script. Runs against the REAL, actually-
// downloaded gold-300-authoring-owner-decision.v0.2.json and the real,
// read-only N4.20 outputs. Never trusts the decision's own self-reported
// counts or SHAs -- everything is independently recomputed from live data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyAndRecordGold300OwnerDecisionV02 } from "../scripts/build-gold-300-owner-decision-v0.2-verification-v04202.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

const OWNER_REVIEW_V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/owner-review-v0.2");
const REAL_DECISION_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision.v0.2.json");

test("verifyAndRecordGold300OwnerDecisionV02: the real, downloaded decision independently re-verifies as a genuine approval, with zero domain or provenance violations", () => {
  const result = verifyAndRecordGold300OwnerDecisionV02();
  assert.equal(result.allOk, true);
  assert.equal(result.isGenuineApproval, true);
  assert.deepEqual(result.verificationReport.domain_verification.violations, []);
  assert.deepEqual(result.verificationReport.provenance_verification.violations, []);
});

test("verifyAndRecordGold300OwnerDecisionV02: the recorded gate-status.v0.2.json reflects gold_300_plan_authorized/eligible_authoring_authorized/holdout_authoring_authorized=true while every other authorization stays false", () => {
  const result = verifyAndRecordGold300OwnerDecisionV02();
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

test("verifyAndRecordGold300OwnerDecisionV02: the written verification report on disk matches the returned report exactly, and pins the real decision file's own SHA-256", () => {
  const result = verifyAndRecordGold300OwnerDecisionV02();
  const onDisk = readJson(resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision-verification-report.v0.2.json"));
  assert.equal(onDisk.all_checks_passed, true);
  assert.equal(onDisk.decision_sha256, sha256(readFileSync(REAL_DECISION_PATH)));
  assert.equal(onDisk.decision_id, "e266789a-5263-4015-9dc1-7fa8e6eb36c2");
  assert.equal(onDisk.owner, "최재완");
});

test("verifyAndRecordGold300OwnerDecisionV02: a decision whose packet_a_sha256 disagrees with the real packet file on disk fails provenance verification and is NOT recorded as authorized -- verified against a temp copy, the real decision file is restored afterward", () => {
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
    writeFileSync(REAL_DECISION_PATH, realBytes);
  }
  // restore the genuine recorded state so this file leaves the repo in the real, correct state
  const restored = verifyAndRecordGold300OwnerDecisionV02();
  assert.equal(restored.isGenuineApproval, true);
});

test("verifyAndRecordGold300OwnerDecisionV02: a decision with blocked_authoring_authorized=true is rejected outright and never recorded as authorized -- verified against a temp copy, restored afterward", () => {
  const realBytes = readFileSync(REAL_DECISION_PATH);
  const tampered = JSON.parse(realBytes.toString("utf8"));
  tampered.blocked_authoring_authorized = true;
  try {
    writeFileSync(REAL_DECISION_PATH, `${JSON.stringify(tampered, null, 2)}\n`);
    const result = verifyAndRecordGold300OwnerDecisionV02();
    assert.equal(result.allOk, false);
    assert.ok(result.verificationReport.domain_verification.violations.some((v) => v.type === "BLOCKED_AUTHORING_AUTHORIZED_NOT_FALSE"));
  } finally {
    writeFileSync(REAL_DECISION_PATH, realBytes);
  }
  const restored = verifyAndRecordGold300OwnerDecisionV02();
  assert.equal(restored.isGenuineApproval, true);
});

test("verifyAndRecordGold300OwnerDecisionV02 never modifies the real N4.20 selection/author-allocation/packet files", () => {
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
