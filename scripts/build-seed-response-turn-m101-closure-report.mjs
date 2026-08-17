import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_ROOT = path.join(ROOT, "work/domain-seed");
const OUT_PATH = path.join(
  ROOT,
  "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m101-closure-report.v0.1.json",
);
const ids = Array.from({ length: 25 }, (_, index) => `question_seed_v07_${String(index + 1).padStart(2, "0")}`);
const expectedChanged = new Set([
  "question_seed_v07_02",
  "question_seed_v07_10",
  "question_seed_v07_13",
  "question_seed_v07_15",
  "question_seed_v07_17",
  "question_seed_v07_20",
  "question_seed_v07_24",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readWire(revision, questionId) {
  const relativePath = `work/domain-seed/seed-harness-v07-wire.r${revision}/${questionId}.response.json`;
  const bytes = await readFile(path.join(ROOT, relativePath));
  const body = JSON.parse(bytes.toString("utf8"));
  return { relativePath, rawSha256: sha256(bytes), answer: body.answer, answerSha256: sha256(body.answer) };
}

function lineMultiset(text) {
  return [...text.split("\n")].sort();
}

function factLineMultiset(text) {
  return text.split("\n").filter((line) => line.startsWith("- [")).sort();
}

const rows = [];
for (const questionId of ids) {
  const [r13, r14, r16] = await Promise.all([
    readWire(13, questionId),
    readWire(14, questionId),
    readWire(16, questionId),
  ]);
  const answerChanged = r14.answer !== r16.answer;
  rows.push({
    question_id: questionId,
    r14_raw_sha256: r14.rawSha256,
    r16_raw_sha256: r16.rawSha256,
    r14_answer_sha256: r14.answerSha256,
    r16_answer_sha256: r16.answerSha256,
    byte_identical_r14_to_r16: r14.rawSha256 === r16.rawSha256,
    answer_changed_r14_to_r16: answerChanged,
    line_multiset_identical_r14_to_r16: JSON.stringify(lineMultiset(r14.answer)) === JSON.stringify(lineMultiset(r16.answer)),
    fact_line_multiset_identical_r14_to_r16: JSON.stringify(factLineMultiset(r14.answer)) === JSON.stringify(factLineMultiset(r16.answer)),
    r13_answer_byte_identical_to_r16: r13.answer === r16.answer,
  });
}

const changedIds = rows.filter((row) => row.answer_changed_r14_to_r16).map((row) => row.question_id);
assert.deepEqual(changedIds, [...expectedChanged], "r14→r16 answer changes must be exactly the reviewed seven-question set");

const byId = new Map(rows.map((row) => [row.question_id, row]));
assert.equal(byId.get("question_seed_v07_02").r13_answer_byte_identical_to_r16, true, "Q02 must return byte-identically to r13 answer output");
assert.equal(byId.get("question_seed_v07_06").answer_changed_r14_to_r16, false, "Q06 must remain unchanged");
assert.equal(byId.get("question_seed_v07_25").answer_changed_r14_to_r16, false, "Q25 must remain unchanged");
for (const questionId of ["question_seed_v07_10", "question_seed_v07_24"]) {
  assert.equal(byId.get(questionId).line_multiset_identical_r14_to_r16, true, `${questionId} may change line order only`);
}
assert.equal(byId.get("question_seed_v07_20").fact_line_multiset_identical_r14_to_r16, true, "Q20 must preserve every rendered Fact while reordering them");

const q17 = await readWire(16, "question_seed_v07_17");
assert.match(q17.answer, /효성중공업의 해지금액\(원\)은 삼성중공업보다 176,404,288,000원 큽니다\./);
assert.doesNotMatch(q17.answer, /해지금액\(원\)는/);
const q20 = await readWire(16, "question_seed_v07_20");
assert.match(q20.answer, /계약금액\(원\)은 2024-03-15 대비 2024-12-05에 100,000,000원 증가했습니다\./);
assert.doesNotMatch(q20.answer, /계약금액\(원\)는/);

const report = {
  schema_version: "0.1.0",
  report_id: "seed-response-turn-m101-closure-report-v0.1",
  scope: "TURN_M10_1_OUTPUT_LAYER_LOCAL_CORRECTION_ONLY",
  release_eligible: false,
  wire_comparison: {
    baseline_revision: 14,
    final_revision: 16,
    intermediate_revision: 15,
    total_questions: rows.length,
    changed_question_ids: changedIds,
    unchanged_question_ids: rows.filter((row) => !row.answer_changed_r14_to_r16).map((row) => row.question_id),
    expected_change_reasons: {
      question_seed_v07_02: "lone investment amount falls through to ordinary Fact rendering; r13 answer restored byte-identically",
      question_seed_v07_10: "stable chronological ordering within the same metric family; line multiset unchanged",
      question_seed_v07_13: "duplicate cross-entity difference conclusion collapsed to one directional sentence",
      question_seed_v07_15: "duplicate cross-entity difference conclusion collapsed to one directional sentence",
      question_seed_v07_17: "duplicate differences collapsed and Korean particle selected from the parenthesized unit label",
      question_seed_v07_20: "stable chronological ordering plus parenthesized-unit particle correction; factual line multiset unchanged",
      question_seed_v07_24: "stable chronological ordering within the same metric family; line multiset unchanged",
    },
    rows,
  },
  mechanical_assertions: {
    exact_expected_changed_set: true,
    q02_r13_answer_byte_identical: true,
    q06_r14_to_r16_unchanged: true,
    q25_r14_to_r16_unchanged: true,
    chronological_reorders_preserve_fact_line_multisets: true,
    parenthesized_unit_particles_are_natural: true,
  },
  calculator_unit_alias_contract: {
    aliases: { "원": "KRW", "%": "PERCENT", "주": "SHARES" },
    comparison_only: true,
    request_inputs_mutated: false,
    validation_proof_mutated: false,
    calculation_result_inputs_mutated: false,
    formula_set_changed: false,
    result_shape_changed: false,
    standalone_contract_version_field_present: false,
    compatibility_evidence: "documented shared-service behavior plus positive, immutability, and cross-dimension negative contract tests",
  },
  prohibited_scope_confirmation: {
    new_research: false,
    new_ontology_or_structured_records: false,
    plan_expansion: false,
    gold_or_metric_changes: false,
    release_approval_or_production_binding: false,
    stage_commit_push: false,
  },
  known_non_blocking_items: [
    "Wire r15 is retained as an intermediate diagnostic capture; r16 is the final Turn M10.1 capture.",
    "The official clean-clone gate remains a pre-release concern while the source tree is uncommitted.",
  ],
};

await mkdir(path.dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${path.relative(ROOT, OUT_PATH)}\nsha256 ${sha256(await readFile(OUT_PATH))}\n`);
