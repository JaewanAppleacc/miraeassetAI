// Turn K item A/C/G: proves the bundle builder (1) copies every closure
// entry with a verified hash, (2) deterministically gzip-compresses only
// the Canonical DocumentIR shards, (3) fails the WHOLE build if the
// resulting directory ever has a missing OR an extra file relative to the
// bundle manifest, and (4) never allows an APPROVED/READY status.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildReleaseBundle, verifyReleaseBundleDirectoryMatchesManifest } from "../domain/adapters/seed-release-bundle-builder.mjs";
import { gunzipSafe } from "../domain/adapters/deterministic-gzip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function baseOptions(bundleDirAbs) {
  return {
    bundleDir: path.relative(ROOT, bundleDirAbs),
    status: "CANDIDATE",
    root: ROOT,
    generatedAt: "2026-08-17T00:00:00.000Z",
    structuredManifestPath: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
    canonicalReleaseManifestPath: "domain/releases/seed-release.v0.19.manifest.json",
    planPath: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
    planManifestPath: "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
    expectedReleaseId: "seed-release-v0.19",
    expectedApprovedRevision: "seed-structured-artifacts-v0.6",
    companyDirectoryArtifactPath: "work/domain-seed/seed-company-directory.v0.2.approved.jsonl",
    companyDirectoryManifestPath: "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json",
    companyDirectoryOwnerDecisionPath: "work/domain-seed/seed-company-directory-owner-decision.v0.2.approved.json",
    timelinePolicyDecisionPath: "work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json",
  };
}

let bundleDirAbs; let result;
test.before(async () => {
  bundleDirAbs = await mkdtemp(path.join(ROOT, "work", "bundle-builder-test-"));
  result = await buildReleaseBundle(baseOptions(bundleDirAbs));
});
test.after(async () => { await rm(bundleDirAbs, { recursive: true, force: true }); });

test("status is never anything but CANDIDATE/RELEASE_PENDING -- APPROVED/READY is rejected outright", async () => {
  const otherDir = await mkdtemp(path.join(ROOT, "work", "bundle-builder-status-test-"));
  try {
    await assert.rejects(
      buildReleaseBundle({ ...baseOptions(otherDir), status: "APPROVED" }),
      /status must be one of CANDIDATE, RELEASE_PENDING/,
    );
    await assert.rejects(
      buildReleaseBundle({ ...baseOptions(otherDir), status: "READY" }),
      /status must be one of CANDIDATE, RELEASE_PENDING/,
    );
  } finally { await rm(otherDir, { recursive: true, force: true }); }
});

test("bundle-manifest.json declares status CANDIDATE and never self-approves (no approved_by/decision-shaped field)", async () => {
  const manifest = JSON.parse(await readFile(result.bundleManifestPath, "utf8"));
  assert.equal(manifest.status, "CANDIDATE");
  assert.equal("approved_by" in manifest, false);
  assert.equal("release_gate_status" in manifest, false);
});

test("a caller-pinned generatedAt makes the complete bundle manifest byte-deterministic across independent directories", async () => {
  const otherDir = await mkdtemp(path.join(ROOT, "work", "bundle-builder-determinism-test-"));
  try {
    const other = await buildReleaseBundle(baseOptions(otherDir));
    const [first, second] = await Promise.all([readFile(result.bundleManifestPath), readFile(other.bundleManifestPath)]);
    assert.equal(sha256(second), sha256(first));
  } finally { await rm(otherDir, { recursive: true, force: true }); }
});

test("Canonical DocumentIR shards are the ONLY gzip-compressed entries; every other entry is copied verbatim with a matching hash", async () => {
  const manifest = JSON.parse(await readFile(result.bundleManifestPath, "utf8"));
  for (const entry of manifest.entries) {
    if (entry.role === "CANONICAL_DOCUMENT_IR_BASE" || entry.role === "CANONICAL_DOCUMENT_IR_DELTA") {
      assert.equal(entry.compression, "gzip");
    } else {
      assert.equal(entry.compression, "none");
      const bytes = await readFile(path.join(bundleDirAbs, entry.bundle_path));
      assert.equal(sha256(bytes), entry.decoded_sha256);
    }
  }
});

test("gzip-compressed DocumentIR entries decode back to byte-identical original content via gunzipSafe", async () => {
  const manifest = JSON.parse(await readFile(result.bundleManifestPath, "utf8"));
  const deltaEntry = manifest.entries.find((e) => e.role === "CANONICAL_DOCUMENT_IR_DELTA");
  const encoded = await readFile(path.join(bundleDirAbs, deltaEntry.bundle_path));
  assert.equal(sha256(encoded), deltaEntry.encoded_sha256);
  const { decoded } = gunzipSafe(encoded, { maxEncodedBytes: 100_000_000, maxDecodedBytes: 500_000_000, maxCompressionRatio: 1000 });
  assert.equal(sha256(decoded), deltaEntry.decoded_sha256);
});

test("verifyReleaseBundleDirectoryMatchesManifest passes on a freshly built bundle", async () => {
  const check = await verifyReleaseBundleDirectoryMatchesManifest({ bundleDir: bundleDirAbs });
  assert.equal(check.status, "CANDIDATE");
});

test("an extra file dropped into the bundle directory (not declared in the manifest) fails verification closed", async () => {
  const strayPath = path.join(bundleDirAbs, "work/domain-seed/stray-extra-file.txt");
  await writeFile(strayPath, "not part of the closure");
  try {
    await assert.rejects(
      verifyReleaseBundleDirectoryMatchesManifest({ bundleDir: bundleDirAbs }),
      /unexpected extra file/,
    );
  } finally { await rm(strayPath); }
});

test("a missing declared file fails verification closed", async () => {
  const goldEntry = JSON.parse(await readFile(result.bundleManifestPath, "utf8")).entries.find((e) => e.role === "SEED_GOLD");
  const goldPath = path.join(bundleDirAbs, goldEntry.bundle_path);
  const backup = await readFile(goldPath);
  await rm(goldPath);
  try {
    await assert.rejects(verifyReleaseBundleDirectoryMatchesManifest({ bundleDir: bundleDirAbs }), /missing file/);
  } finally { await writeFile(goldPath, backup); }
});

test("a tampered (content-modified) declared file fails verification closed on hash mismatch", async () => {
  const relationEntry = JSON.parse(await readFile(result.bundleManifestPath, "utf8")).entries.find((e) => e.role === "VERIFIED_RELATION");
  const relPath = path.join(bundleDirAbs, relationEntry.bundle_path);
  const backup = await readFile(relPath);
  await writeFile(relPath, Buffer.concat([backup, Buffer.from("\n")]));
  try {
    await assert.rejects(verifyReleaseBundleDirectoryMatchesManifest({ bundleDir: bundleDirAbs }), /sha256 mismatch/);
  } finally { await writeFile(relPath, backup); }
});

test("dev-only artifacts (Harness raw results, review packets, receipts) never appear in the bundle -- only closure roles are present", async () => {
  const manifest = JSON.parse(await readFile(result.bundleManifestPath, "utf8"));
  const bundlePaths = manifest.entries.map((e) => e.source_path);
  for (const forbiddenSubstring of ["harness-v07", "review-packet", "run-receipt", "sandbox-only"]) {
    assert.ok(
      bundlePaths.every((p) => !p.includes(forbiddenSubstring)),
      `bundle unexpectedly contains a dev-only artifact matching "${forbiddenSubstring}"`,
    );
  }
});
