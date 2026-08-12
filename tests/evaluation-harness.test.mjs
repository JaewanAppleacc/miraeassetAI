import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestAnswer } from "../domain/evaluation-harness/api-client.mjs";
import { loadGold } from "../domain/evaluation-harness/gold-loader.mjs";
import { scoreClosed } from "../domain/evaluation-harness/metrics/closed-metric.mjs";
import { scoreOpen } from "../domain/evaluation-harness/metrics/open-metric.mjs";
import { runHarness, validateConfig } from "../domain/evaluation-harness/harness-runner.mjs";
import { appendEventLineDurable, acquireExclusiveLock, releaseExclusiveLock } from "../domain/evaluation-harness/durable-ledger.mjs";
import { validateFinalResponse } from "../domain/runtime/final-response-validator.mjs";
import { toAnswerWireResponse } from "../domain/runtime/answer-wire-response.mjs";
import { appendUsageEvent, appendEventLineAtomic, readLedgerFile } from "../domain/runtime/evaluation-usage-ledger.mjs";
import { requiredFactSlotsSha256 } from "../domain/contracts.mjs";

const SHA = "a".repeat(64);
const COMMIT = "0".repeat(40);

// The INTERNAL FinalResponse shape (retrieved_context array, think_trace
// object) -- used directly by the metrics unit tests below (scoreClosed/
// scoreOpen's own contract is unchanged by the wire update) and as the
// source object wireBody() converts from for every mock GET /answer server
// response, since a real server now replies with the WIRE shape, never
// this one, directly.
function baseResponse(overrides = {}) {
  return {
    question: "q",
    retrieved_context: [],
    think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: { answerability: "OUT_OF_SCOPE" } },
    answer: "no",
    ...overrides,
  };
}

// What a real GET /answer server actually sends: the 5-string-field wire
// body (see domain/interfaces/answer-wire-response.schema.json). Every
// mock HTTP server in this file must respond with this, not the internal
// shape, so these tests exercise harness-runner.mjs's real wire-decoding
// path (validateAnswerWireResponse + fromAnswerWireResponseSafe), not a
// shape it will never actually see in production.
function wireBody(questionId, overrides = {}) {
  return toAnswerWireResponse(questionId, baseResponse(overrides));
}

async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "harness-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function goldRecord(overrides = {}) {
  return {
    schema_version: "0.2.0",
    question_id: "q_test_001",
    evaluation_group_id: "eval_group_test_001",
    split: "DEV_TUNE",
    question: "테스트 질문",
    question_type: "NUMERIC_LOOKUP",
    difficulty: "MEDIUM",
    answer_mode: "CLOSED",
    doc_groups: ["exchange"],
    corp_codes: ["00000001"],
    as_of_date: "2026-03-31",
    expected_answerability: "SUPPORTED",
    gold_document_ids: ["exchange_00000001000001"],
    expected_fact_ids: [],
    expected_event_ids: [],
    required_evidence_slots: [],
    expected_answer: { status: "SUPPORTED", value: 100, unit: null, reason_code: null },
    authored_against: {
      corpus_snapshot_id: "corpus_test",
      manifest_sha256: "0".repeat(64),
      parser_name: "test-parser",
      parser_version: "0.1.0",
      document_ir_schema_version: "1.0",
      semantic_bundle_schema_version: "0.2.0",
      gold_revision: "gold-test",
    },
    expected_execution: {
      applicable_fact_coverage_states: ["NO_STRUCTURED_FACT_COVERAGE"],
      required_fact_slots: [],
      required_fact_slots_sha256: requiredFactSlotsSha256([]),
      required_fact_slots_lock_status: "GOLD_LOCKED",
      route_policy: [
        {
          when: "NO_STRUCTURED_FACT_COVERAGE",
          preferred_route: "RETRIEVAL",
          allowed_routes: ["RETRIEVAL"],
          required_operations: [],
          forbidden_operations: [],
          expected_answerability: "SUPPORTED",
        },
      ],
    },
    scoring_spec: { comparator: "EXACT", tolerance: 0, unit: null, rounding: null },
    tags: ["test"],
    ...overrides,
  };
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// ---------------------------------------------------------------------------
// 1. Closed RANGE comparator
// ---------------------------------------------------------------------------

test("Closed RANGE: PASS when the structured value is inside [min,max]", () => {
  const gold = goldRecord({
    expected_answer: { status: "SUPPORTED", value: [100, 200], unit: null, reason_code: null },
    scoring_spec: { comparator: "RANGE", tolerance: null, unit: null, rounding: null },
  });
  const response = baseResponse({
    think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { result: 150 }, validation: { answerability: "SUPPORTED" } },
  });
  assert.equal(scoreClosed(gold, response).value.status, "PASS");
});

test("Closed RANGE: FAIL when the structured value is outside [min,max]", () => {
  const gold = goldRecord({
    expected_answer: { status: "SUPPORTED", value: [100, 200], unit: null, reason_code: null },
    scoring_spec: { comparator: "RANGE", tolerance: null, unit: null, rounding: null },
  });
  const response = baseResponse({
    think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { result: 250 }, validation: { answerability: "SUPPORTED" } },
  });
  assert.equal(scoreClosed(gold, response).value.status, "FAIL");
});

test("Closed RANGE: boundary values PASS (inclusive)", () => {
  const gold = goldRecord({
    expected_answer: { status: "SUPPORTED", value: [100, 200], unit: null, reason_code: null },
    scoring_spec: { comparator: "RANGE", tolerance: null, unit: null, rounding: null },
  });
  for (const boundary of [100, 200]) {
    const response = baseResponse({
      think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { result: boundary }, validation: { answerability: "SUPPORTED" } },
    });
    assert.equal(scoreClosed(gold, response).value.status, "PASS", `boundary ${boundary}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Numeric grading
// ---------------------------------------------------------------------------

test('does NOT mistake a leading year for the answer ("2025년 매출은 100억원" with no structured value)', () => {
  const gold = goldRecord({
    expected_answer: { status: "SUPPORTED", value: 10000000000, unit: "원", reason_code: null },
    scoring_spec: { comparator: "EXACT", tolerance: 0, unit: "원", rounding: null },
  });
  const response = baseResponse({
    answer: "2025년 매출은 100억원",
    think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: { answerability: "SUPPORTED" } },
  });
  const result = scoreClosed(gold, response);
  // Must be NOT_SCORED, never a false PASS/FAIL derived from "2025".
  assert.equal(result.value.status, "NOT_SCORED");
});

test("prefers think_trace.calculation.result over the answer string when both exist", () => {
  const gold = goldRecord({
    expected_answer: { status: "SUPPORTED", value: 10000000000, unit: "원", reason_code: null },
    scoring_spec: { comparator: "EXACT", tolerance: 0, unit: "원", rounding: null },
  });
  const response = baseResponse({
    answer: "2025년 매출은 100억원",
    think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { result: 10000000000 }, validation: { answerability: "SUPPORTED" } },
  });
  assert.equal(scoreClosed(gold, response).value.status, "PASS");
});

test("falls back to think_trace.calculation.value when .result is absent", () => {
  const gold = goldRecord({ expected_answer: { status: "SUPPORTED", value: 42, unit: null, reason_code: null } });
  const response = baseResponse({
    think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { value: 42 }, validation: { answerability: "SUPPORTED" } },
  });
  assert.equal(scoreClosed(gold, response).value.status, "PASS");
});

test("object-shaped expected_answer.value is scored per field, not by reference equality or String.includes", () => {
  const gold = goldRecord({
    expected_answer: {
      status: "SUPPORTED",
      value: { amount_original: 4150000000, amount_latest: 4250000000, end_date_original: "2024-11-30" },
      unit: null,
      reason_code: null,
    },
  });
  const response = baseResponse({
    think_trace: {
      execution_mode: "STRUCTURED",
      operations: [],
      calculation: { result: { amount_original: 4150000000, amount_latest: 4999999999, end_date_original: "2024-11-30" } },
      validation: { answerability: "SUPPORTED" },
    },
  });
  const result = scoreClosed(gold, response);
  assert.equal(result.value.status, "FAIL"); // amount_latest is wrong
  assert.equal(result.value.fields.amount_original.status, "PASS");
  assert.equal(result.value.fields.amount_latest.status, "FAIL");
  assert.equal(result.value.fields.end_date_original.status, "PASS");
});

test("object-shaped expected_answer.value PASSes overall when every field matches", () => {
  const value = { a: 1, b: "x", c: true, d: null };
  const gold = goldRecord({ expected_answer: { status: "SUPPORTED", value, unit: null, reason_code: null } });
  const response = baseResponse({
    think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { result: { ...value } }, validation: { answerability: "SUPPORTED" } },
  });
  assert.equal(scoreClosed(gold, response).value.status, "PASS");
});

// ---------------------------------------------------------------------------
// 3. Evidence grading
// ---------------------------------------------------------------------------

test("evidence slot PASSes via evidence_id when the wire context carries one", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
    extensions: { evidence_verification: [{ slot_name: "x", evidence_id: "evidence_abc123" }] },
  });
  const response = baseResponse({ retrieved_context: [{ evidence_id: "evidence_abc123" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "PASS");
});

test("evidence slot FAILs when the wire evidence_id does not match Gold's recognized evidence_id, even if document_id/source_locator happen to line up", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
    extensions: { evidence_verification: [{ slot_name: "x", evidence_id: "evidence_abc123" }] },
  });
  const response = baseResponse({
    retrieved_context: [{ evidence_id: "evidence_WRONG", document_id: "d", source_locator: "loc", quoted_text: "54,495" }],
  });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "FAIL");
});

test("evidence slot FAILs when the same document_id+source_locator cites a DIFFERENT number from the same block", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
  });
  const response = baseResponse({ retrieved_context: [{ document_id: "d", source_locator: "loc", quoted_text: "40,350" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "FAIL");
});

test("evidence slot PASSes only when document_id+source_locator+quoted_text all match (no evidence_id on wire)", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
  });
  const response = baseResponse({ retrieved_context: [{ document_id: "d", source_locator: "loc", quoted_text: "54,495" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "PASS");
});

test("evidence slot FAILs on document_id+source_locator match alone (no quoted_text at all) -- the delivered bug", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
  });
  const response = baseResponse({ retrieved_context: [{ document_id: "d", source_locator: "loc" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "FAIL");
});

// ---------------------------------------------------------------------------
// 4. Open metric
// ---------------------------------------------------------------------------

test("open metric never scores free-text claim coverage as PASS/FAIL by substring match; it is REVIEW_REQUIRED", () => {
  const gold = goldRecord({ answer_mode: "OPEN", expected_answer: { status: "SUPPORTED", value: {}, unit: null, reason_code: null } });
  const result = scoreOpen(gold, baseResponse());
  assert.equal(result.claim_coverage.status, "REVIEW_REQUIRED");
});

test("open metric groundedness FAILs when a citation is outside gold_document_ids (not just field-shape existence)", () => {
  const gold = goldRecord({ answer_mode: "OPEN", gold_document_ids: ["doc_a"], expected_answer: { status: "SUPPORTED", value: {}, unit: null, reason_code: null } });
  const response = baseResponse({ retrieved_context: [{ document_id: "doc_other", source_locator: "loc" }] });
  assert.equal(scoreOpen(gold, response).groundedness.status, "FAIL");
});

test("open metric groundedness PASSes when every citation is a real gold_document_id with a recognized evidence_id", () => {
  const gold = goldRecord({
    answer_mode: "OPEN",
    gold_document_ids: ["doc_a"],
    expected_answer: { status: "SUPPORTED", value: {}, unit: null, reason_code: null },
    extensions: { evidence_verification: [{ slot_name: "s", evidence_id: "evidence_real" }] },
  });
  const response = baseResponse({ retrieved_context: [{ document_id: "doc_a", evidence_id: "evidence_real" }] });
  assert.equal(scoreOpen(gold, response).groundedness.status, "PASS");
});

test("open metric required_evidence_coverage reuses the real evidence-identity rule (same-block-different-number FAILs)", () => {
  const gold = goldRecord({
    answer_mode: "OPEN",
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
    expected_answer: { status: "SUPPORTED", value: {}, unit: null, reason_code: null },
  });
  const response = baseResponse({ retrieved_context: [{ document_id: "d", source_locator: "loc", quoted_text: "40,350" }] });
  assert.equal(scoreOpen(gold, response).required_evidence_coverage.status, "FAIL");
});

test("open metric explicit_fact_value_slots checks real expected_answer.value string fields deterministically", () => {
  const gold = goldRecord({
    answer_mode: "OPEN",
    expected_answer: { status: "SUPPORTED", value: { counterparty: "테슬라(Tesla, Inc.)" }, unit: null, reason_code: null },
  });
  const passResponse = baseResponse({ answer: "계약 상대방은 테슬라(Tesla, Inc.)입니다." });
  const failResponse = baseResponse({ answer: "계약 상대방은 알 수 없습니다." });
  assert.equal(scoreOpen(gold, passResponse).explicit_fact_value_slots.status, "PASS");
  assert.equal(scoreOpen(gold, failResponse).explicit_fact_value_slots.status, "FAIL");
});

test("open metric temporal_requirements checks date-shaped fields deterministically, separate from other facts", () => {
  const gold = goldRecord({
    answer_mode: "OPEN",
    expected_answer: { status: "SUPPORTED", value: { period_end: "2033-12-31" }, unit: null, reason_code: null },
  });
  const response = baseResponse({ answer: "계약 종료일은 2033-12-31 입니다." });
  assert.equal(scoreOpen(gold, response).temporal_requirements.status, "PASS");
});

// ---------------------------------------------------------------------------
// 5. Usage Ledger pre-reservation
// ---------------------------------------------------------------------------

function lifecycleState(overrides = {}) {
  return {
    assignment_id: "q_test_001",
    assigned_split: "DEV_CHECK",
    split_lock_status: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status: "SEALED",
    ...overrides,
  };
}

test("reservation is durably persisted to the ledger file BEFORE the HTTP request is sent", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");

    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_CHECK" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState()]));

    let sawLedgerAtRequestTime = null;
    const { server, baseUrl } = await startServer((req, res) => {
      const ledgerAtRequestTime = readLedgerFile(ledgerPath);
      sawLedgerAtRequestTime = ledgerAtRequestTime.length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("q_test_001", { question: "테스트 질문" })));
    });
    t.after(() => server.close());

    await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      lifecycle_path: lifecyclePath,
      ledger_path: ledgerPath,
      split: "DEV_CHECK",
      run_purpose: "CRITICAL_REGRESSION_CHECK",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
      run_id: "run-reservation-order-test",
    });

    assert.equal(sawLedgerAtRequestTime, 1, "the ledger must already contain the reservation event when the HTTP request lands");
    const finalLedger = readLedgerFile(ledgerPath);
    assert.equal(finalLedger.length, 1);
    assert.equal(finalLedger[0].run_outcome, "FAILURE"); // pre-committed reservation value, see README known limitation
  });
});

test("a reservation failure means zero HTTP requests are sent for that item", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");

    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "HOLDOUT" })) + "\n");
    // SEALED HOLDOUT lifecycle -> canUseSplit rejects with HOLDOUT_SEALED before any reservation succeeds.
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState({ assigned_split: "HOLDOUT", holdout_lifecycle_status: "SEALED" })]));

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.end(JSON.stringify(wireBody("q_test_001")));
    });
    t.after(() => server.close());

    await assert.rejects(() =>
      runHarness({
        base_url: baseUrl,
        answer_path: "/answer",
        question_parameter: "q",
        gold_path: goldPath,
        result_path: resultPath,
        summary_path: summaryPath,
        lifecycle_path: lifecyclePath,
        ledger_path: ledgerPath,
        split: "HOLDOUT",
        run_purpose: "FINAL_HOLDOUT_EVALUATION",
        timeout_ms: 2000,
        concurrency: 1,
        configuration_sha256: SHA,
        git_commit: COMMIT,
      })
    );
    assert.equal(requestCount, 0, "HOLDOUT_SEALED must block every HTTP request, not just fail scoring afterward");
  });
});

test("HTTP failure still consumes the exposure budget (reservation stays recorded)", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");

    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_CHECK" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState()]));

    const { server, baseUrl } = await startServer((req, res) => {
      res.statusCode = 500;
      res.end("internal error");
    });
    t.after(() => server.close());

    const { summary } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      lifecycle_path: lifecyclePath,
      ledger_path: ledgerPath,
      split: "DEV_CHECK",
      run_purpose: "CRITICAL_REGRESSION_CHECK",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
      run_id: "run-http-failure-budget-test",
    });

    assert.equal(summary.http_errors, 1);
    const finalLedger = readLedgerFile(ledgerPath);
    assert.equal(finalLedger.length, 1, "the exposure reservation must remain even though the HTTP call failed");
  });
});

test("after a mid-run crash, retrying under the SAME run_id is rejected -- no free re-use", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");

    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_CHECK" })) + "\n");
    const state = lifecycleState();
    await writeFile(lifecyclePath, JSON.stringify([state]));

    const runId = "run-crash-retry-test";
    // Simulate "the harness reserved exposure, then the process died before
    // the HTTP call ever completed" by writing the reservation event
    // directly, bypassing any HTTP call.
    const reserved = appendUsageEvent([], {
      assignmentId: state.assignment_id,
      questionId: "q_test_001",
      runId,
      usageKind: "CHECKPOINT",
      executedSplit: "DEV_CHECK",
      runPurpose: "CRITICAL_REGRESSION_CHECK",
      runOutcome: "FAILURE",
      lifecycleState: state,
      gitCommit: COMMIT,
      configurationSha256: SHA,
      notes: "HARNESS_EXPOSURE_RESERVATION",
    });
    assert.equal(reserved.ok, true);
    appendEventLineAtomic(ledgerPath, reserved.event);

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.end(JSON.stringify(wireBody("q_test_001")));
    });
    t.after(() => server.close());

    await assert.rejects(() =>
      runHarness({
        base_url: baseUrl,
        answer_path: "/answer",
        question_parameter: "q",
        gold_path: goldPath,
        result_path: resultPath,
        summary_path: summaryPath,
        lifecycle_path: lifecyclePath,
        ledger_path: ledgerPath,
        split: "DEV_CHECK",
        run_purpose: "CRITICAL_REGRESSION_CHECK",
        timeout_ms: 2000,
        concurrency: 1,
        configuration_sha256: SHA,
        git_commit: COMMIT,
        run_id: runId, // SAME run_id as the already-recorded reservation
      })
    );
    assert.equal(requestCount, 0, "retrying the same run_id+assignment must not re-send the request for free");
  });
});

// ---------------------------------------------------------------------------
// 6. FinalResponse validation via the real validator
// ---------------------------------------------------------------------------

test("validates normal and EARLY_EXIT FinalResponse via the real domain/runtime validator", () => {
  assert.deepEqual(validateFinalResponse(baseResponse()), []);
});

test("rejects missing fields and invalid execution_mode via the real validator", () => {
  assert.ok(validateFinalResponse({ ...baseResponse(), answer: undefined }).length > 0);
  assert.ok(
    validateFinalResponse({ ...baseResponse(), think_trace: { ...baseResponse().think_trace, execution_mode: "BAD" } }).length > 0
  );
});

test("real validator never throws on circular refs, toJSON tricks, or throwing getters", () => {
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => validateFinalResponse(circular));

  const weirdToJSON = { toJSON: () => undefined };
  assert.doesNotThrow(() => validateFinalResponse(weirdToJSON));

  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "answer", {
    get() {
      throw new Error("boom");
    },
    enumerable: true,
  });
  assert.doesNotThrow(() => validateFinalResponse(throwingGetter));
});

test("detects a question echo mismatch between the request and the FinalResponse.question field", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "실제 질문" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("q_test_001", { question: "다른 질문", think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: { answerability: "SUPPORTED" } } })));
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results[0].question_echo_matches, false);
  });
});

test("a malformed (schema-invalid) JSON body never throws out of runHarness", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ not: "a valid FinalResponse" }));
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results[0].response_contract_valid, false);
    assert.ok(results[0].contract_errors.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 7. HTTP client
// ---------------------------------------------------------------------------

test("HTTP client isolates 500, invalid JSON, timeout, and continues", async (t) => {
  const { server, baseUrl } = await startServer((req, res) => {
    const q = new URL(req.url, "http://x").searchParams.get("q");
    if (q === "slow") return setTimeout(() => res.end("{}"), 500);
    if (q === "bad") return res.end("not json");
    if (q === "500") {
      res.statusCode = 500;
      return res.end("{}");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(wireBody("q_test_001")));
  });
  t.after(() => server.close());
  const config = { base_url: baseUrl, answer_path: "/answer", question_parameter: "q", timeout_ms: 200 };
  assert.equal((await requestAnswer(config, "Q-1", "ok")).httpStatus, 200);
  assert.equal((await requestAnswer(config, "Q-1", "500")).httpStatus, 500);
  assert.ok((await requestAnswer(config, "Q-1", "bad")).parseError);
  const slowConfig = { ...config, timeout_ms: 20 };
  assert.equal((await requestAnswer(slowConfig, "Q-1", "slow")).timedOut, true);
  assert.equal((await requestAnswer(config, "Q-1", "ok")).httpStatus, 200);
});

test("transport errors never leak the request URL or raw response text", async (t) => {
  const { server, baseUrl } = await startServer((req, res) => {
    setTimeout(() => res.end("{}"), 500);
  });
  t.after(() => server.close());
  const config = { base_url: baseUrl, answer_path: "/answer", question_parameter: "q", timeout_ms: 20 };
  const result = await requestAnswer(config, "Q-1", "super-secret-question-text");
  assert.equal(result.transportError.includes("super-secret-question-text"), false);
  assert.equal(result.transportError.includes(baseUrl), false);
});

test("raw response is only ever stored as a SHA-256 hash in results, never verbatim", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("q_test_001", { answer: "MARKER_SHOULD_NOT_APPEAR_RAW" })));
    });
    t.after(() => server.close());

    await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    const written = await readFile(resultPath, "utf8");
    assert.equal(written.includes("MARKER_SHOULD_NOT_APPEAR_RAW"), false);
    const parsed = JSON.parse(written.trim());
    assert.equal(typeof parsed.raw_response_sha256, "string");
    assert.equal(parsed.raw_response_sha256.length, 64);
  });
});

test("concurrency does not reorder results -- output stays in Gold order", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    const records = ["q_a", "q_b", "q_c", "q_d"].map((id) =>
      goldRecord({ question_id: id, evaluation_group_id: `eval_group_${id}`, split: "DEV_TUNE", gold_document_ids: [`exchange_0000000${id}`] })
    );
    await writeFile(goldPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      const params = new URL(req.url, "http://x").searchParams;
      const questionId = params.get("question_id");
      const question = params.get("q");
      // Respond to LATER questions faster than earlier ones, so completion
      // order is the reverse of Gold order if the implementation ever
      // reorders by completion instead of by index. Keyed on question_id
      // (unique per record) rather than the question text (every record
      // here shares the same default "테스트 질문").
      const delay = questionId === "q_a" ? 60 : questionId === "q_b" ? 40 : questionId === "q_c" ? 20 : 0;
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(wireBody(questionId, { question })));
      }, delay);
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 4,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.deepEqual(results.map((r) => r.question_id), ["q_a", "q_b", "q_c", "q_d"]);
  });
});

// ---------------------------------------------------------------------------
// 8. Config validation
// ---------------------------------------------------------------------------

function baseConfig(overrides = {}) {
  return {
    base_url: "http://127.0.0.1:1",
    answer_path: "/answer",
    question_parameter: "q",
    gold_path: "/tmp/a-gold.jsonl",
    result_path: "/tmp/a-result.jsonl",
    summary_path: "/tmp/a-summary.json",
    split: "DEV_TUNE",
    run_purpose: "FLOW_SELECTION",
    timeout_ms: 1000,
    concurrency: 1,
    configuration_sha256: SHA,
    git_commit: COMMIT,
    ...overrides,
  };
}

test("config: rejects unknown split", () => {
  assert.throws(() => validateConfig(baseConfig({ split: "NOT_A_SPLIT" })));
});

test("config: rejects unknown run_purpose", () => {
  assert.throws(() => validateConfig(baseConfig({ run_purpose: "NOT_A_PURPOSE" })));
});

test("config: rejects a run_purpose/split combination that contracts.mjs does not allow", () => {
  assert.throws(() => validateConfig(baseConfig({ split: "HOLDOUT", run_purpose: "FLOW_SELECTION" })));
});

test("config: timeout_ms must be a positive integer", () => {
  assert.throws(() => validateConfig(baseConfig({ timeout_ms: 0 })));
  assert.throws(() => validateConfig(baseConfig({ timeout_ms: -5 })));
  assert.throws(() => validateConfig(baseConfig({ timeout_ms: 1.5 })));
});

test("config: concurrency must be a positive integer", () => {
  assert.throws(() => validateConfig(baseConfig({ concurrency: 0 })));
  assert.throws(() => validateConfig(baseConfig({ concurrency: -1 })));
  assert.throws(() => validateConfig(baseConfig({ concurrency: 2.5 })));
});

test("config: configuration_sha256 must be 64 lowercase hex characters", () => {
  assert.throws(() => validateConfig(baseConfig({ configuration_sha256: "short" })));
  assert.throws(() => validateConfig(baseConfig({ configuration_sha256: "A".repeat(64) })));
});

test("config: git_commit must be a 40-character lowercase hex SHA", () => {
  assert.throws(() => validateConfig(baseConfig({ git_commit: "abc" })));
  assert.throws(() => validateConfig(baseConfig({ git_commit: "F".repeat(40) })));
});

test("config: DEV_CHECK requires lifecycle_path and ledger_path", () => {
  assert.throws(() => validateConfig(baseConfig({ split: "DEV_CHECK", run_purpose: "CRITICAL_REGRESSION_CHECK" })));
  assert.throws(() =>
    validateConfig(baseConfig({ split: "DEV_CHECK", run_purpose: "CRITICAL_REGRESSION_CHECK", lifecycle_path: "/tmp/l.json" }))
  );
  assert.doesNotThrow(() =>
    validateConfig(
      baseConfig({
        split: "DEV_CHECK",
        run_purpose: "CRITICAL_REGRESSION_CHECK",
        lifecycle_path: "/tmp/l.json",
        ledger_path: "/tmp/ledger.jsonl",
      })
    )
  );
});

test("config: HOLDOUT requires lifecycle_path and ledger_path", () => {
  assert.throws(() => validateConfig(baseConfig({ split: "HOLDOUT", run_purpose: "FINAL_HOLDOUT_EVALUATION" })));
});

test("config: rejects when an output path collides with an input Gold/Ledger/lifecycle path", () => {
  assert.throws(() => validateConfig(baseConfig({ result_path: baseConfig().gold_path })));
  assert.throws(() =>
    validateConfig(
      baseConfig({
        split: "DEV_CHECK",
        run_purpose: "CRITICAL_REGRESSION_CHECK",
        lifecycle_path: "/tmp/l.json",
        ledger_path: "/tmp/ledger.jsonl",
        summary_path: "/tmp/ledger.jsonl",
      })
    )
  );
});

// ---------------------------------------------------------------------------
// Ledger/split-lifecycle gate sanity (still exercised end-to-end above, plus
// the two direct unit checks the delivered pack already had).
// ---------------------------------------------------------------------------

test("HOLDOUT SEALED is rejected before any usage is recorded", () => {
  const gate = appendUsageEvent([], {
    assignmentId: "a",
    questionId: "a",
    runId: "r",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "FAILURE",
    configurationSha256: SHA,
    gitCommit: COMMIT,
    lifecycleState: { assignment_id: "a", assigned_split: "HOLDOUT", split_lock_status: "LOCKED_BY_CHAIN", holdout_lifecycle_status: "SEALED" },
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "HOLDOUT_SEALED");
});

// ---------------------------------------------------------------------------
// 9. SANDBOX trust boundary: eligibility comes ONLY from a validated,
// still-provisional Split Lifecycle record; sandbox_allowlist can only
// narrow that set, never grant membership in it.
// ---------------------------------------------------------------------------

function splitLifecycleRecord(overrides = {}) {
  return {
    schema_version: "0.1.0",
    assignment_id: "q_test_001",
    assigned_split: "DEV_TUNE",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    holdout_lifecycle_status: "SEALED",
    updated_at: "2026-08-10T09:00:00Z",
    last_usage_event_id: null,
    ...overrides,
  };
}

test("SANDBOX loads zero records from the real v0.11 Gold file with no lifecycle at all (fail-closed regression)", async () => {
  const goldPath = "work/domain-seed/seed-gold-promotion-candidates.v0.11.jsonl";
  assert.ok(fs.existsSync(goldPath), "expected the real v0.11 Gold file to exist for this regression test");
  const devTune = await loadGold(goldPath, "DEV_TUNE");
  assert.equal(devTune.length, 25, "sanity check: v0.11 has 25 DEV_TUNE records");
  const sandbox = await loadGold(goldPath, "SANDBOX");
  assert.equal(sandbox.length, 0, "SANDBOX must not implicitly load any of the 25 DEV_TUNE records");
});

test("SANDBOX loads a question only when its lifecycle is schema-valid AND split_lock_status is PROVISIONAL_UNTIL_CHAIN_CLOSURE", async () => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const records = [
      goldRecord({ question_id: "q_provisional", evaluation_group_id: "eg_p", split: "DEV_TUNE" }),
      goldRecord({ question_id: "q_locked", evaluation_group_id: "eg_l", split: "DEV_TUNE" }),
    ];
    await writeFile(goldPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const lifecycle = new Map([
      ["q_provisional", splitLifecycleRecord({ assignment_id: "q_provisional", split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE" })],
      ["q_locked", splitLifecycleRecord({ assignment_id: "q_locked", split_lock_status: "LOCKED_BY_CHAIN" })],
    ]);

    const approved = await loadGold(goldPath, "SANDBOX", { lifecycle });
    assert.deepEqual(approved.map((r) => r.question_id), ["q_provisional"]);
  });
});

test("allowlist naming a HOLDOUT (locked) question_id does NOT load it -- allowlist only narrows, never grants", async () => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const record = goldRecord({ question_id: "q_holdout", evaluation_group_id: "eg_h", split: "HOLDOUT" });
    await writeFile(goldPath, JSON.stringify(record) + "\n");
    // This question is REAL and LOCKED to HOLDOUT -- exactly the case
    // canUseSplit itself would reject with ASSIGNED_SPLIT_MISMATCH if it
    // ever reached the ledger. It must never even be loaded.
    const lifecycle = new Map([
      ["q_holdout", splitLifecycleRecord({ assignment_id: "q_holdout", assigned_split: "HOLDOUT", split_lock_status: "LOCKED_BY_CHAIN" })],
    ]);

    const approved = await loadGold(goldPath, "SANDBOX", { lifecycle, sandboxAllowlist: ["q_holdout"] });
    assert.equal(approved.length, 0, "naming a locked HOLDOUT question in the allowlist must not make it SANDBOX-eligible");
  });
});

test("allowlist naming a DEV_CHECK (locked) question_id does NOT load it", async () => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const record = goldRecord({ question_id: "q_devcheck", evaluation_group_id: "eg_dc", split: "DEV_CHECK" });
    await writeFile(goldPath, JSON.stringify(record) + "\n");
    const lifecycle = new Map([
      ["q_devcheck", splitLifecycleRecord({ assignment_id: "q_devcheck", assigned_split: "DEV_CHECK", split_lock_status: "LOCKED_BY_COVERAGE" })],
    ]);

    const approved = await loadGold(goldPath, "SANDBOX", { lifecycle, sandboxAllowlist: ["q_devcheck"] });
    assert.equal(approved.length, 0, "naming a locked DEV_CHECK question in the allowlist must not make it SANDBOX-eligible");
  });
});

test("LOCKED_BY_CHAIN and LOCKED_BY_COVERAGE questions are rejected from SANDBOX even with no allowlist restricting anything", async () => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const records = [
      goldRecord({ question_id: "q_chain", evaluation_group_id: "eg_c", split: "DEV_TUNE" }),
      goldRecord({ question_id: "q_coverage", evaluation_group_id: "eg_cv", split: "DEV_TUNE" }),
    ];
    await writeFile(goldPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const lifecycle = new Map([
      ["q_chain", splitLifecycleRecord({ assignment_id: "q_chain", split_lock_status: "LOCKED_BY_CHAIN" })],
      ["q_coverage", splitLifecycleRecord({ assignment_id: "q_coverage", split_lock_status: "LOCKED_BY_COVERAGE" })],
    ]);

    const approved = await loadGold(goldPath, "SANDBOX", { lifecycle });
    assert.equal(approved.length, 0);
  });
});

test("with a PROVISIONAL lifecycle, sandbox_allowlist narrows to exactly the named subset -- it never adds anything", async () => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const records = [
      goldRecord({ question_id: "q_1", evaluation_group_id: "eg_1", split: "DEV_TUNE" }),
      goldRecord({ question_id: "q_2", evaluation_group_id: "eg_2", split: "DEV_TUNE" }),
    ];
    await writeFile(goldPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const lifecycle = new Map([
      ["q_1", splitLifecycleRecord({ assignment_id: "q_1", split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE" })],
      ["q_2", splitLifecycleRecord({ assignment_id: "q_2", split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE" })],
    ]);

    const approved = await loadGold(goldPath, "SANDBOX", { lifecycle, sandboxAllowlist: ["q_1"] });
    assert.deepEqual(approved.map((r) => r.question_id), ["q_1"], "both q_1 and q_2 are eligible, but the allowlist narrows to q_1 only");
  });
});

test("an invalid lifecycle record with assigned_split=\"SANDBOX\" never grants SANDBOX eligibility, and aborts the load with an explicit error rather than silently returning zero", async () => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const record = goldRecord({ question_id: "q_fake_sandbox", evaluation_group_id: "eg_fs", split: "DEV_TUNE" });
    await writeFile(goldPath, JSON.stringify(record) + "\n");
    // EvaluationSplitLifecycle's assigned_split enum has no "SANDBOX"
    // member -- this record is malformed by construction. A lifecycle
    // record EXISTS for this question (unlike "no lifecycle at all", which
    // stays a silent exclusion) -- so this is a real, actionable problem
    // and must fail loudly, not disappear into an innocuous-looking empty
    // SANDBOX set.
    const lifecycle = new Map([
      ["q_fake_sandbox", splitLifecycleRecord({ assignment_id: "q_fake_sandbox", assigned_split: "SANDBOX", split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE" })],
    ]);

    await assert.rejects(() => loadGold(goldPath, "SANDBOX", { lifecycle }), /Lifecycle validation failed/);
  });
});

test("a question with NO lifecycle record at all is still silently excluded from SANDBOX (fail-closed, not an error)", async () => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const records = [
      goldRecord({ question_id: "q_no_lifecycle", evaluation_group_id: "eg_nl", split: "DEV_TUNE" }),
      goldRecord({ question_id: "q_provisional", evaluation_group_id: "eg_p2", split: "DEV_TUNE" }),
    ];
    await writeFile(goldPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // q_no_lifecycle has no entry in the lifecycle map at all.
    const lifecycle = new Map([
      ["q_provisional", splitLifecycleRecord({ assignment_id: "q_provisional", split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE" })],
    ]);

    const approved = await loadGold(goldPath, "SANDBOX", { lifecycle });
    assert.deepEqual(approved.map((r) => r.question_id), ["q_provisional"], "the absent-lifecycle question is quietly excluded, not an error");
  });
});

test("a full SANDBOX harness run never sends an HTTP request for a question outside the validated provisional set", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    const records = [
      goldRecord({ question_id: "q_eligible", evaluation_group_id: "eg_e", split: "DEV_TUNE" }),
      goldRecord({ question_id: "q_locked", evaluation_group_id: "eg_lk", split: "DEV_TUNE" }),
    ];
    await writeFile(goldPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await writeFile(
      lifecyclePath,
      JSON.stringify([
        splitLifecycleRecord({ assignment_id: "q_eligible", split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE" }),
        splitLifecycleRecord({ assignment_id: "q_locked", split_lock_status: "LOCKED_BY_CHAIN" }),
      ])
    );

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      const questionId = new URL(req.url, "http://x").searchParams.get("question_id");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          wireBody(questionId, { question: "테스트 질문", think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: { answerability: "SUPPORTED" } } })
        )
      );
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      lifecycle_path: lifecyclePath,
      ledger_path: ledgerPath,
      split: "SANDBOX",
      run_purpose: "SANDBOX_EXPLORATION",
      timeout_ms: 2000,
      concurrency: 2,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].question_id, "q_eligible");
    assert.equal(requestCount, 1, "only the provisional, lifecycle-eligible question may generate an HTTP request");
  });
});

test("SANDBOX ledger reservation failure means zero HTTP requests for that question", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    const state = splitLifecycleRecord({ assignment_id: "q_test_001", split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE" });
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([state]));

    // Pre-seed the ledger with a reservation for this exact assignment
    // under the SAME run_id the harness will use -- canUseSplit rejects
    // this as DUPLICATE_RUN_ASSIGNMENT before any reservation can succeed.
    const runId = "run-sandbox-reservation-failure-test";
    const preExisting = appendUsageEvent([], {
      assignmentId: "q_test_001",
      questionId: "q_test_001",
      runId,
      usageKind: "SANDBOX",
      executedSplit: "SANDBOX",
      runPurpose: "SANDBOX_EXPLORATION",
      runOutcome: "FAILURE",
      lifecycleState: state,
      gitCommit: COMMIT,
      configurationSha256: SHA,
      notes: "HARNESS_EXPOSURE_RESERVATION",
    });
    assert.equal(preExisting.ok, true);
    appendEventLineDurable(ledgerPath, preExisting.event);

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.end(JSON.stringify(wireBody("q_test_001")));
    });
    t.after(() => server.close());

    await assert.rejects(() =>
      runHarness({
        base_url: baseUrl,
        answer_path: "/answer",
        question_parameter: "q",
        gold_path: goldPath,
        result_path: resultPath,
        summary_path: summaryPath,
        lifecycle_path: lifecyclePath,
        ledger_path: ledgerPath,
        split: "SANDBOX",
        run_purpose: "SANDBOX_EXPLORATION",
        timeout_ms: 2000,
        concurrency: 1,
        configuration_sha256: SHA,
        git_commit: COMMIT,
        run_id: runId,
      })
    );
    assert.equal(requestCount, 0, "a failed SANDBOX reservation must never be followed by an HTTP request");
  });
});

test("config: SANDBOX requires both lifecycle_path and ledger_path", () => {
  assert.throws(() => validateConfig(baseConfig({ split: "SANDBOX", run_purpose: "SANDBOX_EXPLORATION" })));
  assert.throws(() =>
    validateConfig(baseConfig({ split: "SANDBOX", run_purpose: "SANDBOX_EXPLORATION", lifecycle_path: "/tmp/l.json" }))
  );
  assert.doesNotThrow(() =>
    validateConfig(
      baseConfig({
        split: "SANDBOX",
        run_purpose: "SANDBOX_EXPLORATION",
        lifecycle_path: "/tmp/sandbox-l.json",
        ledger_path: "/tmp/sandbox-ledger.jsonl",
      })
    )
  );
});

test("config: a half-configured lifecycle_path without ledger_path is rejected for ANY split, not just SANDBOX/DEV_CHECK/HOLDOUT", () => {
  assert.throws(() => validateConfig(baseConfig({ split: "DEV_TUNE", run_purpose: "FLOW_SELECTION", lifecycle_path: "/tmp/l.json" })));
});

// ---------------------------------------------------------------------------
// 10. response_usable gate
// ---------------------------------------------------------------------------

test("response_usable is false and no metric is computed when HTTP 500 carries an otherwise schema-valid, question-matching body", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "실패 질문" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          wireBody("q_test_001", { question: "실패 질문", think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { result: 100 }, validation: { answerability: "SUPPORTED" } } })
        )
      );
    });
    t.after(() => server.close());

    const { results, summary } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results[0].response_usable, false);
    assert.deepEqual(results[0].metric_results, {}, "no metric may be computed for a non-2xx response, even a schema-valid one");
    assert.deepEqual(summary.failed_question_ids, ["q_test_001"]);
    assert.equal(summary.response_usable, 0);
    assert.equal(summary.api_success, 0);
    assert.equal(summary.contract_success, 1, "the body itself was still schema-valid -- that is tracked separately from usability");
  });
});

test("response_usable is false and no metric is computed when HTTP 200 carries a schema-valid body answering the WRONG question", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "실제 질문" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          wireBody("q_test_001", { question: "다른 질문", think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { result: 100 }, validation: { answerability: "SUPPORTED" } } })
        )
      );
    });
    t.after(() => server.close());

    const { results, summary } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results[0].response_usable, false);
    assert.deepEqual(results[0].metric_results, {});
    assert.equal(summary.response_usable, 0);
    assert.equal(summary.api_success, 1, "HTTP itself was 200 -- tracked separately");
    assert.equal(summary.contract_success, 1, "the body was schema-valid -- tracked separately");
    assert.equal(summary.question_echo_mismatches, 1);
  });
});

test("response_usable is true and metrics ARE computed for a normal HTTP 200, schema-valid, question-matching response", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "정상 질문" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          wireBody("q_test_001", { question: "정상 질문", think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: { result: 100 }, validation: { answerability: "SUPPORTED" } } })
        )
      );
    });
    t.after(() => server.close());

    const { results, summary } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results[0].response_usable, true);
    assert.equal(results[0].metric_results.value.status, "PASS");
    assert.equal(summary.response_usable, 1);
    assert.equal(summary.failed_question_ids.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 11. Cross-process exclusive lock: applies to EVERY execution that uses a
// ledger, not just DEV_CHECK/HOLDOUT -- needsExclusiveLock === usesLedger.
// ---------------------------------------------------------------------------

test("a lock held by another process blocks the run entirely -- zero HTTP requests -- and the run fails closed on timeout", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");

    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_CHECK" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState()]));

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.end(JSON.stringify(wireBody("q_test_001")));
    });
    t.after(() => server.close());

    // Simulate a second, independent Harness process already holding the
    // lock -- acquireExclusiveLock is the same OS-level primitive a real
    // second process would use, so this is a faithful stand-in.
    const externalLockFd = acquireExclusiveLock(`${ledgerPath}.lock`);

    await assert.rejects(
      () =>
        runHarness({
          base_url: baseUrl,
          answer_path: "/answer",
          question_parameter: "q",
          gold_path: goldPath,
          result_path: resultPath,
          summary_path: summaryPath,
          lifecycle_path: lifecyclePath,
          ledger_path: ledgerPath,
          split: "DEV_CHECK",
          run_purpose: "CRITICAL_REGRESSION_CHECK",
          timeout_ms: 2000,
          concurrency: 1,
          configuration_sha256: SHA,
          git_commit: COMMIT,
          lock_timeout_ms: 150,
        }),
      /LEDGER_LOCK_TIMEOUT/
    );
    assert.equal(requestCount, 0, "a blocked run must never make an HTTP request while the lock is held elsewhere");

    releaseExclusiveLock(externalLockFd, `${ledgerPath}.lock`);

    const { summary } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      lifecycle_path: lifecyclePath,
      ledger_path: ledgerPath,
      split: "DEV_CHECK",
      run_purpose: "CRITICAL_REGRESSION_CHECK",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
      run_id: "run-after-lock-release",
    });
    assert.equal(requestCount, 1, "once the lock is released, the run proceeds normally");
    assert.equal(summary.total, 1);
  });
});

test("the exclusive lock file does not outlive a completed run (released even on success)", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_CHECK" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState()]));

    const { server, baseUrl } = await startServer((req, res) => res.end(JSON.stringify(wireBody("q_test_001"))));
    t.after(() => server.close());

    await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      lifecycle_path: lifecyclePath,
      ledger_path: ledgerPath,
      split: "DEV_CHECK",
      run_purpose: "CRITICAL_REGRESSION_CHECK",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(fs.existsSync(`${ledgerPath}.lock`), false);
  });
});

test("the exclusive lock is released even when the run throws (e.g. HOLDOUT_SEALED preflight failure)", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "HOLDOUT" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState({ assigned_split: "HOLDOUT", holdout_lifecycle_status: "SEALED" })]));

    const { server, baseUrl } = await startServer((req, res) => res.end(JSON.stringify(wireBody("q_test_001"))));
    t.after(() => server.close());

    await assert.rejects(() =>
      runHarness({
        base_url: baseUrl,
        answer_path: "/answer",
        question_parameter: "q",
        gold_path: goldPath,
        result_path: resultPath,
        summary_path: summaryPath,
        lifecycle_path: lifecyclePath,
        ledger_path: ledgerPath,
        split: "HOLDOUT",
        run_purpose: "FINAL_HOLDOUT_EVALUATION",
        timeout_ms: 2000,
        concurrency: 1,
        configuration_sha256: SHA,
        git_commit: COMMIT,
      })
    );

    assert.equal(fs.existsSync(`${ledgerPath}.lock`), false, "the lock must not be left behind even when the run throws");
  });
});

test("an externally held lock blocks a SANDBOX run entirely -- zero HTTP requests -- even though SANDBOX has no run budget", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");

    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([splitLifecycleRecord({ assignment_id: "q_test_001", split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE" })]));

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.end(JSON.stringify(wireBody("q_test_001")));
    });
    t.after(() => server.close());

    const externalLockFd = acquireExclusiveLock(`${ledgerPath}.lock`);
    await assert.rejects(
      () =>
        runHarness({
          base_url: baseUrl,
          answer_path: "/answer",
          question_parameter: "q",
          gold_path: goldPath,
          result_path: resultPath,
          summary_path: summaryPath,
          lifecycle_path: lifecyclePath,
          ledger_path: ledgerPath,
          split: "SANDBOX",
          run_purpose: "SANDBOX_EXPLORATION",
          timeout_ms: 2000,
          concurrency: 1,
          configuration_sha256: SHA,
          git_commit: COMMIT,
          lock_timeout_ms: 150,
        }),
      /LEDGER_LOCK_TIMEOUT/
    );
    assert.equal(requestCount, 0, "a lock-blocked SANDBOX run must still send zero HTTP requests");
    releaseExclusiveLock(externalLockFd, `${ledgerPath}.lock`);
  });
});

test("an externally held lock blocks a DEV_TUNE run that opts into lifecycle_path+ledger_path -- zero HTTP requests", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");

    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");
    await writeFile(
      lifecyclePath,
      JSON.stringify([splitLifecycleRecord({ assignment_id: "q_test_001", assigned_split: "DEV_TUNE", split_lock_status: "LOCKED_BY_CHAIN" })])
    );

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.end(JSON.stringify(wireBody("q_test_001")));
    });
    t.after(() => server.close());

    const externalLockFd = acquireExclusiveLock(`${ledgerPath}.lock`);
    await assert.rejects(
      () =>
        runHarness({
          base_url: baseUrl,
          answer_path: "/answer",
          question_parameter: "q",
          gold_path: goldPath,
          result_path: resultPath,
          summary_path: summaryPath,
          lifecycle_path: lifecyclePath,
          ledger_path: ledgerPath,
          split: "DEV_TUNE",
          run_purpose: "FLOW_SELECTION",
          timeout_ms: 2000,
          concurrency: 1,
          configuration_sha256: SHA,
          git_commit: COMMIT,
          lock_timeout_ms: 150,
        }),
      /LEDGER_LOCK_TIMEOUT/
    );
    assert.equal(requestCount, 0, "a lock-blocked DEV_TUNE run (opted into a ledger) must still send zero HTTP requests");
    releaseExclusiveLock(externalLockFd, `${ledgerPath}.lock`);
  });
});

test("a DEV_TUNE run WITHOUT lifecycle_path/ledger_path is unaffected by an externally held lock on an unrelated ledger path", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const someOtherLedgerPath = join(dir, "unrelated-ledger.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("q_test_001", { question: "테스트 질문" })));
    });
    t.after(() => server.close());

    // Released inside withTmpDir (not via t.after), since t.after callbacks
    // run after withTmpDir's own cleanup has already deleted this tmp dir.
    const externalLockFd = acquireExclusiveLock(`${someOtherLedgerPath}.lock`);

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });
    assert.equal(requestCount, 1, "a run with no ledger involvement at all needs no lock and is unaffected");
    assert.equal(results.length, 1);

    releaseExclusiveLock(externalLockFd, `${someOtherLedgerPath}.lock`);
  });
});

// ---------------------------------------------------------------------------
// 12. Summary success breakdown
// ---------------------------------------------------------------------------

test("summary has no ambiguous 'success' field; api_success/contract_success/metric_pass/metric_fail/not_scored/review_required are all reported and sum consistently", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    const passRecord = goldRecord({
      question_id: "q_pass",
      evaluation_group_id: "eg_pass",
      question: "합격 질문",
      gold_document_ids: ["exchange_pass_0001"],
      expected_answer: { status: "SUPPORTED", value: 100, unit: null, reason_code: null },
    });
    const failRecord = goldRecord({
      question_id: "q_fail",
      evaluation_group_id: "eg_fail",
      question: "실패 질문",
      gold_document_ids: ["exchange_fail_0001"],
      expected_answer: { status: "SUPPORTED", value: 999, unit: null, reason_code: null },
    });
    const openRecord = goldRecord({
      question_id: "q_open",
      evaluation_group_id: "eg_open",
      question: "공개 질문",
      answer_mode: "OPEN",
      gold_document_ids: ["exchange_open_0001"],
      expected_answer: { status: "SUPPORTED", value: {}, unit: null, reason_code: null },
    });
    await writeFile(goldPath, [passRecord, failRecord, openRecord].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      const params = new URL(req.url, "http://x").searchParams;
      const q = params.get("q");
      const questionId = params.get("question_id");
      const calcResult = q === "합격 질문" ? 100 : q === "실패 질문" ? 1 : undefined;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          wireBody(questionId, {
            question: q,
            answer: "설명",
            think_trace: {
              execution_mode: "STRUCTURED",
              operations: [],
              calculation: calcResult !== undefined ? { result: calcResult } : {},
              validation: { answerability: "SUPPORTED" },
            },
          })
        )
      );
    });
    t.after(() => server.close());

    const { results, summary } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal("success" in summary, false, "the old ambiguous 'success' field must be gone");
    assert.equal(summary.api_success, 3);
    assert.equal(summary.contract_success, 3);
    assert.equal(summary.response_usable, 3);

    const independentTotalMetricEntries = results.reduce((sum, r) => sum + Object.keys(r.metric_results ?? {}).length, 0);
    const summedBuckets = summary.metric_pass + summary.metric_fail + summary.not_scored + summary.review_required;
    assert.equal(summedBuckets, independentTotalMetricEntries, "every metric result must land in exactly one bucket");

    assert.ok(summary.metric_pass >= 1, "the passing Closed value should count toward metric_pass");
    assert.ok(summary.metric_fail >= 1, "the failing Closed value should count toward metric_fail");
    assert.ok(summary.review_required >= 1, "the Open claim_coverage should count toward review_required, never pass/fail");
  });
});

// ---------------------------------------------------------------------------
// 13. fsync durability
// ---------------------------------------------------------------------------

test("appendEventLineDurable calls fsyncSync before returning (genuinely durable, not just buffered)", async (t) => {
  await withTmpDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const fsyncSpy = mock.method(fs, "fsyncSync");
    t.after(() => fsyncSpy.mock.restore());

    appendEventLineDurable(ledgerPath, { hello: "world" });

    // 2 calls: the file's own fd, plus the parent directory's fd since this
    // call created a brand-new ledger file (see the "new ledger file"
    // durability test below for the create-vs-append distinction).
    assert.equal(fsyncSpy.mock.calls.length, 2);
    const written = await readFile(ledgerPath, "utf8");
    assert.deepEqual(JSON.parse(written.trim()), { hello: "world" });
  });
});

test("appendEventLineDurable fsyncs only the file (not the directory) when appending to an ALREADY-EXISTING ledger file", async (t) => {
  await withTmpDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    appendEventLineDurable(ledgerPath, { first: true }); // creates the file

    const fsyncSpy = mock.method(fs, "fsyncSync");
    t.after(() => fsyncSpy.mock.restore());
    appendEventLineDurable(ledgerPath, { second: true }); // file already exists

    assert.equal(fsyncSpy.mock.calls.length, 1, "no new directory entry is being created, so only the file fd needs fsync");
    const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ first: true }, { second: true }]);
  });
});

test("appendEventLineDurable writes the full line even if a single writeSync call would only accept part of it", async (t) => {
  await withTmpDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const realWriteSync = fs.writeSync;
    // Simulate a short write: the first call only accepts half the buffer.
    let call = 0;
    const writeSyncSpy = mock.method(fs, "writeSync", (fd, buffer, offset, length) => {
      call++;
      if (call === 1) {
        const shortLength = Math.max(1, Math.floor(length / 2));
        return realWriteSync(fd, buffer, offset, shortLength);
      }
      return realWriteSync(fd, buffer, offset, length);
    });
    t.after(() => writeSyncSpy.mock.restore());

    const bigEvent = { padding: "x".repeat(500) };
    appendEventLineDurable(ledgerPath, bigEvent);

    assert.ok(writeSyncSpy.mock.calls.length >= 2, "a short first write must be followed by at least one more writeSync call");
    const written = await readFile(ledgerPath, "utf8");
    assert.deepEqual(JSON.parse(written.trim()), bigEvent, "the full JSONL line must be on disk despite the short write");
  });
});

test("appendEventLineDurable throws an explicit error instead of looping forever when writeSync returns 0", async (t) => {
  await withTmpDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const writeSyncSpy = mock.method(fs, "writeSync", () => 0);
    t.after(() => writeSyncSpy.mock.restore());

    assert.throws(() => appendEventLineDurable(ledgerPath, { hello: "world" }), /writeSync returned 0/);
  });
});

test("appendEventLineDurable throws an explicit error when writeSync returns a negative number", async (t) => {
  await withTmpDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const writeSyncSpy = mock.method(fs, "writeSync", () => -1);
    t.after(() => writeSyncSpy.mock.restore());

    assert.throws(() => appendEventLineDurable(ledgerPath, { hello: "world" }), /writeSync returned -1/);
  });
});

test("a reservation write that fails with writeSync=0 aborts before any HTTP request is sent", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_CHECK" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState()]));

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.end(JSON.stringify(wireBody("q_test_001")));
    });
    t.after(() => server.close());

    const writeSyncSpy = mock.method(fs, "writeSync", () => 0);
    t.after(() => writeSyncSpy.mock.restore());

    await assert.rejects(
      () =>
        runHarness({
          base_url: baseUrl,
          answer_path: "/answer",
          question_parameter: "q",
          gold_path: goldPath,
          result_path: resultPath,
          summary_path: summaryPath,
          lifecycle_path: lifecyclePath,
          ledger_path: ledgerPath,
          split: "DEV_CHECK",
          run_purpose: "CRITICAL_REGRESSION_CHECK",
          timeout_ms: 2000,
          concurrency: 1,
          configuration_sha256: SHA,
          git_commit: COMMIT,
        }),
      /writeSync returned 0/
    );
    assert.equal(requestCount, 0, "a reservation write failure must abort before any HTTP request, not hang or proceed anyway");
  });
});

test("a DEV_CHECK reservation calls fsyncSync before the HTTP request is sent", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_CHECK" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState()]));

    const fsyncSpy = mock.method(fs, "fsyncSync");
    t.after(() => fsyncSpy.mock.restore());
    let fsyncCallsBeforeRequest = -1;
    const { server, baseUrl } = await startServer((req, res) => {
      fsyncCallsBeforeRequest = fsyncSpy.mock.calls.length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("q_test_001", { question: "테스트 질문" })));
    });
    t.after(() => server.close());

    await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      lifecycle_path: lifecyclePath,
      ledger_path: ledgerPath,
      split: "DEV_CHECK",
      run_purpose: "CRITICAL_REGRESSION_CHECK",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
      run_id: "run-fsync-order-test",
    });

    // 2: the ledger file's own fd, plus the parent directory's fd since
    // this is a brand-new ledger file being created by the reservation.
    assert.equal(fsyncCallsBeforeRequest, 2, "fsyncSync must already have completed by the time the HTTP request lands");
  });
});

// ---------------------------------------------------------------------------
// 14. evidence_id must not contradict wire-provided provenance
// ---------------------------------------------------------------------------

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("evidence slot FAILs when a matching evidence_id is paired with a CONTRADICTING document_id on the wire", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
    extensions: {
      evidence_verification: [
        { slot_name: "x", document_id: "d", evidence_id: "evidence_abc123", canonical_source_locator: "loc", quote_sha256: sha256Hex("54,495") },
      ],
    },
  });
  const response = baseResponse({ retrieved_context: [{ evidence_id: "evidence_abc123", document_id: "OTHER_DOCUMENT" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "FAIL");
});

test("evidence slot FAILs when a matching evidence_id is paired with a CONTRADICTING source_locator on the wire", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
    extensions: {
      evidence_verification: [
        { slot_name: "x", document_id: "d", evidence_id: "evidence_abc123", canonical_source_locator: "loc", quote_sha256: sha256Hex("54,495") },
      ],
    },
  });
  const response = baseResponse({ retrieved_context: [{ evidence_id: "evidence_abc123", source_locator: "OTHER_LOCATOR" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "FAIL");
});

test("evidence slot FAILs when a matching evidence_id is paired with quoted_text whose hash does NOT match Gold's quote_sha256", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
    extensions: {
      evidence_verification: [
        { slot_name: "x", document_id: "d", evidence_id: "evidence_abc123", canonical_source_locator: "loc", quote_sha256: sha256Hex("54,495") },
      ],
    },
  });
  const response = baseResponse({ retrieved_context: [{ evidence_id: "evidence_abc123", quoted_text: "40,350" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "FAIL");
});

test("evidence slot PASSes when a matching evidence_id's wire document_id/source_locator/quoted_text are all consistent with Gold's provenance", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
    extensions: {
      evidence_verification: [
        { slot_name: "x", document_id: "d", evidence_id: "evidence_abc123", canonical_source_locator: "loc", quote_sha256: sha256Hex("54,495") },
      ],
    },
  });
  const response = baseResponse({ retrieved_context: [{ evidence_id: "evidence_abc123", document_id: "d", source_locator: "loc", quoted_text: "54,495" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "PASS");
});

test("evidence slot still PASSes on evidence_id alone when the wire provides no document_id/source_locator/quoted_text to cross-check", () => {
  const gold = goldRecord({
    required_evidence_slots: [{ slot_name: "x", acceptable_sources: [{ document_id: "d", source_locator: "loc", evidence_span: "54,495" }] }],
    extensions: {
      evidence_verification: [
        { slot_name: "x", document_id: "d", evidence_id: "evidence_abc123", canonical_source_locator: "loc", quote_sha256: sha256Hex("54,495") },
      ],
    },
  });
  const response = baseResponse({ retrieved_context: [{ evidence_id: "evidence_abc123" }] });
  assert.equal(scoreClosed(gold, response)["evidence:x"].status, "PASS");
});

// ---------------------------------------------------------------------------
// 15. Wire-boundary decoding: the harness never applies
// domain/runtime/final-response-validator.mjs's INTERNAL validator to a raw
// wire body; a wire-schema-valid body whose retrieved_context/think_trace
// strings are not valid JSON is a diagnosable contract defect
// (response_usable=false), not a thrown exception. question_id echo is
// checked independently of question echo.
// ---------------------------------------------------------------------------

test("response_usable is false when the wire body's question_id does not match the request's, even though the question text and everything else matches", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "테스트 질문" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("WRONG-QUESTION-ID", { question: "테스트 질문" })));
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results[0].question_echo_matches, false);
    assert.equal(results[0].response_usable, false);
  });
});

test("response_usable is false when retrieved_context is not valid JSON, even though the wire shape itself (5 strings) is schema-valid -- never throws out of runHarness", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "테스트 질문" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          question_id: "q_test_001",
          question: "테스트 질문",
          retrieved_context: "not valid json",
          think_trace: "{}",
          answer: "a",
        })
      );
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results[0].response_contract_valid, false);
    assert.equal(results[0].response_usable, false);
    assert.ok(results[0].contract_errors.some((e) => e.includes("JSON decode failed")));
  });
});

test("response_usable is false when retrieved_context/think_trace ARE valid JSON but decode to the wrong internal type (retrieved_context=\"42\", think_trace=\"[]\") -- JSON.parse succeeding is not enough", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "테스트 질문" })) + "\n");

    const { server, baseUrl } = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      // Wire-schema-valid (5 required strings) AND both retrieved_context
      // and think_trace ARE valid JSON -- fromAnswerWireResponseSafe
      // succeeds -- but they decode to a number and an array, neither of
      // which satisfies final-response.schema.json's retrieved_context
      // (must be an array) / think_trace (must be an object) shape. Only
      // gate 3 (validateFinalResponse on the restored value) catches this.
      res.end(
        JSON.stringify({
          question_id: "q_test_001",
          question: "테스트 질문",
          retrieved_context: "42",
          think_trace: "[]",
          answer: "a",
        })
      );
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(results[0].response_contract_valid, false);
    assert.equal(results[0].response_usable, false);
    assert.deepEqual(results[0].metric_results, {}, "no metric may be computed when the restored value fails validateFinalResponse");
    assert.ok(
      results[0].contract_errors.some((e) => e.includes("restored FinalResponse invalid")),
      `expected a "restored FinalResponse invalid" contract error, got: ${JSON.stringify(results[0].contract_errors)}`
    );
  });
});

// ---------------------------------------------------------------------------
// 16. Retry policy: timeout or HTTP 5xx get up to `retries` additional
// attempts (default 2, so up to 3 total HTTP calls); a 4xx, a 2xx contract
// defect, or a question-echo mismatch are never retried. Every attempt
// sends the exact same question_id/question, and the Usage Ledger
// reservation happens exactly once per item regardless of attempt count.
// ---------------------------------------------------------------------------

test("a timeout is retried up to the default 2 times (3 total attempts)", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer(() => {
      requestCount++;
      // Never responds -- every attempt times out.
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 100,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(requestCount, 3, "1 initial attempt + 2 retries = 3 total HTTP calls");
    assert.equal(results[0].attempt_count, 3);
    assert.equal(results[0].attempts.length, 3);
    for (const attempt of results[0].attempts) assert.equal(attempt.timed_out, true);
    assert.equal(results[0].timed_out, true);
    assert.equal(results[0].response_usable, false);
  });
});

test("an HTTP 5xx is retried up to the default 2 times (3 total attempts)", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.statusCode = 503;
      res.end("service unavailable");
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(requestCount, 3);
    assert.equal(results[0].attempt_count, 3);
    assert.equal(results[0].http_status, 503);
    assert.equal(results[0].response_usable, false);
  });
});

test("retries stop as soon as an attempt succeeds -- a 5xx followed by a 200 makes exactly 2 attempts, not 3", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      if (requestCount === 1) {
        res.statusCode = 503;
        return res.end("try again");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("q_test_001", { question: "테스트 질문" })));
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(requestCount, 2);
    assert.equal(results[0].attempt_count, 2);
    assert.equal(results[0].http_status, 200);
    assert.equal(results[0].response_usable, true);
  });
});

test("an HTTP 4xx is never retried -- exactly one attempt", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.statusCode = 400;
      res.end("bad request");
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(requestCount, 1);
    assert.equal(results[0].attempt_count, 1);
    assert.equal(results[0].http_status, 400);
  });
});

test("an HTTP 200 with a schema-invalid (contract-defect) body is never retried -- exactly one attempt", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ not: "a valid wire body" }));
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(requestCount, 1);
    assert.equal(results[0].attempt_count, 1);
    assert.equal(results[0].response_contract_valid, false);
  });
});

test("a question-echo mismatch (HTTP 200, otherwise wire-schema-valid) is never retried -- exactly one attempt", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "실제 질문" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("q_test_001", { question: "다른 질문" })));
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(requestCount, 1);
    assert.equal(results[0].attempt_count, 1);
    assert.equal(results[0].question_echo_matches, false);
  });
});

test("every retry attempt sends the exact same question_id and question", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "테스트 질문" })) + "\n");

    const seenQuestionIds = [];
    const seenQuestions = [];
    const { server, baseUrl } = await startServer((req, res) => {
      const params = new URL(req.url, "http://x").searchParams;
      seenQuestionIds.push(params.get("question_id"));
      seenQuestions.push(params.get("q"));
      res.statusCode = 500;
      res.end("fail");
    });
    t.after(() => server.close());

    await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(seenQuestionIds.length, 3);
    assert.ok(seenQuestionIds.every((id) => id === "q_test_001"), "every attempt must send the same question_id");
    assert.ok(seenQuestions.every((q) => q === "테스트 질문"), "every attempt must send the same question");
  });
});

test("the Usage Ledger reservation happens exactly ONCE per item, even though the HTTP call is retried 3 times", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const ledgerPath = join(dir, "ledger.jsonl");
    const lifecyclePath = join(dir, "lifecycle.json");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_CHECK" })) + "\n");
    await writeFile(lifecyclePath, JSON.stringify([lifecycleState()]));

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.statusCode = 500;
      res.end("fail");
    });
    t.after(() => server.close());

    await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      lifecycle_path: lifecyclePath,
      ledger_path: ledgerPath,
      split: "DEV_CHECK",
      run_purpose: "CRITICAL_REGRESSION_CHECK",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
      run_id: "run-retry-ledger-once-test",
    });

    assert.equal(requestCount, 3, "sanity check: the HTTP call really was retried 3 times");
    const finalLedger = readLedgerFile(ledgerPath);
    assert.equal(finalLedger.length, 1, "exactly one reservation event must exist, regardless of how many HTTP attempts were made");
  });
});

test("config.retries overrides the default -- retries:0 means exactly 1 attempt, never retried even on a 5xx", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.statusCode = 500;
      res.end("fail");
    });
    t.after(() => server.close());

    const { results } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
      retries: 0,
    });

    assert.equal(requestCount, 1);
    assert.equal(results[0].attempt_count, 1);
  });
});

test("config: retries must be a non-negative integer when present", () => {
  assert.throws(() => validateConfig(baseConfig({ retries: -1 })));
  assert.throws(() => validateConfig(baseConfig({ retries: 1.5 })));
  assert.throws(() => validateConfig(baseConfig({ retries: "2" })));
  assert.doesNotThrow(() => validateConfig(baseConfig({ retries: 0 })));
  assert.doesNotThrow(() => validateConfig(baseConfig({ retries: 5 })));
});

test("config: the official execution profile (timeout_ms=300000, concurrency=1, retries=2) validates cleanly", () => {
  assert.doesNotThrow(() =>
    validateConfig(baseConfig({ timeout_ms: 300_000, concurrency: 1, retries: 2 }))
  );
});

test("a full run under the official execution profile (timeout_ms=300000, concurrency=1, retries=2) succeeds normally against a promptly-responding server", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    await writeFile(goldPath, JSON.stringify(goldRecord({ split: "DEV_TUNE", question: "테스트 질문" })) + "\n");

    let requestCount = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      requestCount++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(wireBody("q_test_001", { question: "테스트 질문" })));
    });
    t.after(() => server.close());

    const { results, summary } = await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 300_000,
      concurrency: 1,
      retries: 2,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    // The mock server responds immediately, so this never actually waits
    // anywhere near 300 seconds -- this only proves the official profile's
    // exact values flow through end-to-end without altering normal
    // behavior: a single successful attempt, no retries consumed.
    assert.equal(requestCount, 1, "a promptly-successful response must not trigger any retry, even with retries=2 configured");
    assert.equal(results[0].attempt_count, 1);
    assert.equal(results[0].response_usable, true);
    assert.equal(summary.response_usable, 1);
  });
});

test("concurrency=1 processes items strictly sequentially -- no two HTTP requests are ever in flight at the same time", async (t) => {
  await withTmpDir(async (dir) => {
    const goldPath = join(dir, "gold.jsonl");
    const resultPath = join(dir, "result.jsonl");
    const summaryPath = join(dir, "summary.json");
    const records = ["q_1", "q_2", "q_3"].map((id) =>
      goldRecord({ question_id: id, evaluation_group_id: `eval_group_${id}`, split: "DEV_TUNE", gold_document_ids: [`exchange_0000000${id}`] })
    );
    await writeFile(goldPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    let inFlight = 0;
    let maxInFlight = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const questionId = new URL(req.url, "http://x").searchParams.get("question_id");
      setTimeout(() => {
        inFlight--;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(wireBody(questionId, { question: "테스트 질문" })));
      }, 20);
    });
    t.after(() => server.close());

    await runHarness({
      base_url: baseUrl,
      answer_path: "/answer",
      question_parameter: "q",
      gold_path: goldPath,
      result_path: resultPath,
      summary_path: summaryPath,
      split: "DEV_TUNE",
      run_purpose: "FLOW_SELECTION",
      timeout_ms: 2000,
      concurrency: 1,
      configuration_sha256: SHA,
      git_commit: COMMIT,
    });

    assert.equal(maxInFlight, 1, "concurrency=1 must never have more than one HTTP request in flight at once");
  });
});
