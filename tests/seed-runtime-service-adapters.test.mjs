import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSeedRuntimeServiceAdapters, ReleaseNotApprovedError } from "../domain/adapters/seed-runtime-service-adapters.mjs";

// os.tmpdir() itself is a symlink on macOS (/var -> /private/var); resolve
// it once so temp dirs created from it are symlink-free, matching what
// the Company Directory symlink-defense tests below actually intend to
// exercise (a deliberately symlinked FILE inside an otherwise-real dir).
async function realpathTmp() { return realpath(os.tmpdir()); }

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
// Test-only structured manifest fixture: same real v0.1 Evidence/Fact/
// Coverage/OwnerDecision pins, plus a CHAIN_MANIFEST role (the real v0.1
// Chain manifest, 16 records) -- required now that createSeedRuntimeServiceAdapters
// mandates one. See tests/release-authorization-boundary.test.mjs's header
// for the plan+chain binding contract these fixtures satisfy.
const STRUCTURED_MANIFEST = path.join(ROOT, "tests/fixtures/seed-structured-artifacts.v01-with-chain.test-fixture.manifest.json");
// Real, unmodified v0.11 release manifest -- carries no release_authorization
// block, so it is now itself a fail-closed fixture (see the two
// RELEASE_NOT_APPROVED tests below). Positive-path tests use the
// APPROVED_CANONICAL_MANIFEST test-only fixture instead, which is a
// byte-for-byte copy of this file plus one added release_authorization block.
const CANONICAL_MANIFEST = path.join(ROOT, "domain/releases/seed-release.v0.11.manifest.json");
const APPROVED_CANONICAL_MANIFEST = path.join(ROOT, "tests/fixtures/seed-release.v0.11.approved.manifest.json");
const DRAFT_CANONICAL_MANIFEST = path.join(ROOT, "domain/releases/seed-release.v0.15.draft.manifest.json");
const STRUCTURED_MANIFEST_V03 = path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.3.manifest.json");
const PLAN_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.1.jsonl");
const PLAN_MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.1.manifest.json");

let runtimeBundle;
test.before(async () => {
  runtimeBundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST,
    canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
    planPath: PLAN_PATH,
    planManifestPath: PLAN_MANIFEST_PATH,
    root: ROOT,
  });
});

test("constructs one frozen SharedContext and four frozen Runtime service adapters", () => {
  assert.deepEqual(runtimeBundle.context, {
    corpus_snapshot_id: "corpus_04750795e1a2d5c3",
    fact_coverage_snapshot_id: "fact_coverage_snapshot_8102664d6ead285485104d8f",
  });
  assert.ok(Object.isFrozen(runtimeBundle));
  assert.ok(Object.isFrozen(runtimeBundle.context));
  assert.ok(Object.isFrozen(runtimeBundle.serviceAdapters));
  assert.deepEqual(Object.keys(runtimeBundle.serviceAdapters).sort(), [
    "documentStoreAdapter", "evidenceStoreAdapter", "factStoreAdapter", "structuredStoreAdapter",
  ]);
});

test("every adapter in the bundle resolves its real pinned Seed data", async () => {
  const { documentStoreAdapter, evidenceStoreAdapter, factStoreAdapter, structuredStoreAdapter } = runtimeBundle.serviceAdapters;
  assert.ok(await documentStoreAdapter.getDocument("exchange_20230428800439"));
  assert.ok(await evidenceStoreAdapter.getEvidence("evidence_05dabd799b44945b5d8d0f61"));
  assert.ok(await factStoreAdapter.getFact("fact_3119bfad2317adbd818a3b6a"));
  assert.deepEqual(structuredStoreAdapter.recordCounts(), { FACT: 54, EVENT: 24, RELATION: 40, EVIDENCE: 160 });
});

// A tampered corpus_snapshot_id (or any other field) is written to a new
// temp path, which no longer matches the decision artifact's declared
// canonical_release_manifest.path -- so this is now caught by the
// release-authorization decision-binding check (path mismatch, before
// content is even hashed) -- RELEASE_NOT_APPROVED -- before ever reaching
// the later, now-unreachable-in-practice "canonical/structured corpus
// snapshot mismatch" defense-in-depth check. Full attack-scenario coverage
// (canonical/structured manifest path+hash binding, same-content-different-
// path copies, artifact add/remove/tamper, decision hash mismatch, approver
// mismatch, path traversal, symlink escape/alias) lives in
// tests/release-authorization-boundary.test.mjs.
test("a tampered canonical manifest field is refused as RELEASE_NOT_APPROVED, not silently accepted", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "seed-runtime-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(APPROVED_CANONICAL_MANIFEST, "utf8"));
  manifest.corpus_snapshot_id = "corpus_intentionally_wrong";
  const badCanonicalManifest = path.join(directory, "canonical.json");
  await writeFile(badCanonicalManifest, JSON.stringify(manifest));
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST,
      canonicalReleaseManifestPath: badCanonicalManifest,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError, `expected ReleaseNotApprovedError, got ${error}`);
      assert.equal(error.code, "RELEASE_NOT_APPROVED");
      assert.match(error.message, /canonical_release_manifest/);
      return true;
    },
  );
});

test("fails closed when either manifest path is omitted", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH }),
    /structuredManifestPath is required/,
  );
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH }),
    /canonicalReleaseManifestPath is required/,
  );
});

test("fails closed when either plan path is omitted", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST, canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST, planManifestPath: PLAN_MANIFEST_PATH }),
    /planPath is required/,
  );
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST, canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST, planPath: PLAN_PATH }),
    /planManifestPath is required/,
  );
});

test("fails closed with RELEASE_NOT_APPROVED when the canonical release manifest carries no release_authorization", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST,
      canonicalReleaseManifestPath: CANONICAL_MANIFEST,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.equal(error.code, "RELEASE_NOT_APPROVED");
      return true;
    },
  );
});

test("fails closed with RELEASE_NOT_APPROVED for the current v0.15 draft manifest", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_V03,
      canonicalReleaseManifestPath: DRAFT_CANONICAL_MANIFEST,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.equal(error.code, "RELEASE_NOT_APPROVED");
      return true;
    },
  );
});

// -- Turn J: Company Directory release-binding boundary ------------------
// STRUCTURED_MANIFEST's own corpus_snapshot_id ("corpus_04750795e1a2d5c3",
// asserted above) is byte-identical to the REAL Company Directory
// candidate/decision's corpus_snapshot_id, so these tests bind the REAL
// work/domain-seed/seed-company-directory.* artifacts against this same
// fixture bundle -- no separate synthetic fixture needed, and no
// question_id/company-name branching in Runtime code is exercised (only
// this test file's own selection of which real files to point at).
const COMPANY_DIRECTORY_ARTIFACT = path.join(ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl");
const COMPANY_DIRECTORY_MANIFEST = path.join(ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json");
const COMPANY_DIRECTORY_APPROVED_DECISION = path.join(ROOT, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json");
const COMPANY_DIRECTORY_PENDING_DECISION = path.join(ROOT, "work/domain-seed/seed-company-directory-owner-decision-template.v0.1.json");

function companyDirectoryBaseOptions() {
  return {
    structuredManifestPath: STRUCTURED_MANIFEST, canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
  };
}

test("Company Directory binding: omitting companyDirectoryArtifactPath is a strict no-op -- context.companyLabels stays absent, identical to every other test in this file", async () => {
  const bundle = await createSeedRuntimeServiceAdapters(companyDirectoryBaseOptions());
  assert.equal("companyLabels" in bundle.context, false);
});

test("Company Directory binding: a real APPROVED decision succeeds and populates context.companyLabels with real resolved names", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({
    ...companyDirectoryBaseOptions(),
    companyDirectoryArtifactPath: COMPANY_DIRECTORY_ARTIFACT, companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST,
    companyDirectoryOwnerDecisionPath: COMPANY_DIRECTORY_APPROVED_DECISION,
  });
  assert.equal(bundle.context.companyLabels["01390344"].corp_name, "HD현대중공업");
  assert.equal(bundle.context.companyLabels["00164645"].corp_name, "HMM");
  assert.ok(Object.isFrozen(bundle.context.companyLabels));
});

test("Company Directory binding: a PENDING decision fails the WHOLE Runtime construction closed (RELEASE_NOT_APPROVED), not just company resolution", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      ...companyDirectoryBaseOptions(),
      companyDirectoryArtifactPath: COMPANY_DIRECTORY_ARTIFACT, companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST,
      companyDirectoryOwnerDecisionPath: COMPANY_DIRECTORY_PENDING_DECISION,
    }),
    (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
  );
});

test("Company Directory binding: a decision whose artifact_sha256 does not match the real artifact fails closed", async () => {
  const dir = await mkdtemp(path.join(await realpathTmp(), "seed-company-directory-hash-"));
  try {
    const tamperedDecision = JSON.parse(await readFile(COMPANY_DIRECTORY_APPROVED_DECISION, "utf8"));
    tamperedDecision.artifact_sha256 = "0".repeat(64);
    const decisionPath = path.join(dir, "decision.json");
    await writeFile(decisionPath, JSON.stringify(tamperedDecision));
    await assert.rejects(
      createSeedRuntimeServiceAdapters({
        ...companyDirectoryBaseOptions(),
        companyDirectoryArtifactPath: COMPANY_DIRECTORY_ARTIFACT, companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST,
        companyDirectoryOwnerDecisionPath: decisionPath,
      }),
      (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Company Directory binding: a decision whose artifact_path points at a different (even byte-identical-content) file fails closed", async () => {
  const dir = await mkdtemp(path.join(await realpathTmp(), "seed-company-directory-path-"));
  try {
    const copiedArtifactPath = path.join(dir, "copied-directory.jsonl");
    await writeFile(copiedArtifactPath, await readFile(COMPANY_DIRECTORY_ARTIFACT));
    const tamperedDecision = JSON.parse(await readFile(COMPANY_DIRECTORY_APPROVED_DECISION, "utf8"));
    const decisionPath = path.join(dir, "decision.json");
    await writeFile(decisionPath, JSON.stringify(tamperedDecision));
    await assert.rejects(
      createSeedRuntimeServiceAdapters({
        ...companyDirectoryBaseOptions(),
        companyDirectoryArtifactPath: copiedArtifactPath, companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST,
        companyDirectoryOwnerDecisionPath: decisionPath,
      }),
      (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Company Directory binding: a decision whose corpus_snapshot_id does not match this release's corpus_snapshot_id fails closed (snapshot mismatch)", async () => {
  const dir = await mkdtemp(path.join(await realpathTmp(), "seed-company-directory-snapshot-"));
  try {
    const tamperedDecision = JSON.parse(await readFile(COMPANY_DIRECTORY_APPROVED_DECISION, "utf8"));
    tamperedDecision.corpus_snapshot_id = "corpus_WRONG_SNAPSHOT";
    const decisionPath = path.join(dir, "decision.json");
    await writeFile(decisionPath, JSON.stringify(tamperedDecision));
    await assert.rejects(
      createSeedRuntimeServiceAdapters({
        ...companyDirectoryBaseOptions(),
        companyDirectoryArtifactPath: COMPANY_DIRECTORY_ARTIFACT, companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST,
        companyDirectoryOwnerDecisionPath: decisionPath,
      }),
      (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Company Directory binding: a symlinked owner decision path fails closed even when the symlink target is the real, correctly-bound decision", async () => {
  const dir = await mkdtemp(path.join(await realpathTmp(), "seed-company-directory-symlink-"));
  try {
    const symlinkPath = path.join(dir, "decision-alias.json");
    await symlink(COMPANY_DIRECTORY_APPROVED_DECISION, symlinkPath);
    await assert.rejects(
      createSeedRuntimeServiceAdapters({
        ...companyDirectoryBaseOptions(),
        companyDirectoryArtifactPath: COMPANY_DIRECTORY_ARTIFACT, companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST,
        companyDirectoryOwnerDecisionPath: symlinkPath,
      }),
      (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// -- Turn K: requireCompanyDirectory production policy --------------------
// This is the flag domain/runtime/configured-seed-runtime.mjs (the ONE
// production caller) hardcodes to true. Every test above in this section
// exercises requireCompanyDirectory left at its default (false/no-op), so
// these lock in the OPPOSITE behavior: once a caller opts in, omission or
// any binding failure must fail the whole Runtime construction closed,
// never silently degrade to "no company resolution".

test("requireCompanyDirectory default (false): omitting companyDirectoryArtifactPath is unaffected -- unchanged no-op, no RELEASE_NOT_APPROVED", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({ ...companyDirectoryBaseOptions(), requireCompanyDirectory: false });
  assert.equal("companyLabels" in bundle.context, false);
});

test("requireCompanyDirectory: true with companyDirectoryArtifactPath omitted fails the whole Runtime construction closed (RELEASE_NOT_APPROVED)", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ ...companyDirectoryBaseOptions(), requireCompanyDirectory: true }),
    (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
  );
});

test("requireCompanyDirectory: true with a real APPROVED decision succeeds exactly like the default case, plus companyLabels is populated", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({
    ...companyDirectoryBaseOptions(), requireCompanyDirectory: true,
    companyDirectoryArtifactPath: COMPANY_DIRECTORY_ARTIFACT, companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST,
    companyDirectoryOwnerDecisionPath: COMPANY_DIRECTORY_APPROVED_DECISION,
  });
  assert.equal(bundle.context.companyLabels["01390344"].corp_name, "HD현대중공업");
});

test("requireCompanyDirectory: true with a PENDING decision still fails closed (the pre-existing binding check fires before the requireCompanyDirectory check is ever reached)", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      ...companyDirectoryBaseOptions(), requireCompanyDirectory: true,
      companyDirectoryArtifactPath: COMPANY_DIRECTORY_ARTIFACT, companyDirectoryManifestPath: COMPANY_DIRECTORY_MANIFEST,
      companyDirectoryOwnerDecisionPath: COMPANY_DIRECTORY_PENDING_DECISION,
    }),
    (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
  );
});
