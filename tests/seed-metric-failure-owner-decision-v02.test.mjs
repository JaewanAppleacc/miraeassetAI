// Integrity guard for the v0.2 metric-failure owner adjudication
// (work/domain-seed/seed-metric-failure-owner-decision.v0.2.jsonl), which
// corrects v0.1's wrong requires_gold_change:true judgment: Gold already
// carries the correct expected values, and the real gap is in the current
// Agent response text. Proves v0.1 stays byte-identical (audit history,
// never modified), v0.2's manifest hashes match disk, every v0.2 record
// carries the corrected judgment fields, the raw Harness result is still
// untouched, and the combined report's counts match exactly what was
// requested (4 raw, 4 reviewed, 4 still-unresolved, 0 adjudicated-as-pass).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const V01_DECISION_PATH = path.join(ROOT, "work/domain-seed/seed-metric-failure-owner-decision.v0.1.jsonl");
const V02_DECISION_PATH = path.join(ROOT, "work/domain-seed/seed-metric-failure-owner-decision.v0.2.jsonl");
const V02_MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-metric-failure-owner-decision.v0.2.manifest.json");
const V02_REPORT_PATH = path.join(ROOT, "work/domain-seed/seed-metric-failure-adjudication-report.v0.2.json");

function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function readRecords(p) { return (await readFile(p, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }

test("v0.1's decision artifact is preserved byte-identical (audit history, never modified)", async () => {
  const records = await readRecords(V01_DECISION_PATH);
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.owner_disposition, "APPROVE");
    assert.equal(record.requires_gold_change, true); // the (now-known-wrong) v0.1 judgment, unmodified
  }
});

test("v0.2 has exactly 4 records for the same 4 question_id/metric_name pairs as v0.1", async () => {
  const [v01, v02] = await Promise.all([readRecords(V01_DECISION_PATH), readRecords(V02_DECISION_PATH)]);
  const key = (r) => `${r.question_id}::${r.metric_name}`;
  assert.deepEqual(new Set(v02.map(key)), new Set(v01.map(key)));
  assert.equal(v02.length, 4);
});

test("every v0.2 record carries the corrected judgment fields", async () => {
  const records = await readRecords(V02_DECISION_PATH);
  for (const record of records) {
    assert.equal(record.original_automatic_status, "FAIL");
    assert.equal(record.owner_disposition, "APPROVE_DATA_SEMANTICS_ONLY");
    assert.ok(typeof record.owner_disposition_note === "string" && record.owner_disposition_note.length > 0);
    assert.match(record.owner_disposition_note, /PASS로 승인한다는 뜻이 아니다/);
    assert.equal(record.reviewer, "최재완");
    assert.match(record.reviewed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.equal(record.requires_new_fact, false);
    assert.equal(record.requires_gold_change, false);
    assert.equal(record.requires_metric_change, false);
    assert.equal(record.data_semantics_confirmed, true);
    assert.equal(record.current_response_complete, false);
    assert.equal(record.metric_failure_valid, true);
    assert.equal(record.resolution_status, "RESPONSE_IMPLEMENTATION_REQUIRED");
    assert.ok(typeof record.required_response_change === "string" && record.required_response_change.length > 0);
  }
});

test("v0.2's manifest declares supersedes -> v0.1 and pins v0.1's real, unmodified content hash", async () => {
  const manifest = JSON.parse(await readFile(V02_MANIFEST_PATH, "utf8"));
  assert.equal(manifest.supersedes.path, "work/domain-seed/seed-metric-failure-owner-decision.v0.1.jsonl");
  const v01Bytes = await readFile(V01_DECISION_PATH);
  assert.equal(manifest.supersedes.sha256, sha256Hex(v01Bytes));
});

test("v0.2's manifest pinned inputs still match the real files on disk (SHA-256)", async () => {
  const manifest = JSON.parse(await readFile(V02_MANIFEST_PATH, "utf8"));
  for (const [key, pin] of Object.entries(manifest.pinned_inputs)) {
    const bytes = await readFile(path.join(ROOT, pin.path));
    assert.equal(sha256Hex(bytes), pin.sha256, `pinned_inputs.${key} (${pin.path}) sha256 mismatch`);
  }
  const decisionBytes = await readFile(V02_DECISION_PATH);
  assert.equal(sha256Hex(decisionBytes), manifest.decision_artifact.sha256);
  assert.equal(manifest.decision_artifact.record_count, 4);
});

test("the raw Harness result is still unmodified: metric_fail is still 4, review_required is still 17", async () => {
  const summary = JSON.parse(await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.summary.json"), "utf8"));
  assert.equal(summary.metric_fail, 4);
  assert.equal(summary.review_required, 17);
});

test("v0.2's combined report reconciles exactly: 4 raw, 4 reviewed, 4 required, 0 adjudicated-as-pass, 0 unadjudicated meaning, 4 unresolved", async () => {
  const report = JSON.parse(await readFile(V02_REPORT_PATH, "utf8"));
  assert.equal(report.raw_metric_fail, 4);
  assert.equal(report.data_semantics_reviewed, 4);
  assert.equal(report.response_implementation_required, 4);
  assert.equal(report.owner_adjudicated_as_pass, 0);
  assert.equal(report.unadjudicated_data_meaning, 0);
  assert.equal(report.unresolved_response_metric_fail, 4);
  assert.equal(report.raw_results_modified, false);
});

test("v0.2's Release Gate expression keeps overall + response_implementation + deployment BLOCKED, only data_semantics_review COMPLETE", async () => {
  const report = JSON.parse(await readFile(V02_REPORT_PATH, "utf8"));
  assert.equal(report.release_gate.data_semantics_review_gate.status, "COMPLETE");
  assert.equal(report.release_gate.data_semantics_review_gate.reviewed, 4);
  assert.equal(report.release_gate.automatic_metric_gate_raw.status, "BLOCKED");
  assert.equal(report.release_gate.automatic_metric_gate_raw.metric_fail, 4);
  assert.equal(report.release_gate.response_implementation_gate.status, "BLOCKED");
  assert.equal(report.release_gate.response_implementation_gate.required, 4);
  assert.equal(report.release_gate.manual_review_gate.status, "BLOCKED");
  assert.equal(report.release_gate.manual_review_gate.review_required, 17);
  assert.equal(report.release_gate.deployment_gate.status, "BLOCKED");
  assert.equal(report.release_gate.overall_release_gate, "BLOCKED");
});
