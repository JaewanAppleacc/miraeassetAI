// Turn N4.15: verifies the Owner batch-approval processing for Turn N4.13's
// Strategy A component-safe reallocation plan
// (scripts/build-component-safe-reallocation-owner-decision-v0415.mjs)
// against the REAL, already-downloaded Owner decision, and that it never
// applies the plan, changes Anchor 150 membership, or authorizes official
// split / Gold authoring / the remaining 281 provisional relation decisions.
// Per this repo's established convention, "never modifies a sibling
// artifact" is proven via a static write-scope scan, and byte-unmodified
// real-file claims are proven via a live before/after hash comparison of
// this script's OWN read-only inputs (not a race-prone shared artifact).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-component-safe-reallocation-owner-decision-v0415.mjs");
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const OWNER_REVIEW_DIR = resolve(CSR_DIR, "owner-review-v0.1");
const RESULTS_OWNER_DIR = resolve(OWNER_REVIEW_DIR, "results/owner-v0.1");
const OWNER_DECISION_PATH = resolve(RESULTS_OWNER_DIR, "component-safe-reallocation-owner-decision.v0.1.json");
const REPORT_PATH = resolve(RESULTS_OWNER_DIR, "component-safe-reallocation-owner-decision-verification-report.v0.1.json");
const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

let anchorBefore; let authorBefore; let poolBefore;
test.before(() => {
  anchorBefore = sha256File(ANCHOR_V02_PATH);
  authorBefore = sha256File(AUTHOR_V02_PATH);
  poolBefore = sha256File(POOL_PATH);
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

test("Turn N4.15: static proof -- the script's only write call targets its own results/owner-v0.1/ report path", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const RESULTS_OWNER_DIR = resolve\(OWNER_REVIEW_DIR, "results\/owner-v0\.1"\)/);
  const writeCallRegex = /\bwriteJson\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p");
  assert.deepEqual(targets, ["reportPath"]);
  assert.match(source, /const reportPath = resolve\(RESULTS_OWNER_DIR, "component-safe-reallocation-owner-decision-verification-report\.v0\.1\.json"\)/);
});

test("Turn N4.15: the persisted Owner decision matches the real downloaded record exactly", () => {
  const decision = readJson(OWNER_DECISION_PATH);
  assert.equal(decision.decision_id, "ac91a441-c97c-48d5-8f58-d504784d3cb5");
  assert.equal(decision.owner, "최재완");
  assert.equal(decision.owner_disposition, "APPROVE_COMPONENT_SAFE_REALLOCATION");
  assert.equal(decision.delta_sha256, "543c1b541d0d66b0362610472e02e9461223ecc9d6bd71933d798bb41683d81e");
  assert.equal(decision.split_operation_count, 62);
  assert.equal(decision.author_operation_count, 8);
  assert.equal(decision.unique_changed_assignment_count, 70);
  assert.equal(decision.checklist.length, 10);
  assert.ok(decision.checklist.every((c) => c.checked === true));
});

test("Turn N4.15: the verification report shows every cross-reference check passing, with delta_sha256 an EXACT match (never waived)", () => {
  const report = readJson(REPORT_PATH);
  assert.equal(report.status, "OWNER_DECISION_VERIFIED_STRATEGY_A_NOT_APPLIED");
  assert.deepEqual(report.cross_reference_checks.violations, []);
  assert.equal(report.cross_reference_checks.all_passed, true);
  assert.equal(report.delta_sha256_exact_match, true);
});

test("Turn N4.15: plan_sha256/verification_report_sha256 drift is explicitly recorded with real reproducibility evidence, never silently swallowed", () => {
  const report = readJson(REPORT_PATH);
  for (const field of ["plan_sha256", "verification_report_sha256"]) {
    const note = report.sha_drift_notes[field];
    assert.ok(note, `${field} drift must be transparently recorded`);
    assert.equal(note.accepted_as, "PRE_FIX_RAW_HASH_CITATION_CONTENT_REPRODUCIBILITY_CONFIRMED");
    assert.equal(note.matches_current_raw, false, "the owner-cited value is a stale RAW hash -- it must not match the current (different) raw hash");
    assert.equal(note.matches_current_canonical, false, "the owner-cited value predates the canonical-hash fix -- it must not equal the current canonical hash either");
    assert.ok(note.owner_cited_sha256 && note.current_canonical_sha256);
  }
});

test("Turn N4.15: live_recomputed_values and live_structural_values match the plan's known real numbers exactly (never hardcoded copy-paste of the decision)", () => {
  const report = readJson(REPORT_PATH);
  assert.equal(report.live_recomputed_values.anchor_count, 150);
  assert.equal(report.live_recomputed_values.candidate_pool_count, 500);
  assert.equal(report.live_recomputed_values.split_operation_count, 62);
  assert.equal(report.live_recomputed_values.author_operation_count, 8);
  assert.equal(report.live_recomputed_values.unique_changed_assignment_count, 70);
  assert.equal(report.live_recomputed_values.overlapping_assignment_count, 0);
  assert.equal(report.live_recomputed_values.quarantine_intrusion_count, 0);
  assert.deepEqual(report.live_structural_values.before_split_counts, { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 });
  assert.deepEqual(report.live_structural_values.after_split_counts, { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 });
  assert.deepEqual(report.live_structural_values.before_author_counts, { AUTHOR_A: 75, AUTHOR_B: 75 });
  assert.deepEqual(report.live_structural_values.after_author_counts, { AUTHOR_A: 75, AUTHOR_B: 75 });
  assert.equal(report.live_structural_values.before_split_leakage, 6);
  assert.equal(report.live_structural_values.after_split_leakage, 0);
  assert.equal(report.live_structural_values.before_author_leakage, 4);
  assert.equal(report.live_structural_values.after_author_leakage, 0);
});

test("Turn N4.15: HARD invariants -- official_split_eligible/gold_authoring_authorized/anchor_membership_changed/relation_decisions_authorized are hardcoded false in the report, and strategy_a_applied is false", () => {
  const report = readJson(REPORT_PATH);
  assert.equal(report.official_split_eligible, false);
  assert.equal(report.gold_authoring_authorized, false);
  assert.equal(report.anchor_membership_changed, false);
  assert.equal(report.relation_decisions_authorized, false);
  assert.equal(report.strategy_a_applied, false);
});

test("Turn N4.15: Strategy A remains UNAPPLIED -- anchor-selection.v0.2.jsonl, author-allocation.v0.2.jsonl, and candidate-pool.v0.1.jsonl are byte-unmodified by this script's own execution", () => {
  const anchorAfter = sha256File(ANCHOR_V02_PATH);
  const authorAfter = sha256File(AUTHOR_V02_PATH);
  const poolAfter = sha256File(POOL_PATH);
  assert.equal(anchorAfter, anchorBefore, "anchor-selection.v0.2.jsonl must be byte-unmodified");
  assert.equal(authorAfter, authorBefore, "author-allocation.v0.2.jsonl must be byte-unmodified");
  assert.equal(poolAfter, poolBefore, "candidate-pool.v0.1.jsonl must be byte-unmodified");

  const report = readJson(REPORT_PATH);
  assert.equal(report.strategy_a_unapplied_proof.anchor_selection_v02_unchanged, true);
  assert.equal(report.strategy_a_unapplied_proof.author_allocation_v02_unchanged, true);
  assert.equal(report.strategy_a_unapplied_proof.candidate_pool_v01_unchanged, true);
});

test("Turn N4.15: the official 500-row candidate pool and 150-row Anchor/Author files still show their pre-existing counts -- this Turn never touches the remaining 281 provisional relations", () => {
  const pool = readJsonl(POOL_PATH);
  assert.equal(pool.length, 500);
  const anchor = readJsonl(ANCHOR_V02_PATH);
  assert.equal(anchor.length, 150);
  const author = readJsonl(AUTHOR_V02_PATH);
  assert.equal(author.length, 150);
  const ledger = readJsonl(resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl"));
  assert.equal(ledger.length, 326);
  const provisionalCount = ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
  assert.equal(provisionalCount, 294, "this Turn must never promote or resolve any of the 294 provisional relations");
});

test("Turn N4.15: re-running the script is idempotent and deterministic (byte-identical report apart from generated_at)", () => {
  function canonical(obj) { const c = { ...obj }; delete c.generated_at; return JSON.stringify(c, Object.keys(c).sort()); }
  const before = canonical(readJson(REPORT_PATH));
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const after = canonical(readJson(REPORT_PATH));
  assert.equal(before, after);
});
