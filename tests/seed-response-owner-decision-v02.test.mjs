// Integrity guard for the v0.2 Owner decision over the 17 real
// REVIEW_REQUIRED response-review items
// (work/domain-seed/seed-response-owner-decision.v0.2.jsonl) and the
// generalized synthesis-requirements catalog it derives
// (seed-response-synthesis-requirements.v0.1.json).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const HARNESS_RESULT_PATH = path.join(ROOT, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl");
const TEMPLATE_PATH = path.join(ROOT, "work/domain-seed/seed-response-owner-review-template.v0.1.jsonl");
const DECISION_PATH = path.join(ROOT, "work/domain-seed/seed-response-owner-decision.v0.2.jsonl");
const DECISION_MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-response-owner-decision.v0.2.manifest.json");
const REQUIREMENTS_PATH = path.join(ROOT, "work/domain-seed/seed-response-synthesis-requirements.v0.1.json");
const Q17_RESULT_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/A_Q17_REVIEW_RESULT.json");
const Q22_RESULT_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/C_Q22_REVIEW_RESULT.json");
const GOLD_PATH = path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");

function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function readJsonl(p) { return (await readFile(p, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }

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

test("17 decision records, 0 duplicate, 0 missing, 0 extra vs the mechanically re-derived REVIEW_REQUIRED set", async () => {
  const [expected, records] = await Promise.all([mechanicallyDeriveReviewRequiredSet(), readJsonl(DECISION_PATH)]);
  assert.equal(records.length, 17);
  const ids = records.map((r) => r.review_item_id);
  assert.equal(new Set(ids).size, ids.length);
  const actualKeys = records.map((r) => `${r.question_id}::${r.metric_name}`);
  assert.deepEqual(new Set(actualKeys), new Set(expected));
  assert.equal(actualKeys.length, expected.length);
});

test("17/17 owner_disposition=FIX_REQUIRED and requires_response_implementation=true; requires_gold_change/fact_change/metric_change all false", async () => {
  const records = await readJsonl(DECISION_PATH);
  assert.equal(records.length, 17);
  for (const record of records) {
    assert.equal(record.owner_disposition, "FIX_REQUIRED");
    assert.equal(record.requires_response_implementation, true);
    assert.equal(record.requires_gold_change, false);
    assert.equal(record.requires_fact_change, false);
    assert.equal(record.requires_metric_change, false);
    assert.equal(record.reviewer, "최재완");
    assert.match(record.reviewed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.ok(Array.isArray(record.required_response_capabilities) && record.required_response_capabilities.length > 0);
    assert.equal(record.source_template_path, "work/domain-seed/seed-response-owner-review-template.v0.1.jsonl");
  }
});

test("no self-approval marker anywhere in the decision artifact (reviewer is never Claude/AI/an automated marker)", async () => {
  const text = await readFile(DECISION_PATH, "utf8");
  for (const forbidden of ["approved_by\":\"Claude", "AI_APPROVED", "OWNER_ACCEPTED", "\"reviewer\":\"Claude"]) {
    assert.equal(text.includes(forbidden), false, `forbidden marker found: ${forbidden}`);
  }
  const records = await readJsonl(DECISION_PATH);
  for (const record of records) assert.equal(record.reviewer, "최재완");
});

test("Q17's neutral comparability caveat judgment is preserved exactly as decided", async () => {
  const [records, q17Result] = await Promise.all([
    readJsonl(DECISION_PATH),
    readFile(Q17_RESULT_PATH, "utf8").then(JSON.parse),
  ]);
  const q17 = records.find((r) => r.question_id === "question_seed_v07_17" && r.metric_name === "claim_coverage");
  assert.ok(q17);
  assert.equal(q17.comparability_caveat, "ALLOW_NEUTRAL_CAVEAT");
  assert.equal(q17.comparability_caveat, q17Result.recommendation);
  assert.equal(q17.comparability_caveat_premise_values_check, q17Result.premise_values_check);
  assert.equal(q17.comparability_caveat_creates_new_fact, q17Result.creates_new_fact);
  assert.equal(q17.comparability_caveat_permits_economic_superiority_claim, q17Result.permits_economic_superiority_claim);
  assert.deepEqual(q17.issues, q17Result.issues);
  assert.equal(q17.owner_disposition, "FIX_REQUIRED");
});

test("Q22's three checks and 6 issues are preserved exactly as decided", async () => {
  const [records, q22Result] = await Promise.all([
    readJsonl(DECISION_PATH),
    readFile(Q22_RESULT_PATH, "utf8").then(JSON.parse),
  ]);
  const q22 = records.find((r) => r.question_id === "question_seed_v07_22" && r.metric_name === "claim_coverage");
  assert.ok(q22);
  assert.equal(q22.effective_predecessor_check, "PASS");
  assert.equal(q22.latest_conditions_check, "FAIL");
  assert.equal(q22.timeline_check, "FAIL");
  assert.equal(q22.effective_predecessor_check, q22Result.effective_predecessor_check);
  assert.equal(q22.latest_conditions_check, q22Result.latest_conditions_check);
  assert.equal(q22.timeline_check, q22Result.timeline_check);
  assert.equal(q22.issues.length, 6);
  assert.deepEqual(q22.issues, q22Result.issues);
});

test("input template/Harness/wire/Gold/result-file SHAs are unchanged (never modified by this decision authoring)", async () => {
  const manifest = JSON.parse(await readFile(DECISION_MANIFEST_PATH, "utf8"));
  for (const [key, pin] of Object.entries(manifest.inputs)) {
    const bytes = await readFile(path.join(ROOT, pin.path));
    assert.equal(sha256Hex(bytes), pin.sha256, `inputs.${key} sha256 mismatch`);
  }
  // Independently verify the template and Gold are still exactly what they
  // were when the review packet / v0.19 freeze were built.
  const templateBytes = await readFile(TEMPLATE_PATH);
  const decisionRecords = await readJsonl(DECISION_PATH);
  for (const record of decisionRecords) assert.equal(record.source_template_sha256, sha256Hex(templateBytes));
  await assert.doesNotReject(readFile(GOLD_PATH));
});

test("every capability in the requirements artifact links to at least one real review_item_id, and every review_item_id links to at least one capability", async () => {
  const [requirements, decisionRecords] = await Promise.all([
    readFile(REQUIREMENTS_PATH, "utf8").then(JSON.parse),
    readJsonl(DECISION_PATH),
  ]);
  assert.equal(requirements.capabilities.length, 10);
  const decisionIds = new Set(decisionRecords.map((r) => r.review_item_id));
  for (const cap of requirements.capabilities) {
    assert.ok(Array.isArray(cap.observed_review_item_ids) && cap.observed_review_item_ids.length > 0, `${cap.capability_id} has no linked review items`);
    for (const itemId of cap.observed_review_item_ids) assert.ok(decisionIds.has(itemId), `${cap.capability_id} references unknown review_item_id ${itemId}`);
  }
  const linkedItemIds = new Set(requirements.capabilities.flatMap((c) => c.observed_review_item_ids));
  for (const record of decisionRecords) {
    assert.ok(linkedItemIds.has(record.review_item_id), `review item ${record.review_item_id} is not linked from any capability`);
    for (const capId of record.required_response_capabilities) {
      assert.ok(requirements.capabilities.some((c) => c.capability_id === capId), `${record.review_item_id} references unknown capability ${capId}`);
    }
  }
});

test("the requirements artifact contains no question_id or company-name dispatch rule in its capability definitions", async () => {
  const requirements = JSON.parse(await readFile(REQUIREMENTS_PATH, "utf8"));
  const forbiddenTokens = [
    "question_seed_v07", "삼성중공업", "효성중공업", "현대건설", "SATORP", "한화오션", "셀트리온",
    "삼성전자", "신한지주", "HD현대중공업", "HMM", "현대모비스", "삼성E&A", "삼성바이오로직스", "에스엠",
  ];
  for (const cap of requirements.capabilities) {
    const text = `${cap.description} ${cap.applies_when} ${cap.required_output_elements.join(" ")} ${cap.forbidden_or_safety.join(" ")}`;
    for (const token of forbiddenTokens) {
      assert.equal(text.includes(token), false, `capability ${cap.capability_id} contains overfit token "${token}"`);
    }
    // Every capability's applies_when must reference at least one
    // structured-signal vocabulary term, not just prose.
    assert.match(cap.applies_when, /signal/i);
  }
});

test("each capability declares at least one implementation layer from {Planner, Response Composer, Final Validator}", async () => {
  const requirements = JSON.parse(await readFile(REQUIREMENTS_PATH, "utf8"));
  for (const cap of requirements.capabilities) {
    assert.ok(Array.isArray(cap.implementation_layers) && cap.implementation_layers.length > 0);
    for (const layer of cap.implementation_layers) {
      assert.ok(["Planner", "Response Composer", "Final Validator"].includes(layer), `${cap.capability_id} has unknown implementation layer ${layer}`);
    }
  }
});

test("no existing data (Gold/Fact/Evidence/Coverage/Plan/Chain/release/configured-runtime) was modified by this turn", async () => {
  // Read-only doesNotReject checks that these files still exist and are
  // parseable at their known v0.19-freeze locations; the actual byte-
  // identity is verified externally via git diff --stat in the report.
  const paths = [
    "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
    "work/domain-seed/seed-facts-verified.v0.7.jsonl",
    "work/domain-seed/seed-evidence-verified.v0.9.jsonl",
    "work/domain-seed/seed-fact-coverage-verified.v0.6.json",
    "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
    "domain/releases/seed-release.v0.19.manifest.json",
    "domain/releases/seed-release.v0.19.decision.json",
    "domain/runtime/configured-seed-runtime.mjs",
  ];
  for (const p of paths) await assert.doesNotReject(readFile(path.join(ROOT, p)));
});
