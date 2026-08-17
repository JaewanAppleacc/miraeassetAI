// Production anti-rollback coverage: a byte-valid, correctly-decision-
// bound release is not automatically a CURRENT one. domain/releases/
// seed-release.v0.17.manifest.json is exactly this trap -- self-consistent,
// same corpus_snapshot_id, and (before this hardening) constructed
// successfully even through the real configured-seed-runtime.mjs singleton
// via a full env-var override -- despite being discarded audit history
// (self-approved batch; see seed-release.v0.17.BLOCKED.audit-report.json).
//
// Every scenario below exercises the REAL configuredSeedRuntime singleton
// (domain/runtime/configured-seed-runtime.mjs) through its actual env-var
// override surface, not a hand-rolled adapter call -- proving the policy
// (expectedReleaseId/expectedApprovedRevision/requireOwnerBatchDecision) is
// hardcoded there and cannot be weakened by environment variables, which
// may only redirect WHICH files are read.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createSeedRuntimeServiceAdapters, ReleaseNotApprovedError } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const V19_PATHS = Object.freeze({
  structuredManifestPath: path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"),
  canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.19.manifest.json"),
  planPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"),
  planManifestPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"),
});
const V17_PATHS = Object.freeze({
  structuredManifestPath: "work/domain-seed/seed-structured-artifacts.v0.5.manifest.json",
  canonicalReleaseManifestPath: "domain/releases/seed-release.v0.17.manifest.json",
  planPath: "work/domain-seed/seed-thin-flow-plans.v0.5.jsonl",
  planManifestPath: "work/domain-seed/seed-thin-flow-plans.v0.5.manifest.json",
});
const V18_PATHS = Object.freeze({
  structuredManifestPath: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
  canonicalReleaseManifestPath: "domain/releases/seed-release.v0.18.manifest.json",
  planPath: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
  planManifestPath: "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
});

// Runs a tiny child-process script that imports the REAL configured-seed-
// runtime.mjs singleton under a controlled env, so each scenario gets a
// truly fresh module instance (the singleton is constructed once at import
// time) instead of a stale in-process one.
async function initializeConfiguredRuntimeWithEnv(envOverrides) {
  const script = `
    import(${JSON.stringify(path.join(ROOT, "domain/runtime/configured-seed-runtime.mjs"))}).then(async (m) => {
      const ok = await m.configuredSeedRuntime.initialize();
      console.log(JSON.stringify({ ok, readiness: m.configuredSeedRuntime.readiness() }));
    }).catch((error) => { console.log(JSON.stringify({ ok: false, error: error.message })); });
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: { ...process.env, ...envOverrides },
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

// ---------------------------------------------------------------------------
// Direct adapter-level proof (fast, precise error messages)
// ---------------------------------------------------------------------------

test("adapter: v0.17, unpinned (no policy), still constructs -- legacy/independent callers are unaffected", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: path.join(ROOT, V17_PATHS.structuredManifestPath),
    canonicalReleaseManifestPath: path.join(ROOT, V17_PATHS.canonicalReleaseManifestPath),
    planPath: path.join(ROOT, V17_PATHS.planPath),
    planManifestPath: path.join(ROOT, V17_PATHS.planManifestPath),
    root: ROOT,
  });
  assert.deepEqual(bundle.serviceAdapters.structuredStoreAdapter.recordCounts(), { FACT: 73, EVENT: 24, RELATION: 40, EVIDENCE: 219 });
});

test("adapter: v0.17, pinned to the production policy (expectedReleaseId=v0.19), is refused with RELEASE_NOT_APPROVED", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: path.join(ROOT, V17_PATHS.structuredManifestPath),
      canonicalReleaseManifestPath: path.join(ROOT, V17_PATHS.canonicalReleaseManifestPath),
      planPath: path.join(ROOT, V17_PATHS.planPath),
      planManifestPath: path.join(ROOT, V17_PATHS.planManifestPath),
      root: ROOT,
      expectedReleaseId: "seed-release-v0.19",
      expectedApprovedRevision: "seed-structured-artifacts-v0.6",
      requireOwnerBatchDecision: true,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.equal(error.code, "RELEASE_NOT_APPROVED");
      assert.match(error.message, /canonical manifest release_id \("seed-release-v0\.17"\) does not match the required production release_id \("seed-release-v0\.19"\)/);
      return true;
    },
  );
});

test("adapter: v0.18, pinned to the production policy (expectedReleaseId=v0.19), is refused too -- the policy pins the exact current release, not merely 'not v0.17'", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: path.join(ROOT, V18_PATHS.structuredManifestPath),
      canonicalReleaseManifestPath: path.join(ROOT, V18_PATHS.canonicalReleaseManifestPath),
      planPath: path.join(ROOT, V18_PATHS.planPath),
      planManifestPath: path.join(ROOT, V18_PATHS.planManifestPath),
      root: ROOT,
      expectedReleaseId: "seed-release-v0.19",
      expectedApprovedRevision: "seed-structured-artifacts-v0.6",
      requireOwnerBatchDecision: true,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.match(error.message, /release_id \("seed-release-v0\.18"\) does not match the required production release_id \("seed-release-v0\.19"\)/);
      return true;
    },
  );
});

test("adapter: v0.19, pinned to the production policy, succeeds", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({ ...V19_PATHS, root: ROOT, expectedReleaseId: "seed-release-v0.19", expectedApprovedRevision: "seed-structured-artifacts-v0.6", requireOwnerBatchDecision: true });
  assert.deepEqual(bundle.serviceAdapters.structuredStoreAdapter.recordCounts(), { FACT: 73, EVENT: 24, RELATION: 40, EVIDENCE: 219 });
});

test("adapter: release_id tampered alone (decision's own release_id changed, everything else self-consistent) is refused", async (t) => {
  // Build a self-consistent forged pair: copy the real v0.19 canonical +
  // decision, change ONLY decision.release_id (and the canonical's
  // matching field would normally need to change too for internal
  // consistency -- but assertDecisionBindsReleaseBundle already requires
  // decision.release_id === canonicalManifest.release_id, so tampering
  // decision.release_id ALONE breaks that FIRST, proving release_id is
  // checked before -- and independently of -- assertExpectedReleaseIdentity).
  const [canonical, decision] = await Promise.all([
    readFile(V19_PATHS.canonicalReleaseManifestPath, "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "domain/releases/seed-release.v0.19.decision.json"), "utf8").then(JSON.parse),
  ]);
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-anti-rollback-tmp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { createHash } = await import("node:crypto");
  const sha256OfString = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
  const toRootRelative = (p) => path.relative(ROOT, p).split(path.sep).join("/");

  const tamperedDecision = { ...decision, release_id: "seed-release-v0.17" };
  const decisionFinal = { ...tamperedDecision, canonical_release_manifest: { ...tamperedDecision.canonical_release_manifest, path: toRootRelative(path.join(directory, "canonical.json")) } };
  const decisionText = `${JSON.stringify(decisionFinal, null, 2)}\n`;
  await writeFile(path.join(directory, "decision.json"), decisionText);
  const finalCanonical = { ...canonical, release_authorization: { ...canonical.release_authorization, decision_artifact_path: toRootRelative(path.join(directory, "decision.json")), decision_artifact_sha256: sha256OfString(decisionText) } };
  const canonicalPath = path.join(directory, "canonical.json");
  await writeFile(canonicalPath, JSON.stringify(finalCanonical, null, 2));

  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: V19_PATHS.structuredManifestPath, canonicalReleaseManifestPath: canonicalPath,
      planPath: V19_PATHS.planPath, planManifestPath: V19_PATHS.planManifestPath, root: ROOT,
      expectedReleaseId: "seed-release-v0.19", expectedApprovedRevision: "seed-structured-artifacts-v0.6", requireOwnerBatchDecision: true,
    }),
    (error) => { assert.ok(error instanceof ReleaseNotApprovedError); return true; },
  );
});

test("adapter: approved_revision mismatch (declared expectedApprovedRevision disagrees with the real decision) is refused", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      ...V19_PATHS, root: ROOT,
      expectedReleaseId: "seed-release-v0.19",
      expectedApprovedRevision: "seed-structured-artifacts-v0.4", // stale/wrong revision
      requireOwnerBatchDecision: true,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.match(error.message, /approved_revision \("seed-structured-artifacts-v0\.6"\) does not match the required production approved_revision \("seed-structured-artifacts-v0\.4"\)/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Real configured-seed-runtime.mjs singleton, via its actual env-var
// override surface -- the exact repro path from the audit.
// ---------------------------------------------------------------------------

test("configured runtime: legacy per-artifact v0.17 env overrides are ignored; production still boots the pinned v0.20 bundle", async () => {
  const result = await initializeConfiguredRuntimeWithEnv({
    SEED_STRUCTURED_MANIFEST_PATH: V17_PATHS.structuredManifestPath,
    SEED_CANONICAL_RELEASE_MANIFEST_PATH: V17_PATHS.canonicalReleaseManifestPath,
    SEED_PLAN_PATH: V17_PATHS.planPath,
    SEED_PLAN_MANIFEST_PATH: V17_PATHS.planManifestPath,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.readiness, { status: "READY", ready: true, error_code: null });
});

test("configured runtime: legacy per-artifact v0.18 env overrides cannot redirect the pinned v0.20 bundle", async () => {
  const result = await initializeConfiguredRuntimeWithEnv({
    SEED_STRUCTURED_MANIFEST_PATH: V18_PATHS.structuredManifestPath,
    SEED_CANONICAL_RELEASE_MANIFEST_PATH: V18_PATHS.canonicalReleaseManifestPath,
    SEED_PLAN_PATH: V18_PATHS.planPath,
    SEED_PLAN_MANIFEST_PATH: V18_PATHS.planManifestPath,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.readiness, { status: "READY", ready: true, error_code: null });
});

test("configured runtime: no override at all succeeds -- final v0.20 is READY", async () => {
  const result = await initializeConfiguredRuntimeWithEnv({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.readiness, { status: "READY", ready: true, error_code: null });
});

test("configured runtime: legacy v0.19 per-artifact env values do not alter the final v0.20 selection", async () => {
  const result = await initializeConfiguredRuntimeWithEnv({
    SEED_STRUCTURED_MANIFEST_PATH: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
    SEED_CANONICAL_RELEASE_MANIFEST_PATH: "domain/releases/seed-release.v0.19.manifest.json",
    SEED_PLAN_PATH: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
    SEED_PLAN_MANIFEST_PATH: "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.readiness, { status: "READY", ready: true, error_code: null });
});

// ---------------------------------------------------------------------------
// External mount deployment scenario: the SAME v0.19 bundle, byte-identical,
// copied to a completely different root (e.g. a deployment volume mount
// outside the source tree) -- must still succeed, proving the policy keys
// off release IDENTITY (content), never off a specific filesystem location.
// ---------------------------------------------------------------------------

// os.tmpdir() itself is a symlink on macOS (/var -> /private/var), which
// would incidentally trip the strict "no symlink anywhere along the path"
// check this hardening added -- resolve it once so the mount root and
// everything under it is symlink-free, matching a real deployment mount
// (a real directory, not a symlinked one).
async function freshMountRoot(prefix) {
  const base = await realpath(os.tmpdir());
  return mkdtemp(path.join(base, prefix));
}

const MOUNT_RELATIVE_FILES = Object.freeze([
  "domain/releases/seed-release.v0.19.manifest.json",
  "domain/releases/seed-release.v0.19.decision.json",
  "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
  "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
  "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
  "work/domain-seed/seed-evidence-verified.v0.9.jsonl",
  "work/domain-seed/seed-evidence-verified.v0.9.manifest.json",
  "work/domain-seed/seed-facts-verified.v0.7.jsonl",
  "work/domain-seed/seed-fact-coverage-verified.v0.6.json",
  "work/domain-seed/seed-events-verified.v0.1.jsonl",
  "work/domain-seed/seed-relation-gold.v0.2.jsonl",
  "work/domain-seed/seed-chain-manifest.v0.2.jsonl",
  "work/domain-seed/seed-structured-owner-decision.v0.7.jsonl",
  "work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl",
  "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl",
  "work/domain-seed/seed-canonical-document-ir.v0.15.delta.jsonl",
  "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  // Turn J: configured-seed-runtime.mjs now unconditionally binds the
  // Company Directory too, so a mounted-elsewhere deployment must carry
  // these 3 files as well or construction fails closed (correctly) --
  // this list mirrors that requirement rather than special-casing it away.
  "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl",
  "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json",
  "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json",
]);

test("adapter: the same v0.19 bundle, byte-identical, mounted at a completely different root, still succeeds", async (t) => {
  const mountRoot = await freshMountRoot("seed-v019-mount-");
  t.after(() => rm(mountRoot, { recursive: true, force: true }));
  for (const relative of MOUNT_RELATIVE_FILES) {
    const source = path.join(ROOT, relative);
    const destination = path.join(mountRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }

  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: path.join(mountRoot, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"),
    canonicalReleaseManifestPath: path.join(mountRoot, "domain/releases/seed-release.v0.19.manifest.json"),
    planPath: path.join(mountRoot, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"),
    planManifestPath: path.join(mountRoot, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"),
    root: mountRoot,
    expectedReleaseId: "seed-release-v0.19",
    expectedApprovedRevision: "seed-structured-artifacts-v0.6",
    requireOwnerBatchDecision: true,
  });
  assert.deepEqual(bundle.serviceAdapters.structuredStoreAdapter.recordCounts(), { FACT: 73, EVENT: 24, RELATION: 40, EVIDENCE: 219 });
});

test("configured runtime: SEED_RUNTIME_ROOT containing only the old v0.19 loose-file layout fails closed", async (t) => {
  const mountRoot = await freshMountRoot("seed-v019-mount-env-");
  t.after(() => rm(mountRoot, { recursive: true, force: true }));
  for (const relative of MOUNT_RELATIVE_FILES) {
    const source = path.join(ROOT, relative);
    const destination = path.join(mountRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }

  const result = await initializeConfiguredRuntimeWithEnv({ SEED_RUNTIME_ROOT: mountRoot });
  assert.equal(result.ok, false);
  assert.deepEqual(result.readiness, { status: "FAILED", ready: false, error_code: "SEED_RUNTIME_INIT_FAILED" });
});
