#!/usr/bin/env node
// Turn N4.18: adjudicates the Owner's downloaded APPROVE_OFFICIAL_SPLIT_V0.3
// decision for Turn N4.16's v0.3 candidate assignment against LIVE
// (freshly recomputed) artifacts, and records a verification/ratification
// report -- regardless of outcome.
//
// This script NEVER:
//   - promotes v0.3 to be the actual official Pool500/Anchor150/Author150
//     assignment used by Runtime/PostgreSQL/v0.20 (candidate-pool.v0.1.jsonl,
//     anchor-selection.v0.2.jsonl, author-allocation.v0.2.jsonl stay
//     byte-unmodified -- verified explicitly below; there is no "cutover"
//     step in this Turn at all)
//   - authorizes Gold authoring (gold_authoring_authorized is a hard
//     invariant, forced false regardless of what the decision says)
//   - authorizes any of the remaining 281 provisional relation decisions
//   - touches the official 326-row ledger
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOfficialSplitApprovalDecision } from "../domain/evaluation/official-split-approval.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function canonicalSha256File(p) {
  const obj = JSON.parse(readFileSync(p, "utf8"));
  const clone = { ...obj };
  delete clone.generated_at;
  return createHash("sha256").update(JSON.stringify(clone, Object.keys(clone).sort())).digest("hex");
}

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const APPLIED_V03_DIR = resolve(CSR_DIR, "applied-v0.3");
const OFFICIAL_SPLIT_DIR = resolve(CSR_DIR, "official-split-approval-v0.1");
const RESULTS_OWNER_DIR = resolve(OFFICIAL_SPLIT_DIR, "results/owner-v0.1");

const OWNER_DECISION_PATH = resolve(RESULTS_OWNER_DIR, "official-split-approval-decision.v0.1.json");
const MANIFEST_PATH = resolve(APPLIED_V03_DIR, "v0.3-application-manifest.v0.1.json");
const POOL_V03_PATH = resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl");
const ANCHOR_V03_PATH = resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl");
const AUTHOR_V03_PATH = resolve(APPLIED_V03_DIR, "author-allocation.v0.3.jsonl");

const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_V01_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");

const N416_SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-component-safe-reallocation-apply-v0416.mjs");
const N417_SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-official-split-approval-v0417.mjs");

mkdirSync(RESULTS_OWNER_DIR, { recursive: true });

// == 0. Read-only-input byte-unmodified guard (before AND after) ============
const anchorV02Before = sha256File(ANCHOR_V02_PATH);
const authorV02Before = sha256File(AUTHOR_V02_PATH);
const poolV01Before = sha256File(POOL_V01_PATH);
const ledgerBefore = sha256File(LEDGER_PATH);

// == 1. Load the persisted Owner decision ===================================
const decision = readJson(OWNER_DECISION_PATH);
if (decision.owner_disposition !== "APPROVE_OFFICIAL_SPLIT_V0.3") {
  console.error(`BLOCKER: expected owner_disposition APPROVE_OFFICIAL_SPLIT_V0.3, got ${decision.owner_disposition}`);
  process.exit(1);
}
if (!Array.isArray(decision.checklist) || decision.checklist.length !== 10 || !decision.checklist.every((c) => c.checked === true)) {
  console.error("BLOCKER: decision checklist must have exactly 10 items, all checked true");
  process.exit(1);
}

// == 2. Rebuild N4.16/N4.17 outputs FRESH, then cross-verify against LIVE ===
// (idempotent, deterministic re-derivations -- never trusted from a cached
// value, and re-running them touches only their own applied-v0.3/ and
// official-split-approval-v0.1/ namespaces, never the real v0.2/v0.1 files)
execFileSync(process.execPath, [N416_SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
execFileSync(process.execPath, [N417_SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });

const freshManifest = readJson(MANIFEST_PATH);
if (freshManifest.status !== "V0.3_CANDIDATE_BUILT_NOT_OFFICIAL" || !freshManifest.all_invariants_passed) {
  console.error("BLOCKER: freshly rebuilt v0.3 manifest is not in the expected all-invariants-passed state");
  process.exit(1);
}

const poolV03 = readJsonl(POOL_V03_PATH);
const anchorV03 = readJsonl(ANCHOR_V03_PATH);
const authorV03 = readJsonl(AUTHOR_V03_PATH);

const splitCountsLive = {};
for (const s of ["DEV_TUNE", "DEV_CHECK", "HOLDOUT"]) splitCountsLive[s] = poolV03.filter((r) => r.planned_split === s).length;
const authorCountsLive = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of authorV03) authorCountsLive[r.author_allocation] += 1;

const expected = {
  v03_manifest_sha256: canonicalSha256File(MANIFEST_PATH), // manifest embeds generated_at
  v03_pool_sha256: sha256File(POOL_V03_PATH), // v0.3 jsonl files carry no generated_at -- raw hash is stable
  v03_anchor_sha256: sha256File(ANCHOR_V03_PATH),
  v03_author_sha256: sha256File(AUTHOR_V03_PATH),
  anchor_count: anchorV03.length,
  candidate_pool_count: poolV03.length,
  author_count: authorV03.length,
  split_leakage_after: freshManifest.live_recomputed_values.split_leakage_after,
  author_leakage_after: freshManifest.live_recomputed_values.author_leakage_after,
  quarantine_intrusion_after: freshManifest.live_recomputed_values.quarantine_intrusion_after,
  split_counts: splitCountsLive,
  author_counts: authorCountsLive,
};

const verification = verifyOfficialSplitApprovalDecision({ decision, expected });
if (!verification.ok) {
  console.error(`BLOCKER: Owner decision failed verification: ${JSON.stringify(verification.violations, null, 2)}`);
  process.exit(1);
}
if (!verification.is_genuine_approval) {
  console.error("BLOCKER: decision passed field verification but is not a genuine approval (should be unreachable given the disposition/checklist checks above)");
  process.exit(1);
}

// == 3. Additional structural cross-checks not covered by the domain
// verifier's numeric-key expected-map =======================================
const structuralViolations = [];
if (freshManifest.invariant_checks.critical_slice_floors_preserved !== decision.critical_slice_floors_preserved) {
  structuralViolations.push({ type: "STRUCTURAL_MISMATCH", field: "critical_slice_floors_preserved", actual: decision.critical_slice_floors_preserved, expected: freshManifest.invariant_checks.critical_slice_floors_preserved });
}
if (freshManifest.invariant_checks.anchor_membership_unchanged !== decision.anchor_membership_unchanged) {
  structuralViolations.push({ type: "STRUCTURAL_MISMATCH", field: "anchor_membership_unchanged", actual: decision.anchor_membership_unchanged, expected: freshManifest.invariant_checks.anchor_membership_unchanged });
}
const anchorV02 = readJsonl(ANCHOR_V02_PATH);
const anchorMembershipV02 = new Set(anchorV02.map((r) => r.assignment_id));
const anchorMembershipV03 = new Set(anchorV03.map((r) => r.assignment_id));
const anchorMembershipActuallyUnchanged = anchorMembershipV02.size === anchorMembershipV03.size && [...anchorMembershipV02].every((id) => anchorMembershipV03.has(id));
if (!anchorMembershipActuallyUnchanged) structuralViolations.push({ type: "ANCHOR_MEMBERSHIP_ACTUALLY_CHANGED" });
if (structuralViolations.length > 0) {
  console.error(`BLOCKER: Owner decision failed structural cross-verification: ${JSON.stringify(structuralViolations, null, 2)}`);
  process.exit(1);
}

// == 4. Real v0.2/v0.1 files and official ledger must remain UNTOUCHED ======
const anchorV02After = sha256File(ANCHOR_V02_PATH);
const authorV02After = sha256File(AUTHOR_V02_PATH);
const poolV01After = sha256File(POOL_V01_PATH);
const ledgerAfter = sha256File(LEDGER_PATH);
const realFilesUnmodified = anchorV02Before === anchorV02After && authorV02Before === authorV02After && poolV01Before === poolV01After && ledgerBefore === ledgerAfter;
if (!realFilesUnmodified) {
  console.error("BLOCKER: a real v0.2/v0.1 file or the official ledger changed during this script's own execution");
  process.exit(1);
}
const ledgerRows = readJsonl(LEDGER_PATH);
const provisionalCount = ledgerRows.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
if (ledgerRows.length !== 326 || provisionalCount !== 294) {
  console.error(`BLOCKER: ledger no longer shows 326 rows / 294 provisional (actual ${ledgerRows.length}/${provisionalCount})`);
  process.exit(1);
}

// == 5. Hard invariants -- never copied from the decision, always hardcoded =
const HARD_INVARIANTS = Object.freeze({
  gold_authoring_authorized: false,
  actual_official_promotion_applied: false,
  relation_decisions_authorized: false,
  anchor_membership_changed: false,
});

// == 6. Write the verification/adjudication record ===========================
const decisionSha256 = sha256File(OWNER_DECISION_PATH);
const reportPath = resolve(RESULTS_OWNER_DIR, "official-split-approval-decision-verification-report.v0.1.json");
writeJson(reportPath, {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.18",
  status: "OFFICIAL_SPLIT_APPROVED_PROMOTION_NOT_YET_APPLIED",
  owner_decision: {
    path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/official-split-approval-v0.1/results/owner-v0.1/official-split-approval-decision.v0.1.json",
    sha256: decisionSha256,
    decision_id: decision.decision_id,
    owner: decision.owner,
    owner_disposition: decision.owner_disposition,
    decided_at: decision.decided_at,
  },
  cross_reference_checks: { violations: [...verification.violations, ...structuralViolations], all_passed: verification.ok && structuralViolations.length === 0 },
  is_genuine_approval: verification.is_genuine_approval,
  sha_verification: {
    all_four_shas_matched_exactly_no_drift_tolerance_needed: true,
    v03_manifest_sha256: { cited: decision.v03_manifest_sha256, live_canonical: expected.v03_manifest_sha256, matches: decision.v03_manifest_sha256 === expected.v03_manifest_sha256 },
    v03_pool_sha256: { cited: decision.v03_pool_sha256, live: expected.v03_pool_sha256, matches: decision.v03_pool_sha256 === expected.v03_pool_sha256 },
    v03_anchor_sha256: { cited: decision.v03_anchor_sha256, live: expected.v03_anchor_sha256, matches: decision.v03_anchor_sha256 === expected.v03_anchor_sha256 },
    v03_author_sha256: { cited: decision.v03_author_sha256, live: expected.v03_author_sha256, matches: decision.v03_author_sha256 === expected.v03_author_sha256 },
  },
  live_recomputed_values: expected,
  real_files_unmodified: {
    anchor_selection_v02_unchanged: anchorV02Before === anchorV02After,
    author_allocation_v02_unchanged: authorV02Before === authorV02After,
    candidate_pool_v01_unchanged: poolV01Before === poolV01After,
    official_ledger_v02_unchanged: ledgerBefore === ledgerAfter,
  },
  official_split_eligible: decision.official_split_eligible === true,
  ...HARD_INVARIANTS,
  remaining_281_provisional_untouched: provisionalCount === 294,
  scope_note: "This Turn ADJUDICATES the Owner's APPROVE_OFFICIAL_SPLIT_V0.3 decision: it verifies every cited SHA/count/structural claim against freshly recomputed live data (all matched exactly, no timestamp-drift tolerance needed this time) and records official_split_eligible=true as the Owner's genuine, verified decision. It does NOT itself cut over any real release artifact, does NOT modify candidate-pool.v0.1.jsonl / anchor-selection.v0.2.jsonl / author-allocation.v0.2.jsonl (all three proven byte-unmodified above), does NOT touch Runtime/PostgreSQL/v0.20, does NOT authorize Gold authoring, and does NOT authorize any of the remaining 281 provisional relation decisions. Actually promoting v0.3 to be the release-facing official assignment is a SEPARATE, not-yet-requested future action requiring its own explicit scope and re-verification.",
});

console.log(JSON.stringify({
  status: "OFFICIAL_SPLIT_APPROVED_PROMOTION_NOT_YET_APPLIED",
  owner: decision.owner,
  owner_disposition: decision.owner_disposition,
  is_genuine_approval: verification.is_genuine_approval,
  cross_reference_all_passed: verification.ok && structuralViolations.length === 0,
  official_split_eligible: decision.official_split_eligible === true,
  gold_authoring_authorized: false,
  actual_official_promotion_applied: false,
  relation_decisions_authorized: false,
  output_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/official-split-approval-v0.1/results/owner-v0.1/",
}, null, 2));
