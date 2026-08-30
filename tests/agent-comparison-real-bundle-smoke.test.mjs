// Turn P1.1 clean-worktree requirement: "가능한 테스트는 승인 bundle에서 임시
// materialization해 실행" -- unlike the legacy Seed 25 E2E tests (which
// need the git-untracked work/domain-seed/ scratch data -- see
// scripts/run-agent-comparison-seed25-smoke.mjs's own documented
// limitation), THIS test needs nothing but the git-tracked
// domain/releases/bundles/seed-release-v0.20-r3.candidate/ bundle already
// present in any clone, materialized read-only via
// domain/agent-comparison/seed-bundle-harness.mjs (the same
// createSeedRuntimeServiceAdapters construction point production uses).
// It queries broadly (no fixed company/metric) rather than depending on
// the Seed 25 question list, so it runs in a genuinely clean worktree.
//
// This is NOT part of the default `npm run test:agent-comparison`
// aggregate (kept fast/fully-hermetic, no bundle I/O) -- run it via
// `npm run test:agent-comparison:real-bundle-smoke`.
import assert from "node:assert/strict";
import test from "node:test";
import { createSeedBundleHarness } from "../domain/agent-comparison/seed-bundle-harness.mjs";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createStructuredFirstFlow } from "../domain/agent-comparison/flows/structured-first-agent.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { instrumentModelAdapter, buildTelemetryEvent } from "../domain/agent-comparison/telemetry.mjs";
import { validateFinalResponse } from "../domain/runtime/final-response-validator.mjs";
import { validateTelemetryEvent } from "../domain/agent-comparison/contracts.mjs";

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 50, timeoutMs: 30000 });

let harness;
let sample;

test.before(async () => {
  harness = await createSeedBundleHarness({ root: process.cwd() });
  const probeQuery = {
    schema_version: "0.2.0", query_id: "query_real_bundle_smoke_probe", execution_scope: "OFFICIAL",
    corpus_snapshot_id: harness.context.corpus_snapshot_id, fact_coverage_snapshot_id: harness.context.fact_coverage_snapshot_id,
    targets: ["FACT"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: "2030-01-01", limit: 1,
  };
  const probeResult = await harness.serviceAdapters.structuredStoreAdapter.query(probeQuery);
  assert.equal(probeResult.status, "OK", "the real v0.20-r3 bundle must expose at least one VERIFIED Fact");
  sample = probeResult.records[0].payload;
});

test.after(async () => {
  if (harness) await harness.dispose();
});

test("real bundle smoke: a well-behaved model answer over a REAL VERIFIED Fact from the approved v0.20-r3 bundle PASSES citation binding end-to-end", async () => {
  const baseModel = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `값은 ${sample.normalized_value}입니다.`, used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
  });
  const { adapter: instrumented, usage } = instrumentModelAdapter(baseModel);
  const flow = createStructuredFirstFlow(instrumented);
  const input = { question: "real bundle smoke question", question_id: "q_real_bundle_smoke_01", hints: { corp_codes: [sample.corp_code], metric_codes: [sample.metric_code] } };
  const context = { ...harness.context, as_of_date: "2030-01-01" };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, harness.serviceAdapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.deepEqual(outcome.execution_trace.selected_evidence, sample.evidence_ids);

  const event = buildTelemetryEvent({
    benchmarkRunId: "real_bundle_smoke", agentVariantId: "STRUCTURED_FIRST", modelConfigId: "model_fake-deterministic-v1",
    executionScope: "OFFICIAL", question: input.question, questionId: input.question_id, agentOutcome: outcome, modelUsage: usage(),
  });
  assert.deepEqual(validateTelemetryEvent(event), []);
  assert.equal(event.citation_binding_status, "PASS");
  assert.equal(event.scoring_eligible, true);
});

test("real bundle smoke: a hallucinated number never present in the real VERIFIED Fact/Evidence is discarded, and the deterministic fallback contains the REAL value instead", async () => {
  const baseModel = createDeterministicFakeModelAdapter({
    responder: () => ({ text: "값은 999,999,999,999,999입니다.", used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
  });
  const flow = createStructuredFirstFlow(baseModel);
  const input = { question: "real bundle smoke hallucination question", question_id: "q_real_bundle_smoke_02", hints: { corp_codes: [sample.corp_code], metric_codes: [sample.metric_code] } };
  const context = { ...harness.context, as_of_date: "2030-01-01" };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, harness.serviceAdapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
  assert.doesNotMatch(outcome.final_response.answer, /999,999,999,999,999/);
  assert.match(outcome.final_response.answer, new RegExp(String(sample.normalized_value)));
});
