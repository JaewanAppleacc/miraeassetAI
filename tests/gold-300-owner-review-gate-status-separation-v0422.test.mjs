// Turn N4.22 Part C: regression coverage for the permanent filename split
// between the v0.2 UI builder's TEMPLATE_STATUS_PATH (always PENDING
// defaults) and the decision verifier's VERIFICATION_STATUS_PATH (a real,
// recorded decision outcome). Turn N4.20.2 already fixed a silent
// same-filename collision between these two; this suite locks the fix in
// under the new, unmistakable names and proves execution-order
// independence in both directions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildGold300OwnerReviewV02, TEMPLATE_STATUS_PATH } from "../scripts/build-gold-300-owner-review-v0.2-v04201.mjs";
import { VERIFICATION_STATUS_PATH, verifyAndRecordGold300OwnerDecisionV02 } from "../scripts/build-gold-300-owner-decision-v0.2-verification-v04202.mjs";

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

test("TEMPLATE_STATUS_PATH and VERIFICATION_STATUS_PATH are permanently distinct filenames", () => {
  assert.notEqual(TEMPLATE_STATUS_PATH, VERIFICATION_STATUS_PATH);
  assert.match(TEMPLATE_STATUS_PATH, /template-status/);
  assert.match(VERIFICATION_STATUS_PATH, /verification-status/);
});

test("buildGold300OwnerReviewV02 (builder) never writes to VERIFICATION_STATUS_PATH", () => {
  const before = readFileSync(VERIFICATION_STATUS_PATH);
  buildGold300OwnerReviewV02();
  const after = readFileSync(VERIFICATION_STATUS_PATH);
  assert.deepEqual(after, before, "the UI builder must never touch the verifier's own recorded-decision file");
});

test("verifyAndRecordGold300OwnerDecisionV02 (verifier) never writes to TEMPLATE_STATUS_PATH", () => {
  const before = readFileSync(TEMPLATE_STATUS_PATH);
  verifyAndRecordGold300OwnerDecisionV02();
  const after = readFileSync(TEMPLATE_STATUS_PATH);
  assert.deepEqual(after, before, "the verifier must never touch the UI builder's own template-status file");
});

test("execution order builder -> verifier: running the UI builder first, then the verifier, still leaves a correctly recorded verification-status (verified state is not clobbered by a subsequent template rebuild)", () => {
  buildGold300OwnerReviewV02();
  const result = verifyAndRecordGold300OwnerDecisionV02();
  assert.equal(result.allOk, true);
  assert.equal(result.isGenuineApproval, true);
  const onDisk = readJson(VERIFICATION_STATUS_PATH);
  assert.equal(onDisk.real_decision_verified, true);
  assert.equal(onDisk.gold_300_plan_authorized, true);
});

test("execution order verifier -> builder: running the verifier first, then rebuilding the UI template, does not corrupt or downgrade the already-recorded verification-status", () => {
  const before = verifyAndRecordGold300OwnerDecisionV02();
  assert.equal(before.allOk, true);
  const verificationStatusBytesBefore = readFileSync(VERIFICATION_STATUS_PATH);

  buildGold300OwnerReviewV02(); // template rebuild -- must be a no-op for the verifier's own file

  const verificationStatusBytesAfter = readFileSync(VERIFICATION_STATUS_PATH);
  assert.equal(sha256(verificationStatusBytesAfter), sha256(verificationStatusBytesBefore));
  const templateStatus = readJson(TEMPLATE_STATUS_PATH);
  assert.equal(templateStatus.status, "GOLD_300_PLAN_REVIEW_READY_PENDING_DECISION", "the template always re-declares PENDING regardless of any real recorded decision");
  assert.equal(templateStatus.gold_300_plan_authorized, false, "the template's own PENDING defaults never reflect a real decision's authorization");
});

test("a template rebuild never overwrites recorded authorization with PENDING inside VERIFICATION_STATUS_PATH itself (the two statuses stay independently readable at all times)", () => {
  verifyAndRecordGold300OwnerDecisionV02();
  buildGold300OwnerReviewV02();
  buildGold300OwnerReviewV02();
  const verificationStatus = readJson(VERIFICATION_STATUS_PATH);
  assert.equal(verificationStatus.status, "GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING_RECORDED");
  assert.equal(verificationStatus.gold_300_plan_authorized, true);
});
