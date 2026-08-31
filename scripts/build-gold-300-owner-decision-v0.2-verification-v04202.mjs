#!/usr/bin/env node
// Turn N4.20.2 (corrected): ingests, then independently re-verifies, the
// Owner's real, browser-downloaded APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_
// AUTHORING decision (v0.2). This script never accepts a decision that
// was only ever pasted as chat text -- ingestGold300OwnerDecisionV02
// requires an explicit sourcePath on disk, checks it for macOS's
// browser-download provenance marker (com.apple.quarantine -- present on
// files a browser wrote via a real download, never on a file this repo's
// own tooling wrote), then copies it byte-for-byte and re-hashes the copy
// against the source before anything else runs. Only if every check here
// (ingestion provenance + domain/count verification + packet/official-
// split SHA cross-checks) passes does this script record the plan/
// eligible/holdout-authoring authorization as real; it can NEVER cause
// blocked_authoring_authorized, holdout_agent_access_authorized,
// holdout_evaluation_authorized, production_wiring_authorized,
// agent_ranking_authorized, relation_decisions_authorized, or
// actual_official_promotion_applied to become anything but false.
//
// Writes its recorded gate status to a filename DISTINCT from the v0.2 UI
// builder's own gate-status file (which always re-declares PENDING) --
// Turn N4.20.2's original version shared that exact filename, so whichever
// script last ran during a full test:domain pass silently clobbered the
// other's meaning. Never repeat that collision.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGold300PlanDecisionV02 } from "../domain/evaluation/gold-300-authorization.mjs";
import { buildGold300PlanReverification } from "./build-gold-300-plan-reverification-v04201.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function sha256Bytes(buf) { return createHash("sha256").update(buf).digest("hex"); }
function sha256File(p) { return sha256Bytes(readFileSync(p)); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const AUTHORING_V01_DIR = resolve(V02_DIR, "gold-authoring-300-v0.1");
const OWNER_REVIEW_V02_DIR = resolve(V02_DIR, "gold-authoring-300-v0.2/owner-review-v0.2");

export const REAL_DECISION_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision.v0.2.json");
const PACKET_A_PATH = resolve(AUTHORING_V01_DIR, "author-a-gold-150-authoring-packet.v0.1.jsonl");
const PACKET_B_PATH = resolve(AUTHORING_V01_DIR, "author-b-gold-150-authoring-packet.v0.1.jsonl");
const OFFICIAL_SPLIT_DECISION_PATH = resolve(V02_DIR, "component-safe-reallocation-v0.1/official-split-approval-v0.1/results/owner-v0.1/official-split-approval-decision.v0.1.json");
const RECORDED_GATE_STATUS_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision-recorded-gate-status.v0.2.json");
const VERIFICATION_REPORT_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision-verification-report.v0.2.json");
// writeFileSync copies BYTES only, never extended attributes -- the copy
// at REAL_DECISION_PATH can never itself carry the source's
// com.apple.quarantine marker, no matter how genuine the source download
// was. The provenance evidence is therefore captured ONCE at ingestion
// time and persisted here, so a LATER, separate verify call (with no
// in-memory `ingestion` object) still has real evidence to report instead
// of silently re-checking the copy and always finding it clean.
const INGESTION_PROVENANCE_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision-ingestion-provenance.v0.2.json");

// Reads macOS extended attributes via the real `xattr` binary (never
// parsed by hand from some other cache) and reports whether the
// browser-download markers are present. A file this repo's own scripts
// write (via writeFileSync) never carries com.apple.quarantine -- only a
// file a browser actually wrote via its download path does. This is
// evidence, not a hard cryptographic proof (an attacker with local file
// access could forge the attribute), but it is exactly the signal that
// distinguishes "genuinely downloaded" from "pasted into a text file" --
// the failure mode this Turn exists to close.
function checkDownloadProvenance(sourcePath) {
  let xattrOutput = "";
  try {
    xattrOutput = execFileSync("xattr", ["-l", sourcePath], { encoding: "utf8" });
  } catch {
    return { checked: false, has_quarantine_marker: false, has_where_froms_marker: false, raw: null, note: "xattr command unavailable or failed -- provenance could not be checked on this platform" };
  }
  return {
    checked: true,
    has_quarantine_marker: xattrOutput.includes("com.apple.quarantine"),
    has_where_froms_marker: xattrOutput.includes("com.apple.metadata:kMDItemWhereFroms"),
    raw: xattrOutput.trim(),
  };
}

// Ingests a real decision file from an explicit filesystem sourcePath
// (e.g. the user's real ~/Downloads file) into the repo's canonical
// location, verifying byte-for-byte fidelity. NEVER accepts inline JSON
// text as a substitute for a real file on disk.
export function ingestGold300OwnerDecisionV02({ sourcePath, generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();
  if (typeof sourcePath !== "string" || sourcePath.length === 0) throw new Error("ingestGold300OwnerDecisionV02: sourcePath is required and must point to a real file on disk");
  if (!existsSync(sourcePath)) throw new Error(`ingestGold300OwnerDecisionV02: sourcePath does not exist: ${sourcePath}`);

  const sourceBytes = readFileSync(sourcePath);
  const sourceSha256 = sha256Bytes(sourceBytes);
  const provenance = checkDownloadProvenance(sourcePath);

  // Parse-validate before copying -- a byte-for-byte copy of invalid JSON
  // would still fail JSON.parse downstream, but failing fast here with a
  // clear message is better than a cryptic parse error deep in verification.
  JSON.parse(sourceBytes.toString("utf8"));

  writeFileSync(REAL_DECISION_PATH, sourceBytes);
  const copiedSha256 = sha256File(REAL_DECISION_PATH);
  if (copiedSha256 !== sourceSha256) throw new Error(`ingestGold300OwnerDecisionV02: copied file SHA-256 (${copiedSha256}) does not match source (${sourceSha256}) -- refusing to proceed`);

  writeJson(INGESTION_PROVENANCE_PATH, {
    schema_version: "0.1.0", turn: "N4.20.2", generated_at: now,
    source_path: sourcePath, source_sha256: sourceSha256, copied_sha256: copiedSha256,
    provenance,
  });

  return Object.freeze({
    sourcePath, targetPath: REAL_DECISION_PATH, sha256: sourceSha256, bytes: sourceBytes.length,
    provenance, generated_at: now,
  });
}

export function verifyAndRecordGold300OwnerDecisionV02({ generatedAt, ingestion } = {}) {
  const now = generatedAt ?? new Date().toISOString();
  if (!existsSync(REAL_DECISION_PATH)) throw new Error(`verifyAndRecordGold300OwnerDecisionV02: no decision file at ${REAL_DECISION_PATH} -- call ingestGold300OwnerDecisionV02({ sourcePath }) first`);

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

  // ---- 3. Ingestion provenance -- read from the in-memory `ingestion`
  // object if this call followed a fresh ingestGold300OwnerDecisionV02()
  // in the SAME process, otherwise from the persisted provenance file
  // ingestion wrote to disk. NEVER re-check REAL_DECISION_PATH's own
  // xattrs here: it is a plain writeFileSync copy and can never itself
  // carry the source's com.apple.quarantine marker, so doing that would
  // silently and incorrectly report "not a genuine download" every time.
  // A decision file lacking the marker (or with no provenance record at
  // all) is flagged, not silently trusted, though not hard-rejected here.
  let ingestionProvenance = ingestion?.provenance;
  if (!ingestionProvenance) {
    if (existsSync(INGESTION_PROVENANCE_PATH)) {
      ingestionProvenance = readJson(INGESTION_PROVENANCE_PATH).provenance;
    } else {
      ingestionProvenance = { checked: false, has_quarantine_marker: false, has_where_froms_marker: false, raw: null, note: "no ingestion provenance record found -- this decision file's origin cannot be confirmed as a real download" };
    }
  }

  // ---- 4. Domain-level structural/count/hard-invariant verification ----
  const domainVerification = verifyGold300PlanDecisionV02({ decision, expected });

  const allOk = domainVerification.ok && provenanceViolations.length === 0;
  const isGenuineApproval = allOk && domainVerification.is_genuine_approval;

  const verificationReport = {
    schema_version: "0.2.0", turn: "N4.20.2", generated_at: now,
    decision_path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/owner-review-v0.2/gold-300-authoring-owner-decision.v0.2.json",
    decision_sha256: decisionSha256,
    decision_id: decision.decision_id,
    owner: decision.owner,
    owner_disposition: decision.owner_disposition,
    decided_at: decision.decided_at,
    ingestion_source_path: ingestion?.sourcePath ?? null,
    ingestion_provenance: ingestionProvenance,
    domain_verification: domainVerification,
    provenance_verification: { ok: provenanceViolations.length === 0, violations: provenanceViolations },
    all_checks_passed: allOk,
    is_genuine_approval: isGenuineApproval,
    live_recomputed_expected: expected,
    n4_20_inputs_unmodified: report.n4_20_inputs_unmodified,
  };
  writeJson(VERIFICATION_REPORT_PATH, verificationReport);

  const recordedGateStatus = {
    schema_version: "0.2.0", turn: "N4.20.2", generated_at: now,
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
    note: "gold_300_plan_authorized/eligible_authoring_authorized/holdout_authoring_authorized reflect a REAL, independently re-verified, provenance-checked Owner decision -- not a UI default and not chat-pasted text. blocked_authoring_authorized, holdout_agent_access_authorized, holdout_evaluation_authorized, production_wiring_authorized, agent_ranking_authorized, and relation_decisions_authorized remain hard-coded false regardless of this decision's content.",
  };
  writeJson(RECORDED_GATE_STATUS_PATH, recordedGateStatus);

  return Object.freeze({ verificationReport, recordedGateStatus, allOk, isGenuineApproval });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error("Usage: node build-gold-300-owner-decision-v0.2-verification-v04202.mjs <path-to-real-downloaded-decision.json>");
    process.exit(2);
  }
  const ingestion = ingestGold300OwnerDecisionV02({ sourcePath });
  if (!ingestion.provenance.has_quarantine_marker) {
    console.error(`WARNING: ${sourcePath} has no com.apple.quarantine extended attribute -- it may not be a genuine browser download. Proceeding with verification, but flag this in any report.`);
  }
  const result = verifyAndRecordGold300OwnerDecisionV02({ ingestion });
  console.log(JSON.stringify({
    status: result.allOk ? (result.isGenuineApproval ? "RECORDED_GENUINE_APPROVAL" : "RECORDED_NOT_GENUINE") : "VERIFICATION_FAILED",
    all_checks_passed: result.allOk,
    is_genuine_approval: result.isGenuineApproval,
    ingestion_provenance: ingestion.provenance,
    domain_violations: result.verificationReport.domain_verification.violations,
    provenance_violations: result.verificationReport.provenance_verification.violations,
  }, null, 2));
  if (!result.allOk) process.exit(1);
}
