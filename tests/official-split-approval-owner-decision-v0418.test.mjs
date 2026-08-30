// Turn N4.18: verifies the Owner's downloaded APPROVE_OFFICIAL_SPLIT_V0.3
// decision adjudication (scripts/build-official-split-approval-owner
// -decision-v0418.mjs) against the REAL, already-downloaded Owner decision,
// and that it never promotes v0.3 to be the real release-facing assignment,
// never authorizes Gold authoring, and never touches the official ledger or
// any of the remaining 281 provisional relations. Per this repo's
// established convention, "never modifies a sibling artifact" is proven via
// a static write-scope scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-official-split-approval-owner-decision-v0418.mjs");
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const OFFICIAL_SPLIT_DIR = resolve(CSR_DIR, "official-split-approval-v0.1");
const RESULTS_OWNER_DIR = resolve(OFFICIAL_SPLIT_DIR, "results/owner-v0.1");
const OWNER_DECISION_PATH = resolve(RESULTS_OWNER_DIR, "official-split-approval-decision.v0.1.json");
const REPORT_PATH = resolve(RESULTS_OWNER_DIR, "official-split-approval-decision-verification-report.v0.1.json");
const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_V01_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

let anchorBefore; let authorBefore; let poolBefore; let ledgerBefore;
test.before(() => {
  anchorBefore = sha256File(ANCHOR_V02_PATH);
  authorBefore = sha256File(AUTHOR_V02_PATH);
  poolBefore = sha256File(POOL_V01_PATH);
  ledgerBefore = sha256File(LEDGER_PATH);
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

test("Turn N4.18: static proof -- the script's only write call targets its own results/owner-v0.1/ report path", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const RESULTS_OWNER_DIR = resolve\(OFFICIAL_SPLIT_DIR, "results\/owner-v0\.1"\)/);
  const writeCallRegex = /\bwriteJson\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p");
  assert.deepEqual(targets, ["reportPath"]);
  assert.match(source, /const reportPath = resolve\(RESULTS_OWNER_DIR, "official-split-approval-decision-verification-report\.v0\.1\.json"\)/);
});

test("Turn N4.18: the persisted Owner decision matches the real downloaded record exactly", () => {
  const decision = readJson(OWNER_DECISION_PATH);
  assert.equal(decision.decision_id, "2f92d078-75bb-405d-b19e-d15c466d9672");
  assert.equal(decision.owner, "최재완");
  assert.equal(decision.owner_disposition, "APPROVE_OFFICIAL_SPLIT_V0.3");
  assert.equal(decision.official_split_eligible, true);
  assert.equal(decision.gold_authoring_authorized, false);
  assert.equal(decision.actual_official_promotion_applied, false);
  assert.equal(decision.checklist.length, 10);
  assert.ok(decision.checklist.every((c) => c.checked === true));
});

test("Turn N4.18: the verification report shows every cross-reference check passing, is a genuine approval, and all four v0.3 SHAs matched exactly with no drift tolerance needed", () => {
  const report = readJson(REPORT_PATH);
  assert.equal(report.status, "OFFICIAL_SPLIT_APPROVED_PROMOTION_NOT_YET_APPLIED");
  assert.deepEqual(report.cross_reference_checks.violations, []);
  assert.equal(report.cross_reference_checks.all_passed, true);
  assert.equal(report.is_genuine_approval, true);
  assert.equal(report.sha_verification.all_four_shas_matched_exactly_no_drift_tolerance_needed, true);
  for (const key of ["v03_manifest_sha256", "v03_pool_sha256", "v03_anchor_sha256", "v03_author_sha256"]) {
    assert.equal(report.sha_verification[key].matches, true, `${key} must match exactly`);
    assert.equal(report.sha_verification[key].cited, report.sha_verification[key].live ?? report.sha_verification[key].live_canonical);
  }
});

test("Turn N4.18: live_recomputed_values match the v0.3 candidate's known real numbers exactly (never hardcoded copy-paste of the decision)", () => {
  const report = readJson(REPORT_PATH);
  assert.equal(report.live_recomputed_values.anchor_count, 150);
  assert.equal(report.live_recomputed_values.candidate_pool_count, 500);
  assert.equal(report.live_recomputed_values.author_count, 150);
  assert.equal(report.live_recomputed_values.split_leakage_after, 0);
  assert.equal(report.live_recomputed_values.author_leakage_after, 0);
  assert.equal(report.live_recomputed_values.quarantine_intrusion_after, 0);
  assert.deepEqual(report.live_recomputed_values.split_counts, { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 });
  assert.deepEqual(report.live_recomputed_values.author_counts, { AUTHOR_A: 75, AUTHOR_B: 75 });
});

test("Turn N4.18: official_split_eligible is recorded true (the Owner's genuine verified decision), while gold_authoring_authorized/actual_official_promotion_applied/relation_decisions_authorized/anchor_membership_changed remain hardcoded false", () => {
  const report = readJson(REPORT_PATH);
  assert.equal(report.official_split_eligible, true);
  assert.equal(report.gold_authoring_authorized, false);
  assert.equal(report.actual_official_promotion_applied, false);
  assert.equal(report.relation_decisions_authorized, false);
  assert.equal(report.anchor_membership_changed, false);
  assert.equal(report.remaining_281_provisional_untouched, true);
});

test("Turn N4.18: NO actual promotion happened -- candidate-pool.v0.1.jsonl, anchor-selection.v0.2.jsonl, author-allocation.v0.2.jsonl, and the official ledger are byte-unmodified by this script's own execution", () => {
  const anchorAfter = sha256File(ANCHOR_V02_PATH);
  const authorAfter = sha256File(AUTHOR_V02_PATH);
  const poolAfter = sha256File(POOL_V01_PATH);
  const ledgerAfter = sha256File(LEDGER_PATH);
  assert.equal(anchorAfter, anchorBefore, "anchor-selection.v0.2.jsonl must be byte-unmodified");
  assert.equal(authorAfter, authorBefore, "author-allocation.v0.2.jsonl must be byte-unmodified");
  assert.equal(poolAfter, poolBefore, "candidate-pool.v0.1.jsonl must be byte-unmodified -- this Turn is an ADJUDICATION, not a cutover");
  assert.equal(ledgerAfter, ledgerBefore, "the official 326-row ledger must be byte-unmodified");

  const report = readJson(REPORT_PATH);
  assert.equal(report.real_files_unmodified.anchor_selection_v02_unchanged, true);
  assert.equal(report.real_files_unmodified.author_allocation_v02_unchanged, true);
  assert.equal(report.real_files_unmodified.candidate_pool_v01_unchanged, true);
  assert.equal(report.real_files_unmodified.official_ledger_v02_unchanged, true);
});

test("Turn N4.18: the official 326-row ledger still shows 294 provisional rows -- this Turn never touches the remaining 281 provisional relations", () => {
  const ledger = readJsonl(LEDGER_PATH);
  assert.equal(ledger.length, 326);
  const provisionalCount = ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
  assert.equal(provisionalCount, 294);
});

test("Turn N4.18: re-running the script is idempotent and deterministic (byte-identical report apart from generated_at)", () => {
  function canonical(obj) { const c = { ...obj }; delete c.generated_at; return JSON.stringify(c, Object.keys(c).sort()); }
  const before = canonical(readJson(REPORT_PATH));
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const after = canonical(readJson(REPORT_PATH));
  assert.equal(before, after);
});
