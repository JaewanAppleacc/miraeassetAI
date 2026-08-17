import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createSeedFactArtifactStore } from "../domain/adapters/seed-fact-artifact-store.mjs";
import { buildSeedFactNormalizationV02 } from "../scripts/build-seed-fact-normalization-v02.mjs";
import { promoteSeedFactNormalizationV02, SEED_FACT_NORMALIZATION_PROMOTION_PATHS } from "../scripts/promote-seed-fact-normalization-v02.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
function decisionText(review, disposition = "APPROVE") {
  return `${review.map((item) => JSON.stringify({ fact_id: item.fact_id, disposition, proposed_normalized_value_krw: item.proposed_normalized_value_krw, reviewer: "independent-worker", decided_at: "2026-08-13T03:30:00.000Z", note: "fixture" })).join("\n")}\n`;
}

test("promotion fails closed when the independent decision artifact is absent", async () => {
  const paths = { ...SEED_FACT_NORMALIZATION_PROMOTION_PATHS, ownerDecision: "work/domain-seed/does-not-exist.owner-decision.jsonl" };
  await assert.rejects(() => promoteSeedFactNormalizationV02({ root: ROOT, paths, writeOutputs: false }), /does-not-exist|ENOENT/);
});

test("promotion rejects incomplete, rejected, or value-unbound decisions", async () => {
  const { review } = await buildSeedFactNormalizationV02({ root: ROOT, writeOutputs: false });
  await assert.rejects(() => promoteSeedFactNormalizationV02({ root: ROOT, writeOutputs: false, decisionText: decisionText(review.slice(1)) }), /INCOMPLETE/);
  await assert.rejects(() => promoteSeedFactNormalizationV02({ root: ROOT, writeOutputs: false, decisionText: decisionText(review, "REJECT") }), /REJECTED/);
  const decisions = decisionText(review).trim().split("\n").map(JSON.parse); decisions[0].proposed_normalized_value_krw += 1;
  await assert.rejects(() => promoteSeedFactNormalizationV02({ root: ROOT, writeOutputs: false, decisionText: `${decisions.map(JSON.stringify).join("\n")}\n` }), /does not bind/);
});

test("16 complete approvals produce a new pinned Fact/Coverage set without mutating v0.1", async () => {
  const [factBefore, coverageBefore] = await Promise.all([
    readFile(path.join(ROOT, "work/domain-seed/seed-facts-verified.v0.1.jsonl")),
    readFile(path.join(ROOT, "work/domain-seed/seed-fact-coverage-verified.v0.1.json")),
  ]);
  const { review } = await buildSeedFactNormalizationV02({ root: ROOT, writeOutputs: false });
  const result = await promoteSeedFactNormalizationV02({ root: ROOT, writeOutputs: false, decisionText: decisionText(review) });
  assert.equal(result.factsVerified.length, 54);
  assert.equal(result.factsVerified.filter((fact) => fact.attributes?.normalization_migration?.status === "OWNER_APPROVED").length, 16);
  assert.equal(result.coverageVerified.slots.length, 69);
  assert.notEqual(result.coverageVerified.fact_coverage_snapshot_id, JSON.parse(coverageBefore).fact_coverage_snapshot_id);
  assert.equal(result.manifest.artifact_set_id, "seed-structured-artifacts-v0.2");
  assert.equal(result.manifest.release_status, "DRAFT_UNTIL_V02_PLANS_AND_HARNESS_E2E");
  assert.deepEqual(await readFile(path.join(ROOT, "work/domain-seed/seed-facts-verified.v0.1.jsonl")), factBefore);
  assert.deepEqual(await readFile(path.join(ROOT, "work/domain-seed/seed-fact-coverage-verified.v0.1.json")), coverageBefore);

  const tempRoot = path.join(ROOT, "work/domain-seed");
  const store = await createSeedFactArtifactStore({
    factArtifactPath: path.join(tempRoot, "seed-facts-verified.v0.1.jsonl"),
    factArtifactSha256: result.manifest.artifacts.find((item) => item.role === "VERIFIED_FACT").sha256,
    factRecordCount: 54,
    factCoverageSnapshotPath: path.join(tempRoot, "seed-fact-coverage-verified.v0.1.json"),
    factCoverageSnapshotSha256: result.manifest.artifacts.find((item) => item.role === "FACT_COVERAGE_SNAPSHOT").sha256,
  }).catch(() => null);
  assert.equal(store, null, "v0.2 pins must never validate the old v0.1 bytes");
});
