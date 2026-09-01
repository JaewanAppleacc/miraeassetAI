// Reads the ALREADY-GENERATED work/ outputs of this Turn's real diagnostic
// run (scripts/p10.1.1-hierarchical-diagnostic.mjs +
// scripts/p10.1.1-determinism-and-latency-check.mjs) and P10.1's own
// committed strategy-metrics.v0.1.json -- no Gold question/answer content
// is ever read by this test, only aggregate counts and IDs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { RETENTION_STATUS } from "../domain/agent-comparison/chunking-comparison/hierarchical-retention-rule.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.1.1-hierarchical-diagnostic");
const P101_OUT_DIR = path.join(ROOT, "work", "p10.1-chunking-dev-tune");

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(OUT_DIR, relPath), "utf8"));
}

test("evaluation corpus reproduction: this Turn's reused corpus has the same 372-document count as P10.1's committed manifest", { skip: !existsSync(path.join(P101_OUT_DIR, "evaluation-corpus-manifest.v0.1.json")) }, () => {
  const p101Manifest = JSON.parse(readFileSync(path.join(P101_OUT_DIR, "evaluation-corpus-manifest.v0.1.json"), "utf8"));
  const inputPin = readJson("input-pin-manifest.v0.1.json");
  assert.equal(inputPin.reused_evaluation_corpus_document_count, p101Manifest.total_unique_documents);
  assert.equal(p101Manifest.total_unique_documents, 372);
});

test("input pin manifest matches this Turn's pinned SHAs exactly", { skip: !existsSync(path.join(OUT_DIR, "input-pin-manifest.v0.1.json")) }, () => {
  const pin = readJson("input-pin-manifest.v0.1.json");
  assert.equal(pin.dev_tune_gold_sha256_pinned, "7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b");
  assert.equal(pin.owner_decision_sha256_pinned, "00dc07913a3674102fbb341b5bf61c10ad3ea3d6e0bf52206f366157f88a6c8d");
  assert.equal(pin.row_count, 101);
});

test("retention decision status is one of the 4 pinned enum values, never an ad hoc string", { skip: !existsSync(path.join(OUT_DIR, "hierarchical-diagnostic-report.v0.1.json")) }, () => {
  const report = readJson("hierarchical-diagnostic-report.v0.1.json");
  assert.ok(Object.values(RETENTION_STATUS).includes(report.retention_decision.status), `unexpected status: ${report.retention_decision.status}`);
});

test("all 7 cause fields are present with a boolean triggered + non-empty evidence", { skip: !existsSync(path.join(OUT_DIR, "hierarchical-diagnostic-report.v0.1.json")) }, () => {
  const report = readJson("hierarchical-diagnostic-report.v0.1.json");
  const expectedCauses = ["PARENT_SIZE_1536_DEGRADATION", "BM25_CANDIDATE_STARVATION", "SIBLING_RESULT_CROWDING", "PARENT_EXPANSION_MISSING", "TABLE_ROW_CROWDING", "GOLD_LOCATOR_SCORING_MISMATCH", "NONE_OF_THE_ABOVE"];
  for (const cause of expectedCauses) {
    assert.ok(cause in report.causes, `missing cause field: ${cause}`);
    assert.equal(typeof report.causes[cause].triggered, "boolean");
    assert.ok(report.causes[cause].evidence.length > 0);
  }
});

test("per-configuration-metrics.v0.1.json has locator_provenance_violations=0 for every configuration", { skip: !existsSync(path.join(OUT_DIR, "per-configuration-metrics.v0.1.json")) }, () => {
  const metrics = readJson("per-configuration-metrics.v0.1.json");
  for (const [key, value] of Object.entries(metrics)) {
    if (key === "schema_version" || value.locator_provenance_violations === undefined) continue;
    assert.equal(value.locator_provenance_violations, 0, `${key} has provenance violations`);
  }
});

test("per-item-results.v0.1.jsonl row count matches the sum of each config's item_count", () => {
  const perItemPath = path.join(OUT_DIR, "per-item-results.v0.1.jsonl");
  if (!existsSync(perItemPath)) return; // only meaningful after a real run
  const lines = readFileSync(perItemPath, "utf8").split("\n").filter(Boolean);
  const metrics = readJson("per-configuration-metrics.v0.1.json");
  const expectedTotal = metrics.A_FIXED_BASELINE_TOP100.item_count
    + metrics.C_HIERARCHICAL_1024_TOP30.item_count
    + metrics.C_HIERARCHICAL_1024_TOP100.item_count
    + metrics.D_HIERARCHICAL_1024_PARENT_AWARE_TOP100.item_count;
  assert.equal(lines.length, expectedTotal);
});

test("determinism report shows overall_deterministic=true from the real bounded run", { skip: !existsSync(path.join(OUT_DIR, "determinism-report.v0.1.json")) }, () => {
  const det = readJson("determinism-report.v0.1.json");
  assert.equal(det.overall_deterministic, true);
  assert.equal(det.sample_size, 10);
});
