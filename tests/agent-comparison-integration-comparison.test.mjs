// Turn P3: tests the INTEGRATION harness itself (four-variant-comparison.mjs)
// -- isolation, order independence, failure containment, telemetry
// non-contamination, and that a fail-closed citation-binding/hard-claim
// verdict from a variant (already unit-tested in that variant's own test
// file) is faithfully surfaced through to the harness's ComparisonRecord.
// This file does NOT re-derive each variant's own internal correctness --
// see tests/agent-comparison-{hybrid-retrieval,planner,document-first-rag}.test.mjs
// and tests/agent-comparison-structured-first-agent.test.mjs for that.
import assert from "node:assert/strict";
import test from "node:test";
import {
  runFourVariantComparison, REQUIRED_VARIANT_IDS,
} from "../domain/agent-comparison/integration/four-variant-comparison.mjs";
import { validateComparisonRecord } from "../domain/agent-comparison/integration/contracts.mjs";
import { computeAllAgentVariantRevisions } from "../domain/agent-comparison/integration/variant-revisions.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { createPlannerFlow } from "../domain/agent-comparison/flows/planner-agent.mjs";
import { registerAgentVariant, listRegisteredAgentVariantIds } from "../domain/agent-comparison/variant-registry.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";
import {
  FIXTURE_FACT, FIXTURE_UNAUTHORIZED_FACT, syntheticContext, syntheticServiceAdapters,
} from "./lib/agent-comparison-fixture.mjs";

const MODEL_CONFIG = Object.freeze({
  schema_version: "0.1.0", model_config_id: "model_fake-deterministic-v1", kind: "FAKE_DETERMINISTIC",
  provider: "test-fixture", model: "deterministic-fake-v1",
});
const RELEASE_MANIFEST_SHA256 = "0".repeat(64);
const AGENT_VARIANT_REVISIONS = computeAllAgentVariantRevisions();
const BUDGET_LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 5, maxToolCalls: 50, timeoutMs: 30000 });
const GROUNDED_INPUT = Object.freeze({
  question: "매출액이 얼마인가요?", question_id: "q_integration_01",
  hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] },
});

function wellBehavedResponder() {
  return { text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`, used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: ["evidence_000000000000000000000001"] };
}

function runComparison(overrides = {}) {
  return runFourVariantComparison({
    variantIds: REQUIRED_VARIANT_IDS,
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({ responder: wellBehavedResponder }),
    agentVariantRevisions: AGENT_VARIANT_REVISIONS,
    modelConfig: MODEL_CONFIG,
    releaseId: "synthetic-fixture",
    releaseManifestSha256: RELEASE_MANIFEST_SHA256,
    input: GROUNDED_INPUT,
    context: syntheticContext(),
    budgetLimits: BUDGET_LIMITS,
    serviceAdapters: syntheticServiceAdapters(),
    benchmarkRunId: "benchmark_run_integration_test",
    ...overrides,
  });
}

test("all four variants execute exactly once each over the same input, every record schema-valid", async () => {
  const records = await runComparison();
  assert.equal(records.length, 4);
  assert.deepEqual([...new Set(records.map((r) => r.agent_variant_id))].sort(), [...REQUIRED_VARIANT_IDS].sort());
  for (const record of records) assert.deepEqual(validateComparisonRecord(record), [], record.agent_variant_id);
});

test("all four records share the same model_config_sha256, release_id, and release_manifest_sha256 -- the same ModelConfig/release pin was injected into every variant", async () => {
  const records = await runComparison();
  assert.equal(new Set(records.map((r) => r.model_config_sha256)).size, 1);
  assert.equal(new Set(records.map((r) => r.release_id)).size, 1);
  assert.equal(new Set(records.map((r) => r.release_manifest_sha256)).size, 1);
  assert.equal(new Set(records.map((r) => r.dataset_item_id)).size, 1);
  assert.equal(records[0].dataset_item_id, "q_integration_01");
});

test("execution order does not change a variant's own answer_sha256/execution_trace_sha256 (4+ distinct orders)", async () => {
  const orders = [
    REQUIRED_VARIANT_IDS,
    [...REQUIRED_VARIANT_IDS].reverse(),
    ["PLANNER", "DOCUMENT_FIRST_RAG", "STRUCTURED_FIRST", "HYBRID_RETRIEVAL"],
    ["HYBRID_RETRIEVAL", "STRUCTURED_FIRST", "DOCUMENT_FIRST_RAG", "PLANNER"],
    ["DOCUMENT_FIRST_RAG", "PLANNER", "HYBRID_RETRIEVAL", "STRUCTURED_FIRST"],
  ];
  const runs = [];
  for (const variantIds of orders) {
    // eslint-disable-next-line no-await-in-loop
    const records = await runComparison({ variantIds });
    runs.push(Object.fromEntries(records.map((r) => [r.agent_variant_id, r])));
  }
  for (const variantId of REQUIRED_VARIANT_IDS) {
    const answerHashes = new Set(runs.map((r) => r[variantId].answer_sha256));
    const traceHashes = new Set(runs.map((r) => r[variantId].execution_trace_sha256));
    const runStatuses = new Set(runs.map((r) => r[variantId].run_status));
    assert.equal(answerHashes.size, 1, `${variantId}: answer_sha256 differed across execution orders`);
    assert.equal(traceHashes.size, 1, `${variantId}: execution_trace_sha256 differed across execution orders`);
    assert.equal(runStatuses.size, 1, `${variantId}: run_status differed across execution orders`);
  }
});

test("one variant's ModelAdapter usage never contaminates another's telemetry (each gets its own instrumented adapter)", async () => {
  let totalCalls = 0;
  const records = await runComparison({
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({
      responder: (request) => { totalCalls += 1; return wellBehavedResponder(request); },
    }),
  });
  // Every variant that actually calls the model does so at most once for
  // this single grounded question -- no variant's count reflects another
  // variant's calls (which would show up as attempt counts > 1 or a sum
  // mismatching totalCalls).
  const attemptSum = records.reduce((sum, r) => sum + r.model_call_attempt_count, 0);
  assert.equal(attemptSum, totalCalls);
  for (const record of records) assert.ok(record.model_call_attempt_count <= 1, `${record.agent_variant_id} attempted the model more than once for one question`);
});

test("forcing ONE variant (PLANNER) to fail leaves the other three running normally, records an honest FAILED status, and never leaks the raw exception message", async () => {
  const secretMessage = "internal-stack-trace-detail-that-must-never-leak";
  registerAgentVariant("PLANNER", () => { throw new Error(secretMessage); });
  try {
    const records = await runComparison();
    const byId = Object.fromEntries(records.map((r) => [r.agent_variant_id, r]));

    assert.equal(byId.PLANNER.run_status, "FAILED");
    assert.equal(byId.PLANNER.scoring_eligible, false);
    assert.equal(byId.PLANNER.model_call_attempt_count, 0);
    assert.equal(byId.PLANNER.answer_sha256, null);
    assert.equal(byId.PLANNER.execution_trace_sha256, null);
    assert.notEqual(byId.PLANNER.model_failure_code, null);
    assert.notEqual(byId.PLANNER.model_failure_code, secretMessage);
    assert.deepEqual(validateComparisonRecord(byId.PLANNER), []);

    for (const variantId of ["STRUCTURED_FIRST", "HYBRID_RETRIEVAL", "DOCUMENT_FIRST_RAG"]) {
      assert.equal(byId[variantId].run_status, "OK", `${variantId} should have run normally despite PLANNER failing`);
    }
  } finally {
    // Restore the REAL PLANNER registration -- registerAgentVariant simply
    // overwrites the registry map entry, so re-calling it with the actual
    // factory (imported directly from the unmodified flow file) fully
    // undoes the sabotage for every test file that runs after this one.
    registerAgentVariant("PLANNER", (modelAdapter, options) => createPlannerFlow(modelAdapter, options));
    assert.ok(listRegisteredAgentVariantIds().includes("PLANNER"));
  }
});

test("a run_status=FAILED record is never scoring_eligible=true (fail-closed, not disguised as success)", async () => {
  registerAgentVariant("HYBRID_RETRIEVAL", () => { throw new Error("simulated"); });
  try {
    const records = await runComparison();
    const failed = records.find((r) => r.agent_variant_id === "HYBRID_RETRIEVAL");
    assert.equal(failed.run_status, "FAILED");
    assert.equal(failed.scoring_eligible, false);
  } finally {
    const { createHybridRetrievalFlow } = await import("../domain/agent-comparison/flows/hybrid-retrieval-agent.mjs");
    registerAgentVariant("HYBRID_RETRIEVAL", (modelAdapter, options) => createHybridRetrievalFlow(modelAdapter, options));
  }
});

test("an unauthorized fact_id citation is rejected fail-closed through the full integration harness (STRUCTURED_FIRST): citation_binding_status=FAIL, model_fallback_used implied by scoring_eligible=false, answer never contains the unauthorized value", async () => {
  const records = await runComparison({
    variantIds: ["STRUCTURED_FIRST"],
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({
      responder: () => ({ text: "그럴듯하지만 근거 없는 답변입니다.", used_fact_ids: [FIXTURE_UNAUTHORIZED_FACT.fact_id], used_evidence_ids: [] }),
    }),
  });
  const record = records[0];
  assert.equal(record.citation_binding_status, "FAIL");
  assert.equal(record.scoring_eligible, false);
  assert.deepEqual(validateComparisonRecord(record), []);
});

test("an unsupported number hallucination is rejected fail-closed through the full integration harness (STRUCTURED_FIRST): unsupported_claim_count >= 1", async () => {
  const records = await runComparison({
    variantIds: ["STRUCTURED_FIRST"],
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({
      responder: () => ({ text: "매출액은 9,999,999,999원입니다.", used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: ["evidence_000000000000000000000001"] }),
    }),
  });
  const record = records[0];
  assert.equal(record.citation_binding_status, "FAIL");
  assert.ok(record.unsupported_claim_count >= 1);
  assert.equal(record.scoring_eligible, false);
});

test("a genuine model CALL failure (not a post-generation rejection) is distinguished as citation_binding_status=NOT_CHECKED with a real model_failure_code, still scoring_eligible=false", async () => {
  const records = await runComparison({
    variantIds: ["STRUCTURED_FIRST"],
    modelAdapterFactory: () => ({ generate: async () => { const err = new Error("simulated"); err.code = "MODEL_CALL_TIMEOUT"; throw err; } }),
  });
  const record = records[0];
  assert.equal(record.citation_binding_status, "NOT_CHECKED");
  assert.equal(record.model_fallback_used, true);
  assert.equal(record.scoring_eligible, false);
  assert.equal(record.model_failure_code, "MODEL_CALL_TIMEOUT");
});

test("a legitimate zero-model-call information limit (no company/metric condition) is scoring_eligible=true, distinct from a model-failure fallback", async () => {
  const records = await runComparison({
    variantIds: ["STRUCTURED_FIRST"],
    input: { question: "이 회사는 어떤가요?", question_id: "q_integration_no_conditions" },
  });
  const record = records[0];
  assert.equal(record.model_call_attempt_count, 0);
  assert.equal(record.model_fallback_used, false);
  assert.equal(record.scoring_eligible, true);
});
