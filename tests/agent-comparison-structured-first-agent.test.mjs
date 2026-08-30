import assert from "node:assert/strict";
import test from "node:test";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createStructuredFirstFlow } from "../domain/agent-comparison/flows/structured-first-agent.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { validateFinalResponse } from "../domain/runtime/final-response-validator.mjs";
import {
  CORPUS_SNAPSHOT_ID, FACT_COVERAGE_SNAPSHOT_ID, FIXTURE_FACT, FIXTURE_UNAUTHORIZED_FACT, FIXTURE_UNAUTHORIZED_EVIDENCE,
  syntheticContext, syntheticServiceAdapters,
} from "./lib/agent-comparison-fixture.mjs";

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 20, timeoutMs: 5000 });
const BASE_INPUT = Object.freeze({ question: "매출액이 얼마인가요?", question_id: "q_synthetic", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } });

function countingResponder(fn) {
  let calls = 0;
  const responder = (request) => { calls += 1; return fn(request); };
  return { responder, callCount: () => calls };
}

test("STRUCTURED_FIRST: a fully grounded, citation-bound model answer PASSES and is returned as-is", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`,
    used_fact_ids: [FIXTURE_FACT.fact_id],
    used_evidence_ids: ["evidence_000000000000000000000001"],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(outcome.final_response.think_trace.validation.unsupported_claim_count, 0);
  assert.equal(outcome.final_response.answer, `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`);
  assert.deepEqual(outcome.execution_trace.selected_evidence, ["evidence_000000000000000000000001"]);
});

test("STRUCTURED_FIRST reports an information limit (never a guess) when no company/metric condition can be identified -- the model is never called", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const input = { question: "이 회사는 어떤가요?", question_id: "q_synthetic_02" };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.answerability, "UNANSWERABLE");
  assert.equal(outcome.final_response.think_trace.validation.reason, "NO_CONDITIONS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(callCount(), 0);
  assert.match(outcome.final_response.answer, /회사명|지표명/);
});

test("STRUCTURED_FIRST reports an information limit when the structured store has nothing for the requested condition -- the model is never called (distinct from a model-failure fallback)", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const input = { question: "매출액이 얼마인가요?", question_id: "q_synthetic_03", hints: { corp_codes: ["99999999"], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.reason, "NOT_FOUND");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(callCount(), 0);
  assert.doesNotMatch(outcome.final_response.answer, /\d{3,}/);
});

test("STRUCTURED_FIRST reports an information limit when Evidence fails validation -- the model is never called", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const adapters = syntheticServiceAdapters({ evidenceStoreAdapter: undefined, documentStoreAdapter: undefined });
  const outcome = await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.reason, "NO_GROUNDED_EVIDENCE");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(callCount(), 0);
});

test("STRUCTURED_FIRST: a model CALL failure (e.g. timeout) falls back to a deterministic, fully-grounded answer -- citation_binding_status=NOT_CHECKED (no text was ever produced to check), model_fallback_used=true, scoring_eligible=false", async () => {
  const failingModelAdapter = { generate: async () => { throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout"); } };
  const flow = createStructuredFirstFlow(failingModelAdapter);
  const outcome = await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.match(outcome.final_response.answer, new RegExp(String(FIXTURE_FACT.normalized_value)));
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "NOT_CHECKED");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
});

test("STRUCTURED_FIRST: a model answer citing an UNAUTHORIZED fact_id (never queried/grounded this request) is discarded wholesale -- citation_binding_status=FAIL, deterministic fallback used, model_fallback_used=true", async () => {
  const { responder } = countingResponder(() => ({
    text: "그럴듯하지만 근거 없는 답변입니다.",
    used_fact_ids: [FIXTURE_UNAUTHORIZED_FACT.fact_id],
    used_evidence_ids: [],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
  assert.doesNotMatch(outcome.final_response.answer, /그럴듯하지만/);
  assert.match(outcome.final_response.answer, new RegExp(String(FIXTURE_FACT.normalized_value)));
});

test("STRUCTURED_FIRST: a model answer citing an UNVALIDATED evidence_id is discarded wholesale -- citation_binding_status=FAIL", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`,
    used_fact_ids: [FIXTURE_FACT.fact_id],
    used_evidence_ids: [FIXTURE_UNAUTHORIZED_EVIDENCE.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
});

test("STRUCTURED_FIRST: a model answer inserting an unsupported NUMBER not present in the grounded Fact/Evidence data is discarded wholesale -- citation_binding_status=FAIL, unsupported_claim_count>=1", async () => {
  const { responder } = countingResponder(() => ({
    text: "매출액은 9,999,999,999원입니다.",
    used_fact_ids: [FIXTURE_FACT.fact_id],
    used_evidence_ids: ["evidence_000000000000000000000001"],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.unsupported_claim_count >= 1, true);
  assert.doesNotMatch(outcome.final_response.answer, /9,999,999,999/);
});

test("STRUCTURED_FIRST: a model answer inserting an unsupported DATE not present in the grounded Fact/Evidence data is discarded wholesale -- citation_binding_status=FAIL", async () => {
  const { responder } = countingResponder(() => ({
    text: "이 값은 2031-06-30 기준입니다.",
    used_fact_ids: [FIXTURE_FACT.fact_id],
    used_evidence_ids: ["evidence_000000000000000000000001"],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.unsupported_claim_count >= 1, true);
});

test("STRUCTURED_FIRST: a model answer inserting a DIFFERENT company's identifier (this codebase's own identity/join key is corp_code, not a name string -- domain/README.md) is discarded wholesale -- citation_binding_status=FAIL", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다 (관련 기업 코드 ${FIXTURE_UNAUTHORIZED_FACT.corp_code}).`,
    used_fact_ids: [FIXTURE_FACT.fact_id],
    used_evidence_ids: ["evidence_000000000000000000000001"],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createStructuredFirstFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, syntheticServiceAdapters());

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.doesNotMatch(outcome.final_response.answer, new RegExp(FIXTURE_UNAUTHORIZED_FACT.corp_code));
});

test("STRUCTURED_FIRST only ever queries execution_scope OFFICIAL / verification_statuses VERIFIED -- an adapter is asked to reveal a CANDIDATE record and it is never surfaced", async () => {
  let sawNonOfficialQuery = false;
  const baseAdapters = syntheticServiceAdapters();
  const guardedAdapters = {
    ...baseAdapters,
    structuredStoreAdapter: {
      async query(query) {
        if (query.execution_scope !== "OFFICIAL" || query.verification_statuses.some((s) => s !== "VERIFIED")) sawNonOfficialQuery = true;
        return baseAdapters.structuredStoreAdapter.query(query);
      },
    },
  };
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createStructuredFirstFlow(modelAdapter);
  await runAgentFlow(flow, BASE_INPUT, syntheticContext(), LIMITS, guardedAdapters);
  assert.equal(sawNonOfficialQuery, false);
});

test("sanity: fixture context/snapshot ids are what the fixture module exports (no drift between test and fixture)", () => {
  assert.equal(CORPUS_SNAPSHOT_ID, "corpus_synthetic_fixture_0001");
  assert.equal(FACT_COVERAGE_SNAPSHOT_ID, "fact_coverage_snapshot_synthetic_fixture_0001");
});
