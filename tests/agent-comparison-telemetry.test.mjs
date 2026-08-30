import assert from "node:assert/strict";
import test from "node:test";
import { instrumentModelAdapter, buildTelemetryEvent } from "../domain/agent-comparison/telemetry.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { validateTelemetryEvent } from "../domain/agent-comparison/contracts.mjs";

test("instrumentModelAdapter counts calls/tokens/cost across multiple successful generate() calls and starts a fresh wrapper at zero", async () => {
  const base = createDeterministicFakeModelAdapter({ responder: () => ({ text: "x y z", used_fact_ids: [], used_evidence_ids: [], input_tokens: 3, output_tokens: 3 }) });
  const { adapter, usage } = instrumentModelAdapter(base);
  assert.deepEqual(usage(), { model_call_attempt_count: 0, model_call_success_count: 0, model_call_failure_count: 0, model_failure_code: null, input_tokens: 0, output_tokens: 0, estimated_cost: 0 });
  await adapter.generate({ prompt: "a" });
  await adapter.generate({ prompt: "b" });
  assert.deepEqual(usage(), { model_call_attempt_count: 2, model_call_success_count: 2, model_call_failure_count: 0, model_failure_code: null, input_tokens: 6, output_tokens: 6, estimated_cost: 0 });

  const { usage: freshUsage } = instrumentModelAdapter(base);
  assert.deepEqual(freshUsage(), { model_call_attempt_count: 0, model_call_success_count: 0, model_call_failure_count: 0, model_failure_code: null, input_tokens: 0, output_tokens: 0, estimated_cost: 0 });
});

test("instrumentModelAdapter: attempt always equals success + failure, across a mix of success and failure calls, and the underlying error is rethrown unchanged", async () => {
  let call = 0;
  const flaky = { generate: async () => {
    call += 1;
    if (call % 2 === 0) throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout");
    return { text: "ok", used_fact_ids: [], used_evidence_ids: [], input_tokens: 1, output_tokens: 1, estimated_cost: 0 };
  } };
  const { adapter, usage } = instrumentModelAdapter(flaky);
  await adapter.generate({ prompt: "1" });
  await assert.rejects(() => adapter.generate({ prompt: "2" }), (error) => { assert.equal(error.code, "MODEL_CALL_TIMEOUT"); return true; });
  await adapter.generate({ prompt: "3" });
  await assert.rejects(() => adapter.generate({ prompt: "4" }));

  const snapshot = usage();
  assert.equal(snapshot.model_call_attempt_count, 4);
  assert.equal(snapshot.model_call_attempt_count, snapshot.model_call_success_count + snapshot.model_call_failure_count);
  assert.equal(snapshot.model_call_success_count, 2);
  assert.equal(snapshot.model_call_failure_count, 2);
  assert.equal(snapshot.model_failure_code, "MODEL_CALL_TIMEOUT");
});

test("instrumentModelAdapter records model_failure_code even when the underlying error has no .code (falls back to MODEL_CALL_UNKNOWN_ERROR)", async () => {
  const { adapter, usage } = instrumentModelAdapter({ generate: async () => { throw new Error("plain error, no code"); } });
  await assert.rejects(() => adapter.generate({ prompt: "x" }));
  assert.equal(usage().model_failure_code, "MODEL_CALL_UNKNOWN_ERROR");
  assert.equal(usage().model_call_failure_count, 1);
});

function fakeAgentOutcome({
  answer = "grounded answer", executionMode = "STRUCTURED", answerability = "SUPPORTED",
  validatorAttempts = [], structuredQueryCalls = 0, retrieverCalls = 0, latencyMs = 42, fallbackReason = null,
  citationBindingStatus, unsupportedClaimCount, modelFallbackUsed, scoringEligible,
} = {}) {
  const toolCalls = [
    ...Array.from({ length: structuredQueryCalls }, () => ({ service: "StructuredStore", method: "query", ok: true })),
    ...Array.from({ length: retrieverCalls }, () => ({ service: "Retriever", method: "retrieve", ok: true })),
    ...validatorAttempts.map((ok) => ({ service: "Validator", method: "validateEvidence", ok })),
  ];
  const validation = { answerability };
  if (citationBindingStatus !== undefined) validation.citation_binding_status = citationBindingStatus;
  if (unsupportedClaimCount !== undefined) validation.unsupported_claim_count = unsupportedClaimCount;
  if (modelFallbackUsed !== undefined) validation.model_fallback_used = modelFallbackUsed;
  if (scoringEligible !== undefined) validation.scoring_eligible = scoringEligible;
  return {
    final_response: {
      question: "질문", retrieved_context: [], answer,
      think_trace: { execution_mode: executionMode, operations: [], calculation: {}, validation },
    },
    execution_trace: { tool_calls: toolCalls, latency_ms: latencyMs, fallback_reason: fallbackReason },
  };
}

const ZERO_USAGE = Object.freeze({ model_call_attempt_count: 0, model_call_success_count: 0, model_call_failure_count: 0, model_failure_code: null, input_tokens: 0, output_tokens: 0, estimated_cost: 0 });

test("buildTelemetryEvent derives evidence_validation_success_rate from validateEvidence attempts (null when zero attempts) -- this is a Runtime proof-issuance rate, not a citation-accuracy score", () => {
  const zeroAttempts = buildTelemetryEvent({
    benchmarkRunId: "benchmark_run_x", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1",
    executionScope: "SANDBOX", question: "q", agentOutcome: fakeAgentOutcome({ validatorAttempts: [] }), modelUsage: ZERO_USAGE,
  });
  assert.equal(zeroAttempts.evidence_validation_success_rate, null);

  const mixedAttempts = buildTelemetryEvent({
    benchmarkRunId: "benchmark_run_x", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1",
    executionScope: "SANDBOX", question: "q", agentOutcome: fakeAgentOutcome({ validatorAttempts: [true, true, false] }), modelUsage: ZERO_USAGE,
  });
  assert.equal(mixedAttempts.evidence_validation_success_rate, 2 / 3);
});

test("buildTelemetryEvent: citation_accuracy is gone -- the field simply does not exist on a built event", () => {
  const event = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome(), modelUsage: ZERO_USAGE,
  });
  assert.equal("citation_accuracy" in event, false);
});

test("buildTelemetryEvent counts structured_query_count and document_retrieval_count independently", () => {
  const event = buildTelemetryEvent({
    benchmarkRunId: "benchmark_run_x", agentVariantId: "HYBRID_RETRIEVAL", modelConfigId: "model_fake-v1",
    executionScope: "OFFICIAL", question: "q", agentOutcome: fakeAgentOutcome({ structuredQueryCalls: 2, retrieverCalls: 3 }), modelUsage: ZERO_USAGE,
  });
  assert.equal(event.structured_query_count, 2);
  assert.equal(event.document_retrieval_count, 3);
});

test("buildTelemetryEvent: model call attempt/success/failure counts and model_failure_code come straight from modelUsage, never re-derived", () => {
  const usage = { model_call_attempt_count: 3, model_call_success_count: 1, model_call_failure_count: 2, model_failure_code: "MODEL_CALL_HTTP_ERROR", input_tokens: 40, output_tokens: 10, estimated_cost: 0.01 };
  const event = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome({ modelFallbackUsed: true, citationBindingStatus: "NOT_CHECKED" }), modelUsage: usage,
  });
  assert.equal(event.model_call_attempt_count, 3);
  assert.equal(event.model_call_success_count, 1);
  assert.equal(event.model_call_failure_count, 2);
  assert.equal(event.model_failure_code, "MODEL_CALL_HTTP_ERROR");
  assert.equal(event.input_tokens, 40);
  assert.equal(event.output_tokens, 10);
});

test("buildTelemetryEvent: scoring_eligible defaults to the negation of model_fallback_used when the Flow does not set it explicitly", () => {
  const fallbackRun = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome({ modelFallbackUsed: true, citationBindingStatus: "FAIL", unsupportedClaimCount: 1 }), modelUsage: ZERO_USAGE,
  });
  assert.equal(fallbackRun.model_fallback_used, true);
  assert.equal(fallbackRun.scoring_eligible, false);
  assert.equal(fallbackRun.citation_binding_status, "FAIL");
  assert.equal(fallbackRun.unsupported_claim_count, 1);

  const normalRun = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome({ modelFallbackUsed: false, citationBindingStatus: "PASS" }), modelUsage: ZERO_USAGE,
  });
  assert.equal(normalRun.model_fallback_used, false);
  assert.equal(normalRun.scoring_eligible, true);
});

test("buildTelemetryEvent distinguishes a normal zero-model-call information-limit answer from a model-failure fallback: both have model_fallback_used reflecting the Flow's own claim, but only the failure case has model_call_attempt_count > 0", () => {
  const infoLimit = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome({ answerability: "UNANSWERABLE", modelFallbackUsed: false, citationBindingStatus: "NOT_CHECKED", scoringEligible: true }), modelUsage: ZERO_USAGE,
  });
  assert.equal(infoLimit.model_fallback_used, false);
  assert.equal(infoLimit.model_call_attempt_count, 0);
  assert.equal(infoLimit.scoring_eligible, true);

  const failureFallback = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome({ answerability: "SUPPORTED", modelFallbackUsed: true, citationBindingStatus: "NOT_CHECKED" }),
    modelUsage: { ...ZERO_USAGE, model_call_attempt_count: 1, model_call_failure_count: 1, model_failure_code: "MODEL_CALL_TIMEOUT" },
  });
  assert.equal(failureFallback.model_fallback_used, true);
  assert.equal(failureFallback.model_call_attempt_count, 1);
  assert.equal(failureFallback.scoring_eligible, false);
  assert.equal(failureFallback.model_failure_code, "MODEL_CALL_TIMEOUT");
});

test("buildTelemetryEvent maps answerability to validation_status, and NO_CLAIM_MADE when absent", () => {
  const supported = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome({ answerability: "SUPPORTED" }), modelUsage: ZERO_USAGE,
  });
  assert.equal(supported.validation_status, "SUPPORTED");

  const noClaim = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: { final_response: { question: "q", retrieved_context: [], think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: {} }, answer: "" }, execution_trace: {} },
    modelUsage: ZERO_USAGE,
  });
  assert.equal(noClaim.validation_status, "NO_CLAIM_MADE");
});

test("buildTelemetryEvent output is always schema-valid", () => {
  const event = buildTelemetryEvent({
    benchmarkRunId: "benchmark_run_x", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1",
    executionScope: "SANDBOX", question: "q", agentOutcome: fakeAgentOutcome({ modelFallbackUsed: false, citationBindingStatus: "PASS" }),
    modelUsage: { model_call_attempt_count: 1, model_call_success_count: 1, model_call_failure_count: 0, model_failure_code: null, input_tokens: 10, output_tokens: 5, estimated_cost: 0.001 },
  });
  assert.deepEqual(validateTelemetryEvent(event), []);
});

test("buildTelemetryEvent marks timed_out true only for an ABORTED:TIMEOUT fallback_reason", () => {
  const timedOut = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome({ fallbackReason: "ABORTED:TIMEOUT" }), modelUsage: ZERO_USAGE,
  });
  assert.equal(timedOut.timed_out, true);
  assert.equal(timedOut.error_code, "ABORTED:TIMEOUT");

  const notTimedOut = buildTelemetryEvent({
    benchmarkRunId: "b", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-v1", executionScope: "OFFICIAL",
    question: "q", agentOutcome: fakeAgentOutcome({ fallbackReason: null }), modelUsage: ZERO_USAGE,
  });
  assert.equal(notTimedOut.timed_out, false);
});
