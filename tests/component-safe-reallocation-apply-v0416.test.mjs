// Turn N4.16: verifies the Strategy A v0.3 application build
// (scripts/build-component-safe-reallocation-apply-v0416.mjs) against the
// REAL Turn N4.13/N4.15 outputs, and that it never overwrites the real
// v0.2/v0.1 files, never touches the official ledger, and never sets
// official_split_eligible/gold_authoring_authorized true. Per this repo's
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
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-component-safe-reallocation-apply-v0416.mjs");
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const APPLIED_V03_DIR = resolve(CSR_DIR, "applied-v0.3");
const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");
const DELTA_PATH = resolve(CSR_DIR, "strategy-a-assignment-delta.v0.1.jsonl");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

let anchorBefore; let authorBefore; let poolBefore; let ledgerBefore;
test.before(() => {
  anchorBefore = sha256File(ANCHOR_V02_PATH);
  authorBefore = sha256File(AUTHOR_V02_PATH);
  poolBefore = sha256File(POOL_PATH);
  ledgerBefore = sha256File(LEDGER_PATH);
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

test("Turn N4.16: static proof -- every write call targets only applied-v0.3/, never the real v0.2/v0.1 files or the official ledger", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const APPLIED_V03_DIR = resolve\(CSR_DIR, "applied-v0\.3"\)/);
  const writeCallRegex = /\b(?:writeJson|writeJsonl)\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p" && t !== "rows");
  assert.ok(targets.length >= 4, `expected at least 4 write call sites, found ${targets.length}`);
  const allowedPrefixes = ["resolve(APPLIED_V03_DIR", "poolV03Path", "anchorV03Path", "authorV03Path"];
  for (const t of targets) assert.ok(allowedPrefixes.some((p) => t.startsWith(p)), `write target "${t}" is not provably APPLIED_V03_DIR-rooted`);
  assert.match(source, /const poolV03Path = resolve\(APPLIED_V03_DIR,/);
  assert.match(source, /const anchorV03Path = resolve\(APPLIED_V03_DIR,/);
  assert.match(source, /const authorV03Path = resolve\(APPLIED_V03_DIR,/);
  assert.doesNotMatch(source, /relation-closure-candidate-ledger\.v0\.2\.jsonl["'][\s\S]{0,50}write(?:FileSync|Jsonl|Json)|write(?:FileSync|Jsonl|Json)[\s\S]{0,50}relation-closure-candidate-ledger\.v0\.2\.jsonl/, "must never write to the official ledger");
});

test("Turn N4.16: the real anchor-selection.v0.2.jsonl, author-allocation.v0.2.jsonl, and candidate-pool.v0.1.jsonl are byte-unmodified", () => {
  assert.equal(sha256File(ANCHOR_V02_PATH), anchorBefore);
  assert.equal(sha256File(AUTHOR_V02_PATH), authorBefore);
  assert.equal(sha256File(POOL_PATH), poolBefore);
});

test("Turn N4.16: v0.3 output has the exact expected row counts and the expected number of changed ids", () => {
  const poolV03 = readJsonl(resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl"));
  const anchorV03 = readJsonl(resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl"));
  const authorV03 = readJsonl(resolve(APPLIED_V03_DIR, "author-allocation.v0.3.jsonl"));
  assert.equal(poolV03.length, 500);
  assert.equal(anchorV03.length, 150);
  assert.equal(authorV03.length, 150);

  const delta = readJsonl(DELTA_PATH);
  const splitDeltaIds = new Set(delta.filter((r) => r.dimension === "split").map((r) => r.assignment_id));
  const authorDeltaIds = new Set(delta.filter((r) => r.dimension === "author").map((r) => r.assignment_id));
  assert.equal(splitDeltaIds.size, 62);
  assert.equal(authorDeltaIds.size, 8);

  const poolV02 = readJsonl(POOL_PATH);
  const poolV02ById = new Map(poolV02.map((r) => [r.assignment_id, r]));
  let poolChangedCount = 0;
  for (const r of poolV03) {
    if (r.planned_split !== poolV02ById.get(r.assignment_id).planned_split) poolChangedCount += 1;
  }
  assert.equal(poolChangedCount, 62);

  const authorV02 = readJsonl(AUTHOR_V02_PATH);
  const authorV02ById = new Map(authorV02.map((r) => [r.assignment_id, r]));
  let authorChangedCount = 0;
  for (const r of authorV03) {
    if (r.author_allocation !== authorV02ById.get(r.assignment_id).author_allocation) authorChangedCount += 1;
  }
  assert.equal(authorChangedCount, 8);
});

test("Turn N4.16: anchor-selection.v0.3.jsonl is byte-identical in content to anchor-selection.v0.2.jsonl (Strategy A never touches Anchor content or membership)", () => {
  const anchorV02 = readJsonl(ANCHOR_V02_PATH);
  const anchorV03 = readJsonl(resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl"));
  assert.deepEqual(anchorV03, anchorV02);
});

test("Turn N4.16: only the touched assignment_ids differ, and only in planned_split/author_allocation -- no other field on ANY row was mutated", () => {
  const poolV02 = readJsonl(POOL_PATH);
  const poolV03 = readJsonl(resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl"));
  const poolV02ById = new Map(poolV02.map((r) => [r.assignment_id, r]));
  for (const r of poolV03) {
    const before = poolV02ById.get(r.assignment_id);
    for (const key of Object.keys(r)) {
      if (key === "planned_split") continue;
      assert.deepEqual(r[key], before[key], `pool record ${r.assignment_id} field "${key}" must be unchanged`);
    }
  }
  const authorV02 = readJsonl(AUTHOR_V02_PATH);
  const authorV03 = readJsonl(resolve(APPLIED_V03_DIR, "author-allocation.v0.3.jsonl"));
  const authorV02ById = new Map(authorV02.map((r) => [r.assignment_id, r]));
  for (const r of authorV03) {
    const before = authorV02ById.get(r.assignment_id);
    for (const key of Object.keys(r)) {
      if (key === "author_allocation") continue;
      assert.deepEqual(r[key], before[key], `author record ${r.assignment_id} field "${key}" must be unchanged`);
    }
  }
});

test("Turn N4.16: v0.3 achieves zero split/author/quarantine leakage, preserves split 242/81/177 and author 75/75, and preserves Anchor membership exactly", () => {
  const manifest = readJson(resolve(APPLIED_V03_DIR, "v0.3-application-manifest.v0.1.json"));
  assert.equal(manifest.status, "V0.3_CANDIDATE_BUILT_NOT_OFFICIAL");
  assert.equal(manifest.all_invariants_passed, true);
  assert.equal(manifest.live_recomputed_values.split_leakage_after, 0);
  assert.equal(manifest.live_recomputed_values.author_leakage_after, 0);
  assert.equal(manifest.live_recomputed_values.quarantine_intrusion_after, 0);
  assert.deepEqual(manifest.live_recomputed_values.split_counts, { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 });
  assert.deepEqual(manifest.live_recomputed_values.author_counts, { AUTHOR_A: 75, AUTHOR_B: 75 });
  assert.equal(manifest.invariant_checks.anchor_membership_unchanged, true);
  assert.equal(manifest.invariant_checks.critical_slice_floors_preserved, true);

  const anchorV02 = readJsonl(ANCHOR_V02_PATH);
  const anchorV03 = readJsonl(resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl"));
  const idsV02 = new Set(anchorV02.map((r) => r.assignment_id));
  const idsV03 = new Set(anchorV03.map((r) => r.assignment_id));
  assert.equal(idsV02.size, idsV03.size);
  for (const id of idsV02) assert.ok(idsV03.has(id));
});

test("Turn N4.16: HARD invariants -- official_split_eligible/gold_authoring_authorized/relation_decisions_authorized/actual_official_promotion_applied are all hardcoded false", () => {
  const manifest = readJson(resolve(APPLIED_V03_DIR, "v0.3-application-manifest.v0.1.json"));
  assert.equal(manifest.official_split_eligible, false);
  assert.equal(manifest.gold_authoring_authorized, false);
  assert.equal(manifest.relation_decisions_authorized, false);
  assert.equal(manifest.actual_official_promotion_applied, false);
  assert.equal(manifest.remaining_281_provisional_rows_untouched, true);
});

test("Turn N4.16: the official 326-row ledger is completely byte-unmodified, and the 294 provisional rows are untouched", () => {
  assert.equal(sha256File(LEDGER_PATH), ledgerBefore);
  const ledger = readJsonl(LEDGER_PATH);
  assert.equal(ledger.length, 326);
  const provisionalCount = ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
  assert.equal(provisionalCount, 294);
});

test("Turn N4.16: re-running the script is idempotent and deterministic (byte-identical v0.3 files and manifest apart from generated_at)", () => {
  function canonical(obj) { const c = { ...obj }; delete c.generated_at; return JSON.stringify(c, Object.keys(c).sort()); }
  const poolBeforeContent = readFileSync(resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl"), "utf8");
  const manifestBefore = canonical(readJson(resolve(APPLIED_V03_DIR, "v0.3-application-manifest.v0.1.json")));
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const poolAfterContent = readFileSync(resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl"), "utf8");
  const manifestAfter = canonical(readJson(resolve(APPLIED_V03_DIR, "v0.3-application-manifest.v0.1.json")));
  assert.equal(poolBeforeContent, poolAfterContent);
  assert.equal(manifestBefore, manifestAfter);
});
