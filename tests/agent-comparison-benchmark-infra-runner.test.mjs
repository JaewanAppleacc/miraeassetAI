// Turn P6 section B/F: the common Benchmark Runner -- synthetic fixtures
// and FAKE_DETERMINISTIC only, no real network call, no real Gold/HOLDOUT.
import assert from "node:assert/strict";
import test from "node:test";
import { runBenchmark, REQUIRED_VARIANT_IDS } from "../domain/agent-comparison/benchmark/runner.mjs";
import { loadDatasetRecords } from "../domain/agent-comparison/benchmark/dataset.mjs";
import { validateBenchmarkItemResult } from "../domain/agent-comparison/benchmark/contracts.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { RequestAbortedError } from "../domain/runtime/abortable.mjs";
import {
  registerAgentVariant, listRegisteredAgentVariantIds, _clearRegistryForTests,
} from "../domain/agent-comparison/variant-registry.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";
import { createStructuredFirstFlow } from "../domain/agent-comparison/flows/structured-first-agent.mjs";
import { createHybridRetrievalFlow } from "../domain/agent-comparison/flows/hybrid-retrieval-agent.mjs";
import { createPlannerFlow } from "../domain/agent-comparison/flows/planner-agent.mjs";
import { createDocumentFirstRagFlow } from "../domain/agent-comparison/flows/document-first-rag-agent.mjs";
import {
  makeFixtureDatasetRecord, groundedFixtureResponder, benchmarkFixtureContext, benchmarkFixtureServiceAdapters,
  FAKE_MODEL_CONFIG, BENCHMARK_LIMITS, FIXTURE_FACT, FIXTURE_EVIDENCE,
} from "./lib/agent-comparison-benchmark-infra-fixture.mjs";

const FLOW_FACTORIES = Object.freeze({
  STRUCTURED_FIRST: (adapter, options) => createStructuredFirstFlow(adapter, options),
  HYBRID_RETRIEVAL: (adapter, options) => createHybridRetrievalFlow(adapter, options),
  PLANNER: (adapter, options) => createPlannerFlow(adapter, options),
  DOCUMENT_FIRST_RAG: (adapter, options) => createDocumentFirstRagFlow(adapter, options),
});

function registerAllFour() {
  for (const id of REQUIRED_VARIANT_IDS) registerAgentVariant(id, FLOW_FACTORIES[id]);
}

// scoring.axes.operational.details.latency_ms is a genuine wall-clock
// OBSERVATION (same status as ExecutionTrace.latency_ms itself -- see
// integration/determinism.mjs's own header comment on why that field is
// stripped before hashing) -- it is expected to vary run to run even for
// byte-identical input. Every other scoring field (status/raw_score/
// error_codes/every other detail) must still match exactly.
function stripVolatileScoring(scoring) {
  const clone = structuredClone(scoring);
  if (clone.axes?.operational?.details) delete clone.axes.operational.details.latency_ms;
  return clone;
}

function loadFixtureDataset(overrides) {
  return loadDatasetRecords([makeFixtureDatasetRecord(overrides)], { datasetId: "dataset_runner_test_0001" });
}

function baseRunArgs(extra = {}) {
  return {
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({ responder: groundedFixtureResponder }),
    modelConfig: FAKE_MODEL_CONFIG,
    context: benchmarkFixtureContext(),
    budgetLimits: BENCHMARK_LIMITS,
    serviceAdapters: benchmarkFixtureServiceAdapters(),
    benchmarkRunId: "benchmark_run_infra_test",
    ...extra,
  };
}

// Test 1: all four variants execute the same item set.
test("runBenchmark: all 4 variants execute the same evaluation item, each producing a schema-valid, NORMAL_ANSWER, scoring_eligible result", async () => {
  const { manifest, records } = loadFixtureDataset();
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, ...baseRunArgs() });

  assert.equal(results.length, 4);
  assert.deepEqual(results.map((r) => r.variant_id).sort(), [...REQUIRED_VARIANT_IDS].sort());
  for (const result of results) {
    assert.deepEqual(validateBenchmarkItemResult(result), []);
    assert.equal(result.run_status, "OK");
    assert.equal(result.outcome_category, "NORMAL_ANSWER");
    assert.equal(result.citation_binding_status, "PASS");
    assert.equal(result.scoring_eligible, true);
    assert.equal(result.dataset_id, manifest.dataset_id);
    assert.equal(result.dataset_sha256, manifest.dataset_sha256);
    assert.equal(result.evaluation_item_id, records[0].evaluation_item_id);
    assert.equal(typeof result.evaluation_item_sha256, "string");
    assert.equal(result.model_config_sha256.length, 64);
    assert.equal(typeof result.answer_sha256, "string");
    assert.equal(typeof result.execution_trace_sha256, "string");
  }
});

// Test 2: execution order independence.
test("runBenchmark: reversing variantIds order produces byte-identical per-variant answer_sha256/execution_trace_sha256/scoring", async () => {
  const { manifest, records } = loadFixtureDataset();
  const forward = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: REQUIRED_VARIANT_IDS, ...baseRunArgs() });
  const reversed = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: [...REQUIRED_VARIANT_IDS].reverse(), ...baseRunArgs() });

  const byVariant = (list) => Object.fromEntries(list.map((r) => [r.variant_id, r]));
  const forwardByVariant = byVariant(forward);
  const reversedByVariant = byVariant(reversed);
  for (const variantId of REQUIRED_VARIANT_IDS) {
    assert.equal(forwardByVariant[variantId].answer_sha256, reversedByVariant[variantId].answer_sha256, `${variantId} answer_sha256 differs by order`);
    assert.equal(forwardByVariant[variantId].execution_trace_sha256, reversedByVariant[variantId].execution_trace_sha256, `${variantId} execution_trace_sha256 differs by order`);
    assert.deepEqual(stripVolatileScoring(forwardByVariant[variantId].scoring), stripVolatileScoring(reversedByVariant[variantId].scoring), `${variantId} scoring differs by order`);
  }
});

// Test 3: one variant's harness-level failure never affects the others.
test("runBenchmark: an unregistered variant fails in isolation (run_status=FAILED) without affecting the other three variants' own runs", async () => {
  const before = listRegisteredAgentVariantIds();
  _clearRegistryForTests();
  try {
    registerAgentVariant("STRUCTURED_FIRST", FLOW_FACTORIES.STRUCTURED_FIRST);
    registerAgentVariant("HYBRID_RETRIEVAL", FLOW_FACTORIES.HYBRID_RETRIEVAL);
    registerAgentVariant("PLANNER", FLOW_FACTORIES.PLANNER);
    // DOCUMENT_FIRST_RAG deliberately left unregistered.

    const { manifest, records } = loadFixtureDataset();
    const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, ...baseRunArgs() });
    assert.equal(results.length, 4);

    const byVariant = Object.fromEntries(results.map((r) => [r.variant_id, r]));
    assert.equal(byVariant.DOCUMENT_FIRST_RAG.run_status, "FAILED");
    assert.equal(byVariant.DOCUMENT_FIRST_RAG.outcome_category, "AGENT_VARIANT_EXECUTION_FAILURE");
    assert.equal(byVariant.DOCUMENT_FIRST_RAG.scoring_eligible, false);
    assert.equal(byVariant.DOCUMENT_FIRST_RAG.answer_sha256, null);
    for (const axis of Object.values(byVariant.DOCUMENT_FIRST_RAG.scoring.axes)) assert.equal(axis.status, "SKIPPED");

    for (const variantId of ["STRUCTURED_FIRST", "HYBRID_RETRIEVAL", "PLANNER"]) {
      assert.equal(byVariant[variantId].run_status, "OK");
      assert.equal(byVariant[variantId].outcome_category, "NORMAL_ANSWER");
      assert.equal(byVariant[variantId].scoring_eligible, true);
    }
  } finally {
    _clearRegistryForTests();
    registerAllFour();
    assert.deepEqual([...listRegisteredAgentVariantIds()].sort(), [...before].sort());
  }
});

// Test 4: no telemetry/model-state leakage across variants.
test("runBenchmark: each variant gets its own instrumented ModelAdapter -- model_call_attempt_count never leaks between variants", async () => {
  let totalGenerateCalls = 0;
  const { manifest, records } = loadFixtureDataset();
  const results = await runBenchmark({
    datasetManifest: manifest, datasetRecords: records,
    ...baseRunArgs({
      modelAdapterFactory: () => createDeterministicFakeModelAdapter({
        responder: (request) => { totalGenerateCalls += 1; return groundedFixtureResponder(); },
      }),
    }),
  });
  // Each of the 4 variants makes at most 1 model call for this single
  // fully-grounded item -- if usage counters leaked across variants (a
  // shared instrumented adapter reused instead of a fresh one per variant),
  // a later variant's model_call_attempt_count would be inflated by an
  // earlier variant's own calls.
  for (const result of results) {
    assert.equal(result.model_call_attempt_count, 1, `${result.variant_id} model_call_attempt_count leaked`);
    assert.equal(result.model_call_success_count, 1);
    assert.equal(result.model_call_failure_count, 0);
  }
  assert.equal(totalGenerateCalls, 4);
});

// Test 11: a model-call failure's fallback is never counted as a model success.
test("runBenchmark: a model CALL failure produces MODEL_CALL_FAILURE_FALLBACK, never disguised as NORMAL_ANSWER, and is scoring_eligible=false", async () => {
  const { manifest, records } = loadFixtureDataset();
  const failingModelAdapter = { generate: async () => { throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout"); } };
  const results = await runBenchmark({
    datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"],
    ...baseRunArgs({ modelAdapterFactory: () => failingModelAdapter }),
  });
  assert.equal(results.length, 1);
  const [result] = results;
  assert.equal(result.run_status, "OK"); // runAgentFlow itself never throws
  assert.equal(result.outcome_category, "MODEL_CALL_FAILURE_FALLBACK");
  assert.equal(result.citation_binding_status, "NOT_CHECKED");
  assert.equal(result.model_fallback_used, true);
  assert.equal(result.scoring_eligible, false);
  assert.equal(result.model_call_attempt_count, 1);
  assert.equal(result.model_call_success_count, 0);
  assert.equal(result.model_call_failure_count, 1);
  for (const axis of Object.values(result.scoring.axes)) assert.equal(axis.status, "SKIPPED");
});

// Test: BUDGET_EXCEEDED is its own outcome_category, never disguised as a
// model success, and the request fails closed via runAgentFlow's own
// generic accounting.
test("runBenchmark: exceeding maxToolCalls classifies as BUDGET_EXCEEDED, scoring_eligible=false, no model call ever attempted", async () => {
  const { manifest, records } = loadFixtureDataset();
  const results = await runBenchmark({
    datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"],
    ...baseRunArgs({ budgetLimits: { ...BENCHMARK_LIMITS, maxToolCalls: 0 } }),
  });
  const [result] = results;
  assert.equal(result.outcome_category, "BUDGET_EXCEEDED");
  assert.equal(result.scoring_eligible, false);
  assert.equal(result.model_call_attempt_count, 0);
});

// Test 19 (part 1): TIMEOUT/ABORTED are their own distinct outcome_category
// values, and no lingering handle/promise is left behind (this runner is
// pure in-memory -- an already-aborted signal is rejected before any real
// work starts, so there is nothing to clean up either way).
test("runBenchmark: a pre-aborted request-scoped signal (reason=TIMEOUT) classifies as TIMEOUT, and a plain abort classifies as ABORTED -- both distinct from BUDGET_EXCEEDED/model failure", async () => {
  const { manifest, records } = loadFixtureDataset();

  const timeoutController = new AbortController();
  timeoutController.abort(new RequestAbortedError("TIMEOUT"));
  const timeoutResults = await runBenchmark({
    datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"],
    ...baseRunArgs({ context: { ...benchmarkFixtureContext(), signal: timeoutController.signal } }),
  });
  assert.equal(timeoutResults[0].outcome_category, "TIMEOUT");
  assert.equal(timeoutResults[0].scoring_eligible, false);

  const abortController = new AbortController();
  abortController.abort();
  const abortedResults = await runBenchmark({
    datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"],
    ...baseRunArgs({ context: { ...benchmarkFixtureContext(), signal: abortController.signal } }),
  });
  assert.equal(abortedResults[0].outcome_category, "ABORTED");
  assert.equal(abortedResults[0].scoring_eligible, false);
});

// Test 12: scoring_eligible=false is excluded from accuracy averages but
// still counted in failure-rate statistics (verified at the runner-output
// level here; report.mjs's own aggregation is covered separately in
// tests/agent-comparison-benchmark-infra-report.test.mjs).
test("runBenchmark: a scoring_eligible=false row's axes are all SKIPPED (raw_score null, never averaged) while the row itself is still present in the output", async () => {
  const { manifest, records } = loadFixtureDataset();
  const failingModelAdapter = { generate: async () => { throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout"); } };
  const results = await runBenchmark({
    datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"],
    ...baseRunArgs({ modelAdapterFactory: () => failingModelAdapter }),
  });
  assert.equal(results.length, 1); // never dropped from the output array
  for (const axis of Object.values(results[0].scoring.axes)) assert.equal(axis.raw_score, null);
});

// Test 15: expected_* / question content is never handed to the model as
// ground truth beyond the SAME AgentInput.question path every variant
// already uses.
test("runBenchmark: DatasetRecord.expected_* content never reaches the ModelAdapter prompt", async () => {
  const canary = "CANARY_MUST_NOT_LEAK_INTO_PROMPT_9f3a";
  const item = makeFixtureDatasetRecord({
    expected_facts: [{ fact_id: FIXTURE_FACT.fact_id, semantic_slot: canary, corp_code: FIXTURE_FACT.corp_code, metric_code: FIXTURE_FACT.metric_code, required: true }],
  });
  const { manifest, records } = loadDatasetRecords([item], { datasetId: "dataset_prompt_leak_test" });

  const capturedPrompts = [];
  await runBenchmark({
    datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"],
    ...baseRunArgs({
      modelAdapterFactory: () => createDeterministicFakeModelAdapter({
        responder: (request) => { capturedPrompts.push(request.prompt); return groundedFixtureResponder(); },
      }),
    }),
  });
  assert.equal(capturedPrompts.length, 1);
  assert.doesNotMatch(capturedPrompts[0], new RegExp(canary));
});

// Test 16: no raw prompt/response text, API key, or internal exception
// message ever appears in a BenchmarkItemResult.
test("runBenchmark: BenchmarkItemResult never contains raw answer text, a raw prompt, an API key, or a raw exception message", async () => {
  const { manifest, records } = loadFixtureDataset();
  process.env.BENCHMARK_INFRA_TEST_FAKE_API_KEY = "sk-should-never-leak-abc123";
  try {
    const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...baseRunArgs() });
    const serialized = JSON.stringify(results);
    assert.doesNotMatch(serialized, /매출액|sk-should-never-leak/);
    assert.doesNotMatch(serialized, /Error:|\bat\s+\S+\s*\(/); // no stack-trace-shaped text
  } finally {
    delete process.env.BENCHMARK_INFRA_TEST_FAKE_API_KEY;
  }
});

// Test 17: canonical result SHA is deterministic across repeated runs.
test("runBenchmark: identical input produces byte-identical answer_sha256/execution_trace_sha256/scoring on repeated runs", async () => {
  const { manifest, records } = loadFixtureDataset();
  const first = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...baseRunArgs() });
  const second = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...baseRunArgs() });
  assert.equal(first[0].answer_sha256, second[0].answer_sha256);
  assert.equal(first[0].execution_trace_sha256, second[0].execution_trace_sha256);
  assert.deepEqual(stripVolatileScoring(first[0].scoring), stripVolatileScoring(second[0].scoring));
});

// Test 18: returned result objects are frozen and mutation-independent.
test("runBenchmark: returned BenchmarkItemResult objects are frozen -- mutating one run's result can never affect a second run", async () => {
  const { manifest, records } = loadFixtureDataset();
  const first = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...baseRunArgs() });
  assert.throws(() => { first[0].run_status = "TAMPERED"; }, TypeError);
  const second = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...baseRunArgs() });
  assert.equal(second[0].run_status, "OK");
});

test("sanity: fixture ids are what the fixture module exports (no drift)", () => {
  assert.equal(FIXTURE_FACT.metric_code, "REVENUE");
  assert.equal(typeof FIXTURE_EVIDENCE.evidence_id, "string");
});
