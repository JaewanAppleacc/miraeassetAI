// Turn P2-P: contract tests for the PLANNER Agent variant
// (domain/agent-comparison/flows/planner-agent.mjs). Built the same way
// tests/agent-comparison-structured-first-agent.test.mjs is (see
// domain/agent-comparison/IMPLEMENTATION_GUIDE.md): a synthetic,
// non-production fixture (extended locally here with multi-metric
// synthetic Fact/Evidence sets -- tests/lib/agent-comparison-fixture.mjs
// itself is never modified), plus a read-only real-bundle smoke section at
// the bottom (mirrors tests/agent-comparison-real-bundle-smoke.test.mjs's
// own pattern: query the real v0.20-r3 bundle broadly, no fixed
// question/company list, no Gold/HOLDOUT data). Every id/value below is
// either synthetic (made up for this file only) or read dynamically off
// the real bundle at test time -- never a hardcoded real company name,
// question_id, document_id, or Fact value literal.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createPlannerFlow, DEFAULT_MAX_PLAN_STEPS } from "../domain/agent-comparison/flows/planner-agent.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { validateFinalResponse } from "../domain/runtime/final-response-validator.mjs";
import { instrumentModelAdapter, buildTelemetryEvent } from "../domain/agent-comparison/telemetry.mjs";
import { validateTelemetryEvent } from "../domain/agent-comparison/contracts.mjs";
import {
  registerAgentVariant, getAgentVariantFactory, listRegisteredAgentVariantIds, _clearRegistryForTests,
} from "../domain/agent-comparison/variant-registry.mjs";
import { createSeedBundleHarness } from "../domain/agent-comparison/seed-bundle-harness.mjs";
import {
  CORPUS_SNAPSHOT_ID, FACT_COVERAGE_SNAPSHOT_ID, FIXTURE_UNAUTHORIZED_FACT, FIXTURE_UNAUTHORIZED_EVIDENCE,
  createSyntheticStructuredStoreAdapter, syntheticContext,
} from "./lib/agent-comparison-fixture.mjs";

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 5, maxToolCalls: 50, timeoutMs: 10000 });

// --- local, synthetic multi-metric fixture builder (extends nothing in
//     tests/lib/agent-comparison-fixture.mjs -- purely additive, local to
//     this file) ----------------------------------------------------------

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const PLANNER_CORP_CODE = "00000010";

function buildSyntheticTarget({ index, metricCode, value, corpCode = PLANNER_CORP_CODE, unit = "KRW" }) {
  const documentId = `periodic_${String(index).padStart(14, "0")}`;
  const fileId = `file_${String(index).padStart(24, "0")}`;
  const evidenceId = `evidence_${String(index).padStart(24, "0")}`;
  const factId = `fact_${String(index).padStart(24, "0")}`;
  const sourceLocator = `${documentId}/${fileId}#node=1`;
  const quotedText = `값은 ${value.toLocaleString("en-US")}${unit === "KRW" ? "원" : ""}입니다.`;
  const fact = Object.freeze({
    fact_id: factId, corp_code: corpCode, event_id: null, source_document_id: documentId,
    metric_code: metricCode, raw_label: metricCode, value_type: "NUMERIC", value_status: "DISCLOSED",
    value_certainty: "CONFIRMED", raw_value_text: value.toLocaleString("en-US"), raw_unit_text: unit === "KRW" ? "원" : unit,
    normalized_value: value, unit, currency: unit === "KRW" ? "KRW" : null, scale: 1, scope: "CONSOLIDATED",
    period_type: "ANNUAL", period_start: "2025-01-01", period_end: "2025-12-31", as_of_date: "2025-12-31",
    known_at: "2026-01-01T00:00:00.000Z", valid_from: "2025-01-01", valid_to: null, withheld_until: null,
    extraction_method: "RULE", confidence: 1, verification_status: "VERIFIED", evidence_ids: [evidenceId], attributes: {},
  });
  const evidence = Object.freeze({
    evidence_id: evidenceId, document_id: documentId, file_id: fileId, chunk_id: null, source_locator: sourceLocator,
    quoted_text: quotedText, quote_sha256: sha256Hex(quotedText), extraction_method: "RULE", confidence: 1,
    verification_status: "VERIFIED", metadata: {},
  });
  return { fact, evidence, documentId, documentBlock: { file_id: fileId, source_locator: sourceLocator, text: quotedText } };
}

function structuredRecord(recordType, recordId, verificationStatus, knownAt, sourceDocumentIds, evidenceIds, payload) {
  return { record_type: recordType, record_id: recordId, verification_status: verificationStatus, known_at: knownAt, source_document_ids: sourceDocumentIds, evidence_ids: evidenceIds, payload };
}

function buildSyntheticServiceAdapters(targets, { structuredStoreAdapter } = {}) {
  const records = targets.flatMap(({ fact, evidence, documentId }) => [
    structuredRecord("FACT", fact.fact_id, "VERIFIED", fact.known_at, [documentId], fact.evidence_ids, fact),
    structuredRecord("EVIDENCE", evidence.evidence_id, "VERIFIED", fact.known_at, [documentId], [evidence.evidence_id], evidence),
  ]);
  const documentsById = new Map(targets.map(({ documentId, documentBlock }) => [documentId, { document_id: documentId, corpus_snapshot_id: CORPUS_SNAPSHOT_ID, blocks: [documentBlock] }]));
  const evidenceById = new Map(targets.map(({ evidence }) => [evidence.evidence_id, { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, record: evidence }]));
  // Only needed by the optional CALCULATION path (services.validator.validateFacts
  // resolves fact_id provenance through this store before services.calculator
  // will accept the pair) -- harmless to wire unconditionally for every test.
  const factsById = new Map(targets.map(({ fact }) => [fact.fact_id, { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID, record: fact }]));
  return {
    structuredStoreAdapter: structuredStoreAdapter ?? createSyntheticStructuredStoreAdapter({ records }),
    documentStoreAdapter: { async getDocument(id) { return documentsById.get(id) ?? null; } },
    evidenceStoreAdapter: { async getEvidence(id) { return evidenceById.get(id) ?? null; } },
    factStoreAdapter: { async getFact(id) { return factsById.get(id) ?? null; } },
  };
}

function factLineResponder(targets) {
  return () => ({
    text: targets.map(({ fact }) => `${fact.metric_code}: ${fact.normalized_value.toLocaleString("en-US")}${fact.unit === "KRW" ? "원" : ""}`).join(" / "),
    used_fact_ids: targets.map(({ fact }) => fact.fact_id),
    used_evidence_ids: targets.map(({ evidence }) => evidence.evidence_id),
  });
}

function countingQueryAdapter(inner) {
  let calls = 0;
  return {
    adapter: { async query(query) { calls += 1; return inner.query(query); } },
    callCount: () => calls,
  };
}

// --- 1. single requirement -> at least one step ----------------------------

test("PLANNER: a single-requirement question produces exactly one plan step", async () => {
  const targets = [buildSyntheticTarget({ index: 1, metricCode: "REVENUE", value: 1_000_000_000 })];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({ responder: factLineResponder(targets) });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액이 얼마인가요?", question_id: "q_planner_01", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.plan_step_count, 1);
  assert.equal(outcome.final_response.think_trace.validation.answerability, "SUPPORTED");
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
});

// --- 2. multiple requirements -> stable multi-step plan ---------------------

test("PLANNER: a multi-requirement question produces multiple steps in a stable (sorted) order, independent of hint order", async () => {
  const targets = [
    buildSyntheticTarget({ index: 2, metricCode: "REVENUE", value: 1_000_000_000 }),
    buildSyntheticTarget({ index: 3, metricCode: "OPERATING_PROFIT", value: 200_000_000 }),
    buildSyntheticTarget({ index: 4, metricCode: "NET_INCOME", value: 150_000_000 }),
  ];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({ responder: factLineResponder(targets) });
  const flow = createPlannerFlow(modelAdapter);
  const input = {
    question: "매출액, 영업이익, 당기순이익이 각각 얼마인가요?", question_id: "q_planner_02",
    hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["NET_INCOME", "REVENUE", "OPERATING_PROFIT"] },
  };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.plan_step_count, 3);
  const planOp = outcome.final_response.think_trace.operations.find((op) => op.step === "PLAN");
  assert.deepEqual(planOp.targets, ["metric=NET_INCOME", "metric=OPERATING_PROFIT", "metric=REVENUE"]);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
});

// --- 3. duplicate requirement dedup -----------------------------------------

test("PLANNER: duplicate metric requirements are deduplicated into one step", async () => {
  const targets = [
    buildSyntheticTarget({ index: 5, metricCode: "REVENUE", value: 1_000_000_000 }),
    buildSyntheticTarget({ index: 6, metricCode: "NET_INCOME", value: 150_000_000 }),
  ];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({ responder: factLineResponder(targets) });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액과 당기순이익", question_id: "q_planner_03", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE", "REVENUE", "NET_INCOME"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);
  assert.equal(outcome.final_response.think_trace.validation.plan_step_count, 2);
});

// --- 4. max step count exceeded -> fail-closed ------------------------------

test("PLANNER: exceeding the configured max plan step count fails closed -- zero StructuredStore queries, model never called", async () => {
  const { responder, callCount } = (() => {
    let calls = 0;
    return { responder: () => { calls += 1; return { text: "should never run", used_fact_ids: [], used_evidence_ids: [] }; }, callCount: () => calls };
  })();
  const { adapter: countedAdapter, callCount: queryCallCount } = countingQueryAdapter(createSyntheticStructuredStoreAdapter({ records: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createPlannerFlow(modelAdapter, { maxPlanSteps: 2 });
  const input = {
    question: "여러 지표를 알려주세요", question_id: "q_planner_04",
    hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE", "OPERATING_PROFIT", "NET_INCOME"] },
  };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, { structuredStoreAdapter: countedAdapter });

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.answerability, "UNANSWERABLE");
  assert.equal(outcome.final_response.think_trace.validation.reason, "PLAN_STEP_LIMIT_EXCEEDED");
  assert.equal(outcome.final_response.think_trace.validation.plan_step_count, 0);
  assert.equal(queryCallCount(), 0);
  assert.equal(callCount(), 0);
  assert.ok(DEFAULT_MAX_PLAN_STEPS >= 1);
});

// --- 5. unknown metric -> information limit ---------------------------------

test("PLANNER: a metric_code not present in the existing ontology is never planned -- honest information limit, model never called", async () => {
  const { responder, callCount } = (() => {
    let calls = 0;
    return { responder: () => { calls += 1; return { text: "should never run", used_fact_ids: [], used_evidence_ids: [] }; }, callCount: () => calls };
  })();
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "존재하지 않는 지표 질문", question_id: "q_planner_05", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["NOT_A_REAL_METRIC_CODE"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, buildSyntheticServiceAdapters([]));

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.answerability, "UNANSWERABLE");
  assert.equal(outcome.final_response.think_trace.validation.reason, "UNKNOWN_METRIC_ONLY");
  assert.deepEqual(outcome.final_response.think_trace.validation.rejected_targets, [{ target: "metric=NOT_A_REAL_METRIC_CODE", reason: "UNKNOWN_METRIC" }]);
  assert.equal(callCount(), 0);
});

// --- 6. one step fails -> partial result + honest limitation ---------------

test("PLANNER: when one plan step's query errors, the other step's grounded result is still answered and the failed step is named honestly, not silently dropped", async () => {
  const targets = [
    buildSyntheticTarget({ index: 7, metricCode: "REVENUE", value: 1_000_000_000 }),
    buildSyntheticTarget({ index: 8, metricCode: "OPERATING_PROFIT", value: 200_000_000 }),
  ];
  const baseAdapters = buildSyntheticServiceAdapters(targets);
  const flakyStructuredStoreAdapter = {
    async query(query) {
      if (query.predicates.metric_codes?.includes("OPERATING_PROFIT")) throw new Error("simulated store failure");
      return baseAdapters.structuredStoreAdapter.query(query);
    },
  };
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `REVENUE: ${targets[0].fact.normalized_value}원`, used_fact_ids: [targets[0].fact.fact_id], used_evidence_ids: [targets[0].evidence.evidence_id] }),
  });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액과 영업이익", question_id: "q_planner_06", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE", "OPERATING_PROFIT"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, { ...baseAdapters, structuredStoreAdapter: flakyStructuredStoreAdapter });

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.answerability, "SUPPORTED");
  assert.deepEqual(outcome.final_response.think_trace.validation.missing_targets, [{ target: "metric=OPERATING_PROFIT", reason: "QUERY_FAILED" }]);
  assert.match(outcome.final_response.answer, new RegExp(String(targets[0].fact.normalized_value)));
});

// --- 7. cross-attribution guard ---------------------------------------------

test("PLANNER: a leaky StructuredStore adapter that ignores metric/corp filters can never cross-attribute a Fact to the wrong step", async () => {
  const revenueTarget = buildSyntheticTarget({ index: 9, metricCode: "REVENUE", value: 1_000_000_000 });
  const profitTarget = buildSyntheticTarget({ index: 10, metricCode: "OPERATING_PROFIT", value: 200_000_000 });
  const foreignCorpTarget = buildSyntheticTarget({ index: 11, metricCode: "REVENUE", value: 9_000_000_000, corpCode: "00000099" });
  const allTargets = [revenueTarget, profitTarget, foreignCorpTarget];
  const base = buildSyntheticServiceAdapters(allTargets);
  // Simulate a misbehaving StructuredStore: ANY FACT query returns every
  // known Fact record, ignoring the request's own metric_codes/corp_codes
  // predicates entirely.
  const leakyStructuredStoreAdapter = {
    async query(query) {
      if (!query.targets.includes("FACT")) return base.structuredStoreAdapter.query(query);
      return { corpus_snapshot_id: query.corpus_snapshot_id, fact_coverage_snapshot_id: query.fact_coverage_snapshot_id, status: "OK", error_codes: [], records: [
        { record_type: "FACT", record_id: revenueTarget.fact.fact_id, verification_status: "VERIFIED", known_at: revenueTarget.fact.known_at, source_document_ids: [revenueTarget.documentId], evidence_ids: revenueTarget.fact.evidence_ids, payload: revenueTarget.fact },
        { record_type: "FACT", record_id: profitTarget.fact.fact_id, verification_status: "VERIFIED", known_at: profitTarget.fact.known_at, source_document_ids: [profitTarget.documentId], evidence_ids: profitTarget.fact.evidence_ids, payload: profitTarget.fact },
        { record_type: "FACT", record_id: foreignCorpTarget.fact.fact_id, verification_status: "VERIFIED", known_at: foreignCorpTarget.fact.known_at, source_document_ids: [foreignCorpTarget.documentId], evidence_ids: foreignCorpTarget.fact.evidence_ids, payload: foreignCorpTarget.fact },
      ] };
    },
  };
  const modelAdapter = createDeterministicFakeModelAdapter({ responder: factLineResponder([revenueTarget, profitTarget]) });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액과 영업이익", question_id: "q_planner_07", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE", "OPERATING_PROFIT"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, { ...base, structuredStoreAdapter: leakyStructuredStoreAdapter });

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  // Exactly the 2 correctly-attributed facts, not the leaked 3rd (wrong
  // corp_code) fact, and REVENUE is never double-counted into the
  // OPERATING_PROFIT step (or vice versa).
  const groundedFactIds = outcome.final_response.retrieved_context.filter((entry) => entry.fact_id).map((entry) => entry.fact_id);
  assert.deepEqual(new Set(groundedFactIds), new Set([revenueTarget.fact.fact_id, profitTarget.fact.fact_id]));
  assert.doesNotMatch(outcome.final_response.answer, new RegExp(String(foreignCorpTarget.fact.normalized_value)));
});

// --- 8. order-independence of independent step composition -----------------

test("PLANNER: two independent steps requested in a different order produce byte-identical plan and final answer", async () => {
  const targets = [
    buildSyntheticTarget({ index: 12, metricCode: "REVENUE", value: 1_000_000_000 }),
    buildSyntheticTarget({ index: 13, metricCode: "OPERATING_PROFIT", value: 200_000_000 }),
  ];
  const adapters = buildSyntheticServiceAdapters(targets);
  const responder = factLineResponder(targets);
  const flowA = createPlannerFlow(createDeterministicFakeModelAdapter({ responder }));
  const flowB = createPlannerFlow(createDeterministicFakeModelAdapter({ responder }));
  const baseInput = { question_id: "q_planner_08", question: "매출액과 영업이익", hints: { corp_codes: [PLANNER_CORP_CODE] } };
  const outcomeA = await runAgentFlow(flowA, { ...baseInput, hints: { ...baseInput.hints, metric_codes: ["REVENUE", "OPERATING_PROFIT"] } }, syntheticContext(), LIMITS, adapters);
  const outcomeB = await runAgentFlow(flowB, { ...baseInput, hints: { ...baseInput.hints, metric_codes: ["OPERATING_PROFIT", "REVENUE"] } }, syntheticContext(), LIMITS, adapters);

  // The plan itself, and everything derived from it (queries executed,
  // grounded facts, the composed answer), is fully canonicalized (sorted)
  // and therefore identical either way -- see PLAN DETERMINISM in
  // planner-agent.mjs. Only the ANALYZE_QUESTION operation legitimately
  // still echoes the raw hint order it was actually given (a truthful
  // trace of the input, not a planning decision), so it is excluded from
  // this "final meaning is order-independent" comparison.
  const dropAnalyzeQuestion = (response) => ({
    ...response,
    think_trace: { ...response.think_trace, operations: response.think_trace.operations.filter((op) => op.step !== "ANALYZE_QUESTION") },
  });
  assert.deepEqual(dropAnalyzeQuestion(outcomeA.final_response), dropAnalyzeQuestion(outcomeB.final_response));
  const planA = outcomeA.final_response.think_trace.operations.find((op) => op.step === "PLAN");
  const planB = outcomeB.final_response.think_trace.operations.find((op) => op.step === "PLAN");
  assert.deepEqual(planA.targets, planB.targets);
});

// --- 9. unsupported calculation formula is rejected, not invented ----------

test("PLANNER: an unsupported calculation formula is rejected via the real Calculator contract, never invented locally", async () => {
  const targets = [
    buildSyntheticTarget({ index: 14, metricCode: "REVENUE", value: 1_000_000_000 }),
    buildSyntheticTarget({ index: 15, metricCode: "OPERATING_PROFIT", value: 200_000_000 }),
  ];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({ responder: factLineResponder(targets) });
  const flow = createPlannerFlow(modelAdapter);
  const input = {
    question: "매출액과 영업이익의 평균은?", question_id: "q_planner_09",
    hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE", "OPERATING_PROFIT"], calculation: { formula: "AVERAGE", metric_codes: ["REVENUE", "OPERATING_PROFIT"] } },
  };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  const rejection = outcome.final_response.think_trace.operations.find((op) => op.step === "CALCULATION_REJECTED");
  assert.ok(rejection, "expected a CALCULATION_REJECTED operation");
  assert.equal(rejection.formula, "AVERAGE");
  assert.deepEqual(outcome.final_response.think_trace.calculation, {});
  assert.doesNotMatch(outcome.final_response.answer, /계산 결과/);
});

test("PLANNER: a supported calculation formula (DIFF) is computed only through services.calculator, never a value the Flow invents itself", async () => {
  const targets = [
    buildSyntheticTarget({ index: 16, metricCode: "REVENUE", value: 1_000_000_000 }),
    buildSyntheticTarget({ index: 17, metricCode: "OPERATING_PROFIT", value: 200_000_000 }),
  ];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({ responder: factLineResponder(targets) });
  const flow = createPlannerFlow(modelAdapter);
  const input = {
    question: "매출액과 영업이익의 차이는?", question_id: "q_planner_10",
    hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE", "OPERATING_PROFIT"], calculation: { formula: "DIFF", metric_codes: ["REVENUE", "OPERATING_PROFIT"] } },
  };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.calculation.formula, "DIFF");
  assert.equal(outcome.final_response.think_trace.calculation.result, 800_000_000);
  assert.match(outcome.final_response.answer, /계산 결과.*800,000,000|800000000/);
});

// --- 10. the model cannot alter the plan ------------------------------------

test("PLANNER: the model's own generated text/claims never change which steps were planned or queried", async () => {
  const targets = [
    buildSyntheticTarget({ index: 18, metricCode: "REVENUE", value: 1_000_000_000 }),
    buildSyntheticTarget({ index: 19, metricCode: "OPERATING_PROFIT", value: 200_000_000 }),
  ];
  const adapters = buildSyntheticServiceAdapters(targets);
  const input = { question: "매출액과 영업이익", question_id: "q_planner_11", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE", "OPERATING_PROFIT"] } };

  const benignModel = createDeterministicFakeModelAdapter({ responder: factLineResponder(targets) });
  const hallucinatingModel = createDeterministicFakeModelAdapter({
    responder: () => ({ text: "사실 이 질문은 다른 회사의 다른 지표를 다뤄야 합니다.", used_fact_ids: [FIXTURE_UNAUTHORIZED_FACT.fact_id], used_evidence_ids: [] }),
  });

  const outcomeBenign = await runAgentFlow(createPlannerFlow(benignModel), input, syntheticContext(), LIMITS, adapters);
  const outcomeHallucinated = await runAgentFlow(createPlannerFlow(hallucinatingModel), input, syntheticContext(), LIMITS, adapters);

  const preModelOps = (outcome) => outcome.final_response.think_trace.operations.filter((op) => op.step !== "MODEL_CALL" && op.step !== "VERIFY_GENERATED_ANSWER");
  assert.deepEqual(preModelOps(outcomeBenign), preModelOps(outcomeHallucinated));
  assert.equal(outcomeBenign.final_response.think_trace.validation.plan_step_count, outcomeHallucinated.final_response.think_trace.validation.plan_step_count);
});

// --- 11. unapproved citation/number/date/document_id/corp_code blocked -----

test("PLANNER: citing an unauthorized fact_id (never planned/grounded this request) is discarded wholesale", async () => {
  const targets = [buildSyntheticTarget({ index: 20, metricCode: "REVENUE", value: 1_000_000_000 })];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: "그럴듯하지만 근거 없는 답변입니다.", used_fact_ids: [FIXTURE_UNAUTHORIZED_FACT.fact_id], used_evidence_ids: [] }),
  });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액", question_id: "q_planner_12", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
  assert.doesNotMatch(outcome.final_response.answer, /그럴듯하지만/);
});

test("PLANNER: citing an unvalidated evidence_id is discarded wholesale", async () => {
  const targets = [buildSyntheticTarget({ index: 21, metricCode: "REVENUE", value: 1_000_000_000 })];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `매출액은 ${targets[0].fact.normalized_value}원입니다.`, used_fact_ids: [targets[0].fact.fact_id], used_evidence_ids: [FIXTURE_UNAUTHORIZED_EVIDENCE.evidence_id] }),
  });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액", question_id: "q_planner_13", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
});

test("PLANNER: an unsupported NUMBER not present in any grounded Fact/Evidence is discarded wholesale", async () => {
  const targets = [buildSyntheticTarget({ index: 22, metricCode: "REVENUE", value: 1_000_000_000 })];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: "매출액은 9,999,999,999원입니다.", used_fact_ids: [targets[0].fact.fact_id], used_evidence_ids: [targets[0].evidence.evidence_id] }),
  });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액", question_id: "q_planner_14", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.doesNotMatch(outcome.final_response.answer, /9,999,999,999/);
});

test("PLANNER: an unsupported DATE not present in any grounded Fact/Evidence is discarded wholesale", async () => {
  const targets = [buildSyntheticTarget({ index: 23, metricCode: "REVENUE", value: 1_000_000_000 })];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: "이 값은 2031-06-30 기준입니다.", used_fact_ids: [targets[0].fact.fact_id], used_evidence_ids: [targets[0].evidence.evidence_id] }),
  });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액", question_id: "q_planner_15", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
});

test("PLANNER: a DIFFERENT company's corp_code inserted into the answer text is discarded wholesale (corp_code, not a name, is this codebase's identity/join key)", async () => {
  const targets = [buildSyntheticTarget({ index: 24, metricCode: "REVENUE", value: 1_000_000_000 })];
  const adapters = buildSyntheticServiceAdapters(targets);
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `매출액은 ${targets[0].fact.normalized_value}원입니다 (관련 기업 코드 ${FIXTURE_UNAUTHORIZED_FACT.corp_code}).`, used_fact_ids: [targets[0].fact.fact_id], used_evidence_ids: [targets[0].evidence.evidence_id] }),
  });
  const flow = createPlannerFlow(modelAdapter);
  const input = { question: "매출액", question_id: "q_planner_16", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.doesNotMatch(outcome.final_response.answer, new RegExp(FIXTURE_UNAUTHORIZED_FACT.corp_code));
});

// --- 12. model call failure -> fallback, excluded from scoring --------------

test("PLANNER: a model CALL failure falls back to a deterministic, fully-grounded answer -- scoring_eligible=false", async () => {
  const targets = [buildSyntheticTarget({ index: 25, metricCode: "REVENUE", value: 1_000_000_000 })];
  const adapters = buildSyntheticServiceAdapters(targets);
  const failingModelAdapter = { generate: async () => { throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout"); } };
  const flow = createPlannerFlow(failingModelAdapter);
  const input = { question: "매출액", question_id: "q_planner_17", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE"] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "NOT_CHECKED");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
  assert.match(outcome.final_response.answer, new RegExp(String(targets[0].fact.normalized_value)));

  const { adapter: instrumented, usage } = instrumentModelAdapter(failingModelAdapter);
  try {
    await instrumented.generate({ prompt: "x" });
  } catch {
    // expected -- instrumentModelAdapter rethrows unchanged, this is only
    // exercising the same instrumentation path buildTelemetryEvent expects.
  }
  const event = buildTelemetryEvent({
    benchmarkRunId: "planner_unit_test", agentVariantId: "PLANNER", modelConfigId: "model_fake-deterministic-v1",
    executionScope: "OFFICIAL", question: input.question, questionId: input.question_id, agentOutcome: outcome, modelUsage: usage(),
  });
  assert.deepEqual(validateTelemetryEvent(event), []);
  assert.equal(event.model_fallback_used, true);
  assert.equal(event.scoring_eligible, false);
  assert.equal(event.citation_binding_status, "NOT_CHECKED");
});

// --- 13. determinism ---------------------------------------------------------

test("PLANNER: identical input/context/model produces byte-identical plan, telemetry-relevant fields, and answer across repeated runs", async () => {
  const targets = [
    buildSyntheticTarget({ index: 26, metricCode: "REVENUE", value: 1_000_000_000 }),
    buildSyntheticTarget({ index: 27, metricCode: "OPERATING_PROFIT", value: 200_000_000 }),
  ];
  const adapters = buildSyntheticServiceAdapters(targets);
  const responder = factLineResponder(targets);
  const input = { question: "매출액과 영업이익", question_id: "q_planner_18", hints: { corp_codes: [PLANNER_CORP_CODE], metric_codes: ["REVENUE", "OPERATING_PROFIT"] } };

  const outcome1 = await runAgentFlow(createPlannerFlow(createDeterministicFakeModelAdapter({ responder })), input, syntheticContext(), LIMITS, adapters);
  const outcome2 = await runAgentFlow(createPlannerFlow(createDeterministicFakeModelAdapter({ responder })), input, syntheticContext(), LIMITS, adapters);

  assert.deepEqual(outcome1.final_response, outcome2.final_response);

  const strip = (trace) => trace.operations.map((op) => { const rest = { ...op }; delete rest.started_at; delete rest.latency_ms; return rest; });
  assert.deepEqual(strip(outcome1.execution_trace), strip(outcome2.execution_trace));
});

// --- 14. no registry pollution across variants ------------------------------

test("PLANNER: importing register-planner-variant.mjs registers only PLANNER, nothing else", async () => {
  _clearRegistryForTests();
  await import("../domain/agent-comparison/register-planner-variant.mjs");
  assert.deepEqual(listRegisteredAgentVariantIds(), ["PLANNER"]);
  assert.equal(typeof getAgentVariantFactory("PLANNER"), "function");
  _clearRegistryForTests();
});

test("PLANNER: registerAgentVariant + getAgentVariantFactory round-trip (isolated from any other variant's registration)", () => {
  _clearRegistryForTests();
  const factory = (modelAdapter, options) => createPlannerFlow(modelAdapter, options);
  registerAgentVariant("PLANNER", factory);
  assert.equal(getAgentVariantFactory("PLANNER"), factory);
  assert.deepEqual(listRegisteredAgentVariantIds(), ["PLANNER"]);
  _clearRegistryForTests();
});

// --- real v0.20-r3 bundle smoke ---------------------------------------------
// Read-only: materializes the already-approved bundle into a private
// mkdtemp() dir via seed-bundle-harness.mjs (same construction point
// production uses) and disposes it afterward -- nothing under
// domain/releases/ or any other git-tracked path is ever written. Finds
// its own multi-metric sample dynamically (no fixed company/metric/
// question_id), matching tests/agent-comparison-real-bundle-smoke.test.mjs's
// own "query broadly" pattern. Scoped to its own subtest (t.before/t.after)
// rather than the file-level test.before/test.after, so the ~20 synthetic
// tests above never pay real-bundle materialization cost.
test("real v0.20-r3 bundle smoke", async (t) => {
  let harness;
  let multiMetricSample;

  t.before(async () => {
    harness = await createSeedBundleHarness({ root: process.cwd() });
    const probeQuery = {
      schema_version: "0.2.0", query_id: "query_planner_real_bundle_probe", execution_scope: "OFFICIAL",
      corpus_snapshot_id: harness.context.corpus_snapshot_id, fact_coverage_snapshot_id: harness.context.fact_coverage_snapshot_id,
      targets: ["FACT"], corp_codes: [],
      predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
      period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
      verification_statuses: ["VERIFIED"], as_of_date: "2030-01-01", limit: 300,
    };
    const probeResult = await harness.serviceAdapters.structuredStoreAdapter.query(probeQuery);
    assert.equal(probeResult.status, "OK", "the real v0.20-r3 bundle must expose at least one VERIFIED Fact");
    const byCorp = new Map();
    for (const record of probeResult.records) {
      const fact = record.payload;
      if (!Array.isArray(fact.evidence_ids) || fact.evidence_ids.length === 0) continue;
      if (!byCorp.has(fact.corp_code)) byCorp.set(fact.corp_code, new Map());
      byCorp.get(fact.corp_code).set(fact.metric_code, fact);
    }
    const corpWithTwoMetrics = [...byCorp.entries()].find(([, metrics]) => metrics.size >= 2);
    assert.ok(corpWithTwoMetrics, "expected at least one corp_code with 2+ distinct VERIFIED metrics with evidence in the real bundle");
    const [corpCode, metrics] = corpWithTwoMetrics;
    const [factA, factB] = [...metrics.values()].slice(0, 2);
    multiMetricSample = { corpCode, factA, factB };
  });

  t.after(async () => {
    if (harness) await harness.dispose();
  });

  await t.test("PLANNER plans one step per metric requirement, queries only VERIFIED data, and a well-behaved answer PASSES citation binding", async () => {
    const { factA, factB, corpCode } = multiMetricSample;
    const baseModel = createDeterministicFakeModelAdapter({
      responder: () => ({
        text: `${factA.metric_code}: ${factA.normalized_value} / ${factB.metric_code}: ${factB.normalized_value}`,
        used_fact_ids: [factA.fact_id, factB.fact_id], used_evidence_ids: [...factA.evidence_ids, ...factB.evidence_ids],
      }),
    });
    const { adapter: instrumented, usage } = instrumentModelAdapter(baseModel);
    const flow = createPlannerFlow(instrumented);
    const input = {
      question: "real bundle planner smoke question", question_id: "q_real_bundle_planner_smoke_01",
      hints: { corp_codes: [corpCode], metric_codes: [factA.metric_code, factB.metric_code] },
    };
    const context = { ...harness.context, as_of_date: "2030-01-01" };
    const outcome = await runAgentFlow(flow, input, context, LIMITS, harness.serviceAdapters);

    assert.deepEqual(validateFinalResponse(outcome.final_response), []);
    assert.equal(outcome.final_response.think_trace.validation.plan_step_count, 2);
    assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
    assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);

    const event = buildTelemetryEvent({
      benchmarkRunId: "planner_real_bundle_smoke", agentVariantId: "PLANNER", modelConfigId: "model_fake-deterministic-v1",
      executionScope: "OFFICIAL", question: input.question, questionId: input.question_id, agentOutcome: outcome, modelUsage: usage(),
    });
    assert.deepEqual(validateTelemetryEvent(event), []);
    assert.equal(event.citation_binding_status, "PASS");
    assert.equal(event.scoring_eligible, true);
    assert.equal(event.structured_query_count > 0, true);
  });

  await t.test("a fabricated claim over real VERIFIED data is discarded, and the fallback contains the REAL values instead", async () => {
    const { factA, factB, corpCode } = multiMetricSample;
    const baseModel = createDeterministicFakeModelAdapter({
      responder: () => ({ text: "값은 999,999,999,999,999입니다.", used_fact_ids: [factA.fact_id, factB.fact_id], used_evidence_ids: [...factA.evidence_ids, ...factB.evidence_ids] }),
    });
    const flow = createPlannerFlow(baseModel);
    const input = {
      question: "real bundle planner smoke hallucination question", question_id: "q_real_bundle_planner_smoke_02",
      hints: { corp_codes: [corpCode], metric_codes: [factA.metric_code, factB.metric_code] },
    };
    const context = { ...harness.context, as_of_date: "2030-01-01" };
    const outcome = await runAgentFlow(flow, input, context, LIMITS, harness.serviceAdapters);

    assert.deepEqual(validateFinalResponse(outcome.final_response), []);
    assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
    assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
    assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
    assert.doesNotMatch(outcome.final_response.answer, /999,999,999,999,999/);
    assert.match(outcome.final_response.answer, new RegExp(String(factA.normalized_value)));
  });
});
