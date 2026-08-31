#!/usr/bin/env node
// Turn N4.22 Part B: writes a single, explicit provenance-resolution
// artifact naming BOTH the earlier chat-reconstructed decision
// (decision_id e266789a-5263-4015-9dc1-7fa8e6eb36c2 -- SUPERSEDED,
// untrusted) and the real, file-verified decision (decision_id
// 93c5b69c-6e37-46fd-b319-17179a0d6402 -- ACTIVE) side by side, with their
// SHAs, source types, and verification evidence. This is a forward-only
// resolution record: it does NOT delete, amend, or rewrite anything --
// commit 512799f27806d287dd0add0043872d34213885e8 (which recorded the
// chat-reconstructed decision's runtime state, via a test fixture
// assertion) stays in git history untouched. This script only verifies
// that commit is still reachable (i.e. history was not rewritten out from
// under this resolution) and records that fact.
//
// This is intentionally NOT the gate that grants/denies authorization --
// domain/evaluation/gold-300-owner-decision-provenance.mjs's
// verifyActiveDecisionPin (consumed by the verification script) is the
// actual enforcement point. This script only documents the resolution for
// human/audit review.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_DECISION_PIN, SUPERSEDED_DECISIONS } from "../domain/evaluation/gold-300-owner-decision-provenance.mjs";
import { REAL_DECISION_PATH, VERIFICATION_STATUS_PATH, verifyAndRecordGold300OwnerDecisionV02 } from "./build-gold-300-owner-decision-v0.2-verification-v04202.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const OWNER_REVIEW_V02_DIR = resolve(V02_DIR, "gold-authoring-300-v0.2/owner-review-v0.2");
export const PROVENANCE_RESOLUTION_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-owner-decision-provenance-resolution.v0.1.json");

const HISTORICAL_UNTRUSTED_COMMIT_SHA = "512799f27806d287dd0add0043872d34213885e8";

// Confirms the historical commit is still a real, reachable commit object
// in THIS repo (never assumes it -- a `git cat-file -e` failure here means
// history was rewritten and this resolution's own claim of "forward-only,
// nothing hidden" would be false). Does not require it to be an ancestor
// of any particular branch -- only that the object itself still exists.
function verifyHistoricalCommitReachable(sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function buildGold300OwnerDecisionProvenanceResolution({ generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  const historicalCommitReachable = verifyHistoricalCommitReachable(HISTORICAL_UNTRUSTED_COMMIT_SHA);
  if (!historicalCommitReachable) {
    throw new Error(`buildGold300OwnerDecisionProvenanceResolution: historical commit ${HISTORICAL_UNTRUSTED_COMMIT_SHA} is not reachable in this repository -- refusing to write a resolution record that claims a forward-only, nothing-hidden history when that cannot be confirmed`);
  }

  // Re-run the real, live verification (never trust a stale on-disk
  // status file for this cross-check) so this resolution's own
  // "live_verification_cross_check" reflects the CURRENT state of
  // REAL_DECISION_PATH, not whatever was last written by some earlier,
  // possibly-unrelated invocation.
  const liveResult = verifyAndRecordGold300OwnerDecisionV02();
  const activeDecision = existsSync(REAL_DECISION_PATH) ? readJson(REAL_DECISION_PATH) : null;

  const decisions = [
    ...SUPERSEDED_DECISIONS.map((d) => ({ ...d })),
    {
      decision_id: ACTIVE_DECISION_PIN.decision_id,
      status: ACTIVE_DECISION_PIN.status,
      source_type: ACTIVE_DECISION_PIN.source_type,
      sha256: ACTIVE_DECISION_PIN.sha256,
      usable_for_authoring_authorization: true,
      evidence_note: "Copied byte-for-byte from an explicit sourcePath on disk (never chat-pasted text), with macOS com.apple.quarantine and com.apple.metadata:kMDItemWhereFroms extended attributes confirmed present at ingestion time, and independently re-verified against live-recomputed counts, real packet SHAs, and the real official-split decision.",
    },
  ];

  const resolution = {
    schema_version: "0.1.0",
    turn: "N4.22",
    generated_at: now,
    decisions,
    canonical_active_decision_id: ACTIVE_DECISION_PIN.decision_id,
    canonical_active_decision_sha256: ACTIVE_DECISION_PIN.sha256,
    superseded_decisions_usable_for_authorization: false,
    untrusted_decision_never_deleted_evidence: {
      note: "No file for decision_id e266789a-5263-4015-9dc1-7fa8e6eb36c2 was ever produced by a genuine download, so there is no file to isolate or preserve on disk. The historical trace is the git commit below, left untouched (no amend/revert/reset/force-push) per this project's forward-only history discipline.",
      historical_commit_sha: HISTORICAL_UNTRUSTED_COMMIT_SHA,
      historical_commit_reachable: historicalCommitReachable,
    },
    live_verification_cross_check: {
      active_decision_present: activeDecision !== null,
      active_decision_id: activeDecision?.decision_id ?? null,
      matches_pin: activeDecision !== null
        && activeDecision.decision_id === ACTIVE_DECISION_PIN.decision_id
        && liveResult.verificationReport.decision_sha256 === ACTIVE_DECISION_PIN.sha256,
      all_checks_passed: liveResult.allOk,
      is_genuine_approval: liveResult.isGenuineApproval,
    },
  };

  mkdirSync(OWNER_REVIEW_V02_DIR, { recursive: true });
  writeJson(PROVENANCE_RESOLUTION_PATH, resolution);

  return Object.freeze({ path: PROVENANCE_RESOLUTION_PATH, resolution });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildGold300OwnerDecisionProvenanceResolution();
  console.log(JSON.stringify({
    status: "PROVENANCE_RESOLUTION_WRITTEN",
    canonical_active_decision_id: result.resolution.canonical_active_decision_id,
    superseded_decision_ids: result.resolution.decisions.filter((d) => d.status !== ACTIVE_DECISION_PIN.status).map((d) => d.decision_id),
    matches_pin: result.resolution.live_verification_cross_check.matches_pin,
    all_checks_passed: result.resolution.live_verification_cross_check.all_checks_passed,
  }, null, 2));
}
