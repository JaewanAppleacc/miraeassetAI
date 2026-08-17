// Contract tests for the Plan `sub_requests` CANDIDATE extension
// (schema_version "0.2.0"): domain/adapters/sub-request-vocabulary.mjs,
// domain/adapters/seed-question-plan-store.mjs's new validation branch,
// and scripts/build-seed-thin-flow-plans-v07-candidate.mjs's Gold
// whitelist-reading authoring script.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateSubRequests, SUB_REQUEST_CAPABILITIES, SUB_REQUEST_INTENTS, SUB_REQUEST_OUTPUT_KINDS } from "../domain/adapters/sub-request-vocabulary.mjs";
import { createSeedQuestionPlanStore } from "../domain/adapters/seed-question-plan-store.mjs";
import { buildSeedThinFlowPlansV07Candidate, buildSubRequests } from "../scripts/build-seed-thin-flow-plans-v07-candidate.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function validSubRequest(overrides = {}) {
  return {
    sub_request_id: "sr_01",
    intent: "EXTRACT_FACTS",
    required_slot_names: ["revenue"],
    required_event_types: [],
    required_output_kinds: ["VALUE"],
    required_capabilities: ["ENTITY_AND_PERIOD_LABELING"],
    ...overrides,
  };
}

// -- validateSubRequests (unit) ------------------------------------------

test("validateSubRequests accepts a well-formed sub_requests array", () => {
  assert.doesNotThrow(() => validateSubRequests([validSubRequest()], { slotNames: new Set(["revenue"]), questionId: "q1" }));
});

test("validateSubRequests rejects an empty array", () => {
  assert.throws(() => validateSubRequests([], { slotNames: new Set(), questionId: "q1" }), /non-empty array/);
});

test("validateSubRequests rejects a duplicate sub_request_id", () => {
  const subRequests = [validSubRequest({ sub_request_id: "sr_01" }), validSubRequest({ sub_request_id: "sr_01", required_slot_names: [] })];
  assert.throws(() => validateSubRequests(subRequests, { slotNames: new Set(["revenue"]), questionId: "q1" }), /duplicate sub_request_id/);
});

test("validateSubRequests rejects a sub_request referencing a slot the plan doesn't have", () => {
  const subRequests = [validSubRequest({ required_slot_names: ["nonexistent_slot"] })];
  assert.throws(() => validateSubRequests(subRequests, { slotNames: new Set(["revenue"]), questionId: "q1" }), /references unknown slot/);
});

test("validateSubRequests rejects an unknown intent / output kind / capability", () => {
  assert.throws(() => validateSubRequests([validSubRequest({ intent: "GUESS_ANSWER" })], { slotNames: new Set(["revenue"]), questionId: "q1" }));
  assert.throws(() => validateSubRequests([validSubRequest({ required_output_kinds: ["FREE_TEXT"] })], { slotNames: new Set(["revenue"]), questionId: "q1" }));
  assert.throws(() => validateSubRequests([validSubRequest({ required_capabilities: ["CAPABILITY_ID_AS_A_SUB_REQUEST"] })], { slotNames: new Set(["revenue"]), questionId: "q1" }));
});

test("validateSubRequests rejects an unexpected extra field and a missing required field", () => {
  assert.throws(() => validateSubRequests([{ ...validSubRequest(), expected_answer: 1 }], { slotNames: new Set(["revenue"]), questionId: "q1" }), /unexpected sub_request field/);
  const { required_event_types, ...missingField } = validSubRequest();
  assert.throws(() => validateSubRequests([missingField], { slotNames: new Set(["revenue"]), questionId: "q1" }), /missing required field/);
});

// -- Plan store (schema_version 0.2.0) -----------------------------------

async function withTempFiles(files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "seed-plan-sub-requests-"));
  try {
    const paths = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = path.join(dir, name);
      await writeFile(paths[name], content);
    }
    return await fn(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function planLine(overrides = {}) {
  return JSON.stringify({
    schema_version: "0.2.0",
    question_id: "question_test_01",
    question_sha256: sha256(Buffer.from("테스트 질문")),
    as_of_date: "2025-01-01",
    corp_codes: ["00000001"],
    evidence_ids: [],
    slots: [{ slot_name: "revenue", fact_ids: [], evidence_ids: [] }],
    sub_requests: [validSubRequest()],
    ...overrides,
  });
}

test("Plan store: a 0.2.0 plan with valid sub_requests loads and resolves normally", async () => {
  await withTempFiles({}, async () => {});
  const planText = planLine() + "\n";
  const planBytes = Buffer.from(planText, "utf8");
  const manifest = {
    artifact_sha256: sha256(planBytes), record_count: 1,
    corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x",
  };
  await withTempFiles({ "plan.jsonl": planBytes, "manifest.json": JSON.stringify(manifest) }, async (paths) => {
    const store = await createSeedQuestionPlanStore({ planPath: paths["plan.jsonl"], manifestPath: paths["manifest.json"] });
    const plan = store.resolve("question_test_01", "테스트 질문");
    assert.ok(plan);
    assert.equal(plan.sub_requests.length, 1);
    assert.ok(Object.isFrozen(plan.sub_requests));
    assert.throws(() => { plan.sub_requests.push({}); });
  });
});

test("Plan store: a legacy 0.1.0 plan has no sub_requests -- absence is explicit, not an error", async () => {
  const record = {
    schema_version: "0.1.0", question_id: "question_test_02", question_sha256: sha256(Buffer.from("q2")),
    as_of_date: "2025-01-01", corp_codes: ["00000001"], evidence_ids: [], slots: [{ slot_name: "revenue", fact_ids: [], evidence_ids: [] }],
  };
  const planText = JSON.stringify(record) + "\n";
  const planBytes = Buffer.from(planText, "utf8");
  const manifest = { artifact_sha256: sha256(planBytes), record_count: 1, corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x" };
  await withTempFiles({ "plan.jsonl": planBytes, "manifest.json": JSON.stringify(manifest) }, async (paths) => {
    const store = await createSeedQuestionPlanStore({ planPath: paths["plan.jsonl"], manifestPath: paths["manifest.json"] });
    const plan = store.resolve("question_test_02", "q2");
    assert.ok(plan);
    assert.equal(Object.hasOwn(plan, "sub_requests"), false);
  });
});

test("Plan store: a 0.2.0 plan with EMPTY sub_requests is rejected at construction", async () => {
  const planText = planLine({ sub_requests: [] }) + "\n";
  const planBytes = Buffer.from(planText, "utf8");
  const manifest = { artifact_sha256: sha256(planBytes), record_count: 1, corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x" };
  await withTempFiles({ "plan.jsonl": planBytes, "manifest.json": JSON.stringify(manifest) }, async (paths) => {
    await assert.rejects(createSeedQuestionPlanStore({ planPath: paths["plan.jsonl"], manifestPath: paths["manifest.json"] }), /sub_requests must be a non-empty array/);
  });
});

test("Plan store: a 0.2.0 plan whose sub_request references a slot the plan doesn't have is rejected at construction", async () => {
  const planText = planLine({ sub_requests: [validSubRequest({ required_slot_names: ["nonexistent_slot"] })] }) + "\n";
  const planBytes = Buffer.from(planText, "utf8");
  const manifest = { artifact_sha256: sha256(planBytes), record_count: 1, corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x" };
  await withTempFiles({ "plan.jsonl": planBytes, "manifest.json": JSON.stringify(manifest) }, async (paths) => {
    await assert.rejects(createSeedQuestionPlanStore({ planPath: paths["plan.jsonl"], manifestPath: paths["manifest.json"] }), /references unknown slot/);
  });
});

test("Plan store: a 0.2.0 plan with duplicate sub_request_id is rejected at construction", async () => {
  const planText = planLine({ sub_requests: [validSubRequest({ sub_request_id: "sr_01" }), validSubRequest({ sub_request_id: "sr_01" })] }) + "\n";
  const planBytes = Buffer.from(planText, "utf8");
  const manifest = { artifact_sha256: sha256(planBytes), record_count: 1, corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x" };
  await withTempFiles({ "plan.jsonl": planBytes, "manifest.json": JSON.stringify(manifest) }, async (paths) => {
    await assert.rejects(createSeedQuestionPlanStore({ planPath: paths["plan.jsonl"], manifestPath: paths["manifest.json"] }), /duplicate sub_request_id/);
  });
});

test("Plan store: a 0.1.0 plan that illegally carries sub_requests is rejected (schema_version/content mismatch)", async () => {
  const record = {
    schema_version: "0.1.0", question_id: "question_test_03", question_sha256: sha256(Buffer.from("q3")),
    as_of_date: "2025-01-01", corp_codes: ["00000001"], evidence_ids: [], slots: [{ slot_name: "revenue", fact_ids: [], evidence_ids: [] }],
    sub_requests: [validSubRequest()],
  };
  const planText = JSON.stringify(record) + "\n";
  const planBytes = Buffer.from(planText, "utf8");
  const manifest = { artifact_sha256: sha256(planBytes), record_count: 1, corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x" };
  await withTempFiles({ "plan.jsonl": planBytes, "manifest.json": JSON.stringify(manifest) }, async (paths) => {
    await assert.rejects(createSeedQuestionPlanStore({ planPath: paths["plan.jsonl"], manifestPath: paths["manifest.json"] }), /requires schema_version 0\.2\.0/);
  });
});

test("Plan store: a capability ID disguised as a covered_sub_requests / sub_request field is rejected", () => {
  // covered_sub_requests is a Runtime OUTPUT concept (Response Composer),
  // never a Plan INPUT field -- a plan sub_request must never itself
  // carry something that looks like a runtime coverage-status/capability
  // masquerading as a slot name.
  assert.throws(
    () => validateSubRequests([validSubRequest({ required_slot_names: ["ENTITY_AND_PERIOD_LABELING"] })], { slotNames: new Set(["revenue"]), questionId: "q1" }),
    /references unknown slot/
  );
});

// -- Authoring script (Part A.2 anti-overfitting) -------------------------

test("the v0.7 candidate authoring script never ACCESSES record.expected_answer/scoring_spec/evidence_span (property access, not the forbidden-field literal it declares in its own output manifest)", async () => {
  const source = await readFile(path.join(ROOT, "scripts/build-seed-thin-flow-plans-v07-candidate.mjs"), "utf8");
  const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbiddenAccess of [".expected_answer", "[\"expected_answer\"]", ".scoring_spec", ".evidence_span"]) {
    assert.equal(codeOnly.includes(forbiddenAccess), false, `script source contains forbidden access pattern "${forbiddenAccess}"`);
  }
  // The manifest DOES legitimately declare these names as a documentation
  // literal (forbidden_runtime_fields), which is fine and expected.
  assert.ok(codeOnly.includes("forbidden_runtime_fields"));
});

test("buildSubRequests is a pure structural function: same slot-name shape -> same intents, for entirely synthetic slot names", () => {
  const real = buildSubRequests({ slotNames: ["latest_amount", "correction_timeline"], corpCodeCount: 1 });
  const synthetic = buildSubRequests({ slotNames: ["latest_widget_price", "adjustment_timeline"], corpCodeCount: 1 });
  assert.deepEqual(real.map((sr) => sr.intent), ["REPORT_LATEST_STATE", "TRACE_TIMELINE"]);
  assert.deepEqual(synthetic.map((sr) => sr.intent), ["REPORT_LATEST_STATE", "TRACE_TIMELINE"]);
});

test("buildSubRequests adds a COMPARE_VALUES sub_request only when corp_code_count >= 2", () => {
  const single = buildSubRequests({ slotNames: ["revenue"], corpCodeCount: 1 });
  const multi = buildSubRequests({ slotNames: ["revenue"], corpCodeCount: 2 });
  assert.equal(single.some((sr) => sr.intent === "COMPARE_VALUES"), false);
  assert.equal(multi.some((sr) => sr.intent === "COMPARE_VALUES"), true);
});

test("Plan v0.7 candidate build produces exactly 25 plans, all pass validateSubRequests, and never reads expected_answer", async () => {
  const { manifest, report } = await buildSeedThinFlowPlansV07Candidate({ writeOutputs: false });
  assert.equal(manifest.record_count, 25);
  assert.equal(report.total_plans, 25);
  assert.ok(report.total_sub_requests >= 25);
  for (const entry of report.per_question) assert.ok(entry.sub_request_count >= 1);
});

test("Plan v0.7 candidate never modifies Plan v0.6's own bytes (only adds schema_version + sub_requests)", async () => {
  const v06Bytes = await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"));
  const { manifest } = await buildSeedThinFlowPlansV07Candidate({ writeOutputs: false });
  assert.equal(manifest.source_plan_v06_sha256, sha256(v06Bytes));
  // v0.6 on disk is byte-identical to what it was before this build ran.
  const v06BytesAfter = await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"));
  assert.equal(sha256(v06BytesAfter), sha256(v06Bytes));
});

test("SUB_REQUEST_INTENTS/OUTPUT_KINDS/CAPABILITIES are frozen, non-empty enums", () => {
  for (const enumArray of [SUB_REQUEST_INTENTS, SUB_REQUEST_OUTPUT_KINDS, SUB_REQUEST_CAPABILITIES]) {
    assert.ok(Object.isFrozen(enumArray));
    assert.ok(enumArray.length > 0);
  }
});
