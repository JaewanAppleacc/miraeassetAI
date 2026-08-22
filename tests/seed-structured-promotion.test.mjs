import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSeedEvidenceArtifactStore } from "../domain/adapters/seed-evidence-artifact-store.mjs";
import { createSeedFactArtifactStore } from "../domain/adapters/seed-fact-artifact-store.mjs";
import { promoteSeedStructuredArtifacts } from "../scripts/promote-seed-structured-artifacts.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("promotes the accepted Seed subset without silently claiming a full release", async () => {
  const result = await promoteSeedStructuredArtifacts({ writeOutputs: false });
  assert.deepEqual(result.summary, {
    evidence_count: 160, fact_count: 54, event_count: 24, coverage_slot_count: 69,
    coverage_states: { ALL_REQUIRED_FACT_SLOTS_VERIFIED: 67, FACT_SLOT_VERIFIED_NOT_APPLICABLE: 2 },
    fact_coverage_snapshot_id: result.coverageVerified.fact_coverage_snapshot_id,
    excluded_question_ids: ["question_seed_v07_03", "question_seed_v07_22"],
    secondary_ai_review: "SKIPPED_BY_OWNER_INSTRUCTION", promotion_complete: true, full_release_ready: false,
  });
  assert.ok(result.evidenceVerified.every((record) => record.verification_status === "VERIFIED"));
  assert.ok(result.factsVerified.every((record) => record.verification_status === "VERIFIED"));
  assert.ok(result.eventsVerified.every((record) => record.verification_status === "VERIFIED"));
  assert.ok(result.coverageVerified.slots.every((slot) => slot.verification_status === "VERIFIED"));
  assert.equal(result.manifest.release_status, "DRAFT_UNTIL_FLOW_API_E2E_AND_EXCLUDED_QUESTIONS_RESOLVED");
});

test("records Owner acceptance and skipped secondary review instead of inventing human or Claude review", async () => {
  const result = await promoteSeedStructuredArtifacts({ writeOutputs: false });
  assert.equal(result.decision.owner_disposition, "ACCEPTED");
  assert.equal(result.decision.secondary_ai_review, "SKIPPED_BY_OWNER_INSTRUCTION");
  assert.ok(result.decision.limitations.includes("NO_SECOND_CLAUDE_REVIEW"));
  const promoted = result.evidenceVerified.slice(136);
  assert.equal(promoted.length, 24);
  assert.ok(promoted.every((record) => record.metadata.verification_provenance.secondary_ai_review === "SKIPPED_BY_OWNER_INSTRUCTION"));
});

test("all Fact/Event/Coverage references resolve within the promoted artifact set", async () => {
  const result = await promoteSeedStructuredArtifacts({ writeOutputs: false });
  const evidenceIds = new Set(result.evidenceVerified.map((record) => record.evidence_id));
  const factIds = new Set(result.factsVerified.map((record) => record.fact_id));
  const eventIds = new Set(result.eventsVerified.map((record) => record.event_id));
  for (const fact of result.factsVerified) {
    assert.ok(fact.evidence_ids.every((id) => evidenceIds.has(id)));
    if (fact.event_id) assert.ok(eventIds.has(fact.event_id));
  }
  for (const event of result.eventsVerified) assert.ok(event.evidence_ids.length > 0 && event.evidence_ids.every((id) => evidenceIds.has(id)));
  for (const slot of result.coverageVerified.slots) {
    assert.ok(slot.fact_ids.every((id) => factIds.has(id)));
    assert.ok(slot.evidence_ids.every((id) => evidenceIds.has(id)));
  }
});

test("the promoted artifacts construct the real fail-closed Evidence and Fact Store adapters", async () => {
  const result = await promoteSeedStructuredArtifacts({ writeOutputs: false });
  // Turn N2.2: this test previously never removed its own mkdtemp scratch
  // directory -- try/finally guarantees removal whether the assertions
  // pass or throw.
  const temp = await mkdtemp(path.join(os.tmpdir(), "seed-promoted-"));
  try {
    const evidencePath = path.join(temp, "evidence.jsonl");
    const evidenceManifestPath = path.join(temp, "evidence.manifest.json");
    const factPath = path.join(temp, "facts.jsonl");
    const coveragePath = path.join(temp, "coverage.json");
    await Promise.all([
      writeFile(evidencePath, result.contents.evidenceContent), writeFile(evidenceManifestPath, result.contents.evidenceManifestContent),
      writeFile(factPath, result.contents.factContent), writeFile(coveragePath, result.contents.coverageContent),
    ]);
    const evidenceStore = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath: evidenceManifestPath });
    assert.equal(evidenceStore.recordCount(), 160);
    const factStore = await createSeedFactArtifactStore({
      factArtifactPath: factPath, factArtifactSha256: hash(result.contents.factContent), factRecordCount: 54,
      factCoverageSnapshotPath: coveragePath, factCoverageSnapshotSha256: hash(result.contents.coverageContent),
    });
    assert.equal(factStore.factCount(), 54);
    assert.equal(factStore.slotCount(), 69);
    assert.equal(factStore.authorizedFactCount(), 54);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Q3 and Q22 never leak into promoted structured artifacts", async () => {
  const result = await promoteSeedStructuredArtifacts({ writeOutputs: false });
  const serialized = JSON.stringify({ facts: result.factsVerified, events: result.eventsVerified, coverage: result.coverageVerified });
  assert.doesNotMatch(serialized, /question_seed_v07_(03|22)/);
});
