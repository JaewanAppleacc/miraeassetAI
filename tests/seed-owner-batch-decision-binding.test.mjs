// Attack-scenario coverage for assertOwnerBatchDecisionBinding in
// domain/adapters/seed-runtime-service-adapters.mjs -- the v0.19
// hardening that makes decision.owner_batch_decision genuinely
// load-bearing at the real Runtime release-authorization boundary,
// closing the gap where domain/releases/seed-release.v0.18.decision.json
// declared it (path/sha256/record_count/all_approve) but nothing in the
// construction pipeline ever read it; only tests/seed-release-v018.test.mjs
// checked it separately.
//
// Every scenario below calls the REAL createSeedRuntimeServiceAdapters
// against a mutated copy of the real, working v0.19 release bundle -- no
// hand-rolled shape check, no test-only file-reading shortcut standing in
// for the actual construction path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSeedRuntimeServiceAdapters, ReleaseNotApprovedError } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const STRUCTURED_MANIFEST = path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json");
const REAL_CANONICAL_MANIFEST = path.join(ROOT, "domain/releases/seed-release.v0.19.manifest.json");
const REAL_DECISION_PATH = path.join(ROOT, "domain/releases/seed-release.v0.19.decision.json");
const PLAN_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl");
const PLAN_MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json");
const REAL_OWNER_BATCH_PATH = path.join(ROOT, "work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl");

function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256OfString(text) { return sha256Hex(Buffer.from(text, "utf8")); }
function jsonl(records) { return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`; }
function toRootRelative(p) { return path.relative(ROOT, p).split(path.sep).join("/"); }

async function loadGolden() {
  const [canonical, decision] = await Promise.all([
    readFile(REAL_CANONICAL_MANIFEST, "utf8").then(JSON.parse),
    readFile(REAL_DECISION_PATH, "utf8").then(JSON.parse),
  ]);
  return { canonical, decision };
}

// Rewrites a (possibly mutated) {canonical, decision} pair into a fresh
// temp directory under ROOT/work (gitignored scratch), rebinding
// canonical.release_authorization.decision_artifact_path/sha256 and
// decision.canonical_release_manifest.path so the pair stays internally
// self-consistent -- decision.canonical_release_manifest.sha256 and every
// OTHER field (structured_manifest, thin_plan*, owner_batch_decision
// unless the caller already mutated it) are left exactly as the real,
// working v0.19 decision declares them, since none of that changed.
async function writeBundle(t, { canonical, decision }) {
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-owner-batch-tmp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const decisionFinal = { ...decision, canonical_release_manifest: { ...decision.canonical_release_manifest, path: toRootRelative(path.join(directory, "canonical.json")) } };
  const decisionText = `${JSON.stringify(decisionFinal, null, 2)}\n`;
  await writeFile(path.join(directory, "decision.json"), decisionText);
  const finalCanonical = {
    ...canonical,
    release_authorization: {
      ...canonical.release_authorization,
      decision_artifact_path: toRootRelative(path.join(directory, "decision.json")),
      decision_artifact_sha256: sha256OfString(decisionText),
    },
  };
  const canonicalPath = path.join(directory, "canonical.json");
  await writeFile(canonicalPath, JSON.stringify(finalCanonical, null, 2));
  return { canonicalPath, directory };
}

// Writes a mutated copy of the real 6-item owner batch decision (via
// `transform`) into a fresh temp file under ROOT/work, and returns the
// exact path/sha256/record_count a self-consistent (internally correct)
// decision.owner_batch_decision would declare for it -- so each test
// exercises a batch that is byte-correct with respect to its OWN declared
// hash/count, and only wrong in the one way the test targets.
async function writeMutatedBatch(t, transform) {
  const realItems = (await readFile(REAL_OWNER_BATCH_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const mutated = transform(realItems.map((r) => ({ ...r })));
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-owner-batch-content-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const batchPath = path.join(directory, "batch.jsonl");
  const text = jsonl(mutated);
  await writeFile(batchPath, text);
  const bytes = await readFile(batchPath);
  return { path: toRootRelative(batchPath), sha256: sha256Hex(bytes), record_count: mutated.length, absolutePath: batchPath };
}

async function constructWith(canonicalPath) {
  return createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST, canonicalReleaseManifestPath: canonicalPath,
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
  });
}

function assertReleaseNotApproved(error, messagePattern) {
  assert.ok(error instanceof ReleaseNotApprovedError, `expected ReleaseNotApprovedError, got ${error}`);
  assert.equal(error.code, "RELEASE_NOT_APPROVED");
  if (messagePattern) assert.match(error.message, messagePattern);
  return true;
}

// ---------------------------------------------------------------------------
// 1. Positive control
// ---------------------------------------------------------------------------

test("positive: the real, unmutated v0.19 bundle passes, with owner_batch_decision now genuinely checked", async () => {
  const bundle = await constructWith(REAL_CANONICAL_MANIFEST);
  assert.deepEqual(bundle.serviceAdapters.structuredStoreAdapter.recordCounts(), { FACT: 73, EVENT: 24, RELATION: 40, EVIDENCE: 219 });
});

test("positive: the real, unmutated v0.18 bundle also still passes (owner_batch_decision was already correct there too)", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST,
    canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.18.manifest.json"),
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
  });
  assert.deepEqual(bundle.serviceAdapters.structuredStoreAdapter.recordCounts(), { FACT: 73, EVENT: 24, RELATION: 40, EVIDENCE: 219 });
});

// ---------------------------------------------------------------------------
// 2. Batch decision file missing
// ---------------------------------------------------------------------------

test("negative: owner_batch_decision.path pointing at a non-existent file is refused", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: "work/domain-seed/does-not-exist-batch.jsonl" } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /owner_batch_decision\.path could not be resolved/));
});

// ---------------------------------------------------------------------------
// 3. SHA mismatch
// ---------------------------------------------------------------------------

test("negative: owner_batch_decision.sha256 disagreeing with the real file's actual bytes is refused", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, sha256: "0".repeat(64) } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /owner_batch_decision\.sha256 does not match/));
});

// ---------------------------------------------------------------------------
// 4. record_count mismatch
// ---------------------------------------------------------------------------

test("negative: owner_batch_decision.record_count disagreeing with the real file's actual line count is refused", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, record_count: 5 } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /actual record count \(6\) does not match declared record_count \(5\)/));
});

// ---------------------------------------------------------------------------
// 5. PENDING or REJECT included
// ---------------------------------------------------------------------------

test("negative: a batch item still PENDING (self-consistent hash/count) is refused", async (t) => {
  const batch = await writeMutatedBatch(t, (items) => { items[0].owner_disposition = "PENDING"; items[0].reviewer = null; items[0].reviewed_at = null; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /owner_disposition is "PENDING", not "APPROVE"/));
});

test("negative: a batch item REJECTed (self-consistent hash/count) is refused", async (t) => {
  const batch = await writeMutatedBatch(t, (items) => { items[0].owner_disposition = "REJECT"; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /owner_disposition is "REJECT", not "APPROVE"/));
});

// ---------------------------------------------------------------------------
// 6. reviewer / approved_by mismatch
// ---------------------------------------------------------------------------

test("negative: a batch item whose reviewer disagrees with owner_batch_decision.approved_by is refused", async (t) => {
  const batch = await writeMutatedBatch(t, (items) => { items[0].reviewer = "다른사람"; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /reviewer \("다른사람"\) does not match owner_batch_decision\.approved_by/));
});

// ---------------------------------------------------------------------------
// 7. reviewed_at invalid
// ---------------------------------------------------------------------------

test("negative: a batch item with an invalid reviewed_at is refused", async (t) => {
  const batch = await writeMutatedBatch(t, (items) => { items[0].reviewed_at = "definitely-not-a-date"; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /reviewed_at must be a valid ISO date-time/));
});

// ---------------------------------------------------------------------------
// 8. duplicate fact_id/evidence_id
// ---------------------------------------------------------------------------

test("negative: a duplicate fact_id within the batch is refused", async (t) => {
  const batch = await writeMutatedBatch(t, (items) => { items[1] = { ...items[1], fact_id: items[0].fact_id }; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /duplicate fact_id/));
});

test("negative: a duplicate evidence_id within the batch is refused", async (t) => {
  const batch = await writeMutatedBatch(t, (items) => { items[1] = { ...items[1], evidence_id: items[0].evidence_id }; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /duplicate evidence_id/));
});

// ---------------------------------------------------------------------------
// 9. ID not present in the promoted VERIFIED Fact/Evidence store
// ---------------------------------------------------------------------------

test("negative: a batch fact_id that does not resolve in the promoted VERIFIED Fact store is refused", async (t) => {
  const batch = await writeMutatedBatch(t, (items) => { items[0].fact_id = "fact_000000000000000000000000"; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /fact_000000000000000000000000 does not resolve in the promoted VERIFIED Fact store/));
});

test("negative: a batch evidence_id that does not resolve in the promoted VERIFIED Evidence store is refused", async (t) => {
  const batch = await writeMutatedBatch(t, (items) => { items[0].evidence_id = "evidence_000000000000000000000000"; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /evidence_000000000000000000000000 does not resolve in the promoted VERIFIED Evidence store/));
});

// ---------------------------------------------------------------------------
// 10. Disagreement with the structured manifest's merged OWNER_DECISION
// ---------------------------------------------------------------------------

test("negative: a batch item whose reviewed_at disagrees with the merged OWNER_DECISION's own record for that fact is refused", async (t) => {
  // Every other field stays individually valid (real disposition/reviewer/
  // real ISO date) -- only the cross-check against the structured
  // manifest's merged OWNER_DECISION (which has the ORIGINAL reviewed_at)
  // can catch this.
  const batch = await writeMutatedBatch(t, (items) => { items[0].reviewed_at = "2026-08-13T16:20:24.000Z"; return items; });
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: batch.path, sha256: batch.sha256, record_count: batch.record_count } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /does not match the merged OWNER_DECISION's own record/));
});

// ---------------------------------------------------------------------------
// 11. path traversal
// ---------------------------------------------------------------------------

test("negative: an owner_batch_decision.path containing a '..' segment is refused before touching the filesystem", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: "../outside-secret.jsonl" } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /owner_batch_decision\.path must not contain "\.\." segments/));
});

test("negative: an absolute owner_batch_decision.path is refused", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, owner_batch_decision: { ...decision.owner_batch_decision, path: "/etc/passwd" } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /owner_batch_decision\.path must not be an absolute path/));
});

// ---------------------------------------------------------------------------
// 12. symlink escape / alias
// ---------------------------------------------------------------------------

test("negative: an owner_batch_decision.path reached through a symlink alias (even pointing at byte-identical, real content) is refused", async (t) => {
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-owner-batch-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const aliasPath = path.join(directory, "batch-alias.jsonl");
  await symlink(REAL_OWNER_BATCH_PATH, aliasPath);
  const realBytes = await readFile(REAL_OWNER_BATCH_PATH);

  const { canonical, decision } = await loadGolden();
  const mutated = {
    ...decision,
    owner_batch_decision: { ...decision.owner_batch_decision, path: toRootRelative(aliasPath), sha256: sha256Hex(realBytes) },
  };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /owner_batch_decision\.path involves a symlink/));
});

test("negative: an owner_batch_decision.path that escapes root via a symlink is refused", async (t) => {
  // The symlink itself must live under the REAL ROOT (so the earlier
  // canonical/structured/thin-plan path-binding checks -- which run
  // BEFORE this owner_batch_decision check and require structuredManifestPath/
  // planPath to resolve relative to `root` -- still succeed); only its
  // TARGET points outside root, at real batch content in os.tmpdir().
  const outside = await mkdtemp(path.join(os.tmpdir(), "seed-owner-batch-escape-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideBatchPath = path.join(outside, "outside-batch.jsonl");
  const realBytes = await readFile(REAL_OWNER_BATCH_PATH);
  await writeFile(outsideBatchPath, realBytes);

  const linkDir = await mkdtemp(path.join(ROOT, "work", "seed-owner-batch-escape-link-"));
  t.after(() => rm(linkDir, { recursive: true, force: true }));
  const linkPath = path.join(linkDir, "batch-link.jsonl");
  await symlink(outsideBatchPath, linkPath);

  const { canonical, decision } = await loadGolden();
  const mutated = {
    ...decision,
    owner_batch_decision: { ...decision.owner_batch_decision, path: toRootRelative(linkPath), sha256: sha256Hex(realBytes) },
  };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(constructWith(canonicalPath), (error) => assertReleaseNotApproved(error, /owner_batch_decision\.path involves a symlink/));
});
