// Turn P11-A section G: connects the SAME mock HCX ModelAdapter to all four
// registered Agent variants (STRUCTURED_FIRST, HYBRID_RETRIEVAL, PLANNER,
// DOCUMENT_FIRST_RAG) through the existing, UNMODIFIED
// runFourVariantComparison integration harness
// (domain/agent-comparison/integration/four-variant-comparison.mjs) --
// none of the four flow files, variant-registry.mjs, or
// hard-claim-grounding.mjs are touched by this Turn. Only synthetic fixture
// data is used (tests/lib/agent-comparison-fixture.mjs) -- no Gold/DEV/
// HOLDOUT data, no real bundle. This file proves the wiring, not each
// variant's own internal correctness (already covered by that variant's
// own test file and by tests/agent-comparison-integration-comparison.test.mjs
// against the FAKE_DETERMINISTIC adapter) -- the only new variable here is
// that the ModelAdapter is a real HTTP-based HCX_CHAT_COMPLETIONS adapter
// talking to a real local loopback mock server instead of an in-process
// fake.
import assert from "node:assert/strict";
import test from "node:test";
import {
  runFourVariantComparison, REQUIRED_VARIANT_IDS,
} from "../domain/agent-comparison/integration/four-variant-comparison.mjs";
import { validateComparisonRecord } from "../domain/agent-comparison/integration/contracts.mjs";
import { computeAllAgentVariantRevisions } from "../domain/agent-comparison/integration/variant-revisions.mjs";
import { createModelAdapter } from "../domain/agent-comparison/model-adapter.mjs";
import { createHcxMockServer } from "../domain/agent-comparison/hcx-mock-server.mjs";
import { registerAgentVariant, listRegisteredAgentVariantIds } from "../domain/agent-comparison/variant-registry.mjs";
import { createPlannerFlow } from "../domain/agent-comparison/flows/planner-agent.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";
import { FIXTURE_FACT, FIXTURE_EVIDENCE, syntheticContext, syntheticServiceAdapters } from "./lib/agent-comparison-fixture.mjs";

const API_KEY_ENV_VAR = "AGENT_COMPARISON_HCX_FOUR_AGENT_SMOKE_KEY";
const AGENT_VARIANT_REVISIONS = computeAllAgentVariantRevisions();
const RELEASE_MANIFEST_SHA256 = "0".repeat(64);
const BUDGET_LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 5, maxToolCalls: 50, timeoutMs: 30000 });
const GROUNDED_INPUT = Object.freeze({
  question: "매출액이 얼마인가요?", question_id: "q_hcx_four_agent_smoke_01",
  hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] },
});

function hcxConfigFor(endpointUrl) {
  return {
    schema_version: "0.1.0", model_config_id: "model_hcx-four-agent-smoke-v1", kind: "HCX_CHAT_COMPLETIONS",
    provider: "hcx", model: "test-fixture-model", endpoint_url: endpointUrl, api_key_env_var: API_KEY_ENV_VAR,
    max_output_tokens: 256, temperature: 0.3, top_p: 0.8, seed_supported: false, timeout_ms: 5000,
    request_schema_version: "hcx-chat-completions-v3", response_schema_version: "hcx-chat-completions-v3",
    actual_external_call_authorized: false,
  };
}

async function withHcxMockServer(run) {
  process.env[API_KEY_ENV_VAR] = "fake-key-for-four-agent-smoke";
  const server = createHcxMockServer({ authorizedFactId: FIXTURE_FACT.fact_id, authorizedEvidenceId: FIXTURE_EVIDENCE.evidence_id, groundedAnswerText: FIXTURE_EVIDENCE.quoted_text });
  const baseUrl = await server.listen();
  try {
    await run(server, baseUrl);
  } finally {
    delete process.env[API_KEY_ENV_VAR];
    await server.close();
  }
}

// DOCUMENT_FIRST_RAG's own grounding path requires a Retriever service this
// synthetic fixture does not provide (tests/lib/agent-comparison-fixture.mjs's
// syntheticServiceAdapters() supplies structuredStore/documentStore/
// evidenceStore only) -- it legitimately reaches its own RETRIEVAL_UNAVAILABLE
// information-limit branch and attempts ZERO model calls for this input,
// exactly like tests/agent-comparison-integration-comparison.test.mjs's own
// `model_call_attempt_count <= 1` assertion already accounts for against
// FAKE_DETERMINISTIC. That is a legitimate "no claim made" outcome
// (model_fallback_used=false, scoring_eligible=true, citation_binding_status
// =NOT_CHECKED because there was no generated text to check at all) -- NOT a
// call failure -- so this helper accepts either a genuine PASS (the model
// was called and its answer verified) or that specific legitimate
// zero-call shape, and always fails on anything else (a real FAIL/failed
// call would never satisfy either branch).
function assertModelOutcomeIsPassOrLegitimateZeroCall(record) {
  assert.equal(record.run_status, "OK", record.agent_variant_id);
  assert.equal(record.scoring_eligible, true, record.agent_variant_id);
  if (record.model_call_attempt_count === 1) {
    assert.equal(record.citation_binding_status, "PASS", record.agent_variant_id);
    assert.equal(record.model_call_success_count, 1, record.agent_variant_id);
  } else {
    assert.equal(record.model_call_attempt_count, 0, record.agent_variant_id);
    assert.equal(record.citation_binding_status, "NOT_CHECKED", record.agent_variant_id);
    assert.equal(record.model_fallback_used, false, record.agent_variant_id);
  }
}

function runComparison({ server, baseUrl, scenario = "normal", overrides = {} }) {
  return runFourVariantComparison({
    variantIds: REQUIRED_VARIANT_IDS,
    modelAdapterFactory: () => createModelAdapter(hcxConfigFor(server.urlFor(baseUrl, scenario)), { allowLoopbackMockCalls: true }),
    agentVariantRevisions: AGENT_VARIANT_REVISIONS,
    modelConfig: hcxConfigFor(server.urlFor(baseUrl, scenario)),
    releaseId: "synthetic-fixture",
    releaseManifestSha256: RELEASE_MANIFEST_SHA256,
    input: GROUNDED_INPUT,
    context: syntheticContext(),
    budgetLimits: BUDGET_LIMITS,
    serviceAdapters: syntheticServiceAdapters(),
    benchmarkRunId: "benchmark_run_hcx_four_agent_smoke",
    ...overrides,
  });
}

test("all four variants execute exactly once each against the real mock-HCX adapter, every record schema-valid, each answer either PASS-verified or a legitimate zero-model-call outcome", () => withHcxMockServer(async (server, baseUrl) => {
  const records = await runComparison({ server, baseUrl });
  assert.equal(records.length, 4);
  assert.deepEqual([...new Set(records.map((r) => r.agent_variant_id))].sort(), [...REQUIRED_VARIANT_IDS].sort());
  for (const record of records) {
    assert.deepEqual(validateComparisonRecord(record), [], record.agent_variant_id);
    assertModelOutcomeIsPassOrLegitimateZeroCall(record);
  }
  // At least the three variants whose own grounding path does not require a
  // Retriever service actually called the real mock-HCX adapter this run --
  // proves the wiring is genuinely exercised, not just vacuously "legitimate
  // zero-call" for every variant.
  assert.ok(records.filter((r) => r.model_call_attempt_count === 1).length >= 3);
}));

test("one variant's ModelAdapter usage never contaminates another's telemetry against the real mock-HCX adapter (each gets its own instrumented adapter + its own loopback connection)", () => withHcxMockServer(async (server, baseUrl) => {
  const records = await runComparison({ server, baseUrl });
  for (const record of records) assert.ok(record.model_call_attempt_count <= 1, `${record.agent_variant_id} attempted the model more than once for one question`);
  // Every variant that actually attempted a call succeeded exactly once --
  // no variant's success/failure count reflects another variant's call.
  for (const record of records) {
    if (record.model_call_attempt_count === 1) assert.equal(record.model_call_success_count, 1, record.agent_variant_id);
  }
}));

test("forcing ONE variant (PLANNER) to fail leaves the other three running normally against the same mock-HCX adapter, records an honest FAILED status, never leaks a raw exception message", () => withHcxMockServer(async (server, baseUrl) => {
  const secretMessage = "internal-stack-trace-detail-that-must-never-leak";
  registerAgentVariant("PLANNER", () => { throw new Error(secretMessage); });
  try {
    const records = await runComparison({ server, baseUrl });
    const byId = Object.fromEntries(records.map((r) => [r.agent_variant_id, r]));

    assert.equal(byId.PLANNER.run_status, "FAILED");
    assert.equal(byId.PLANNER.scoring_eligible, false);
    assert.equal(byId.PLANNER.model_call_attempt_count, 0);
    assert.notEqual(byId.PLANNER.model_failure_code, secretMessage);
    assert.deepEqual(validateComparisonRecord(byId.PLANNER), []);

    for (const variantId of ["STRUCTURED_FIRST", "HYBRID_RETRIEVAL", "DOCUMENT_FIRST_RAG"]) {
      assert.equal(byId[variantId].run_status, "OK", `${variantId} should have run normally despite PLANNER failing`);
      assertModelOutcomeIsPassOrLegitimateZeroCall(byId[variantId]);
    }
  } finally {
    registerAgentVariant("PLANNER", (modelAdapter, options) => createPlannerFlow(modelAdapter, options));
    assert.ok(listRegisteredAgentVariantIds().includes("PLANNER"));
  }
}));

test("an unauthorized evidence_id citation from the mock-HCX adapter is rejected fail-closed through the full integration harness (STRUCTURED_FIRST): citation_binding_status=FAIL, scoring_eligible=false", () => withHcxMockServer(async (server, baseUrl) => {
  const records = await runComparison({ server, baseUrl, scenario: "unauthorized-evidence", overrides: { variantIds: ["STRUCTURED_FIRST"] } });
  const record = records[0];
  assert.equal(record.citation_binding_status, "FAIL");
  assert.equal(record.scoring_eligible, false);
  assert.deepEqual(validateComparisonRecord(record), []);
}));

test("a tampered (unsupported) number hallucination from the mock-HCX adapter is rejected fail-closed through the full integration harness (STRUCTURED_FIRST)", () => withHcxMockServer(async (server, baseUrl) => {
  const records = await runComparison({ server, baseUrl, scenario: "tampered-number", overrides: { variantIds: ["STRUCTURED_FIRST"] } });
  const record = records[0];
  assert.equal(record.citation_binding_status, "FAIL");
  assert.ok(record.unsupported_claim_count >= 1);
  assert.equal(record.scoring_eligible, false);
}));

test("a genuine mock-HCX call FAILURE (HTTP 500, not a post-generation rejection) is distinguished as citation_binding_status=NOT_CHECKED with a real model_failure_code, still scoring_eligible=false", () => withHcxMockServer(async (server, baseUrl) => {
  const records = await runComparison({ server, baseUrl, scenario: "http-500", overrides: { variantIds: ["STRUCTURED_FIRST"] } });
  const record = records[0];
  assert.equal(record.citation_binding_status, "NOT_CHECKED");
  assert.equal(record.model_fallback_used, true);
  assert.equal(record.scoring_eligible, false);
  assert.equal(record.model_failure_code, "MODEL_CALL_HTTP_ERROR");
}));

test("execution order does not change a variant's own answer_sha256/execution_trace_sha256 across the real mock-HCX adapter (5 distinct orders)", () => withHcxMockServer(async (server, baseUrl) => {
  const orders = [
    REQUIRED_VARIANT_IDS,
    [...REQUIRED_VARIANT_IDS].reverse(),
    ["PLANNER", "DOCUMENT_FIRST_RAG", "STRUCTURED_FIRST", "HYBRID_RETRIEVAL"],
    ["HYBRID_RETRIEVAL", "STRUCTURED_FIRST", "DOCUMENT_FIRST_RAG", "PLANNER"],
    ["DOCUMENT_FIRST_RAG", "PLANNER", "HYBRID_RETRIEVAL", "STRUCTURED_FIRST"],
  ];
  const runs = [];
  for (const variantIds of orders) {
     
    const records = await runComparison({ server, baseUrl, overrides: { variantIds } });
    runs.push(Object.fromEntries(records.map((r) => [r.agent_variant_id, r])));
  }
  for (const variantId of REQUIRED_VARIANT_IDS) {
    const answerHashes = new Set(runs.map((r) => r[variantId].answer_sha256));
    const traceHashes = new Set(runs.map((r) => r[variantId].execution_trace_sha256));
    assert.equal(answerHashes.size, 1, `${variantId}: answer_sha256 differed across execution orders`);
    assert.equal(traceHashes.size, 1, `${variantId}: execution_trace_sha256 differed across execution orders`);
  }
}));
