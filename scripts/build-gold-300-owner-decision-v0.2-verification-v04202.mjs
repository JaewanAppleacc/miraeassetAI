#!/usr/bin/env node
// Turn N4.20.2: independently re-verifies the Owner's real, downloaded
// APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING decision (v0.2) against
// freshly recomputed live values -- never trusts the decision's own
// self-reported counts, and never trusts any cached prior report. Only
// if every check passes does this script record the plan/eligible/
// holdout-authoring authorization as real; it can NEVER cause
// blocked_authoring_authorized, holdout_agent_access_authorized,
// holdout_evaluation_authorized, production_wiring_authorized,
// agent_ranking_authorized, relation_decisions_authorized, or
// actual_official_promotion_applied to become anything but false.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGold300PlanDecisionV02 } from "../domain/evaluation/gold-300-authorization.mjs";
import { buildGold300PlanReverification } from "./build-gold-300-plan-reverification-v04201.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const AUTHORING_V01_DIR = resolve(V02_DIR, "gold-authoring-300-v0.1");
const OWNER_REVIEW_V02_DIR = resolve(V02_DIR, "gold-authoring-300-v0.2/owner-review-v0.2");

const REAL_DECISION_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision.v0.2.json");
const PACKET_A_PATH = resolve(AUTHORING_V01_DIR, "author-a-gold-150-authoring-packet.v0.1.jsonl");
const PACKET_B_PATH = resolve(AUTHORING_V01_DIR, "author-b-gold-150-authoring-packet.v0.1.jsonl");
const OFFICIAL_SPLIT_DECISION_PATH = resolve(V02_DIR, "component-safe-reallocation-v0.1/official-split-approval-v0.1/results/owner-v0.1/official-split-approval-decision.v0.1.json");

export function verifyAndRecordGold300OwnerDecisionV02({ generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  const decision = readJson(REAL_DECISION_PATH);
  const decisionSha256 = sha256File(REAL_DECISION_PATH);

  // ---- 1. Independently recompute expected counts from LIVE data (never
  // trusts the decision's own numbers, never trusts a cached report) -----
  const reverification = buildGold300PlanReverification();
  const report = reverification.report;

  const expected = {
    total_plan_count: 300,
    author_a_assigned_count: report.author_a_assigned_count,
    author_b_assigned_count: report.author_b_assigned_count,
    immediately_authorizable_count: report.immediately_authorizable_count,
    manual_review_required_count: report.manual_review_required_count,
    blocked_count: report.blocked_count,
    author_a_immediately_authorizable_count: report.author_a_immediately_authorizable_count,
    author_b_immediately_authorizable_count: report.author_b_immediately_authorizable_count,
    author_a_blocked_count: report.author_a_blocked_count,
    author_b_blocked_count: report.author_b_blocked_count,
  };

  // ---- 2. Cross-check packet SHAs and official split decision id against
  // the REAL files on disk right now, not against what the decision claims
  const realPacketASha256 = sha256File(PACKET_A_PATH);
  const realPacketBSha256 = sha256File(PACKET_B_PATH);
  const realOfficialSplitDecision = readJson(OFFICIAL_SPLIT_DECISION_PATH);

  const provenanceViolations = [];
  if (decision.packet_a_sha256 !== realPacketASha256) provenanceViolations.push({ type: "PACKET_A_SHA_MISMATCH", expected: realPacketASha256, actual: decision.packet_a_sha256 });
  if (decision.packet_b_sha256 !== realPacketBSha256) provenanceViolations.push({ type: "PACKET_B_SHA_MISMATCH", expected: realPacketBSha256, actual: decision.packet_b_sha256 });
  if (decision.official_split_decision_id !== realOfficialSplitDecision.decision_id) provenanceViolations.push({ type: "OFFICIAL_SPLIT_DECISION_ID_MISMATCH", expected: realOfficialSplitDecision.decision_id, actual: decision.official_split_decision_id });
  if (realOfficialSplitDecision.owner_disposition !== "APPROVE_OFFICIAL_SPLIT_V0.3") provenanceViolations.push({ type: "OFFICIAL_SPLIT_NOT_A_GENUINE_APPROVAL" });

  // ---- 3. Domain-level structural/count/hard-invariant verification ----
  const domainVerification = verifyGold300PlanDecisionV02({ decision, expected });

  const allOk = domainVerification.ok && provenanceViolations.length === 0;
  const isGenuineApproval = allOk && domainVerification.is_genuine_approval;

  const verificationReport = {
    schema_version: "0.1.0", turn: "N4.20.2", generated_at: now,
    decision_path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/owner-review-v0.2/gold-300-authoring-owner-decision.v0.2.json",
    decision_sha256: decisionSha256,
    decision_id: decision.decision_id,
    owner: decision.owner,
    owner_disposition: decision.owner_disposition,
    decided_at: decision.decided_at,
    domain_verification: domainVerification,
    provenance_verification: { ok: provenanceViolations.length === 0, violations: provenanceViolations },
    all_checks_passed: allOk,
    is_genuine_approval: isGenuineApproval,
    live_recomputed_expected: expected,
    n4_20_inputs_unmodified: report.n4_20_inputs_unmodified,
  };
  writeJson(resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision-verification-report.v0.2.json"), verificationReport);

  const recordedGateStatus = {
    schema_version: "0.1.0", turn: "N4.20.2", generated_at: now,
    status: allOk
      ? (isGenuineApproval ? "GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING_RECORDED" : "DECISION_RECORDED_NOT_A_GENUINE_APPROVAL")
      : "DECISION_VERIFICATION_FAILED_NOT_RECORDED_AS_AUTHORIZED",
    real_decision_verified: allOk,
    gold_300_plan_authorized: isGenuineApproval,
    eligible_authoring_authorized: isGenuineApproval,
    blocked_authoring_authorized: false,
    holdout_authoring_authorized: isGenuineApproval,
    holdout_agent_access_authorized: false,
    holdout_evaluation_authorized: false,
    production_wiring_authorized: false,
    agent_ranking_authorized: false,
    relation_decisions_authorized: false,
    actual_official_promotion_applied: false,
    immediately_authorizable_count: expected.immediately_authorizable_count,
    manual_review_required_count: expected.manual_review_required_count,
    blocked_count: expected.blocked_count,
    author_a_immediately_authorizable_count: expected.author_a_immediately_authorizable_count,
    author_b_immediately_authorizable_count: expected.author_b_immediately_authorizable_count,
    note: "gold_300_plan_authorized/eligible_authoring_authorized/holdout_authoring_authorized reflect a REAL, independently re-verified Owner decision -- not a UI default. blocked_authoring_authorized, holdout_agent_access_authorized, holdout_evaluation_authorized, production_wiring_authorized, agent_ranking_authorized, and relation_decisions_authorized remain hard-coded false regardless of this decision's content.",
  };
  writeJson(resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-review-gate-status.v0.2.json"), recordedGateStatus);

  return Object.freeze({ verificationReport, recordedGateStatus, allOk, isGenuineApproval });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = verifyAndRecordGold300OwnerDecisionV02();
  console.log(JSON.stringify({
    status: result.allOk ? (result.isGenuineApproval ? "RECORDED_GENUINE_APPROVAL" : "RECORDED_NOT_GENUINE") : "VERIFICATION_FAILED",
    all_checks_passed: result.allOk,
    is_genuine_approval: result.isGenuineApproval,
    domain_violations: result.verificationReport.domain_verification.violations,
    provenance_violations: result.verificationReport.provenance_verification.violations,
  }, null, 2));
  if (!result.allOk) process.exit(1);
}
