// Contract tests for the Plan `information_limits` CANDIDATE extension
// (schema_version "0.4.0"): domain/adapters/information-limit-
// vocabulary.mjs's plan-store validation branch. This is a DIFFERENT
// feature from sub_requests (schema_version 0.2.0/0.3.0, tested in
// tests/seed-plan-sub-requests.test.mjs) -- a 0.4.0 plan record must
// never carry sub_requests, and a 0.2.0/0.3.0/0.1.0 plan must never
// carry information_limits (enforced symmetrically to the existing
// sub_requests absence rule).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSeedQuestionPlanStore } from "../domain/adapters/seed-question-plan-store.mjs";
import { APPROVED_ONTOLOGY_METRIC_CODES } from "../domain/adapters/information-limit-vocabulary.mjs";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function withTempFiles(files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "seed-plan-information-limits-"));
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

const APPROVED_TARGET = [...APPROVED_ONTOLOGY_METRIC_CODES][0];

function validInformationLimit(overrides = {}) {
  return {
    target_metric_code: APPROVED_TARGET,
    reason_code: "NOT_DIRECTLY_DISCLOSED",
    available_input_fact_ids: ["fact_aaaaaaaaaaaaaaaaaaaaaaaa"],
    calculation_status: "DERIVED_CALCULATION_NOT_AVAILABLE",
    ...overrides,
  };
}

function planLine(overrides = {}) {
  return JSON.stringify({
    schema_version: "0.4.0",
    question_id: "question_test_il_01",
    question_sha256: sha256(Buffer.from("정보한계 테스트 질문")),
    as_of_date: "2025-01-01",
    corp_codes: ["00000001"],
    evidence_ids: [],
    slots: [{ slot_name: "revenue", fact_ids: [], evidence_ids: [] }],
    information_limits: [validInformationLimit()],
    ...overrides,
  });
}

async function loadOnePlan(planRecordText) {
  const planBytes = Buffer.from(`${planRecordText}\n`, "utf8");
  const manifest = { artifact_sha256: sha256(planBytes), record_count: 1, corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x" };
  return withTempFiles({ "plan.jsonl": planBytes, "manifest.json": JSON.stringify(manifest) }, (paths) =>
    createSeedQuestionPlanStore({ planPath: paths["plan.jsonl"], manifestPath: paths["manifest.json"] }));
}

test("Plan store: a 0.4.0 plan with valid information_limits loads and resolves normally, deep-frozen", async () => {
  const store = await loadOnePlan(planLine());
  const plan = store.resolve("question_test_il_01", "정보한계 테스트 질문");
  assert.ok(plan);
  assert.equal(plan.information_limits.length, 1);
  assert.ok(Object.isFrozen(plan.information_limits));
  assert.throws(() => { plan.information_limits.push({}); });
});

test("Plan store: a legacy 0.1.0 plan has no information_limits -- absence is explicit, not an error", async () => {
  const record = {
    schema_version: "0.1.0", question_id: "question_test_il_02", question_sha256: sha256(Buffer.from("q2")),
    as_of_date: "2025-01-01", corp_codes: ["00000001"], evidence_ids: [], slots: [{ slot_name: "revenue", fact_ids: [], evidence_ids: [] }],
  };
  const store = await loadOnePlan(JSON.stringify(record));
  const plan = store.resolve("question_test_il_02", "q2");
  assert.ok(plan);
  assert.equal(Object.hasOwn(plan, "information_limits"), false);
});

test("Plan store: legacy 0.1.0/0.2.0/0.3.0 plan behavior is UNCHANGED -- a 0.1.0 plan carrying information_limits is rejected (schema/content mismatch)", async () => {
  const record = {
    schema_version: "0.1.0", question_id: "question_test_il_03", question_sha256: sha256(Buffer.from("q3")),
    as_of_date: "2025-01-01", corp_codes: ["00000001"], evidence_ids: [], slots: [{ slot_name: "revenue", fact_ids: [], evidence_ids: [] }],
    information_limits: [validInformationLimit()],
  };
  await assert.rejects(loadOnePlan(JSON.stringify(record)), /information_limits requires schema_version 0\.4\.0/);
});

test("Plan store: a 0.4.0 plan carrying sub_requests is rejected (0.4.0 never inherits the sub_requests contract)", async () => {
  const record = JSON.parse(planLine());
  record.sub_requests = [{ sub_request_id: "sr_01", intent: "EXTRACT_FACTS", required_slot_names: [], required_event_types: [], required_output_kinds: [], required_capabilities: [] }];
  await assert.rejects(loadOnePlan(JSON.stringify(record)), /sub_requests requires schema_version 0\.2\.0 or 0\.3\.0/);
});

test("Plan store: a 0.4.0 plan with an unapproved target_metric_code is rejected at construction", async () => {
  await assert.rejects(
    loadOnePlan(planLine({ information_limits: [validInformationLimit({ target_metric_code: "NOT_APPROVED" })] })),
    /not an Owner-approved ontology token/,
  );
});

test("Plan store: a 0.4.0 plan with EMPTY information_limits is rejected at construction", async () => {
  await assert.rejects(loadOnePlan(planLine({ information_limits: [] })), /non-empty array/);
});
