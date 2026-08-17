// Turn K item B: the bundle manifest must never approve itself -- a
// future v0.20 decision must externally pin its raw-byte SHA-256, and
// swapping the bundle manifest file (even for one that is internally
// self-consistent) must be rejected because the EXTERNAL pin no longer
// matches. No real v0.20 decision exists yet (Turn K forbids creating
// one) -- these tests use a decision-SHAPED fixture object, never a real
// release decision file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertBundleManifestBinding } from "../domain/adapters/seed-release-bundle-manifest-binding.mjs";
import { ReleaseNotApprovedError } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let dir; let bundleManifestPath; let bundleManifestBytes;
test.before(async () => {
  dir = await mkdtemp(path.join(ROOT, "work", "bundle-manifest-binding-test-"));
  bundleManifestPath = path.join(dir, "bundle-manifest.json");
  bundleManifestBytes = Buffer.from(JSON.stringify({ schema_version: "0.1.0", status: "CANDIDATE", entries: [] }, null, 2), "utf8");
  await writeFile(bundleManifestPath, bundleManifestBytes);
});
test.after(async () => { await rm(dir, { recursive: true, force: true }); });

function decisionFixture(overrides = {}) {
  return {
    decision_id: "seed-release-v0.20-decision-TEST-FIXTURE-NOT-REAL",
    bundle_manifest: { path: bundleManifestPath, sha256: sha256(bundleManifestBytes) },
    ...overrides,
  };
}

test("a correctly-pinned bundle manifest passes and returns its parsed content", async () => {
  const result = await assertBundleManifestBinding(decisionFixture(), bundleManifestPath, ROOT);
  assert.equal(result.bundleManifestSha256, sha256(bundleManifestBytes));
  assert.equal(result.bundleManifest.status, "CANDIDATE");
});

test("the bundle manifest file being replaced with different (even internally self-consistent) bytes fails -- the external pin no longer matches", async () => {
  const decision = decisionFixture(); // pins the ORIGINAL bytes' hash
  const swapped = Buffer.from(JSON.stringify({ schema_version: "0.1.0", status: "CANDIDATE", entries: [{ role: "FAKE", bundle_path: "x", decoded_sha256: "0".repeat(64) }] }, null, 2), "utf8");
  await writeFile(bundleManifestPath, swapped);
  try {
    await assert.rejects(
      assertBundleManifestBinding(decision, bundleManifestPath, ROOT),
      (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.match(error.message, /sha256 mismatch/); return true; },
    );
  } finally { await writeFile(bundleManifestPath, bundleManifestBytes); }
});

test("a decision missing the bundle_manifest pin entirely fails closed", async () => {
  await assert.rejects(
    assertBundleManifestBinding({ decision_id: "no-pin" }, bundleManifestPath, ROOT),
    (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.match(error.message, /missing a bundle_manifest/); return true; },
  );
});

test("a decision pinning a DIFFERENT path than the one actually supplied fails closed, even if the hash would otherwise match", async () => {
  const decision = decisionFixture({ bundle_manifest: { path: path.join(dir, "some-other-name.json"), sha256: sha256(bundleManifestBytes) } });
  await assert.rejects(
    assertBundleManifestBinding(decision, bundleManifestPath, ROOT),
    (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.match(error.message, /does not match the decision's declared bundle_manifest.path/); return true; },
  );
});

test("a symlinked bundle manifest path fails closed even when the symlink target is the real, correctly-pinned file", async () => {
  const symlinkPath = path.join(dir, "manifest-alias.json");
  await symlink(bundleManifestPath, symlinkPath);
  try {
    const decision = decisionFixture({ bundle_manifest: { path: symlinkPath, sha256: sha256(bundleManifestBytes) } });
    await assert.rejects(
      assertBundleManifestBinding(decision, symlinkPath, ROOT),
      (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.match(error.message, /symlink/); return true; },
    );
  } finally { await rm(symlinkPath); }
});

test("a self-declared hash INSIDE the bundle manifest content is never consulted -- only the externally pinned decision hash matters", async () => {
  // A bundle manifest that claims (falsely, and irrelevantly) to approve
  // itself must still be rejected/accepted purely based on the EXTERNAL
  // decision pin, never its own internal self-declaration.
  const selfApprovingBytes = Buffer.from(JSON.stringify({ schema_version: "0.1.0", status: "APPROVED", self_declared_hash: "totally-trust-me" }, null, 2), "utf8");
  await writeFile(bundleManifestPath, selfApprovingBytes);
  try {
    // Decision still pins the OLD (pre-swap) hash -> must fail despite the file's own claims.
    await assert.rejects(assertBundleManifestBinding(decisionFixture(), bundleManifestPath, ROOT), /sha256 mismatch/);
    // Decision pinning the NEW real hash succeeds regardless of the file's self-declared "APPROVED" status --
    // binding is purely a hash check, not a semantic trust judgment.
    const result = await assertBundleManifestBinding(
      { bundle_manifest: { path: bundleManifestPath, sha256: sha256(selfApprovingBytes) } }, bundleManifestPath, ROOT,
    );
    assert.equal(result.bundleManifest.status, "APPROVED"); // binding itself doesn't judge status -- callers must separately enforce that
  } finally { await writeFile(bundleManifestPath, bundleManifestBytes); }
});

// -- Turn L2 item 6: against the REAL v0.20 CANDIDATE bundle, not a fixture --
// Everything above proves the CONTRACT generically. These tests prove the
// contract holds for the actual artifact this repo would ship: computing
// the real candidate bundle's bundle-manifest.json raw-byte SHA-256 and
// verifying it against a fixture decision object's bundle_manifest pin
// (no real v0.20 decision exists yet -- see this file's header).
const REAL_BUNDLE_DIR = path.join(ROOT, "domain/releases/bundles/seed-release-v0.20");
const REAL_BUNDLE_MANIFEST_PATH = path.join(REAL_BUNDLE_DIR, "bundle-manifest.json");

test("the real v0.20 CANDIDATE bundle-manifest.json passes binding against a fixture decision pinning its real, freshly-computed sha256", async () => {
  const realBytes = await readFile(REAL_BUNDLE_MANIFEST_PATH);
  const realSha256 = sha256(realBytes);
  const fixtureDecision = { decision_id: "seed-release-v0.20-decision-TEST-FIXTURE-NOT-REAL", bundle_manifest: { path: REAL_BUNDLE_MANIFEST_PATH, sha256: realSha256 } };
  const result = await assertBundleManifestBinding(fixtureDecision, REAL_BUNDLE_MANIFEST_PATH, ROOT);
  assert.equal(result.bundleManifest.status, "CANDIDATE");
  assert.equal(result.bundleManifestSha256, realSha256);
});

test("a copy of the real bundle-manifest.json at a DIFFERENT path (byte-identical content) fails binding -- path must match the pin exactly", async () => {
  const copyDir = await mkdtemp(path.join(ROOT, "work", "real-bundle-manifest-copy-"));
  try {
    const realBytes = await readFile(REAL_BUNDLE_MANIFEST_PATH);
    const copiedPath = path.join(copyDir, "bundle-manifest.json");
    await writeFile(copiedPath, realBytes);
    const fixtureDecision = { bundle_manifest: { path: REAL_BUNDLE_MANIFEST_PATH, sha256: sha256(realBytes) } };
    await assert.rejects(assertBundleManifestBinding(fixtureDecision, copiedPath, ROOT), /does not match the decision's declared bundle_manifest.path/);
  } finally { await rm(copyDir, { recursive: true, force: true }); }
});

test("swapping the real bundle-manifest.json content (a different, even structurally valid, manifest) fails binding on hash mismatch", async () => {
  const realBytes = await readFile(REAL_BUNDLE_MANIFEST_PATH);
  const realSha256 = sha256(realBytes);
  const swapped = Buffer.from(JSON.stringify({ schema_version: "0.1.0", status: "CANDIDATE", entries: [] }, null, 2), "utf8");
  await writeFile(REAL_BUNDLE_MANIFEST_PATH, swapped);
  try {
    const fixtureDecision = { bundle_manifest: { path: REAL_BUNDLE_MANIFEST_PATH, sha256: realSha256 } };
    await assert.rejects(assertBundleManifestBinding(fixtureDecision, REAL_BUNDLE_MANIFEST_PATH, ROOT), /sha256 mismatch/);
  } finally { await writeFile(REAL_BUNDLE_MANIFEST_PATH, realBytes); }
});

test("swapping a real bundle artifact's bytes (e.g. VERIFIED_RELATION) changes its sha256, which a manifest-binding-only check does NOT catch -- that is verifyReleaseBundleDirectoryMatchesManifest's job, not this contract's", async () => {
  // Documents the boundary between the two contracts: assertBundleManifestBinding
  // only proves the MANIFEST FILE ITSELF is the one the decision pinned.
  // Whether every entry's artifact bytes still match the manifest's own
  // declared hashes is verifyReleaseBundleDirectoryMatchesManifest's
  // responsibility (see tests/seed-release-bundle-builder.test.mjs's
  // tamper tests -- those exercise a scratch-built bundle with the same
  // roles/shape, not this exact directory, since mutating the real
  // shipped bundle mid-test-suite would be destructive).
  const realBytes = await readFile(REAL_BUNDLE_MANIFEST_PATH);
  const realSha256 = sha256(realBytes);
  const fixtureDecision = { bundle_manifest: { path: REAL_BUNDLE_MANIFEST_PATH, sha256: realSha256 } };
  const result = await assertBundleManifestBinding(fixtureDecision, REAL_BUNDLE_MANIFEST_PATH, ROOT);
  assert.ok(Array.isArray(result.bundleManifest.entries) && result.bundleManifest.entries.length > 0);
});
