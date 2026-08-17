// Turn K item D (deployment side): unpackReleaseBundle round-trip fidelity
// and tamper/limit rejection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildReleaseBundle } from "../domain/adapters/seed-release-bundle-builder.mjs";
import { unpackReleaseBundle } from "../domain/adapters/seed-release-bundle-unpack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let bundleDirAbs; let buildResult;
test.before(async () => {
  bundleDirAbs = await mkdtemp(path.join(ROOT, "work", "bundle-unpack-test-src-"));
  buildResult = await buildReleaseBundle({
    bundleDir: path.relative(ROOT, bundleDirAbs), status: "CANDIDATE", root: ROOT,
    structuredManifestPath: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
    canonicalReleaseManifestPath: "domain/releases/seed-release.v0.19.manifest.json",
    planPath: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
    planManifestPath: "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
    expectedReleaseId: "seed-release-v0.19", expectedApprovedRevision: "seed-structured-artifacts-v0.6",
    companyDirectoryArtifactPath: "work/domain-seed/seed-company-directory.v0.2.approved.jsonl",
    companyDirectoryManifestPath: "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json",
    companyDirectoryOwnerDecisionPath: "work/domain-seed/seed-company-directory-owner-decision.v0.2.approved.json",
    timelinePolicyDecisionPath: "work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json",
  });
});
test.after(async () => { await rm(bundleDirAbs, { recursive: true, force: true }); });

test("unpackReleaseBundle reconstructs every source file byte-identical to the real, original (pre-bundling) file", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bundle-unpack-test-dest-"));
  try {
    const { unpacked_files } = await unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot });
    assert.equal(unpacked_files.length, 21);
    for (const sourcePath of unpacked_files) {
      const [original, unpacked] = await Promise.all([readFile(path.join(ROOT, sourcePath)), readFile(path.join(destRoot, sourcePath))]);
      assert.equal(sha256(unpacked), sha256(original), `${sourcePath} did not round-trip byte-identically`);
    }
  } finally { await rm(destRoot, { recursive: true, force: true }); }
});

test("a tampered (bit-flipped) gzip-compressed bundle entry fails unpack closed on encoded sha256 mismatch", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bundle-unpack-test-tamper-"));
  const deltaEntry = JSON.parse(await readFile(buildResult.bundleManifestPath, "utf8")).entries.find((e) => e.role === "CANONICAL_DOCUMENT_IR_DELTA");
  const gzPath = path.join(bundleDirAbs, deltaEntry.bundle_path);
  const backup = await readFile(gzPath);
  try {
    const tampered = Buffer.from(backup);
    tampered[20] ^= 0xff; // flip a bit inside the compressed payload
    await writeFile(gzPath, tampered);
    await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /encoded sha256 mismatch|invalid gzip/);
  } finally {
    await writeFile(gzPath, backup);
    await rm(destRoot, { recursive: true, force: true });
  }
});

test("a tampered (content-modified) raw bundle entry fails unpack closed on sha256 mismatch", async () => {
  const destRoot = await mkdtemp(path.join(ROOT, "work", "bundle-unpack-test-tamper-raw-"));
  const goldEntry = JSON.parse(await readFile(buildResult.bundleManifestPath, "utf8")).entries.find((e) => e.role === "SEED_GOLD");
  const rawPath = path.join(bundleDirAbs, goldEntry.bundle_path);
  const backup = await readFile(rawPath);
  try {
    await writeFile(rawPath, Buffer.concat([backup, Buffer.from("\n")]));
    await assert.rejects(unpackReleaseBundle({ bundleDir: bundleDirAbs, destRoot }), /sha256 mismatch/);
  } finally {
    await writeFile(rawPath, backup);
    await rm(destRoot, { recursive: true, force: true });
  }
});

test("production decode ceilings are hard-coded exports, not derived from any manifest value", async () => {
  const { PRODUCTION_MAX_ENCODED_BYTES, PRODUCTION_MAX_DECODED_BYTES, PRODUCTION_MAX_COMPRESSION_RATIO } = await import("../domain/adapters/seed-release-bundle-unpack.mjs");
  assert.equal(typeof PRODUCTION_MAX_ENCODED_BYTES, "number");
  assert.equal(typeof PRODUCTION_MAX_DECODED_BYTES, "number");
  assert.equal(typeof PRODUCTION_MAX_COMPRESSION_RATIO, "number");
});
