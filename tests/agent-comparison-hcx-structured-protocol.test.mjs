// Turn P11-D: scoped, offline unit tests for the structured-output
// PROTOCOL comparison (Native v3 Function Calling vs OpenAI-compatible
// response_format=json_schema). Every test here is pure/offline -- no real
// network call. This file is intentionally NOT wired into package.json's
// test:domain file list, same as tests/agent-comparison-hcx-real-smoke.test.mjs
// and tests/agent-comparison-hcx-response-compatibility.test.mjs -- run it
// directly: node --test tests/agent-comparison-hcx-structured-protocol.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { FUNCTION_CALLING_TOOL_NAME, classifyNativeV3Envelope } from "../domain/agent-comparison/hcx-structured-protocol/envelope-native-v3.mjs";
import { classifyOpenAiCompatibleEnvelope } from "../domain/agent-comparison/hcx-structured-protocol/envelope-openai-compatible.mjs";
import { callCandidateA, CANDIDATE_A_ID } from "../domain/agent-comparison/hcx-structured-protocol/candidate-a-function-calling.mjs";
import { callCandidateB, CANDIDATE_B_ID, CANDIDATE_B_ENDPOINT_URL } from "../domain/agent-comparison/hcx-structured-protocol/candidate-b-response-format.mjs";
import { COMMON_STRUCTURED_ANSWER_SCHEMA } from "../domain/agent-comparison/hcx-structured-protocol/common-schema.mjs";
import { toolParametersSchema } from "../domain/agent-comparison/hcx-structured-protocol/envelope-native-v3.mjs";
import { runStructuredProtocolComparison } from "../domain/agent-comparison/hcx-structured-protocol/runner.mjs";
import { buildComparisonReport } from "../domain/agent-comparison/hcx-structured-protocol/artifacts.mjs";
import { validateComparisonReport } from "../domain/agent-comparison/hcx-structured-protocol/contracts.mjs";
import { selectStructuredProtocol, isCandidateGreen } from "../domain/agent-comparison/hcx-structured-protocol/selection.mjs";
import { P11D_HARD_LIMITS } from "../domain/agent-comparison/hcx-structured-protocol/hard-limits.mjs";
import { P11D_STRUCTURED_PROTOCOL_SCENARIOS } from "../domain/agent-comparison/hcx-structured-protocol/scenarios.mjs";
import { classifyHcxAssistantContent } from "../domain/agent-comparison/hcx-model-adapter.mjs";
import { parseStructuredAnswer } from "../domain/agent-comparison/structured-answer-parsing.mjs";

const FAKE_API_KEY = "test-only-fake-key-p11d-never-real";
const parametersSchema = toolParametersSchema(COMMON_STRUCTURED_ANSWER_SCHEMA);

function candidateAOptions(overrides = {}) {
  return {
    prompt: "테스트 프롬프트",
    endpointUrl: "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005",
    apiKey: FAKE_API_KEY,
    maxOutputTokens: 1024,
    parametersSchema,
    timeoutMs: 5000,
    ...overrides,
  };
}

function candidateBOptions(overrides = {}) {
  return {
    prompt: "테스트 프롬프트",
    model: "HCX-005",
    apiKey: FAKE_API_KEY,
    maxOutputTokens: 1024,
    commonSchema: COMMON_STRUCTURED_ANSWER_SCHEMA,
    timeoutMs: 5000,
    ...overrides,
  };
}

function jsonResponse(body, extra = {}) {
  return { ok: true, status: 200, headers: { get: (name) => (name === "content-type" ? "application/json" : null) }, json: async () => body, ...extra };
}

function httpErrorResponse(status) {
  return { ok: false, status, headers: { get: () => "application/json" }, json: async () => ({}) };
}

const VALID_ARGS = { answer: "테스트 답변", used_fact_ids: ["synth_fact_0001"], used_evidence_ids: ["synth_evidence_0001"] };

function nativeEnvelope(message, extra = {}) {
  return { status: { code: "20000" }, result: { message, usage: { promptTokens: 5, completionTokens: 5 }, ...extra } };
}

// --- candidate A: normal single tool call ----------------------------------
test("candidate A: a single matching tool call with valid arguments is SUCCESS", async () => {
  const fetchImpl = async () => jsonResponse(nativeEnvelope({
    content: "",
    toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: VALID_ARGS } }],
  }));
  const result = await callCandidateA(candidateAOptions({ fetchImpl }));
  assert.equal(result.ok, true);
  assert.equal(result.outcome_class, "SUCCESS");
  assert.deepEqual(result.used_fact_ids, ["synth_fact_0001"]);
});

// --- candidate A: missing / duplicate / wrong-name tool calls ---------------
test("candidate A: zero tool calls is TOOL_CALL_MISSING", async () => {
  const fetchImpl = async () => jsonResponse(nativeEnvelope({ content: "", toolCalls: [] }));
  const result = await callCandidateA(candidateAOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome_class, "TOOL_CALL_MISSING");
});

test("candidate A: two tool calls is TOOL_CALL_DUPLICATE", async () => {
  const call = { id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: VALID_ARGS } };
  const fetchImpl = async () => jsonResponse(nativeEnvelope({ content: "", toolCalls: [call, call] }));
  const result = await callCandidateA(candidateAOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome_class, "TOOL_CALL_DUPLICATE");
});

test("candidate A: a tool call with the wrong name is TOOL_CALL_NAME_MISMATCH", async () => {
  const fetchImpl = async () => jsonResponse(nativeEnvelope({
    content: "",
    toolCalls: [{ id: "1", type: "function", function: { name: "some_other_tool", arguments: VALID_ARGS } }],
  }));
  const result = await callCandidateA(candidateAOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome_class, "TOOL_CALL_NAME_MISMATCH");
});

// --- candidate A: malformed / schema-invalid arguments ----------------------
test("candidate A: non-object arguments is TOOL_CALL_ARGUMENTS_NOT_OBJECT", async () => {
  const fetchImpl = async () => jsonResponse(nativeEnvelope({
    content: "",
    toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: "not-an-object" } }],
  }));
  const result = await callCandidateA(candidateAOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome_class, "TOOL_CALL_ARGUMENTS_NOT_OBJECT");
});

test("candidate A: schema-invalid arguments (wrong field type) is TOOL_CALL_ARGUMENTS_SCHEMA_INVALID", async () => {
  const fetchImpl = async () => jsonResponse(nativeEnvelope({
    content: "",
    toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: { answer: 12345, used_fact_ids: [], used_evidence_ids: [] } } }],
  }));
  const result = await callCandidateA(candidateAOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome_class, "TOOL_CALL_ARGUMENTS_SCHEMA_INVALID");
});

// --- candidate A: natural-language content alongside a tool call is rejected
test("candidate A: non-blank assistant content alongside a valid tool call is rejected", async () => {
  const fetchImpl = async () => jsonResponse(nativeEnvelope({
    content: "다음과 같이 답변합니다.",
    toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: VALID_ARGS } }],
  }));
  const result = await callCandidateA(candidateAOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome_class, "NATURAL_LANGUAGE_CONTENT_PRESENT");
});

// --- candidate B: normal response_format JSON -------------------------------
test("candidate B: a single plain-JSON content is SUCCESS", async () => {
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_ARGS) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
  const result = await callCandidateB(candidateBOptions({ fetchImpl }));
  assert.equal(result.ok, true);
  assert.equal(result.outcome_class, "SUCCESS");
});

// --- candidate B: malformed / explanatory / code-fence / empty content -----
test("candidate B: malformed JSON content is rejected", async () => {
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: '{"answer": "잘린 응답"' } }] });
  const result = await callCandidateB(candidateBOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.match(result.outcome_class, /^CONTENT_/);
});

test("candidate B: explanatory text around the JSON is rejected", async () => {
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: `다음은 답변입니다: ${JSON.stringify(VALID_ARGS)}` } }] });
  const result = await callCandidateB(candidateBOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.match(result.outcome_class, /^CONTENT_/);
});

test("candidate B: a ```json code fence is rejected (stricter than the P11-C prompt-only path)", async () => {
  const fenced = "```json\n" + JSON.stringify(VALID_ARGS) + "\n```";
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: fenced } }] });
  const result = await callCandidateB(candidateBOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome_class, "CONTENT_FENCED_OR_MIXED_REJECTED");
});

test("candidate B: empty content is rejected", async () => {
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: "" } }] });
  const result = await callCandidateB(candidateBOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome_class, "CONTENT_EMPTY");
});

test("candidate B: two concatenated JSON objects (no fence) is rejected", async () => {
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: `${JSON.stringify(VALID_ARGS)}\n${JSON.stringify(VALID_ARGS)}` } }] });
  const result = await callCandidateB(candidateBOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.match(result.outcome_class, /^CONTENT_/);
});

// --- envelope mixing is rejected by both parsers ----------------------------
test("envelope mixing: an OpenAI-shaped body is never VALID under the native v3 envelope classifier", () => {
  const openAiShaped = { choices: [{ message: { content: "{}" } }] };
  assert.notEqual(classifyNativeV3Envelope(openAiShaped), "VALID");
});

test("envelope mixing: a native-v3-shaped body is never VALID under the OpenAI-compatible envelope classifier", () => {
  const nativeShaped = { status: { code: "20000" }, result: { message: { content: "{}" } } };
  assert.notEqual(classifyOpenAiCompatibleEnvelope(nativeShaped), "VALID");
});

// --- evidence id mismatch is rejected (checked at the runner level for both candidates) ---
test("evidence ID mismatch: a candidate answer citing an id outside the scenario's authorized set is rejected end-to-end", async () => {
  const unauthorizedArgs = { answer: "x", used_fact_ids: ["synth_fact_9999_not_authorized"], used_evidence_ids: [] };
  const fetchImpl = async (url, init) => {
    const parsedBody = JSON.parse(init.body);
    if (Array.isArray(parsedBody.tools)) {
      return jsonResponse(nativeEnvelope({ content: "", toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: unauthorizedArgs } }] }));
    }
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(unauthorizedArgs) } }] });
  };
  const loaded = { ready: true, rawApiKey: FAKE_API_KEY, model: "HCX-005", candidateAEndpointUrl: "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005", maxOutputTokens: 1024, redacted: { run_id: "test" } };
  const runResult = await runStructuredProtocolComparison(loaded, { fetchImpl });
  for (const run of [...runResult.candidateA.scenarioRuns, ...runResult.candidateB.scenarioRuns]) {
    assert.equal(run.ok, false, `expected ${run.scenario_type} rep ${run.repetition} to be rejected for an unauthorized id`);
    assert.equal(run.outcome_class, "EVIDENCE_ID_MISMATCH");
  }
});

// --- API key / header / raw prompt / raw response never exposed ------------
test("no secret/raw-content leakage: a failing call's outcome object never contains the api key, an authorization header, or the raw prompt/content", async () => {
  const secretLike = "다음은 절대 노출되면 안되는 SENSITIVE_MARKER_XYZ 문장입니다.";
  const fetchImpl = async () => jsonResponse(nativeEnvelope({ content: secretLike, toolCalls: [] }));
  const result = await callCandidateA(candidateAOptions({ fetchImpl }));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SENSITIVE_MARKER_XYZ/);
  assert.doesNotMatch(serialized, new RegExp(FAKE_API_KEY));
  assert.doesNotMatch(serialized, /authorization/i);
});

test("no secret/raw-content leakage: buildComparisonReport never serializes the api key or the fixed scenario task text, and is schema-valid", async () => {
  const fetchImpl = async () => jsonResponse(nativeEnvelope({ content: "", toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: VALID_ARGS } }] }));
  const loaded = { ready: true, rawApiKey: FAKE_API_KEY, model: "HCX-005", candidateAEndpointUrl: "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005", maxOutputTokens: 1024, redacted: { run_id: "test", api_key_present: true } };
  const runResult = await runStructuredProtocolComparison(loaded, { fetchImpl });
  const report = buildComparisonReport(loaded, runResult, { runId: "test", createdAt: "2026-09-02T00:00:00.000Z" });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(FAKE_API_KEY));
  for (const scenario of P11D_STRUCTURED_PROTOCOL_SCENARIOS) assert.doesNotMatch(serialized, new RegExp(scenario.task.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(report.security_attestation.overall_status, "PASS");
  assert.deepEqual(validateComparisonReport(report), []);
});

// --- request hard cap --------------------------------------------------------
test("hard cap: total requests across both candidates never exceeds GLOBAL_HARD_CAP even under persistent 500s", async () => {
  let callCount = 0;
  const fetchImpl = async () => { callCount += 1; return httpErrorResponse(500); };
  const loaded = { ready: true, rawApiKey: FAKE_API_KEY, model: "HCX-005", candidateAEndpointUrl: "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005", maxOutputTokens: 1024, redacted: { run_id: "test" } };
  const runResult = await runStructuredProtocolComparison(loaded, { fetchImpl });
  assert.ok(callCount <= P11D_HARD_LIMITS.GLOBAL_HARD_CAP, `made ${callCount} calls, global hard cap is ${P11D_HARD_LIMITS.GLOBAL_HARD_CAP}`);
  assert.ok(runResult.totalRequests <= P11D_HARD_LIMITS.GLOBAL_HARD_CAP);
});

// --- retry only on 429/5xx ----------------------------------------------------
test("retry: a 429/5xx http status is marked retryable; a 4xx is not, for both candidates", async () => {
  const a503 = await callCandidateA(candidateAOptions({ fetchImpl: async () => httpErrorResponse(503) }));
  assert.equal(a503.retryable, true);
  const a400 = await callCandidateA(candidateAOptions({ fetchImpl: async () => httpErrorResponse(400) }));
  assert.equal(a400.retryable, false);
  const b429 = await callCandidateB(candidateBOptions({ fetchImpl: async () => httpErrorResponse(429) }));
  assert.equal(b429.retryable, true);
  const b415 = await callCandidateB(candidateBOptions({ fetchImpl: async () => httpErrorResponse(415) }));
  assert.equal(b415.retryable, false);
  assert.equal(b415.outcome_class, "HTTP_4XX_UNSUPPORTED_OR_REJECTED");
});

test("retry: the runner retries a single request once on 503 then succeeds, and performs zero retries on a 4xx", async () => {
  // Empty used_fact_ids/used_evidence_ids are trivially authorized for every
  // scenario (scenarios.mjs's allowedFactIds/allowedEvidenceIds sets), so
  // this test's success path is never confounded by the (separately tested)
  // evidence-id-mismatch check.
  const universallyAuthorizedArgs = { answer: "x", used_fact_ids: [], used_evidence_ids: [] };
  let candidateACallCount = 0;
  const fetchImpl = async (url, init) => {
    const parsedBody = JSON.parse(init.body);
    const isCandidateA = Array.isArray(parsedBody.tools);
    if (isCandidateA) {
      candidateACallCount += 1;
      if (candidateACallCount === 1) return httpErrorResponse(503); // only the very first candidate-A call fails, and is retried once
      return jsonResponse(nativeEnvelope({ content: "", toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: universallyAuthorizedArgs } }] }));
    }
    return httpErrorResponse(422); // candidate B: every call is a non-retryable 4xx
  };
  const loaded = { ready: true, rawApiKey: FAKE_API_KEY, model: "HCX-005", candidateAEndpointUrl: "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005", maxOutputTokens: 1024, redacted: { run_id: "test" } };
  const runResult = await runStructuredProtocolComparison(loaded, { fetchImpl });

  assert.equal(runResult.candidateA.retriesPerformed, 1);
  assert.equal(runResult.candidateA.requestsSucceeded, P11D_HARD_LIMITS.PER_CANDIDATE_REQUESTS);
  // candidate B: 15 logical requests, each a single non-retryable attempt -> 0 retries, all failed.
  assert.equal(runResult.candidateB.retriesPerformed, 0);
  assert.equal(runResult.candidateB.requestsFailed, P11D_HARD_LIMITS.PER_CANDIDATE_REQUESTS);
});

// --- generic adapter / existing P11-A/B/C behavior is unchanged ------------
test("generic adapter unchanged: classifyHcxAssistantContent (P11-C) still tolerates a single json fence -- P11-D's stricter candidate-B classifier is a separate function, not a change to this one", () => {
  const fenced = "```json\n" + JSON.stringify(VALID_ARGS) + "\n```";
  const { content_class } = classifyHcxAssistantContent(fenced);
  assert.equal(content_class, "FENCED_JSON");
});

test("generic adapter unchanged: parseStructuredAnswer (shared generic parser) still rejects a fence exactly as before", () => {
  const fenced = "```json\n" + JSON.stringify(VALID_ARGS) + "\n```";
  assert.throws(() => parseStructuredAnswer(fenced));
});

// --- auth error aborts the entire run immediately ---------------------------
test("auth error: a 401 from candidate A immediately aborts the whole run -- candidate B is never attempted", async () => {
  let candidateBAttempted = false;
  const fetchImpl = async (url, init) => {
    const parsedBody = JSON.parse(init.body);
    if (Array.isArray(parsedBody.tools)) return httpErrorResponse(401);
    candidateBAttempted = true;
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_ARGS) } }] });
  };
  const loaded = { ready: true, rawApiKey: FAKE_API_KEY, model: "HCX-005", candidateAEndpointUrl: "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005", maxOutputTokens: 1024, redacted: { run_id: "test" } };
  const runResult = await runStructuredProtocolComparison(loaded, { fetchImpl });
  assert.equal(runResult.authAborted, true);
  assert.equal(runResult.stoppedEarlyReason, "AUTH_ERROR");
  assert.equal(candidateBAttempted, false);
  assert.equal(runResult.candidateB.skippedReason, "AUTH_ABORTED_BEFORE_START");
});

// --- fail-closed: missing credentials makes zero calls ----------------------
test("fail-closed: ready:false makes zero calls to either candidate", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return httpErrorResponse(200); };
  const runResult = await runStructuredProtocolComparison({ ready: false, missing: ["HCX_API_KEY"] }, { fetchImpl });
  assert.equal(called, false);
  assert.equal(runResult.stoppedEarlyReason, "MISSING_CREDENTIALS");
});

test("fail-closed: the report built for a ready:false config is itself schema-valid", () => {
  const report = buildComparisonReport({ ready: false, missing: ["HCX_API_KEY", "HCX_ENDPOINT_URL", "HCX_MODEL_ID"] }, null, { runId: "test", createdAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(report.ready, false);
  assert.equal(report.candidates, null);
  assert.deepEqual(validateComparisonReport(report), []);
});

test("real run shape: buildComparisonReport(ready, a GREEN 15/15-vs-15-failed runResult) is schema-valid end to end", async () => {
  const fetchImpl = async (url, init) => {
    const parsedBody = JSON.parse(init.body);
    if (Array.isArray(parsedBody.tools)) {
      return jsonResponse(nativeEnvelope({ content: "", toolCalls: [{ id: "1", type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME, arguments: { answer: "x", used_fact_ids: [], used_evidence_ids: [] } } }] }));
    }
    return httpErrorResponse(400);
  };
  const loaded = { ready: true, rawApiKey: FAKE_API_KEY, model: "HCX-005", candidateAEndpointUrl: "https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005", maxOutputTokens: 1024, redacted: { run_id: "test" } };
  const runResult = await runStructuredProtocolComparison(loaded, { fetchImpl });
  const report = buildComparisonReport(loaded, runResult, { runId: "test", createdAt: "2026-09-02T00:00:00.000Z" });
  assert.deepEqual(validateComparisonReport(report), []);
  assert.equal(report.selection.status, "GREEN_SELECTED");
  assert.equal(report.selection.selected_candidate, "FUNCTION_CALLING");
  assert.equal(report.candidates.FUNCTION_CALLING.green, true);
  assert.equal(report.candidates.RESPONSE_FORMAT.green, false);
  assert.equal(report.candidates.RESPONSE_FORMAT.unsupported_count, P11D_HARD_LIMITS.PER_CANDIDATE_REQUESTS);
});

// --- selection rule (section G) ---------------------------------------------
function greenCandidate(overrides = {}) {
  return {
    scenarioRuns: Array.from({ length: P11D_HARD_LIMITS.PER_CANDIDATE_REQUESTS }, (_, i) => ({ scenario_type: "X", repetition: i + 1, ok: true, outcome_class: "SUCCESS" })),
    requestsSucceeded: P11D_HARD_LIMITS.PER_CANDIDATE_REQUESTS,
    requestsFailed: 0,
    retriesPerformed: 0,
    latencyStats: { p50_ms: 500, p95_ms: 800, max_ms: 900, count: 15 },
    tokenUsageAggregate: { input_tokens_total: 1000, output_tokens_total: 500 },
    skippedReason: null,
    ...overrides,
  };
}
function redCandidate() {
  return { scenarioRuns: [{ scenario_type: "X", repetition: 1, ok: false, outcome_class: "TOOL_CALL_MISSING" }], requestsSucceeded: 0, requestsFailed: 1, retriesPerformed: 0, latencyStats: null, tokenUsageAggregate: null, skippedReason: null };
}

test("selection: both GREEN with no cost penalty -> response_format (B) is preferred", () => {
  const decision = selectStructuredProtocol({ candidateA: greenCandidate(), candidateB: greenCandidate(), secretNonLeakPass: true });
  assert.equal(decision.status, "GREEN");
  assert.equal(decision.selected, CANDIDATE_B_ID);
});

test("selection: both GREEN but B's p95 latency is >=25% higher -> Function Calling (A) is preferred", () => {
  const decision = selectStructuredProtocol({
    candidateA: greenCandidate({ latencyStats: { p50_ms: 400, p95_ms: 800, max_ms: 900, count: 15 } }),
    candidateB: greenCandidate({ latencyStats: { p50_ms: 1000, p95_ms: 1100, max_ms: 1200, count: 15 } }),
    secretNonLeakPass: true,
  });
  assert.equal(decision.status, "GREEN");
  assert.equal(decision.selected, CANDIDATE_A_ID);
});

test("selection: only candidate A GREEN -> A selected", () => {
  const decision = selectStructuredProtocol({ candidateA: greenCandidate(), candidateB: redCandidate(), secretNonLeakPass: true });
  assert.equal(decision.selected, CANDIDATE_A_ID);
});

test("selection: only candidate B GREEN -> B selected", () => {
  const decision = selectStructuredProtocol({ candidateA: redCandidate(), candidateB: greenCandidate(), secretNonLeakPass: true });
  assert.equal(decision.selected, CANDIDATE_B_ID);
});

test("selection: neither reaches 15/15 -> RED, no selection", () => {
  const decision = selectStructuredProtocol({ candidateA: redCandidate(), candidateB: redCandidate(), secretNonLeakPass: true });
  assert.equal(decision.status, "RED");
  assert.equal(decision.selected, null);
});

test("selection: secret non-leak FAIL forces RED regardless of success rate", () => {
  const decision = selectStructuredProtocol({ candidateA: greenCandidate(), candidateB: greenCandidate(), secretNonLeakPass: false });
  assert.equal(decision.status, "RED");
  assert.equal(decision.selected, null);
});

test("isCandidateGreen: a candidate stopped early (fewer than 15 runs) is never GREEN", () => {
  assert.equal(isCandidateGreen({ scenarioRuns: Array(10).fill({ ok: true }), skippedReason: null }), false);
});
