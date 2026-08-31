// Turn P9: Gold-blind calibration dataset tests. The bundle-reading tests
// here access ONLY VERIFIED Evidence/Fact from the already-approved
// v0.20-r3 bundle (the SAME read-only, materialize-then-cleanup harness
// importReferenceRelease already uses) -- no PostgreSQL, no Gold/HOLDOUT
// file, no SEED_GOLD/OWNER_DECISION role is ever read by this file.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  collectVerifiedCalibrationCandidates, selectCalibrationDataset, toManifestItems,
  computeCalibrationDatasetSha256, buildCalibrationDatasetManifest, sha256Hex,
} from "../domain/agent-comparison/embedding-calibration/dataset.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE_OPTIONS = Object.freeze({
  root: ROOT,
  bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: "seed-release-v0.20",
});

function syntheticCandidate({ evidenceId, factId, corpCode, text, docId }) {
  return {
    evidenceId, factId, sourceDocumentId: docId ?? `doc_${corpCode}`, corpCode,
    quotedText: text, inputTextSha256: sha256Hex(text),
  };
}

// -------------------------------------------------------------------------
// Real v0.20-r3 bundle: VERIFIED-only, Gold-blind, materialize+cleanup.
// -------------------------------------------------------------------------

test("collectVerifiedCalibrationCandidates reads only real VERIFIED Evidence/Fact from the v0.20-r3 bundle, and cleans up its temp materialization", async () => {
  const { tmpdir } = await import("node:os");
  const { readdir } = await import("node:fs/promises");
  const before = await readdir(tmpdir());

  const candidates = await collectVerifiedCalibrationCandidates(BUNDLE_OPTIONS);
  assert.ok(candidates.length > 0, "the real v0.20-r3 bundle must yield at least one candidate");
  for (const c of candidates) {
    assert.match(c.evidenceId, /^evidence_[0-9a-f]{24}$/);
    assert.match(c.factId, /^fact_/);
    assert.match(c.corpCode, /^\d{8}$/);
    assert.ok(c.quotedText.trim().length > 0);
    assert.equal(c.inputTextSha256, sha256Hex(c.quotedText));
  }
  // Membership is unique per evidence_id.
  assert.equal(new Set(candidates.map((c) => c.evidenceId)).size, candidates.length);

  const after = await readdir(tmpdir());
  const leftoverMaterializations = after.filter((name) => name.startsWith("disclosure-reference-v020-") && !before.includes(name));
  assert.deepEqual(leftoverMaterializations, [], "the temp bundle materialization must be fully cleaned up");
});

test("[Gold-blind] the collected candidate objects never carry a split, expected_answer, or Gold/HOLDOUT-shaped field", async () => {
  const candidates = await collectVerifiedCalibrationCandidates(BUNDLE_OPTIONS);
  for (const c of candidates) {
    const keys = Object.keys(c);
    for (const forbidden of ["split", "expected_answer", "expected_facts", "gold", "holdout", "question_id"]) {
      assert.ok(!keys.includes(forbidden), `candidate must never carry a "${forbidden}" field`);
    }
  }
});

// -------------------------------------------------------------------------
// Deterministic sampling / stratification (synthetic candidates -- fast,
// no bundle I/O, exercises edge cases the real bundle may not).
// -------------------------------------------------------------------------

test("selectCalibrationDataset is deterministic: the SAME candidates + salt select the IDENTICAL items in the IDENTICAL order, twice", () => {
  const candidates = Array.from({ length: 40 }, (_, i) => syntheticCandidate({ evidenceId: `evidence_${String(i).padStart(24, "0")}`, factId: `fact_${i}`, corpCode: String(10000000 + (i % 5)), text: `text number ${i}` }));
  const first = selectCalibrationDataset({ candidates, maximumItemCount: 10, sampleSalt: "salt-a" });
  const second = selectCalibrationDataset({ candidates, maximumItemCount: 10, sampleSalt: "salt-a" });
  assert.deepEqual(first.map((i) => i.calibrationItemId), second.map((i) => i.calibrationItemId));
});

test("a DIFFERENT sample_salt selects a different (or differently ordered) subset", () => {
  const candidates = Array.from({ length: 40 }, (_, i) => syntheticCandidate({ evidenceId: `evidence_${String(i).padStart(24, "0")}`, factId: `fact_${i}`, corpCode: String(10000000 + (i % 5)), text: `text number ${i}` }));
  const a = selectCalibrationDataset({ candidates, maximumItemCount: 10, sampleSalt: "salt-a" }).map((i) => i.evidenceId);
  const b = selectCalibrationDataset({ candidates, maximumItemCount: 10, sampleSalt: "salt-b" }).map((i) => i.evidenceId);
  assert.notDeepEqual(a, b);
});

test("duplicate evidence_id candidates are deduplicated to zero duplicates in the selected dataset", () => {
  const candidates = [
    syntheticCandidate({ evidenceId: "evidence_dup", factId: "fact_1", corpCode: "00000001", text: "a" }),
    syntheticCandidate({ evidenceId: "evidence_dup", factId: "fact_1", corpCode: "00000001", text: "a" }),
    syntheticCandidate({ evidenceId: "evidence_other", factId: "fact_2", corpCode: "00000002", text: "b" }),
  ];
  const selected = selectCalibrationDataset({ candidates, maximumItemCount: 10, sampleSalt: "salt" });
  assert.equal(selected.length, 2);
  assert.equal(new Set(selected.map((i) => i.evidenceId)).size, 2);
});

test("bounded stratification: no single corp_code exceeds its bounded share even when the pool is dominated by one company", () => {
  const dominant = Array.from({ length: 90 }, (_, i) => syntheticCandidate({ evidenceId: `evidence_dom_${String(i).padStart(20, "0")}`, factId: `fact_dom_${i}`, corpCode: "00000001", text: `dominant text ${i}` }));
  const minority = Array.from({ length: 10 }, (_, i) => syntheticCandidate({ evidenceId: `evidence_min_${String(i).padStart(20, "0")}`, factId: `fact_min_${i}`, corpCode: `0000000${i % 9}`, text: `minority text ${i}` }));
  const selected = selectCalibrationDataset({ candidates: [...dominant, ...minority], maximumItemCount: 20, sampleSalt: "salt", maxCorpShare: 0.25 });
  const counts = {};
  for (const item of selected) counts[item.corpCode] = (counts[item.corpCode] ?? 0) + 1;
  const maxAllowed = Math.ceil(20 * 0.25);
  for (const [corp, count] of Object.entries(counts)) {
    assert.ok(count <= maxAllowed, `corp ${corp} has ${count} items, exceeding the bounded cap of ${maxAllowed}`);
  }
});

test("maximum_item_count is honored exactly (never exceeded, and takes the full pool when the pool is smaller)", () => {
  const small = Array.from({ length: 5 }, (_, i) => syntheticCandidate({ evidenceId: `evidence_s${i}`, factId: `fact_s${i}`, corpCode: "00000001", text: `t${i}` }));
  const selectedSmall = selectCalibrationDataset({ candidates: small, maximumItemCount: 200, sampleSalt: "salt" });
  assert.equal(selectedSmall.length, 5);

  const large = Array.from({ length: 500 }, (_, i) => syntheticCandidate({ evidenceId: `evidence_l${String(i).padStart(20, "0")}`, factId: `fact_l${i}`, corpCode: String(10000000 + (i % 40)), text: `t${i}` }));
  const selectedLarge = selectCalibrationDataset({ candidates: large, maximumItemCount: 200, sampleSalt: "salt" });
  assert.equal(selectedLarge.length, 200);
});

test("each selected item's expected_self_match_id equals its own calibration_item_id", () => {
  const candidates = [syntheticCandidate({ evidenceId: "evidence_x", factId: "fact_x", corpCode: "00000001", text: "hello" })];
  const [item] = selectCalibrationDataset({ candidates, maximumItemCount: 5, sampleSalt: "salt" });
  assert.equal(item.expectedSelfMatchId, item.calibrationItemId);
});

// -------------------------------------------------------------------------
// Manifest projection: no raw text, order/content-sensitive SHA.
// -------------------------------------------------------------------------

test("toManifestItems never includes the raw quoted text (textContent) anywhere in its output", () => {
  const candidates = [syntheticCandidate({ evidenceId: "evidence_secret", factId: "fact_1", corpCode: "00000001", text: "a very specific secret-looking quote (단위: 백만원)" })];
  const items = selectCalibrationDataset({ candidates, maximumItemCount: 5, sampleSalt: "salt" });
  const manifestItems = toManifestItems(items);
  const serialized = JSON.stringify(manifestItems);
  assert.ok(!serialized.includes("secret-looking quote"), "manifest projection must never contain the raw quoted text");
  assert.ok(!Object.prototype.hasOwnProperty.call(manifestItems[0], "textContent"));
  assert.ok(!Object.prototype.hasOwnProperty.call(manifestItems[0], "quotedText"));
});

test("computeCalibrationDatasetSha256 is deterministic for identical input, and changes when EITHER content OR order changes", () => {
  const items = [
    { calibration_item_id: "a", evidence_id: "e1", input_text_sha256: "x".repeat(64) },
    { calibration_item_id: "b", evidence_id: "e2", input_text_sha256: "y".repeat(64) },
  ];
  const first = computeCalibrationDatasetSha256(items);
  const second = computeCalibrationDatasetSha256(items);
  assert.equal(first, second, "identical input must reproduce the identical SHA");

  const reordered = [items[1], items[0]];
  const reorderedSha = computeCalibrationDatasetSha256(reordered);
  assert.notEqual(first, reorderedSha, "reordering the SAME items must change the SHA (order-sensitive by design)");

  const contentChanged = [items[0], { ...items[1], input_text_sha256: "z".repeat(64) }];
  assert.notEqual(first, computeCalibrationDatasetSha256(contentChanged), "changing one item's content must change the SHA");
});

test("buildCalibrationDatasetManifest never repeats raw quotes and pins ranking_performed/dev_gold_accessed/holdout_accessed to false", () => {
  const candidates = [syntheticCandidate({ evidenceId: "evidence_1", factId: "fact_1", corpCode: "00000001", text: "quoted content here" })];
  const items = selectCalibrationDataset({ candidates, maximumItemCount: 5, sampleSalt: "salt" });
  const manifest = buildCalibrationDatasetManifest({ datasetId: "ds_test", sampleSalt: "salt", datasetItems: items, candidatePoolSize: 1 });
  assert.ok(!JSON.stringify(manifest).includes("quoted content here"));
  assert.equal(manifest.ranking_performed, false);
  assert.equal(manifest.dev_gold_accessed, false);
  assert.equal(manifest.holdout_accessed, false);
  assert.equal(manifest.item_count, 1);
  assert.match(manifest.calibration_dataset_sha256, /^[0-9a-f]{64}$/);
});

test("sha256Hex matches Node's own crypto sha256 for a plain string", () => {
  const text = "예시 텍스트 (단위: 백만원)";
  assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"));
});
