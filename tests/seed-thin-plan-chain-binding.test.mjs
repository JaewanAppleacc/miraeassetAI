// Dedicated attack-scenario coverage for the two release-authorization
// hardening additions in domain/adapters/seed-runtime-service-adapters.mjs:
// Thin plan binding (assertThinPlanBinding) and Chain referential integrity
// (assertChainReferentialIntegrity). tests/release-authorization-boundary.test.mjs
// already exercises the canonical/structured manifest binding boundary in
// depth and threads planPath/planManifestPath through every call so those
// pre-existing scenarios keep passing under the new mandatory arguments --
// this file is scoped narrowly to the NEW surface those two additions
// introduced: can a caller substitute a different (even byte-identical
// elsewhere, even real, even same-corpus-snapshot) plan; can a decision's
// own thin_plan/thin_plan_manifest/source_gold/source_coverage pins be
// stale or tampered without being caught; can SEED_PLAN_PATH-style
// injection reach a plan the approved decision never bound to; and does
// the structured manifest's CHAIN_MANIFEST role and its cross-references
// against Event/Relation actually get verified, not just declared.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSeedRuntimeServiceAdapters, ReleaseNotApprovedError, canonicalManifestBindingHash,
} from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { createManagedSeedThinRuntime } from "../domain/runtime/seed-thin-runner.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const STRUCTURED_MANIFEST_WITH_CHAIN = path.join(ROOT, "tests/fixtures/seed-structured-artifacts.v01-with-chain.test-fixture.manifest.json");
const APPROVED_CANONICAL_MANIFEST = path.join(ROOT, "tests/fixtures/seed-release.v0.11.approved.manifest.json");
const DECISION_V01_PATH = path.join(ROOT, "tests/fixtures/seed-release-v0.11-decision.v01-structured.json");
const PLAN_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.1.jsonl");
const PLAN_MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.1.manifest.json");
const PLAN_PATH_V02 = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.2.jsonl");

function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256OfString(text) { return sha256Hex(Buffer.from(text, "utf8")); }

async function loadGolden() {
  const [structuredManifest, structuredBytes, canonical, decision] = await Promise.all([
    readFile(STRUCTURED_MANIFEST_WITH_CHAIN, "utf8").then(JSON.parse),
    readFile(STRUCTURED_MANIFEST_WITH_CHAIN),
    readFile(APPROVED_CANONICAL_MANIFEST, "utf8").then(JSON.parse),
    readFile(DECISION_V01_PATH, "utf8").then(JSON.parse),
  ]);
  return { structuredManifest, structuredBytes, canonical, decision };
}

// General-purpose fixture writer: takes the golden {canonical, decision}
// pair (optionally with `decision` already mutated by the caller, e.g. to
// tamper a thin_plan/thin_plan_manifest/thin_plan_source_gold/
// thin_plan_source_coverage pin, or to rebuild structured_artifacts against
// a mutated structuredManifest), writes canonical.json + decision.json into
// a fresh temp directory under ROOT, and rebinds
// canonical.release_authorization.decision_artifact_path/sha256 so the
// canonical/decision pair stays internally self-consistent -- exactly the
// same rebinding tests/release-authorization-boundary.test.mjs's
// writeReleasePair performs, duplicated locally so this file has no
// cross-file coupling to that one's unexported helper.
async function writeBundle(t, { canonical, decision }) {
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-thin-plan-chain-tmp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const toRootRelative = (name) => path.relative(ROOT, path.join(directory, name)).split(path.sep).join("/");

  const decisionFinal = {
    ...decision,
    canonical_release_manifest: { ...decision.canonical_release_manifest, path: toRootRelative("canonical.json") },
  };
  const decisionText = `${JSON.stringify(decisionFinal, null, 2)}\n`;
  await writeFile(path.join(directory, "decision.json"), decisionText);

  const finalCanonical = {
    ...canonical,
    release_authorization: {
      ...canonical.release_authorization,
      decision_artifact_path: toRootRelative("decision.json"),
      decision_artifact_sha256: sha256OfString(decisionText),
    },
  };
  const canonicalPath = path.join(directory, "canonical.json");
  await writeFile(canonicalPath, JSON.stringify(finalCanonical, null, 2));
  return { canonicalPath, directory };
}

// Writes a mutated structuredManifest (its `artifacts` array replaced by
// `artifacts`) to a temp file, rebinds decision.structured_manifest to its
// actual path+hash, and rebuilds decision.structured_artifacts to exactly
// match the mutated artifacts array (element-for-element, same shape
// assertArtifactSetMatches requires) -- so the ONLY thing under test is
// whatever `artifacts` deliberately changed, not an incidental
// structured_manifest or structured_artifacts binding mismatch.
async function writeMutatedStructuredBundle(t, { structuredManifest, artifacts, canonical, decision }) {
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-thin-plan-chain-struct-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mutatedManifest = { ...structuredManifest, artifacts };
  const manifestText = JSON.stringify(mutatedManifest, null, 2);
  const manifestPath = path.join(directory, "structured.json");
  await writeFile(manifestPath, manifestText);
  const structuredHash = sha256OfString(manifestText);

  const decisionWithStructured = {
    ...decision,
    structured_manifest: { path: path.relative(ROOT, manifestPath).split(path.sep).join("/"), sha256: structuredHash },
    structured_artifacts: artifacts.map((a) => ({ role: a.role, path: a.path, sha256: a.sha256, record_count: a.record_count ?? null })),
  };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: decisionWithStructured });
  return { canonicalPath, structuredManifestPath: manifestPath };
}

// ---------------------------------------------------------------------------
// Thin plan binding
// ---------------------------------------------------------------------------

test("plan-binding: the approved plan, unmutated, passes", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN,
    canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
    root: ROOT,
  });
  assert.deepEqual(bundle.authorizedRuntimeAssets, { planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH });
});

test("plan-binding: a different plan file (even real, even byte-identical .jsonl content, even same corpus_snapshot_id) is refused", async () => {
  // v0.2's plan .jsonl is byte-identical to v0.1's (same 23 answer-free
  // plans), but lives at a different path and was built from a different
  // Gold/Coverage revision (different fact_coverage_snapshot_id) -- the
  // approved decision declares v0.1's exact path, so this is refused on
  // path alone, before content or snapshot ids are ever compared.
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN,
      canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
      planPath: PLAN_PATH_V02, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.match(error.message, /thin_plan\.path/);
      return true;
    },
  );
});

test("plan-binding: a 1-byte change to the plan's content (decision's pinned sha256 no longer matches actual bytes) is refused", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, thin_plan: { ...decision.thin_plan, sha256: "0".repeat(64) } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.match(error.message, /thin_plan\.sha256 does not match/);
      return true;
    },
  );
});

test("plan-binding: the plan manifest being swapped for one whose own sha256 pin disagrees is refused", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, thin_plan_manifest: { ...decision.thin_plan_manifest, sha256: "f".repeat(64) } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.match(error.message, /thin_plan_manifest\.sha256 does not match/);
      return true;
    },
  );
});

test("plan-binding: a plan reached through a symlink alias at the declared path is refused, even with matching bytes", async (t) => {
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-thin-plan-chain-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const aliasPlanPath = path.join(directory, "plan-alias.jsonl");
  await symlink(PLAN_PATH, aliasPlanPath);
  const aliasRelative = path.relative(ROOT, aliasPlanPath).split(path.sep).join("/");

  const { canonical, decision } = await loadGolden();
  const planBytes = await readFile(PLAN_PATH);
  const mutated = { ...decision, thin_plan: { ...decision.thin_plan, path: aliasRelative, sha256: sha256Hex(planBytes) } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath,
      planPath: aliasPlanPath, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.match(error.message, /thin_plan path involves a symlink/);
      return true;
    },
  );
});

test("plan-binding: SEED_PLAN_PATH-style env override to an unapproved plan does not bypass the gate -- the managed runtime fails closed, not fabricates STRUCTURED", async () => {
  // Simulates domain/runtime/configured-seed-runtime.mjs's SEED_PLAN_PATH
  // override reaching createManagedSeedThinRuntime with a real, well-formed,
  // but NOT the approved-decision-bound plan (v0.2's, same corpus, wrong
  // path/fact_coverage_snapshot_id). Construction must fail closed --
  // readiness reports FAILED, never READY -- and the exact same conclusion
  // as the direct-adapter test above, exercised end-to-end through the
  // Runtime Host entry point a deployment override actually goes through.
  const runtime = createManagedSeedThinRuntime({
    root: ROOT,
    structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN,
    canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
    planPath: PLAN_PATH_V02, // the "injected" override
    planManifestPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.2.manifest.json"),
  });
  assert.equal(await runtime.initialize(), false);
  assert.deepEqual(runtime.readiness(), { status: "FAILED", ready: false, error_code: "SEED_RUNTIME_INIT_FAILED" });
});

test("plan-binding: source_gold declared by the decision no longer matching the plan manifest's own source_gold content is refused", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, thin_plan_source_gold: { ...decision.thin_plan_source_gold, sha256: "a".repeat(64) } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.match(error.message, /source_gold \(work\/domain-seed\/seed-gold-promotion-candidates\.v0\.13\.jsonl\) could not be read|thin_plan_source_gold\.sha256 does not match/);
      return true;
    },
  );
});

test("plan-binding: source_coverage declared by the decision no longer matching the plan manifest's own source_coverage content is refused", async (t) => {
  const { canonical, decision } = await loadGolden();
  const mutated = { ...decision, thin_plan_source_coverage: { ...decision.thin_plan_source_coverage, sha256: "b".repeat(64) } };
  const { canonicalPath } = await writeBundle(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError);
      assert.match(error.message, /thin_plan_source_coverage\.sha256 does not match/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Chain referential integrity
// ---------------------------------------------------------------------------

test("chain-binding: the real CHAIN_MANIFEST artifact carries exactly 16 records and construction succeeds with it", async () => {
  const { structuredManifest } = await loadGolden();
  const chainPin = structuredManifest.artifacts.find((a) => a.role === "CHAIN_MANIFEST");
  assert.equal(chainPin.record_count, 16);
  const bytes = await readFile(path.join(ROOT, chainPin.path));
  assert.equal(sha256Hex(bytes), chainPin.sha256);
  const lines = bytes.toString("utf8").trim().split("\n");
  assert.equal(lines.length, 16);
  for (const line of lines) assert.match(JSON.parse(line).chain_id, /^chain_[0-9a-f]{24}$/);

  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
  });
  assert.ok(Object.isFrozen(bundle.chainIntegrity));
});

test("chain-binding: a Chain record missing its chain_id is refused", async (t) => {
  const { structuredManifest, canonical, decision } = await loadGolden();
  const chainPin = structuredManifest.artifacts.find((a) => a.role === "CHAIN_MANIFEST");
  const realLines = (await readFile(path.join(ROOT, chainPin.path), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  realLines[0] = { ...realLines[0], chain_id: undefined };
  const mutatedText = `${realLines.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const mutatedDir = await mkdtemp(path.join(ROOT, "work", "seed-thin-plan-chain-mutant-"));
  t.after(() => rm(mutatedDir, { recursive: true, force: true }));
  const mutatedChainPath = path.join(mutatedDir, "chain.jsonl");
  await writeFile(mutatedChainPath, mutatedText);
  const mutatedBytes = await readFile(mutatedChainPath);

  const artifacts = structuredManifest.artifacts.map((a) => (a.role === "CHAIN_MANIFEST"
    ? { role: "CHAIN_MANIFEST", path: path.relative(ROOT, mutatedChainPath).split(path.sep).join("/"), sha256: sha256Hex(mutatedBytes), bytes: mutatedBytes.length, record_count: 16 }
    : a));
  const { canonicalPath, structuredManifestPath } = await writeMutatedStructuredBundle(t, { structuredManifest, artifacts, canonical, decision });

  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath, canonicalReleaseManifestPath: canonicalPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    /invalid or duplicate chain_id in Chain artifact/,
  );
});

test("chain-binding: a tampered CHAIN_MANIFEST sha256 pin (bytes on disk do not match the structured manifest's own declared hash) is refused", async (t) => {
  const { structuredManifest, canonical, decision } = await loadGolden();
  const artifacts = structuredManifest.artifacts.map((a) => (a.role === "CHAIN_MANIFEST" ? { ...a, sha256: "c".repeat(64) } : a));
  const { canonicalPath, structuredManifestPath } = await writeMutatedStructuredBundle(t, { structuredManifest, artifacts, canonical, decision });

  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath, canonicalReleaseManifestPath: canonicalPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    /CHAIN_MANIFEST: raw bytes do not match the structured manifest's own sha256 pin/,
  );
});

test("chain-binding: an Event referencing a chain_id absent from the Chain artifact is refused", async (t) => {
  const { structuredManifest, canonical, decision } = await loadGolden();
  const eventPin = structuredManifest.artifacts.find((a) => a.role === "VERIFIED_EVENT");
  const realLines = (await readFile(path.join(ROOT, eventPin.path), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const targetIndex = realLines.findIndex((e) => typeof e.chain_id === "string");
  assert.ok(targetIndex >= 0, "expected at least one Event with a chain_id");
  realLines[targetIndex] = { ...realLines[targetIndex], chain_id: "chain_000000000000000000000000" };
  const mutatedText = `${realLines.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const mutatedDir = await mkdtemp(path.join(ROOT, "work", "seed-thin-plan-chain-event-"));
  t.after(() => rm(mutatedDir, { recursive: true, force: true }));
  const mutatedEventPath = path.join(mutatedDir, "event.jsonl");
  await writeFile(mutatedEventPath, mutatedText);
  const mutatedBytes = await readFile(mutatedEventPath);

  const artifacts = structuredManifest.artifacts.map((a) => (a.role === "VERIFIED_EVENT"
    ? { role: "VERIFIED_EVENT", path: path.relative(ROOT, mutatedEventPath).split(path.sep).join("/"), sha256: sha256Hex(mutatedBytes), bytes: mutatedBytes.length, record_count: eventPin.record_count }
    : a));
  const { canonicalPath, structuredManifestPath } = await writeMutatedStructuredBundle(t, { structuredManifest, artifacts, canonical, decision });

  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath, canonicalReleaseManifestPath: canonicalPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    /references chain_id chain_000000000000000000000000, which does not exist in the Chain artifact/,
  );
});

test("chain-binding: a structured manifest missing the CHAIN_MANIFEST role entirely is refused", async (t) => {
  const { structuredManifest, canonical, decision } = await loadGolden();
  const artifacts = structuredManifest.artifacts.filter((a) => a.role !== "CHAIN_MANIFEST");
  const { canonicalPath, structuredManifestPath } = await writeMutatedStructuredBundle(t, { structuredManifest, artifacts, canonical, decision });

  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath, canonicalReleaseManifestPath: canonicalPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT,
    }),
    /missing role CHAIN_MANIFEST/,
  );
});
