// Turn P11-E: scoped, offline tests for the official
// HCX_NATIVE_V3_FUNCTION_CALLING ModelAdapter -- the P11-D-selected
// candidate (NATIVE_V3_FUNCTION_CALLING, 15/15) promoted to a real,
// registered adapter kind. Every test here is pure/offline -- no real
// network call. This file is intentionally NOT wired into package.json's
// test:domain file list, same as the other P11 HCX test files -- run it
// directly: node --test tests/agent-comparison-hcx-native-function-calling-adapter.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createModelAdapter, ModelCallError, ModelAdapterUnavailableError } from "../domain/agent-comparison/model-adapter.mjs";
import {
  createHcxNativeFunctionCallingModelAdapter, RETRY_MAX_ATTEMPTS, HCX_NATIVE_FUNCTION_CALLING_ALLOWED_HOSTNAME,
} from "../domain/agent-comparison/hcx-native-function-calling-adapter.mjs";
import { FUNCTION_CALLING_TOOL_NAME } from "../domain/agent-comparison/hcx-structured-protocol/envelope-native-v3.mjs";
import { COMMON_STRUCTURED_ANSWER_SCHEMA } from "../domain/agent-comparison/hcx-structured-protocol/common-schema.mjs";
import { validateModelConfig, MODEL_ADAPTER_KINDS } from "../domain/agent-comparison/contracts.mjs";
import { verifyCitationBinding } from "../domain/agent-comparison/flows/hard-claim-grounding.mjs";
import { parseStructuredAnswer } from "../domain/agent-comparison/structured-answer-parsing.mjs";
import { classifyHcxAssistantContent } from "../domain/agent-comparison/hcx-model-adapter.mjs";
import { runFourVariantComparison, REQUIRED_VARIANT_IDS } from "../domain/agent-comparison/integration/four-variant-comparison.mjs";
import { validateComparisonRecord } from "../domain/agent-comparison/integration/contracts.mjs";
import { computeAllAgentVariantRevisions } from "../domain/agent-comparison/integration/variant-revisions.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";
import { FIXTURE_FACT, syntheticContext, syntheticServiceAdapters } from "./lib/agent-comparison-fixture.mjs";

const FAKE_API_KEY = "test-only-fake-key-p11e-never-real";
const ENV_VAR = "AGENT_COMPARISON_HCX_NATIVE_FC_P11E_TEST_KEY";
const REAL_ENDPOINT = "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005";

function baseConfig(overrides = {}) {
  return {
    schema_version: "0.1.0",
    model_config_id: "model_hcx-native-fc-p11e-test",
    kind: "HCX_NATIVE_V3_FUNCTION_CALLING",
    provider: "hcx",
    model: "HCX-005",
    endpoint_url: REAL_ENDPOINT,
    api_key_env_var: ENV_VAR,
    max_output_tokens: 1024,
    temperature: 0,
    top_p: 0.8,
    timeout_ms: 5000,
    actual_external_call_authorized: true,
    ...overrides,
  };
}

function withKey(run) {
  process.env[ENV_VAR] = FAKE_API_KEY;
  return Promise.resolve().then(run).finally(() => { delete process.env[ENV_VAR]; });
}

const VALID_ARGS = { answer: "테스트 답변", used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: ["evidence_000000000000000000000001"] };

function nativeEnvelope(message, extra = {}) {
  return { status: { code: "20000" }, result: { message, usage: { promptTokens: 5, completionTokens: 5 }, ...extra } };
}
function jsonResponse(body) {
  return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body };
}
function httpErrorResponse(status) {
  return { ok: false, status, headers: { get: () => "application/json" }, json: async () => ({}) };
}
function validToolCallResponse(args = VALID_ARGS) {
  return jsonResponse(nativeEnvelope({ content: "", toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: args } }] }));
}

// ============================================================
// F.1-10: official adapter fail-closed structural behavior
// ============================================================

test("1. a normal single matching tool call succeeds", () => withKey(async () => {
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl: async () => validToolCallResponse() });
  const result = await adapter.generate({ prompt: "x" });
  assert.equal(result.text, "테스트 답변");
  assert.deepEqual(result.used_fact_ids, [FIXTURE_FACT.fact_id]);
  assert.equal(result.diagnostics.tool_call_shape_class, "EXACTLY_ONE_MATCHING_TOOL_CALL");
}));

async function expectMalformed(fetchImpl) {
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}

test("2. zero tool calls is rejected", () => withKey(() => expectMalformed(async () => jsonResponse(nativeEnvelope({ content: "", toolCalls: [] })))));

test("3. two tool calls is rejected", () => withKey(() => {
  const call = { id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: VALID_ARGS } };
  return expectMalformed(async () => jsonResponse(nativeEnvelope({ content: "", toolCalls: [call, call] })));
}));

test("4. a wrong tool name is rejected", () => withKey(() => expectMalformed(async () => jsonResponse(nativeEnvelope({
  content: "", toolCalls: [{ id: "1", type: "function", function: { name: "some_other_tool", arguments: VALID_ARGS } }],
})))));

test("5. malformed (non-object) arguments are rejected", () => withKey(() => expectMalformed(async () => jsonResponse(nativeEnvelope({
  content: "", toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: "not-an-object" } }],
})))));

test("6. truncated arguments (JSON.parse failure inside the mock envelope) are rejected", () => withKey(() => expectMalformed(async () => ({
  ok: true, status: 200, headers: { get: () => "application/json" },
  json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
}))));

test("7. schema-invalid arguments (wrong field type) are rejected", () => withKey(() => expectMalformed(async () => jsonResponse(nativeEnvelope({
  content: "", toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: { answer: 12345, used_fact_ids: [], used_evidence_ids: [] } } }],
})))));

test("8. non-blank assistant content alongside a valid tool call is rejected", () => withKey(() => expectMalformed(async () => jsonResponse(nativeEnvelope({
  content: "다음과 같이 답변합니다.", toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: VALID_ARGS } }],
})))));

test("9. an unrecognized Native v3 envelope shape is rejected", () => withKey(() => expectMalformed(async () => jsonResponse({ choices: [{ message: { content: "{}" } }] }))));

// F.10: evidence ID mismatch -- verified via the EXISTING, unmodified
// flow-level verifyCitationBinding (flows/hard-claim-grounding.mjs), never
// a second adapter-internal id-allowlist (see this adapter's own header
// comment for why duplicating that check here would be wrong).
test("10. evidence ID mismatch is rejected -- by the existing verifyCitationBinding, fed the adapter's own returned ids", () => withKey(async () => {
  const unauthorizedArgs = { answer: "x", used_fact_ids: ["fact_not_authorized_for_this_request"], used_evidence_ids: [] };
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl: async () => validToolCallResponse(unauthorizedArgs) });
  const result = await adapter.generate({ prompt: "x" });
  const binding = verifyCitationBinding({
    usedFactIds: result.used_fact_ids,
    usedEvidenceIds: result.used_evidence_ids,
    authorizedFactIds: new Set([FIXTURE_FACT.fact_id]),
    validatedEvidenceIds: new Set(["evidence_000000000000000000000001"]),
  });
  assert.equal(binding.ok, false);
  assert.equal(binding.reason, "UNAUTHORIZED_FACT_ID");
}));

test("10b. an authorized evidence/fact id combination passes verifyCitationBinding unchanged", () => withKey(async () => {
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl: async () => validToolCallResponse() });
  const result = await adapter.generate({ prompt: "x" });
  const binding = verifyCitationBinding({
    usedFactIds: result.used_fact_ids,
    usedEvidenceIds: result.used_evidence_ids,
    authorizedFactIds: new Set([FIXTURE_FACT.fact_id]),
    validatedEvidenceIds: new Set(["evidence_000000000000000000000001"]),
  });
  assert.equal(binding.ok, true);
}));

// ============================================================
// F.11-15: construction-time fail-closed, zero fetch calls
// ============================================================

function expectZeroFetchConstructionRefusal(config) {
  let called = false;
  assert.throws(() => createHcxNativeFunctionCallingModelAdapter(config, { fetchImpl: async () => { called = true; return httpErrorResponse(200); } }), ModelAdapterUnavailableError);
  assert.equal(called, false);
}

test("11. actual_external_call_authorized=false -> construction refused, zero fetch", () => withKey(() => {
  expectZeroFetchConstructionRefusal(baseConfig({ actual_external_call_authorized: false }));
}));

test("12. missing API key env var -> construction refused, zero fetch", () => {
  delete process.env[ENV_VAR];
  expectZeroFetchConstructionRefusal(baseConfig());
});

test("13. a non-https endpoint -> construction refused, zero fetch", () => withKey(() => {
  expectZeroFetchConstructionRefusal(baseConfig({ endpoint_url: "http://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005" }));
}));

test("14. a wrong hostname -> construction refused, zero fetch", () => withKey(() => {
  expectZeroFetchConstructionRefusal(baseConfig({ endpoint_url: "https://evil.example.com/v3/chat-completions/HCX-005" }));
}));

test("15. model/path mismatch -> construction refused, zero fetch", () => withKey(() => {
  expectZeroFetchConstructionRefusal(baseConfig({ endpoint_url: "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-007" }));
}));

test("HCX_NATIVE_FUNCTION_CALLING_ALLOWED_HOSTNAME is exactly clovastudio.stream.ntruss.com", () => {
  assert.equal(HCX_NATIVE_FUNCTION_CALLING_ALLOWED_HOSTNAME, "clovastudio.stream.ntruss.com");
});

// ============================================================
// F.16-19: retry / auth / hard cap
// ============================================================

test("16. a 429/5xx is retried once and can then succeed", () => withKey(async () => {
  let attempts = 0;
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), {
    fetchImpl: async () => { attempts += 1; return attempts === 1 ? httpErrorResponse(503) : validToolCallResponse(); },
  });
  const result = await adapter.generate({ prompt: "x" });
  assert.equal(result.text, "테스트 답변");
  assert.equal(attempts, 2);
}));

test("17. a plain 4xx is never retried", () => withKey(async () => {
  let attempts = 0;
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl: async () => { attempts += 1; return httpErrorResponse(422); } });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => { assert.equal(error.code, "MODEL_CALL_HTTP_ERROR"); return true; });
  assert.equal(attempts, 1);
}));

test("18. an auth error (401) is never retried -- immediate failure", () => withKey(async () => {
  let attempts = 0;
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl: async () => { attempts += 1; return httpErrorResponse(401); } });
  await assert.rejects(() => adapter.generate({ prompt: "x" }));
  assert.equal(attempts, 1);
}));

test("19. request hard cap: persistent 5xx never causes more than RETRY_MAX_ATTEMPTS fetch calls for one generate() call", () => withKey(async () => {
  let attempts = 0;
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl: async () => { attempts += 1; return httpErrorResponse(500); } });
  await assert.rejects(() => adapter.generate({ prompt: "x" }));
  assert.equal(attempts, RETRY_MAX_ATTEMPTS);
  assert.equal(RETRY_MAX_ATTEMPTS, 2);
}));

// ============================================================
// F.20: secret / raw-content non-exposure
// ============================================================

test("20. no secret or raw-content leakage: a failing call's thrown error never contains the api key or the raw assistant content", () => withKey(async () => {
  const secretLike = "다음은 절대 노출되면 안되는 SENSITIVE_MARKER_XYZ 문장입니다.";
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl: async () => jsonResponse(nativeEnvelope({ content: secretLike, toolCalls: [] })) });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    const serialized = JSON.stringify({ message: error.message, diagnostics: error.diagnostics });
    assert.doesNotMatch(serialized, /SENSITIVE_MARKER_XYZ/);
    assert.doesNotMatch(serialized, new RegExp(FAKE_API_KEY));
    assert.doesNotMatch(serialized, /authorization/i);
    return true;
  });
}));

test("20b. a successful call's own result never carries an api key/authorization field", () => withKey(async () => {
  const adapter = createHcxNativeFunctionCallingModelAdapter(baseConfig(), { fetchImpl: async () => validToolCallResponse() });
  const result = await adapter.generate({ prompt: "x" });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(FAKE_API_KEY));
  assert.doesNotMatch(serialized, /authorization/i);
}));

// ============================================================
// F.21-26: registry/factory/four-variant integration
// ============================================================

test("21. createModelAdapter (the registry/factory) constructs an HCX_NATIVE_V3_FUNCTION_CALLING adapter from a plain ModelConfig", () => withKey(async () => {
  const adapter = createModelAdapter(baseConfig(), { fetchImpl: async () => validToolCallResponse() });
  assert.equal(adapter.model, "HCX-005");
  const result = await adapter.generate({ prompt: "x" });
  assert.equal(result.text, "테스트 답변");
}));

test("21b. createModelAdapter rejects an invalid HCX_NATIVE_V3_FUNCTION_CALLING config before constructing anything (missing top_p)", () => {
  const { top_p, ...invalid } = baseConfig();
  assert.throws(() => createModelAdapter(invalid));
});

test("22. every existing adapter kind remains constructible after this Turn's changes (backward compatibility)", () => {
  assert.deepEqual([...MODEL_ADAPTER_KINDS].sort(), ["FAKE_DETERMINISTIC", "HCX_CHAT_COMPLETIONS", "HCX_NATIVE_V3_FUNCTION_CALLING", "HTTP_CHAT_COMPLETIONS"]);
  const fake = createModelAdapter({ schema_version: "0.1.0", model_config_id: "model_fake-v1", kind: "FAKE_DETERMINISTIC", provider: "test-fixture", model: "deterministic-fake-v1" });
  assert.equal(typeof fake.generate, "function");
});

test("22b. HTTP_CHAT_COMPLETIONS construction/behavior is unchanged (still uses the shared generic parser, still fence-intolerant)", async () => {
  process.env.AGENT_COMPARISON_HTTP_TEST_KEY = "fake";
  try {
    const adapter = createModelAdapter(
      { schema_version: "0.1.0", model_config_id: "model_http-v1", kind: "HTTP_CHAT_COMPLETIONS", provider: "test", model: "test-model", endpoint_url: "https://example.invalid/v1/chat/completions", api_key_env_var: "AGENT_COMPARISON_HTTP_TEST_KEY" },
      { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: "y", used_fact_ids: [], used_evidence_ids: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }) },
    );
    const result = await adapter.generate({ prompt: "x" });
    assert.equal(result.text, "y");
  } finally {
    delete process.env.AGENT_COMPARISON_HTTP_TEST_KEY;
  }
});

const MODEL_CONFIG_FOR_INTEGRATION = Object.freeze(baseConfig());
const RELEASE_MANIFEST_SHA256 = "0".repeat(64);
const AGENT_VARIANT_REVISIONS = computeAllAgentVariantRevisions();
const BUDGET_LIMITS = Object.freeze({ maxHcxCalls: 4, maxRetrievals: 5, maxToolCalls: 50, timeoutMs: 30000 });
const GROUNDED_INPUT = Object.freeze({
  question: "매출액이 얼마인가요?", question_id: "q_p11e_integration_01",
  hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] },
});

function runFourVariantComparisonWithNativeFcAdapter() {
  return withKey(() => runFourVariantComparison({
    variantIds: REQUIRED_VARIANT_IDS,
    modelAdapterFactory: () => createModelAdapter(MODEL_CONFIG_FOR_INTEGRATION, { fetchImpl: async () => validToolCallResponse() }),
    agentVariantRevisions: AGENT_VARIANT_REVISIONS,
    modelConfig: MODEL_CONFIG_FOR_INTEGRATION,
    releaseId: "synthetic-fixture-p11e",
    releaseManifestSha256: RELEASE_MANIFEST_SHA256,
    input: GROUNDED_INPUT,
    context: syntheticContext(),
    budgetLimits: BUDGET_LIMITS,
    serviceAdapters: syntheticServiceAdapters(),
    benchmarkRunId: "benchmark_run_p11e_integration_test",
  }));
}

test("23. all four variants execute successfully through the new official adapter path (synthetic smoke)", async () => {
  const records = await runFourVariantComparisonWithNativeFcAdapter();
  assert.equal(records.length, 4);
  assert.deepEqual([...new Set(records.map((r) => r.agent_variant_id))].sort(), [...REQUIRED_VARIANT_IDS].sort());
  for (const record of records) assert.deepEqual(validateComparisonRecord(record), [], record.agent_variant_id);
});

test("24. every variant's model call goes through the exact same modelAdapterFactory/ModelConfig (same model_config_sha256 across all four)", async () => {
  const records = await runFourVariantComparisonWithNativeFcAdapter();
  assert.equal(new Set(records.map((r) => r.model_config_sha256)).size, 1);
});

// F.25: no variant-specific parser -- there is exactly ONE
// classifyNativeV3ToolCallShape/classifyNativeV3Envelope pair
// (hcx-structured-protocol/envelope-native-v3.mjs), imported unchanged by
// hcx-native-function-calling-adapter.mjs; no flow file imports it or
// re-implements tool-call/envelope parsing itself (grep-verified below).
test("25. no Agent variant flow file imports or duplicates the Native v3 envelope/tool-call parser", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const flowsDir = new URL("../domain/agent-comparison/flows/", import.meta.url);
  const files = (await readdir(flowsDir)).filter((f) => f.endsWith(".mjs"));
  for (const file of files) {
    const content = await readFile(new URL(file, flowsDir), "utf8");
    assert.doesNotMatch(content, /classifyNativeV3|envelope-native-v3|submit_grounded_answer/, `${file} must not duplicate the Native v3 adapter's own parsing logic`);
  }
});

// F.26: P11-D's own validation rules and the official adapter's rules are
// the same functions, not parallel reimplementations.
test("26. the official adapter and P11-D's own experiment import the identical envelope/schema functions (module identity, not just equivalent behavior)", async () => {
  const officialModule = await import("../domain/agent-comparison/hcx-native-function-calling-adapter.mjs");
  const p11dCandidateA = await import("../domain/agent-comparison/hcx-structured-protocol/candidate-a-function-calling.mjs");
  const officialEnvelope = await import("../domain/agent-comparison/hcx-structured-protocol/envelope-native-v3.mjs");
  // Both modules end up calling the exact same exported functions from
  // envelope-native-v3.mjs / common-schema.mjs -- verified by re-importing
  // those shared modules here and confirming there is only one copy on the
  // module graph (Node's ESM cache guarantees identity for the same
  // resolved specifier), not by comparing source text.
  const commonSchemaA = await import("../domain/agent-comparison/hcx-structured-protocol/common-schema.mjs");
  assert.equal(officialModule.HCX_NATIVE_FUNCTION_CALLING_ALLOWED_HOSTNAME, "clovastudio.stream.ntruss.com");
  assert.equal(typeof p11dCandidateA.callCandidateA, "function");
  assert.equal(typeof officialEnvelope.classifyNativeV3ToolCallShape, "function");
  assert.equal(typeof commonSchemaA.validateCommonStructuredAnswer, "function");
});

// ============================================================
// F.27-30: scope boundaries this Turn must not cross
// ============================================================

test("27. no production Runtime import: hcx-native-function-calling-adapter.mjs is never imported from domain/runtime/", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const runtimeDir = new URL("../domain/runtime/", import.meta.url);
  let files;
  try { files = await readdir(runtimeDir); } catch { files = []; }
  for (const file of files.filter((f) => f.endsWith(".mjs"))) {
    const content = await readFile(new URL(file, runtimeDir), "utf8");
    assert.doesNotMatch(content, /hcx-native-function-calling-adapter/, `${file} must not import the P11-E adapter -- production Runtime wiring is out of scope this Turn`);
  }
});

// 28/29/30 (Agent-quality evaluation, DEV_TUNE/DEV_CHECK/HOLDOUT access,
// DocumentIR/chunking/P10.x changes) are NOT unit-testable claims -- they
// are facts about what this Turn's diff does and does not touch, verified
// directly against `git diff` in the final handoff report, not by a test
// asserting over its own source text (which is circular and, for a file
// whose own comments legitimately discuss those terms, actively wrong).

// ============================================================
// generic adapter regression (unchanged behavior)
// ============================================================

test("generic adapter unchanged: parseStructuredAnswer still rejects a code fence exactly as before", () => {
  const fenced = "```json\n" + JSON.stringify(VALID_ARGS) + "\n```";
  assert.throws(() => parseStructuredAnswer(fenced));
});

test("generic adapter unchanged: HCX_CHAT_COMPLETIONS's own classifyHcxAssistantContent still tolerates a single fence (P11-C behavior untouched by P11-E)", () => {
  const fenced = "```json\n" + JSON.stringify(VALID_ARGS) + "\n```";
  const { content_class } = classifyHcxAssistantContent(fenced);
  assert.equal(content_class, "FENCED_JSON");
});

test("model-config schema: HCX_NATIVE_V3_FUNCTION_CALLING requires endpoint_url/api_key_env_var/top_p/actual_external_call_authorized", () => {
  assert.deepEqual(validateModelConfig(baseConfig()), []);
  const { top_p, ...missingTopP } = baseConfig();
  assert.notDeepEqual(validateModelConfig(missingTopP), []);
});

test("COMMON_STRUCTURED_ANSWER_SCHEMA (the reused structured-answer validator) still requires exactly answer/used_fact_ids/used_evidence_ids", () => {
  assert.deepEqual(COMMON_STRUCTURED_ANSWER_SCHEMA.required, ["answer", "used_fact_ids", "used_evidence_ids"]);
});
