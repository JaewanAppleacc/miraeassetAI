// Integrity guard for the metric-failure owner adjudication artifacts
// (work/domain-seed/seed-metric-failure-owner-decision.v0.1.jsonl + its
// manifest/review.md/report). Proves the manifest's pinned SHA-256 values
// still match the real files on disk (so this stays a reliable pointer
// into the exact v0.19 data freeze point it was authored against), that
// the raw Harness result was never touched or overwritten, and that the
// decision records themselves never claim to create a new Fact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DECISION_PATH = path.join(ROOT, "work/domain-seed/seed-metric-failure-owner-decision.v0.1.jsonl");
const MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-metric-failure-owner-decision.v0.1.manifest.json");
const REPORT_PATH = path.join(ROOT, "work/domain-seed/seed-metric-failure-adjudication-report.v0.1.json");

function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function readManifest() { return JSON.parse(await readFile(MANIFEST_PATH, "utf8")); }
async function readDecisionRecords() {
  const text = (await readFile(DECISION_PATH, "utf8")).trim();
  return text.split("\n").map((line) => JSON.parse(line));
}

test("the decision artifact has exactly 4 records, matching the 4 real Harness metric_fail items", async () => {
  const records = await readDecisionRecords();
  assert.equal(records.length, 4);
  const seen = new Set(records.map((r) => `${r.question_id}::${r.metric_name}`));
  assert.deepEqual(seen, new Set([
    "question_seed_v07_07::explicit_fact_value_slots",
    "question_seed_v07_21::explicit_fact_value_slots",
    "question_seed_v07_21::temporal_requirements",
    "question_seed_v07_24::explicit_fact_value_slots",
  ]));
});

test("every record is APPROVE, claims no new Fact, and carries all required fields", async () => {
  const records = await readDecisionRecords();
  const requiredFields = [
    "question_id", "metric_name", "original_automatic_status", "owner_disposition", "reviewer", "reviewed_at",
    "adjudication_type", "verified_meaning", "permitted_sources", "forbidden_inference",
    "requires_new_fact", "requires_gold_change", "requires_metric_change", "notes",
  ];
  for (const record of records) {
    for (const field of requiredFields) assert.ok(field in record, `missing field ${field} in ${record.question_id}/${record.metric_name}`);
    assert.equal(record.original_automatic_status, "FAIL");
    assert.equal(record.owner_disposition, "APPROVE");
    assert.equal(record.reviewer, "최재완");
    assert.equal(record.requires_new_fact, false);
    assert.match(record.reviewed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  }
});

test("the manifest's pinned inputs still match the real files on disk (SHA-256)", async () => {
  const manifest = await readManifest();
  for (const [key, pin] of Object.entries(manifest.pinned_inputs)) {
    const bytes = await readFile(path.join(ROOT, pin.path));
    assert.equal(sha256Hex(bytes), pin.sha256, `pinned_inputs.${key} (${pin.path}) sha256 mismatch`);
    assert.equal(bytes.length, pin.bytes, `pinned_inputs.${key} (${pin.path}) byte length mismatch`);
  }
  const decisionBytes = await readFile(DECISION_PATH);
  assert.equal(sha256Hex(decisionBytes), manifest.decision_artifact.sha256);
  assert.equal(manifest.decision_artifact.record_count, 4);
});

test("the manifest pins v0.19 release + Gold v0.17 + Harness v05 + the v0.19 Fact/Evidence/Coverage freeze point", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.pinned_inputs.release_manifest.path, "domain/releases/seed-release.v0.19.manifest.json");
  assert.equal(manifest.pinned_inputs.release_decision.path, "domain/releases/seed-release.v0.19.decision.json");
  assert.equal(manifest.pinned_inputs.gold.path, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
  assert.equal(manifest.pinned_inputs.harness_result.path, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl");
  assert.equal(manifest.pinned_inputs.harness_summary.path, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.summary.json");
  assert.equal(manifest.pinned_inputs.fact.path, "work/domain-seed/seed-facts-verified.v0.7.jsonl");
  assert.equal(manifest.pinned_inputs.evidence.path, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");
  assert.equal(manifest.pinned_inputs.coverage.path, "work/domain-seed/seed-fact-coverage-verified.v0.6.json");
});

test("the raw Harness result is unmodified: metric_fail is still 4, review_required is still 17", async () => {
  const summary = JSON.parse(await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.summary.json"), "utf8"));
  assert.equal(summary.metric_fail, 4);
  assert.equal(summary.review_required, 17);
});

test("the combined report never claims the raw result changed, and the counts reconcile: 4 raw, 4 adjudicated, 0 unadjudicated", async () => {
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  assert.equal(report.raw_metric_fail, 4);
  assert.equal(report.owner_adjudicated, 4);
  assert.equal(report.unadjudicated_metric_fail, 0);
  assert.equal(report.raw_results_modified, false);
  assert.equal(report.adjudicated_items.length, 4);
  for (const item of report.adjudicated_items) assert.equal(item.original_automatic_status, "FAIL");
});

test("the combined report keeps the overall Release Gate BLOCKED even though metric adjudication is complete", async () => {
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  assert.equal(report.release_gate.metric_adjudication_gate.status, "COMPLETE");
  assert.equal(report.release_gate.metric_adjudication_gate.adjudicated, 4);
  assert.equal(report.release_gate.metric_adjudication_gate.unadjudicated, 0);
  assert.equal(report.release_gate.automatic_metric_gate_raw.status, "BLOCKED");
  assert.equal(report.release_gate.automatic_metric_gate_raw.metric_fail, 4);
  assert.equal(report.release_gate.manual_review_gate.status, "BLOCKED");
  assert.equal(report.release_gate.manual_review_gate.review_required, 17);
  assert.equal(report.release_gate.deployment_gate.status, "BLOCKED");
  assert.equal(report.release_gate.overall_release_gate, "BLOCKED");
});
