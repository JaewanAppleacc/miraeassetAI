// Integrity guard for the Owner response-review PENDING packet
// (work/domain-seed/seed-response-owner-review-template.v0.1.jsonl).
// Proves the review-item set is EXACTLY the real, mechanically re-derived
// Harness v05 REVIEW_REQUIRED set (never a hardcoded 17), has zero
// duplicate review_item_id, zero missing/extra items vs the raw result,
// every record is left fully PENDING (no auto-approval), the manifest's
// pinned SHA-256 values match disk, and the raw Harness/Gold/Evidence/
// Fact/Coverage/release files were never modified.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const HARNESS_RESULT_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl");
const TEMPLATE_PATH = path.join(ROOT, "work/domain-seed/seed-response-owner-review-template.v0.1.jsonl");
const MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-response-owner-review-template.v0.1.manifest.json");
const CHECKLIST_PATH = path.join(ROOT, "work/domain-seed/seed-response-owner-review-template.v0.1.checklist.md");
const PAGES_PATH = path.join(ROOT, "work/domain-seed/seed-response-owner-review-pages.v0.1.md");

function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function readJsonl(p) { return (await readFile(p, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }

// The SAME mechanical derivation the builder script uses: every top-level
// metric_results entry whose own status is exactly "REVIEW_REQUIRED".
// Recomputed independently here (not imported from the builder) so this
// test would catch a regression in either file.
async function mechanicallyDeriveReviewRequiredSet() {
  const harnessRecords = await readJsonl(HARNESS_RESULT_PATH);
  const items = [];
  for (const record of harnessRecords) {
    for (const [metricName, metric] of Object.entries(record.metric_results ?? {})) {
      if (metric && metric.status === "REVIEW_REQUIRED") items.push(`${record.question_id}::${metricName}`);
    }
  }
  return items;
}

test("the template's review-item set EXACTLY matches the real, mechanically re-derived Harness REVIEW_REQUIRED set (no hardcoded count)", async () => {
  const [expected, records] = await Promise.all([mechanicallyDeriveReviewRequiredSet(), readJsonl(TEMPLATE_PATH)]);
  const actual = records.map((r) => `${r.question_id}::${r.metric_name}`);
  assert.deepEqual(new Set(actual), new Set(expected));
  assert.equal(actual.length, expected.length, "0 missing, 0 extra vs the raw REVIEW_REQUIRED set");
});

test("13 claim_coverage + 4 explicit_fact_value_slots = 17, matching the currently-expected breakdown", async () => {
  const records = await readJsonl(TEMPLATE_PATH);
  assert.equal(records.filter((r) => r.metric_name === "claim_coverage").length, 13);
  assert.equal(records.filter((r) => r.metric_name === "explicit_fact_value_slots").length, 4);
  assert.equal(records.length, 17);
});

test("zero duplicate review_item_id", async () => {
  const records = await readJsonl(TEMPLATE_PATH);
  const ids = records.map((r) => r.review_item_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every record is fully PENDING -- no auto-approval, no partially-filled judgment", async () => {
  const records = await readJsonl(TEMPLATE_PATH);
  for (const record of records) {
    assert.equal(record.owner_disposition, "PENDING");
    assert.equal(record.reviewer, null);
    assert.equal(record.reviewed_at, null);
    assert.equal(record.notes, null);
    assert.deepEqual(record.allowed_dispositions, ["APPROVE_RESPONSE", "FIX_REQUIRED", "REJECT_RESPONSE", "PENDING"]);
  }
});

test("every record carries the full on-screen review context (question/answer/retrieved_context/think_trace/gold/evidence/review_questions)", async () => {
  const records = await readJsonl(TEMPLATE_PATH);
  for (const record of records) {
    assert.equal(typeof record.review_item_id, "string");
    assert.equal(typeof record.question_id, "string");
    assert.equal(typeof record.metric_name, "string");
    assert.equal(typeof record.question, "string");
    assert.equal(typeof record.agent_answer, "string");
    assert.ok(Array.isArray(record.retrieved_context));
    assert.ok("think_trace_calculation" in record);
    assert.ok("think_trace_validation" in record);
    assert.ok("gold_expected_answer_value" in record);
    assert.ok("metric_detail" in record);
    assert.ok(Array.isArray(record.related_evidence));
    for (const evidence of record.related_evidence) {
      for (const field of ["evidence_id", "document_id", "source_locator", "quoted_text"]) assert.ok(field in evidence);
    }
    assert.ok(Array.isArray(record.review_questions) && record.review_questions.length > 0);
  }
});

test("explicit_fact_value_slots records list the exact field-level REVIEW_REQUIRED names and an agent-vs-gold comparison; claim_coverage records do not", async () => {
  const records = await readJsonl(TEMPLATE_PATH);
  for (const record of records) {
    if (record.metric_name === "explicit_fact_value_slots") {
      assert.ok(Array.isArray(record.metric_detail_review_required_fields) && record.metric_detail_review_required_fields.length > 0);
      assert.ok(Array.isArray(record.field_comparison) && record.field_comparison.length === record.metric_detail_review_required_fields.length);
      for (const c of record.field_comparison) {
        assert.ok("field" in c && "agent_value" in c && "gold_expected_value" in c);
      }
    } else {
      assert.equal(record.metric_detail_review_required_fields, undefined);
      assert.equal(record.field_comparison, undefined);
    }
  }
});

test("the manifest's pinned inputs and outputs still match the real files on disk (SHA-256)", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const { wire_responses: wireResponses, ...otherInputs } = manifest.inputs;
  for (const [key, pin] of Object.entries(otherInputs)) {
    const bytes = await readFile(path.join(ROOT, pin.path));
    assert.equal(sha256Hex(bytes), pin.sha256, `inputs.${key} (${pin.path}) sha256 mismatch`);
  }
  for (const [questionId, pin] of Object.entries(wireResponses)) {
    const bytes = await readFile(path.join(ROOT, pin.path));
    assert.equal(sha256Hex(bytes), pin.sha256, `inputs.wire_responses.${questionId} (${pin.path}) sha256 mismatch`);
  }
  const decisionBytes = await readFile(TEMPLATE_PATH);
  assert.equal(sha256Hex(decisionBytes), manifest.outputs.decision.sha256);
  assert.equal(manifest.outputs.decision.record_count, 17);
  const checklistBytes = await readFile(CHECKLIST_PATH);
  assert.equal(sha256Hex(checklistBytes), manifest.outputs.checklist.sha256);
  const pagesBytes = await readFile(PAGES_PATH);
  assert.equal(sha256Hex(pagesBytes), manifest.outputs.pages.sha256);
});

test("the manifest's review_required_set.total is not a hardcoded literal -- it equals the actual record count and the actual mechanical re-derivation", async () => {
  const [manifest, expected] = await Promise.all([
    readFile(MANIFEST_PATH, "utf8").then(JSON.parse),
    mechanicallyDeriveReviewRequiredSet(),
  ]);
  assert.equal(manifest.review_required_set.total, expected.length);
  assert.equal(manifest.review_required_set.items.length, expected.length);
});

test("the raw Harness result and its wire responses are unmodified: metric_fail is still 4, review_required is still 17", async () => {
  const summary = JSON.parse(await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.summary.json"), "utf8"));
  assert.equal(summary.metric_fail, 4);
  assert.equal(summary.review_required, 17);
});
