import assert from "node:assert/strict";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { collectReferenceReleaseRecords } from "../domain/postgres/reference-release-contract.mjs";
import { importReferenceRelease, withVerifiedReferenceBundle } from "../domain/postgres/reference-release-loader.mjs";
import { buildReleaseBundle } from "../domain/adapters/seed-release-bundle-builder.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OPTIONS = Object.freeze({
  root: ROOT,
  bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: "seed-release-v0.20",
});

const EXPECTED_COUNTS = Object.freeze({
  RELEASE_DECISION: 1,
  CANONICAL_RELEASE_MANIFEST: 1,
  CANONICAL_DOCUMENT_IR_DELTA: 14,
  CANONICAL_DOCUMENT_IR_BASE: 54,
  CHAIN_MANIFEST: 16,
  COMPANY_DIRECTORY_OWNER_DECISION: 1,
  COMPANY_DIRECTORY: 70,
  COMPANY_DIRECTORY_MANIFEST: 1,
  VERIFIED_EVENT: 24,
  VERIFIED_EVIDENCE: 219,
  VERIFIED_EVIDENCE_MANIFEST: 1,
  FACT_COVERAGE_SNAPSHOT: 102,
  VERIFIED_FACT: 87,
  SEED_GOLD: 25,
  VERIFIED_RELATION: 40,
  STRUCTURED_MANIFEST: 1,
  OWNER_DECISION: 102,
  OWNER_BATCH_DECISION: 6,
  THIN_PLAN: 25,
  THIN_PLAN_MANIFEST: 1,
  TIMELINE_FACT_NARRATIVE_POLICY_DECISION: 1,
});

test("the approved v0.20 portable bundle yields the exact 21-role reference inventory and cleans its temp root", async () => {
  let temporaryRoot;
  let total = 0;
  const result = await withVerifiedReferenceBundle(OPTIONS, async (verified) => {
    temporaryRoot = verified.materializedRoot;
    assert.equal(verified.finalDecision.status, "APPROVED");
    assert.equal(verified.bundleManifest.entries.length, 21);
    return collectReferenceReleaseRecords({
      materializedRoot: verified.materializedRoot,
      bundleManifest: verified.bundleManifest,
      async onRecord() { total += 1; },
      async onArtifact() {},
    });
  });
  assert.deepEqual(result.roleCounts, EXPECTED_COUNTS);
  assert.equal(total, 792);
  await assert.rejects(access(temporaryRoot));
});

test("reference import uses one transaction, inserts artifact parents before records, and reaches READY", async () => {
  const operations = [];
  let artifactInserts = 0;
  let recordInserts = 0;
  let sawRecord = false;
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      operations.push(normalized);
      if (normalized.startsWith("SELECT status,")) return { rows: [] };
      if (normalized.startsWith("INSERT INTO disclosure_reference.artifacts")) {
        assert.equal(sawRecord, false, "all artifact parents must exist before the first record insert");
        artifactInserts += 1;
      }
      if (normalized.startsWith("INSERT INTO disclosure_reference.records")) {
        sawRecord = true;
        recordInserts += 1;
      }
      return { rows: [] };
    },
  };
  const result = await importReferenceRelease({ client, ...OPTIONS });
  assert.equal(result.status, "LOADED");
  assert.equal(artifactInserts, 21);
  assert.equal(recordInserts, 792);
  assert.equal(operations[0], "BEGIN");
  assert.equal(operations.at(-1), "COMMIT");
  assert.equal(operations.some((sql) => sql.includes("SET status = 'READY'")), true);
});

test("an already-loaded byte-identical release is idempotent and writes no records", async () => {
  let recordWrites = 0;
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT status,")) {
        return { rows: [{
          status: "READY",
          bundle_manifest_sha256: "5158b001df5c2a2119f66f1b00fbdf92ac79311a9a73c4ef7013981f86640726",
          final_manifest_sha256: "2539103a1709b4fba0622b3a0ded887df17efe0f6f5345131e72cc51ca3843c9",
          final_decision_sha256: "d1b6b9a0ea426e5eb2ade8f9aa0dd1458f92e7b384e07d97fccf02e48925ba1d",
        }] };
      }
      if (normalized.startsWith("INSERT INTO disclosure_reference.records")) recordWrites += 1;
      return { rows: [] };
    },
  };
  const result = await importReferenceRelease({ client, ...OPTIONS });
  assert.deepEqual(result, { status: "ALREADY_LOADED", release_id: "seed-release-v0.20" });
  assert.equal(recordWrites, 0);
});

test("database failure rolls back and never commits a partial reference release", async () => {
  const operations = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      operations.push(normalized);
      if (normalized.startsWith("SELECT status,")) return { rows: [] };
      if (normalized.startsWith("INSERT INTO disclosure_reference.records")) throw new Error("synthetic database failure");
      return { rows: [] };
    },
  };
  await assert.rejects(importReferenceRelease({ client, ...OPTIONS }), /synthetic database failure/);
  assert.equal(operations.includes("ROLLBACK"), true);
  assert.equal(operations.includes("COMMIT"), false);
});

test("a mismatched expected release identity is refused before any database transaction", async () => {
  let queryCount = 0;
  await assert.rejects(
    importReferenceRelease({
      client: { async query() { queryCount += 1; return { rows: [] }; } },
      ...OPTIONS,
      expectedReleaseId: "seed-release-not-approved",
    }),
    /do not identify the expected release/,
  );
  assert.equal(queryCount, 0);
});

test("Turn N1: a mismatched expectedApprovedRevision is refused before any database transaction", async () => {
  let queryCount = 0;
  await assert.rejects(
    importReferenceRelease({
      client: { async query() { queryCount += 1; return { rows: [] }; } },
      ...OPTIONS,
      expectedApprovedRevision: "seed-structured-artifacts-v0.1-not-the-real-one",
    }),
    /does not match the required expectedApprovedRevision/,
  );
  assert.equal(queryCount, 0);
});

test("Turn N1: the real approved_revision ('seed-structured-artifacts-v0.7') is accepted when pinned explicitly", async () => {
  const result = await importReferenceRelease({
    client: { async query(sql) {
      if (String(sql).trim().startsWith("SELECT status,")) return { rows: [] };
      return { rows: [] };
    } },
    ...OPTIONS,
    expectedApprovedRevision: "seed-structured-artifacts-v0.7",
  });
  assert.equal(result.status, "LOADED");
});

// -- Turn N1.1 item 1: bundleDir must be bound to the SAME bundle-manifest.json
// that assertBundleManifestBinding already verified against bundleManifestPath.
// Before this fix, a bundleDir pointing at a completely different (but
// internally self-consistent) bundle was silently accepted as long as
// bundleManifestPath separately happened to be the real, approved file.

test("Turn N1.1 (before/after PoC): a bundleDir swapped for a different, internally self-consistent bundle is REJECTED, even though bundleManifestPath is the real approved file", async () => {
  const fakeBundleDirAbs = await mkdtemp(path.join(ROOT, "work", "n11-poc-fake-bundle-"));
  try {
    await buildReleaseBundle({
      bundleDir: path.relative(ROOT, fakeBundleDirAbs), status: "CANDIDATE", root: ROOT,
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
    await assert.rejects(
      withVerifiedReferenceBundle({ ...OPTIONS, bundleDir: fakeBundleDirAbs }, async (verified) => verified),
      /does not contain the same bundle-manifest\.json/,
    );
  } finally {
    await rm(fakeBundleDirAbs, { recursive: true, force: true });
  }
});

test("Turn N1.1 (before/after PoC): a byte-identical COPY of the real bundle at a different path is also REJECTED", async () => {
  const copyDirAbs = await mkdtemp(path.join(ROOT, "work", "n11-poc-copy-bundle-"));
  await rm(copyDirAbs, { recursive: true, force: true });
  try {
    await cp(OPTIONS.bundleDir, copyDirAbs, { recursive: true });
    await assert.rejects(
      withVerifiedReferenceBundle({ ...OPTIONS, bundleDir: copyDirAbs }, async (verified) => verified),
      /does not contain the same bundle-manifest\.json/,
    );
  } finally {
    await rm(copyDirAbs, { recursive: true, force: true });
  }
});

test("Turn N1.1 counterexample: the real, matching bundleDir/bundleManifestPath pair is still accepted", async () => {
  const result = await withVerifiedReferenceBundle(OPTIONS, async (verified) => verified.bundleManifest.entries.length);
  assert.equal(result, 21);
});

// -- Turn N1.1 item 2: final control path binding -------------------------

test("Turn N1.1: finalManifestPath outside root is rejected", async () => {
  await assert.rejects(
    withVerifiedReferenceBundle({ ...OPTIONS, finalManifestPath: "/etc/passwd" }, async (v) => v),
    /outside its base directory/,
  );
});

test("Turn N1.1: finalDecisionPath outside root is rejected", async () => {
  await assert.rejects(
    withVerifiedReferenceBundle({ ...OPTIONS, finalDecisionPath: "/etc/passwd" }, async (v) => v),
    /outside its base directory/,
  );
});

test("Turn N1.1: a '..'-escaping finalManifestPath is rejected", async () => {
  await assert.rejects(
    withVerifiedReferenceBundle({ ...OPTIONS, finalManifestPath: path.join(ROOT, "..", "escaped-manifest.json") }, async (v) => v),
    /outside its base directory/,
  );
});

test("Turn N1.1: a byte-identical copy of the real final manifest at a DIFFERENT path is rejected (manifest's own declared decision_artifact_path no longer matches, and the decision's canonical_release_manifest.path no longer matches the swapped path)", async () => {
  const copyPath = path.join(ROOT, "work", `n11-poc-manifest-copy-${process.pid}.json`);
  try {
    await cp(OPTIONS.finalManifestPath, copyPath);
    await assert.rejects(
      withVerifiedReferenceBundle({ ...OPTIONS, finalManifestPath: copyPath }, async (v) => v),
      /does not match the final decision's declared canonical_release_manifest\.path/,
    );
  } finally {
    await rm(copyPath, { force: true });
  }
});

test("Turn N1.1: a byte-identical copy of the real final decision at a DIFFERENT path is rejected", async () => {
  const copyPath = path.join(ROOT, "work", `n11-poc-decision-copy-${process.pid}.json`);
  try {
    await cp(OPTIONS.finalDecisionPath, copyPath);
    await assert.rejects(
      withVerifiedReferenceBundle({ ...OPTIONS, finalDecisionPath: copyPath }, async (v) => v),
      /does not match the final manifest's declared decision_artifact_path/,
    );
  } finally {
    await rm(copyPath, { force: true });
  }
});
