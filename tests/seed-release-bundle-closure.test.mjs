// Turn K item A: proves computeReleaseBundleClosure derives the bundle's
// dependency closure MECHANICALLY (by reading the real v0.19 decision and
// re-verifying every pinned hash) rather than from a hand-typed list --
// and that tampering with any referenced file, or omitting a required
// input, fails the whole computation closed.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { computeReleaseBundleClosure } from "../domain/adapters/seed-release-bundle-closure.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function baseOptions() {
  return {
    structuredManifestPath: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
    canonicalReleaseManifestPath: "domain/releases/seed-release.v0.19.manifest.json",
    planPath: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
    planManifestPath: "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
    root: ROOT,
    expectedReleaseId: "seed-release-v0.19",
    expectedApprovedRevision: "seed-structured-artifacts-v0.6",
    companyDirectoryArtifactPath: "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl",
    companyDirectoryManifestPath: "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json",
    companyDirectoryOwnerDecisionPath: "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json",
    expectedCompanyDirectoryOwnerDecisionSha256: "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20",
    timelinePolicyDecisionPath: "work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json",
  };
}

let closure;
test.before(async () => { closure = await computeReleaseBundleClosure(baseOptions()); });

test("closure includes every role the user's checklist named: Gold, Evidence(+manifest), Fact, Coverage, structured Owner decision, batch Owner decision, Company Directory(+manifest+decision), Timeline policy decision", () => {
  const roles = new Set(closure.entries.map((e) => e.role));
  for (const required of [
    "SEED_GOLD", "VERIFIED_EVIDENCE", "VERIFIED_EVIDENCE_MANIFEST", "VERIFIED_FACT", "FACT_COVERAGE_SNAPSHOT",
    "OWNER_DECISION", "OWNER_BATCH_DECISION",
    "COMPANY_DIRECTORY", "COMPANY_DIRECTORY_MANIFEST", "COMPANY_DIRECTORY_OWNER_DECISION",
    "TIMELINE_FACT_NARRATIVE_POLICY_DECISION",
    "CANONICAL_DOCUMENT_IR_BASE", "CANONICAL_DOCUMENT_IR_DELTA",
    "CANONICAL_RELEASE_MANIFEST", "STRUCTURED_MANIFEST", "RELEASE_DECISION",
    "THIN_PLAN", "THIN_PLAN_MANIFEST", "VERIFIED_EVENT", "VERIFIED_RELATION", "CHAIN_MANIFEST",
  ]) {
    assert.ok(roles.has(required), `missing required role ${required}`);
  }
});

test("closure dedups artifacts referenced twice under different decision fields (SEED_GOLD via canonical_artifacts + thin_plan_source_gold; FACT_COVERAGE_SNAPSHOT via structured_artifacts + thin_plan_source_coverage)", () => {
  const paths = closure.entries.map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length, "no duplicate paths in the closure");
  const goldEntries = closure.entries.filter((e) => e.path === "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
  assert.equal(goldEntries.length, 1);
});

test("every closure entry's sha256 matches the real on-disk file bytes", async () => {
  const { createHash } = await import("node:crypto");
  for (const entry of closure.entries) {
    const bytes = await readFile(path.join(ROOT, entry.path));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assert.equal(actual, entry.sha256, `${entry.path} hash mismatch`);
  }
});

test("closure carries release_id/approved_revision/corpus_snapshot_id/fact_coverage_snapshot_id from the real decision", () => {
  assert.equal(closure.release_id, "seed-release-v0.19");
  assert.equal(closure.approved_revision, "seed-structured-artifacts-v0.6");
  assert.equal(closure.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
  assert.ok(typeof closure.fact_coverage_snapshot_id === "string" && closure.fact_coverage_snapshot_id !== "");
});

test("missing companyDirectoryArtifactPath fails closure computation closed (never silently produces a partial closure)", async () => {
  const options = { ...baseOptions() };
  delete options.companyDirectoryArtifactPath;
  await assert.rejects(computeReleaseBundleClosure(options), /companyDirectoryArtifactPath is required/);
});

test("missing timelinePolicyDecisionPath fails closure computation closed", async () => {
  const options = { ...baseOptions() };
  delete options.timelinePolicyDecisionPath;
  await assert.rejects(computeReleaseBundleClosure(options), /timelinePolicyDecisionPath is required/);
});

test("a non-APPROVED timeline policy decision fails closure computation closed", async () => {
  const dir = await mkdtemp(path.join(ROOT, "work", "bundle-closure-timeline-"));
  try {
    const original = JSON.parse(await readFile(path.join(ROOT, "work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json"), "utf8"));
    const pending = { ...original, owner_disposition: "PENDING" };
    const pendingPath = path.join(dir, "timeline-pending.json");
    await writeFile(pendingPath, JSON.stringify(pending));
    await assert.rejects(
      computeReleaseBundleClosure({ ...baseOptions(), timelinePolicyDecisionPath: pendingPath }),
      /owner_disposition is "PENDING", not "APPROVED"/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("release authorization itself failing (e.g. wrong expectedReleaseId) fails closure computation before any enumeration happens", async () => {
  await assert.rejects(
    computeReleaseBundleClosure({ ...baseOptions(), expectedReleaseId: "seed-release-v0.999-does-not-exist" }),
    (error) => { assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
  );
});

test("a tampered structured manifest (content changed after the decision pinned its hash) fails closure computation closed", async () => {
  const dir = await mkdtemp(path.join(ROOT, "work", "bundle-closure-tamper-"));
  try {
    const original = await readFile(path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"));
    const tamperedPath = path.join(dir, "tampered-structured.manifest.json");
    await writeFile(tamperedPath, Buffer.concat([original, Buffer.from(" ")]));
    await assert.rejects(
      computeReleaseBundleClosure({ ...baseOptions(), structuredManifestPath: tamperedPath }),
      (error) => { assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});
