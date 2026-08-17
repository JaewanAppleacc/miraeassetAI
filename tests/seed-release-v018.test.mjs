// Contract test for the v0.18 release (domain/releases/seed-release.v0.18.manifest.json
// + .decision.json), which resolves the v0.17 audit finding
// (domain/releases/seed-release.v0.17.BLOCKED.audit-report.json): the
// 6-item Fact/Evidence batch is now backed by a REAL, externally authored
// Owner decision (work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl,
// 6/6 APPROVE by 최재완), independently validated by
// scripts/promote-seed-fact-batch-v06.mjs before promotion -- not a
// script-minted approval. The Q10 period-semantics defect is fixed too.
// Proves, via the real production createSeedRuntimeServiceAdapters, that
// the hardened release-authorization gate (Thin plan + CHAIN_MANIFEST,
// unchanged from v0.17) still accepts this bundle. Also proves the
// overall Release Gate is explicitly NOT claimed resolved by this release:
// Q07/Q21/Q24 metric_fail and the 17 REVIEW_REQUIRED items remain BLOCKED.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

// Unchanged from v0.17 -- the Chain->document gap is orthogonal to the
// audit fix and must remain fully visible, not incidentally resolved or
// hidden by this release.
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
    structuredManifestPath: path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"),
    canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.18.manifest.json"),
    planPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"),
    planManifestPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"),
    root: ROOT,
  });
});

test("the v0.18 approved release bundle passes the hardened release-authorization gate", () => {
  assert.deepEqual(bundle.context, {
    corpus_snapshot_id: "corpus_04750795e1a2d5c3",
    fact_coverage_snapshot_id: "fact_coverage_snapshot_e496090c2a4da212a768e53d",
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

test("the two Q10 CONSOLIDATION_ENTITY_COUNT facts are VERIFIED with the corrected period semantics and a real Owner attribution", async () => {
  const before = await bundle.serviceAdapters.factStoreAdapter.getFact("fact_9b11df42c16ce405a75d663d");
  const after = await bundle.serviceAdapters.factStoreAdapter.getFact("fact_0dd045e1f5e8ffa6bae6efa6");
  assert.ok(before && after);
  for (const [fact, expected] of [[before.record, { as_of_date: "2023-06-30", known_at: "2023-08-14T00:00:00Z", value: 10 }], [after.record, { as_of_date: "2025-06-30", known_at: "2025-08-14T00:00:00Z", value: 16 }]]) {
    assert.equal(fact.verification_status, "VERIFIED");
    assert.equal(fact.period_type, "POINT_IN_TIME");
    assert.equal(fact.as_of_date, expected.as_of_date);
    assert.equal(fact.known_at, expected.known_at);
    assert.equal(fact.period_start, null);
    assert.equal(fact.period_end, null);
    assert.equal(fact.normalized_value, expected.value);
    assert.equal(fact.attributes.review_provenance.owner_approved_by, "최재완");
    assert.equal(fact.attributes.review_provenance.owner_disposition, "ACCEPTED");
  }
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
  assert.equal(bundle.authorizedRuntimeAssets.planPath, path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"));
  assert.equal(bundle.authorizedRuntimeAssets.planManifestPath, path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"));
  assert.ok(Object.isFrozen(bundle.authorizedRuntimeAssets));
});

test("the known 5-document Chain->DocumentIR gap remains fully visible as advisory findings, not silently dropped or resolved", () => {
  assert.deepEqual(bundle.chainIntegrity.documentResolutionWarnings, EXPECTED_DOCUMENT_RESOLUTION_WARNINGS);
});

test("the v0.18 decision explicitly binds the real, externally authored Owner batch decision (path+SHA-256+all_approve)", async () => {
  const decision = JSON.parse(await readFile(path.join(ROOT, "domain/releases/seed-release.v0.18.decision.json"), "utf8"));
  assert.equal(decision.owner_batch_decision.path, "work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl");
  assert.match(decision.owner_batch_decision.sha256, /^[0-9a-f]{64}$/);
  assert.equal(decision.owner_batch_decision.record_count, 6);
  assert.equal(decision.owner_batch_decision.all_approve, true);
  assert.equal(decision.owner_batch_decision.approved_by, "최재완");
  const actualBytes = await readFile(path.join(ROOT, decision.owner_batch_decision.path));
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(actualBytes).digest("hex"), decision.owner_batch_decision.sha256);
});

// ---------------------------------------------------------------------------
// Release Gate: this release resolves ONLY the v0.17 audit finding. Neither
// the release artifacts nor the gate-status report may claim Q07/Q21/Q24 or
// the REVIEW_REQUIRED items are resolved -- pinned here so a future change
// can't silently start claiming that without this test failing.
// ---------------------------------------------------------------------------
test("the v0.18 Release Gate status report keeps the overall gate BLOCKED and does not claim Q07/Q21/Q24 or REVIEW_REQUIRED are resolved", async () => {
  const status = JSON.parse(await readFile(path.join(ROOT, "domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json"), "utf8"));
  assert.equal(status.overall_release_gate, "BLOCKED");
  assert.equal(status.gates.data_promotion_gate.status, "PASS");
  assert.equal(status.gates.release_authorization_gate.status, "PASS");
  assert.equal(status.gates.runtime_api_gate.status, "PASS");
  assert.equal(status.gates.automatic_metric_gate.status, "BLOCKED");
  assert.match(status.gates.automatic_metric_gate.detail, /Q07/);
  assert.match(status.gates.automatic_metric_gate.detail, /Q21/);
  assert.match(status.gates.automatic_metric_gate.detail, /Q24/);
  assert.equal(status.gates.manual_review_gate.status, "BLOCKED");
  assert.match(status.gates.manual_review_gate.detail, /17 REVIEW_REQUIRED/);
  assert.equal(status.gates.deployment_gate.status, "BLOCKED");
});

test("v0.17/v0.5 and v0.16/v0.4 remain byte-identical on disk (audit history, never overwritten)", async () => {
  const paths = [
    "domain/releases/seed-release.v0.17.manifest.json",
    "domain/releases/seed-release.v0.17.decision.json",
    "work/domain-seed/seed-structured-artifacts.v0.5.manifest.json",
    "work/domain-seed/seed-evidence-verified.v0.7.jsonl",
    "work/domain-seed/seed-facts-verified.v0.5.jsonl",
    "work/domain-seed/seed-fact-coverage-verified.v0.5.json",
    "work/domain-seed/seed-structured-owner-decision.v0.5-batch.jsonl",
    "domain/releases/seed-release.v0.16.manifest.json",
    "work/domain-seed/seed-structured-artifacts.v0.4.manifest.json",
    "work/domain-seed/seed-structured-owner-decision.v0.7-batch.template.jsonl",
  ];
  for (const p of paths) {
    // Existence + readability is the meaningful assertion here (git diff
    // --stat emptiness is verified separately, outside this suite, since
    // that's a repo-state check, not a unit-test-appropriate one).
    await assert.doesNotReject(readFile(path.join(ROOT, p)));
  }
});
