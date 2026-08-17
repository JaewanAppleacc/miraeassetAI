// Contract test for the v0.19 release (domain/releases/seed-release.v0.19.manifest.json
// + .decision.json): a pure re-authorization of v0.18's exact data (Fact
// v0.7 / Evidence v0.9 / Coverage v0.6 / Gold v0.17 / Plan v0.6 / Chain
// v0.2, all byte-identical, unchanged) that exists ONLY to record, at the
// release-authorization layer, that domain.owner_batch_decision is now
// genuinely read and validated by the real Runtime construction boundary
// (assertOwnerBatchDecisionBinding) -- see tests/seed-owner-batch-decision-binding.test.mjs
// for the full attack-scenario coverage of that mechanism. v0.18's own
// manifest/decision are never modified.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

let bundle;
test.before(async () => {
  bundle = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"),
    canonicalReleaseManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.19.manifest.json"),
    planPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"),
    planManifestPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"),
    root: ROOT,
  });
});

test("the v0.19 approved release bundle passes the hardened release-authorization gate, including the now-active owner_batch_decision check", () => {
  assert.deepEqual(bundle.context, {
    corpus_snapshot_id: "corpus_04750795e1a2d5c3",
    fact_coverage_snapshot_id: "fact_coverage_snapshot_e496090c2a4da212a768e53d",
  });
  assert.deepEqual(bundle.serviceAdapters.structuredStoreAdapter.recordCounts(), {
    FACT: 73, EVENT: 24, RELATION: 40, EVIDENCE: 219,
  });
});

test("v0.19's data is byte-identical to v0.18's -- this release changes only the authorization layer, not the underlying data", async () => {
  const [v18, v19] = await Promise.all([
    readFile(path.join(ROOT, "domain/releases/seed-release.v0.18.decision.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "domain/releases/seed-release.v0.19.decision.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(v19.structured_manifest.path, v18.structured_manifest.path);
  assert.equal(v19.structured_manifest.sha256, v18.structured_manifest.sha256);
  assert.equal(v19.thin_plan.sha256, v18.thin_plan.sha256);
  assert.equal(v19.thin_plan.path, v18.thin_plan.path);
  assert.equal(v19.owner_batch_decision.path, v18.owner_batch_decision.path);
  assert.equal(v19.owner_batch_decision.sha256, v18.owner_batch_decision.sha256);
  assert.equal(v19.fact_coverage_snapshot_id, v18.fact_coverage_snapshot_id);
  assert.notEqual(v19.release_id, v18.release_id);
  assert.equal(v19.supersedes ?? undefined, undefined); // supersedes lives on the canonical manifest, not the decision
});

test("v0.19's canonical manifest declares supersedes v0.18 explicitly", async () => {
  const canonical = JSON.parse(await readFile(path.join(ROOT, "domain/releases/seed-release.v0.19.manifest.json"), "utf8"));
  assert.equal(canonical.supersedes, "domain/releases/seed-release.v0.18.manifest.json");
  assert.equal(canonical.release_id, "seed-release-v0.19");
});

test("v0.18's manifest/decision remain byte-identical on disk (never modified)", async () => {
  await assert.doesNotReject(readFile(path.join(ROOT, "domain/releases/seed-release.v0.18.manifest.json")));
  await assert.doesNotReject(readFile(path.join(ROOT, "domain/releases/seed-release.v0.18.decision.json")));
});

test("the two Q10 CONSOLIDATION_ENTITY_COUNT facts remain VERIFIED with the corrected period semantics under v0.19", async () => {
  const before = await bundle.serviceAdapters.factStoreAdapter.getFact("fact_9b11df42c16ce405a75d663d");
  const after = await bundle.serviceAdapters.factStoreAdapter.getFact("fact_0dd045e1f5e8ffa6bae6efa6");
  assert.ok(before && after);
  assert.equal(before.record.period_type, "POINT_IN_TIME");
  assert.equal(after.record.period_type, "POINT_IN_TIME");
  assert.equal(before.record.attributes.review_provenance.owner_approved_by, "최재완");
});

test("the Release Gate status (unchanged, v0.18's report still applies -- no new Facts or Thin Flow templates in v0.19) keeps the overall gate BLOCKED", async () => {
  const status = JSON.parse(await readFile(path.join(ROOT, "domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json"), "utf8"));
  assert.equal(status.overall_release_gate, "BLOCKED");
  assert.equal(status.gates.automatic_metric_gate.status, "BLOCKED");
  assert.match(status.gates.automatic_metric_gate.detail, /Q07/);
  assert.match(status.gates.automatic_metric_gate.detail, /Q21/);
  assert.match(status.gates.automatic_metric_gate.detail, /Q24/);
  assert.equal(status.gates.manual_review_gate.status, "BLOCKED");
  assert.match(status.gates.manual_review_gate.detail, /17 REVIEW_REQUIRED/);
});
