// AUDIT-HISTORY / GENERIC-MODE ONLY -- v0.17 is NOT a production-approved
// release. It was discarded (domain/releases/seed-release.v0.17.BLOCKED.audit-report.json)
// for a self-approved 6-item batch, and MUST NOT ever construct through
// the real configured-seed-runtime.mjs singleton or any caller that
// applies the production anti-rollback policy (expectedReleaseId/
// expectedApprovedRevision/requireOwnerBatchDecision) -- see
// tests/seed-runtime-production-anti-rollback.test.mjs for that negative
// proof, which is the load-bearing contract now.
//
// What this file DOES still prove: createSeedRuntimeServiceAdapters,
// called generically (no production policy -- undefined expectedReleaseId/
// expectedApprovedRevision, requireOwnerBatchDecision left false), still
// accepts a byte-valid, correctly-decision-bound release regardless of
// whether it happens to be current -- this is intentional, generic-mode
// behavior for legacy/independent tooling (auditors, historical fixture
// tests, other Flows pointed at other revisions) that never claims
// production authority. The FIRST test below makes this isolation
// explicit within this same file: the identical bundle, pinned to the
// production policy, is refused.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createSeedRuntimeServiceAdapters, ReleaseNotApprovedError } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

// The exact, currently-known set of Chain -> document references that fall
// outside the canonical DocumentIR bundle (5 of 16 Chains' earlier-anchor
// document). Advisory, non-blocking (see assertChainReferentialIntegrity in
// domain/adapters/seed-runtime-service-adapters.mjs) but must stay visible:
// this assertion pins the exact set so any future change -- fixed gap,
// newly introduced gap, or a regression that silently drops the warning --
// is forced to show up as a test diff instead of disappearing quietly.
const EXPECTED_DOCUMENT_RESOLUTION_WARNINGS = [
  { chain_id: "chain_0a09f2e54a5e5acbb0e44e19", document_id: "holding_20250117000548", question_ids: ["question_seed_v07_04"] },
  { chain_id: "chain_349c689807b555c0b6e045c5", document_id: "periodic_20240312000681", question_ids: ["question_seed_v07_12", "question_seed_v07_16"] },
  { chain_id: "chain_448b6e85a08a60b3be3800c8", document_id: "periodic_20240320001402", question_ids: ["question_seed_v07_11", "question_seed_v07_16"] },
  { chain_id: "chain_5c3167e20c8ba143b82d34af", document_id: "periodic_20240318000635", question_ids: ["question_seed_v07_14"] },
  { chain_id: "chain_b7c1bc8fc198bed75b86faf1", document_id: "major_20230227006069", question_ids: ["question_seed_v07_21"] },
];

let bundle;
test.before(async () => {
  bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.5.manifest.json"),
    canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.17.manifest.json"),
    planPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.5.jsonl"),
    planManifestPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.5.manifest.json"),
    root: ROOT,
  });
});

test("ISOLATION: the identical v0.17 bundle, pinned to the production anti-rollback policy, is refused with RELEASE_NOT_APPROVED", async () => {
  await assert.rejects(
    createSeedRuntimeServiceAdapters({
      structuredManifestPath: path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.5.manifest.json"),
      canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.17.manifest.json"),
      planPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.5.jsonl"),
      planManifestPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.5.manifest.json"),
      root: ROOT,
      expectedReleaseId: "seed-release-v0.19",
      expectedApprovedRevision: "seed-structured-artifacts-v0.6",
      requireOwnerBatchDecision: true,
    }),
    (error) => { assert.ok(error instanceof ReleaseNotApprovedError); assert.equal(error.code, "RELEASE_NOT_APPROVED"); return true; },
  );
});

test("GENERIC MODE (no production policy applied): the v0.17 bundle still passes the hardened release-authorization gate -- audit/legacy tooling only, never production", () => {
  assert.deepEqual(bundle.context, {
    corpus_snapshot_id: "corpus_04750795e1a2d5c3",
    fact_coverage_snapshot_id: "fact_coverage_snapshot_c55f9075851f6fec94ab8a20",
  });
  assert.deepEqual(Object.keys(bundle.serviceAdapters).sort(), [
    "documentStoreAdapter", "evidenceStoreAdapter", "factStoreAdapter", "structuredStoreAdapter",
  ]);
});

test("the promoted structured store reports the full metric-gap-closure-inclusive counts", () => {
  assert.deepEqual(bundle.serviceAdapters.structuredStoreAdapter.recordCounts(), {
    FACT: 73, EVENT: 24, RELATION: 40, EVIDENCE: 219,
  });
});

test("the bad row=16 evidence does not resolve; the row=17 replacement does", async () => {
  const bad = await bundle.serviceAdapters.evidenceStoreAdapter.getEvidence("evidence_3af676a53066446432eb71f4");
  assert.equal(bad, null);
  const good = await bundle.serviceAdapters.evidenceStoreAdapter.getEvidence("evidence_c0b7c71ea8a833271c28a498");
  assert.ok(good);
  assert.equal(good.record.verification_status, "VERIFIED");
  assert.equal(good.record.source_locator, "exchange_20260120800597/20260120800597.xml#node=3&row=17&col=0");
});

test("authorizedRuntimeAssets exposes only the gate-verified plan paths, byte-identical to the release-pinned plan", () => {
  assert.equal(bundle.authorizedRuntimeAssets.planPath, path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.5.jsonl"));
  assert.equal(bundle.authorizedRuntimeAssets.planManifestPath, path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.5.manifest.json"));
  assert.ok(Object.isFrozen(bundle.authorizedRuntimeAssets));
});

test("the known 5-document Chain->DocumentIR gap remains fully visible as advisory findings, not silently dropped", () => {
  assert.deepEqual(bundle.chainIntegrity.documentResolutionWarnings, EXPECTED_DOCUMENT_RESOLUTION_WARNINGS);
  assert.ok(Object.isFrozen(bundle.chainIntegrity));
  assert.ok(Object.isFrozen(bundle.chainIntegrity.documentResolutionWarnings));
});
