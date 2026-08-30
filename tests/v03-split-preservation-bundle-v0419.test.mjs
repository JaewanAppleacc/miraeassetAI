// Turn N4.19: regression coverage for scripts/build-v03-split-preservation-bundle-v0419.mjs.
// This suite runs the REAL builder against the REAL, already-approved v0.3
// split data (read-only) and writes only under the bundle's own new
// directory -- it never modifies any v0.1/v0.2/v0.3 input, the Owner
// decision, or the 326-row ledger.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildV03PreservationBundle, BUNDLE_DIR } from "../scripts/build-v03-split-preservation-bundle-v0419.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }
function canonicalSha256(obj) {
  const clone = { ...obj };
  delete clone.generated_at;
  return sha256(Buffer.from(JSON.stringify(clone, Object.keys(clone).sort())));
}
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

const SOURCE_PATHS = [
  "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl",
  "work/handoff/anchor-dev-tune-v0.2/anchor-selection.v0.2.jsonl",
  "work/handoff/anchor-dev-tune-v0.2/author-allocation.v0.2.jsonl",
  "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/candidate-pool.v0.3.jsonl",
  "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/anchor-selection.v0.3.jsonl",
  "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/author-allocation.v0.3.jsonl",
  "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/v0.3-application-manifest.v0.1.json",
  "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/official-split-approval-v0.1/results/owner-v0.1/official-split-approval-decision.v0.1.json",
  "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/official-split-approval-v0.1/results/owner-v0.1/official-split-approval-decision-verification-report.v0.1.json",
  "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl",
  "work/handoff/anchor-dev-tune-v0.2/split-leakage-report.v0.2.json",
];

function hashAllSources() {
  return Object.fromEntries(SOURCE_PATHS.map((p) => [p, sha256(readFileSync(resolve(REPO_ROOT, p)))]));
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

test("buildV03PreservationBundle never modifies any of its 11 real source files", () => {
  const before = hashAllSources();
  buildV03PreservationBundle();
  const after = hashAllSources();
  assert.deepEqual(after, before, "every real v0.1/v0.2/v0.3/owner-decision/ledger source file must be byte-unmodified");
});

test("the bundle reports all required invariants true (500/150/150/75-75/242-81-177/leakage 0/quarantine 0/anchor unchanged/ledger 326/294/official_split_eligible), and the three unconditional gates false", () => {
  const result = buildV03PreservationBundle();
  assert.equal(result.invariants.candidate_pool_count_500, true);
  assert.equal(result.invariants.anchor_count_150, true);
  assert.equal(result.invariants.split_counts_242_81_177, true);
  assert.equal(result.invariants.author_counts_75_75, true);
  assert.equal(result.invariants.split_leakage_zero, true);
  assert.equal(result.invariants.author_leakage_zero, true);
  assert.equal(result.invariants.quarantine_intrusion_zero, true);
  assert.equal(result.invariants.anchor_membership_unchanged, true);
  assert.equal(result.invariants.critical_slice_floors_preserved, true);
  assert.equal(result.invariants.ledger_326_rows_unchanged, true);
  assert.equal(result.invariants.remaining_281_provisional_untouched, true);
  assert.equal(result.invariants.official_split_eligible, true);
  assert.equal(result.invariants.actual_official_promotion_applied, false);
  assert.equal(result.invariants.gold_authoring_authorized, false);
  assert.equal(result.invariants.relation_decisions_authorized, false);
});

test("the bundle directory contains exactly the declared file set: 11 copied source files + 4 new manifests, nothing missing, nothing extra", () => {
  buildV03PreservationBundle();
  const actual = new Set(walkFiles(BUNDLE_DIR));
  const expected = new Set([
    "inputs/candidate-pool.v0.1.jsonl",
    "inputs/anchor-selection.v0.2.jsonl",
    "inputs/author-allocation.v0.2.jsonl",
    "v0.3/candidate-pool.v0.3.jsonl",
    "v0.3/anchor-selection.v0.3.jsonl",
    "v0.3/author-allocation.v0.3.jsonl",
    "v0.3/v0.3-application-manifest.v0.1.json",
    "owner-approval/official-split-approval-decision.v0.1.json",
    "owner-approval/official-split-approval-decision-verification-report.v0.1.json",
    "ledger/relation-closure-candidate-ledger.v0.2.jsonl",
    "ledger/split-leakage-report.v0.2.json",
    "input-pin-manifest.v0.1.json",
    "invariant-verification-report.v0.1.json",
    "portable-bundle-manifest.v0.1.json",
    "deterministic-rebuild-report.v0.1.json",
  ]);
  assert.deepEqual(actual, expected);
});

test("portable-bundle-manifest.v0.1.json: every bundle_path is relative, contains no /Users/, and no '..' traversal segment", () => {
  buildV03PreservationBundle();
  const manifest = readJson(resolve(BUNDLE_DIR, "portable-bundle-manifest.v0.1.json"));
  assert.equal(manifest.entry_count, 11);
  assert.equal(manifest.entries.length, 11);
  for (const entry of manifest.entries) {
    assert.equal(entry.bundle_path.startsWith("/"), false, `${entry.bundle_path} must not be absolute`);
    assert.equal(entry.bundle_path.includes("/Users/"), false, `${entry.bundle_path} must not embed a home path`);
    assert.equal(entry.bundle_path.split("/").includes(".."), false, `${entry.bundle_path} must not traverse`);
  }
  assert.equal(manifest.portability_check.no_absolute_paths, true);
  assert.equal(manifest.portability_check.no_home_directory_paths, true);
  assert.equal(manifest.portability_check.no_traversal_segments, true);
  assert.match(manifest.canonical_sha_exclusion_rule, /generated_at/);
});

test("input-pin-manifest.v0.1.json: every source_path is repo-relative (no leading '/', no home path) and matches the real files' live SHA/count", () => {
  buildV03PreservationBundle();
  const manifest = readJson(resolve(BUNDLE_DIR, "input-pin-manifest.v0.1.json"));
  for (const [key, entry] of Object.entries(manifest.inputs)) {
    assert.equal(entry.source_path.startsWith("/"), false, `${key}.source_path must not be absolute`);
    assert.equal(entry.source_path.includes("/Users/"), false, `${key}.source_path must not embed a home path`);
    const realBytes = readFileSync(resolve(REPO_ROOT, entry.source_path));
    if (entry.sha256) assert.equal(entry.sha256, sha256(realBytes), `${key}.sha256 must match the real file's live hash`);
  }
  assert.equal(manifest.inputs.candidate_pool_v01.row_count, 500);
  assert.equal(manifest.inputs.anchor_selection_v02.row_count, 150);
  assert.equal(manifest.inputs.author_allocation_v02.row_count, 150);
  assert.equal(manifest.inputs.candidate_pool_v03.row_count, 500);
  assert.equal(manifest.inputs.anchor_selection_v03.row_count, 150);
  assert.equal(manifest.inputs.author_allocation_v03.row_count, 150);
  assert.equal(manifest.inputs.relation_closure_candidate_ledger_v02.row_count, 326);
  assert.equal(manifest.inputs.relation_closure_candidate_ledger_v02.provisional_count, 294);
});

test("deterministic rebuild: running the builder twice produces IDENTICAL canonical hashes for every JSON manifest and identical raw hashes for every .jsonl data file, apart from each manifest's own generated_at", () => {
  buildV03PreservationBundle({ generatedAt: "2026-01-01T00:00:00.000Z" });
  const firstRun = Object.fromEntries(walkFiles(BUNDLE_DIR).map((p) => {
    const bytes = readFileSync(resolve(BUNDLE_DIR, p));
    return [p, p.endsWith(".jsonl") ? { raw: sha256(bytes) } : { canonical: canonicalSha256(JSON.parse(bytes.toString("utf8"))) }];
  }));

  buildV03PreservationBundle({ generatedAt: "2027-06-15T12:34:56.000Z" });
  const secondRun = Object.fromEntries(walkFiles(BUNDLE_DIR).map((p) => {
    const bytes = readFileSync(resolve(BUNDLE_DIR, p));
    return [p, p.endsWith(".jsonl") ? { raw: sha256(bytes) } : { canonical: canonicalSha256(JSON.parse(bytes.toString("utf8"))) }];
  }));

  assert.deepEqual(secondRun, firstRun, "every file's content-hash (canonical for JSON, raw for .jsonl) must be identical across two builds with different generatedAt values");
});

test("a real .jsonl data file inside the bundle is byte-identical to its real source file (no re-derivation, no reformatting)", () => {
  buildV03PreservationBundle();
  const pairs = [
    ["work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl", "inputs/candidate-pool.v0.1.jsonl"],
    ["work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/candidate-pool.v0.3.jsonl", "v0.3/candidate-pool.v0.3.jsonl"],
    ["work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl", "ledger/relation-closure-candidate-ledger.v0.2.jsonl"],
  ];
  for (const [sourceRel, bundleRel] of pairs) {
    const sourceBytes = readFileSync(resolve(REPO_ROOT, sourceRel));
    const bundleBytes = readFileSync(resolve(BUNDLE_DIR, bundleRel));
    assert.equal(sha256(bundleBytes), sha256(sourceBytes), `${bundleRel} must be byte-identical to ${sourceRel}`);
  }
});

test("invariant-verification-report.v0.1.json independently re-states the Owner decision identity and re-verification outcome", () => {
  buildV03PreservationBundle();
  const report = readJson(resolve(BUNDLE_DIR, "invariant-verification-report.v0.1.json"));
  assert.equal(report.owner_decision.owner_disposition, "APPROVE_OFFICIAL_SPLIT_V0.3");
  assert.equal(report.owner_decision.re_verification_ok, true);
  assert.equal(report.owner_decision.is_genuine_approval, true);
  assert.equal(report.all_invariants_passed, true);
  assert.equal(report.production_runtime_postgresql_v020_untouched, true);
});
