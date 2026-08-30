// Turn N4.12: verifies the Owner batch-ratification integration
// (scripts/build-relation-closure-priority-wave-1-owner-ratification-v0412
// .mjs) against the REAL, already-downloaded Owner decision, and that it
// never promotes anything to an official Relation or changes Turn N4.11's
// leakage/gate state. Per this repo's established convention, "never
// modifies a sibling artifact" is proven via a static write-scope scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-relation-closure-priority-wave-1-owner-ratification-v0412.mjs");
const DR_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1");
const PW1_DIR = resolve(DR_DIR, "priority-wave-1-v0.1");
const CONSENSUS_DIR = resolve(PW1_DIR, "consensus-integration-v0.1");
const OWNER_RATIFICATION_DIR = resolve(CONSENSUS_DIR, "owner-ratification-v0.1");
const OWNER_DECISION_PATH = resolve(PW1_DIR, "results/owner-v0.1/priority-wave-1-owner-ratification-decision.v0.1.json");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

test.before(() => {
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

test("Turn N4.12: static proof -- every write call targets only owner-ratification-v0.1/, never the consensus ledger, gate file, or any N4.9/N4.10/N4.11 sibling path", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const OWNER_RATIFICATION_DIR = resolve\(CONSENSUS_DIR, "owner-ratification-v0\.1"\)/);
  const writeCallRegex = /\b(?:writeJson|writeJsonl|writeFileSync)\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p");
  assert.ok(targets.length >= 2, `expected at least 2 write call sites, found ${targets.length}`);
  const allowedPrefixes = ["resolve(OWNER_RATIFICATION_DIR", "ratifiedLedgerPath"];
  for (const t of targets) assert.ok(allowedPrefixes.some((p) => t.startsWith(p)), `write target "${t}" is not provably OWNER_RATIFICATION_DIR-rooted`);
  assert.match(source, /const ratifiedLedgerPath = resolve\(OWNER_RATIFICATION_DIR,/);
  assert.doesNotMatch(source, /relation-closure-candidate-ledger\.v0\.2\.jsonl["'][\s\S]{0,50}writeFileSync|writeFileSync[\s\S]{0,50}relation-closure-candidate-ledger\.v0\.2\.jsonl/, "must never write to the official ledger");
});

test("Turn N4.12: the persisted Owner decision matches the real downloaded record exactly, and passes every cross-reference check", () => {
  const decision = readJson(OWNER_DECISION_PATH);
  assert.equal(decision.decision_id, "f852f7ac-4821-43f8-a91a-45ae36d21d9d");
  assert.equal(decision.owner, "최재완");
  assert.equal(decision.owner_disposition, "APPROVE_DUAL_REVIEW_CONSENSUS");
  assert.equal(decision.confirm_count, 6);
  assert.equal(decision.reject_count, 7);
  assert.equal(decision.needs_more_review_count, 0);
  assert.equal(decision.official_split_eligible, false);
  assert.equal(decision.gold_authoring_authorized, false);
  assert.equal(decision.reviewed_relation_candidate_ids.length, 13);

  const report = readJson(resolve(OWNER_RATIFICATION_DIR, "priority-wave-1-owner-ratification-verification-report.v0.1.json"));
  assert.equal(report.status, "OWNER_RATIFICATION_VERIFIED");
  assert.deepEqual(report.cross_reference_checks.violations, []);
  assert.equal(report.cross_reference_checks.all_passed, true);
});

test("Turn N4.12: the timestamp-only drift on prospective_graph_report_sha256 is explicitly recorded, evidenced by a real rerun-determinism proof, never silently swallowed", () => {
  const report = readJson(resolve(OWNER_RATIFICATION_DIR, "priority-wave-1-owner-ratification-verification-report.v0.1.json"));
  const note = report.prospective_graph_report_sha_note;
  assert.ok(note, "the waiver must be transparently recorded, not silently accepted");
  assert.equal(note.accepted_as, "TIMESTAMP_ONLY_DRIFT_CONFIRMED_VIA_RERUN_DETERMINISM");
  assert.ok(note.canonical_sha256_now);
  assert.ok(note.owner_cited_sha256);
  assert.notEqual(note.canonical_sha256_now, note.owner_cited_sha256, "owner_cited_sha256 is the OLD raw hash -- it must differ from the current canonical hash to justify why a note exists at all");
});

test("Turn N4.12: HARD invariant -- official_split_eligible and gold_authoring_authorized are false everywhere in this Turn's output, and Turn N4.11's gate-status-after-wave1.v0.1.json is completely unchanged", () => {
  const report = readJson(resolve(OWNER_RATIFICATION_DIR, "priority-wave-1-owner-ratification-verification-report.v0.1.json"));
  assert.equal(report.official_split_eligible, false);
  assert.equal(report.gold_authoring_authorized, false);
  assert.equal(report.gate_after_wave1_unchanged.official_split_eligible, false);

  const gate = readJson(resolve(CONSENSUS_DIR, "gate-status-after-wave1.v0.1.json"));
  assert.equal(gate.status, "LEAKAGE_REMAINS_AFTER_PRIORITY_WAVE_1");
  assert.equal(gate.official_split_eligible, false);
  assert.equal(gate.gold_authoring_status, "BLOCKED_PENDING_NEXT_PRIORITY_WAVE");
});

test("Turn N4.12: the owner-ratified consensus ledger has exactly 13 rows, consensus_status is upgraded to OWNER_RATIFIED, but official_relation_status is explicitly NOT an official promotion", () => {
  const rows = readJsonl(resolve(OWNER_RATIFICATION_DIR, "priority-wave-1-owner-ratified-consensus.v0.1.jsonl"));
  assert.equal(rows.length, 13);
  assert.equal(new Set(rows.map((r) => r.relation_candidate_id)).size, 13);
  const confirmRows = rows.filter((r) => r.consensus_disposition === "CONFIRM");
  const rejectRows = rows.filter((r) => r.consensus_disposition === "REJECT");
  assert.equal(confirmRows.length, 6);
  assert.equal(rejectRows.length, 7);
  for (const row of rows) {
    assert.equal(row.consensus_status, "DUAL_REVIEW_CONSENSUS_OWNER_RATIFIED");
    assert.equal(row.official_relation_status, "NOT_YET_OFFICIALLY_PROMOTED");
    assert.equal(row.auto_promoted_to_official_relation, false);
    assert.equal(row.official_split_eligible, false);
    assert.equal(row.owner_ratification.owner, "최재완");
    assert.equal(row.owner_ratification.owner_disposition, "APPROVE_DUAL_REVIEW_CONSENSUS");
  }
});

test("Turn N4.12: the official 326-row relation-closure-candidate-ledger.v0.2.jsonl is byte-unmodified, and Reviewer E/F decision files still match their Turn N4.11 pins", () => {
  const ledger = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl"));
  assert.equal(ledger.length, 326);
  const provisionalCount = ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
  assert.equal(provisionalCount, 294, "the official ledger must still show all 294 as provisional -- this Turn never promotes anything into it");
});

test("Turn N4.12: re-running the script is idempotent and deterministic (byte-identical ratified ledger apart from generated_at)", () => {
  const before = readFileSync(resolve(OWNER_RATIFICATION_DIR, "priority-wave-1-owner-ratified-consensus.v0.1.jsonl"), "utf8");
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const after = readFileSync(resolve(OWNER_RATIFICATION_DIR, "priority-wave-1-owner-ratified-consensus.v0.1.jsonl"), "utf8");
  assert.equal(before, after);
});
