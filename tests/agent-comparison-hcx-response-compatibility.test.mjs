// Turn P11-C: unit tests for the HCX-specific response-shape hardening
// added in hcx-model-adapter.mjs (classifyHcxOuterEnvelope,
// classifyHcxAssistantContent, and parseHcxResponseBody's use of them).
// Every test here is pure/offline -- no real network call. This file is
// intentionally NOT wired into package.json's test:domain file list, same
// as tests/agent-comparison-hcx-real-smoke.test.mjs -- run it directly:
// node --test tests/agent-comparison-hcx-response-compatibility.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createModelAdapter, ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { classifyHcxOuterEnvelope, classifyHcxAssistantContent } from "../domain/agent-comparison/hcx-model-adapter.mjs";
import { parseStructuredAnswer } from "../domain/agent-comparison/structured-answer-parsing.mjs";
import { loadHcxRealSmokeConfig } from "../domain/agent-comparison/hcx-real-smoke/config.mjs";
import { runHcxRealSmoke } from "../domain/agent-comparison/hcx-real-smoke/runner.mjs";
import { HARD_LIMITS } from "../domain/agent-comparison/hcx-real-smoke/hard-limits.mjs";

function hcxConfig(overrides = {}) {
  return {
    schema_version: "0.1.0",
    model_config_id: "model_hcx-p11c-test",
    kind: "HCX_CHAT_COMPLETIONS",
    provider: "hcx",
    model: "test-fixture-model",
    endpoint_url: "http://127.0.0.1:9/hcx/v3/chat-completions",
    api_key_env_var: "AGENT_COMPARISON_HCX_P11C_TEST_KEY",
    max_output_tokens: 256,
    temperature: 0.3,
    top_p: 0.8,
    seed_supported: false,
    timeout_ms: 5000,
    request_schema_version: "hcx-chat-completions-v3",
    response_schema_version: "hcx-chat-completions-v3",
    actual_external_call_authorized: false,
    ...overrides,
  };
}

function withKey(run) {
  process.env.AGENT_COMPARISON_HCX_P11C_TEST_KEY = "fake-key-for-test";
  return Promise.resolve()
    .then(run)
    .finally(() => { delete process.env.AGENT_COMPARISON_HCX_P11C_TEST_KEY; });
}

function envelopeWithContent(content, extra = {}) {
  return {
    ok: true,
    json: async () => ({
      status: { code: "20000" },
      result: { message: { content }, usage: { promptTokens: 1, completionTokens: 1 }, ...extra },
    }),
  };
}

async function generateWith(content, extra = {}) {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => envelopeWithContent(content, extra) });
  return adapter.generate({ prompt: "x" });
}

async function expectMalformed(content, extra = {}) {
  await assert.rejects(() => generateWith(content, extra), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}

const VALID_ANSWER_JSON = JSON.stringify({ answer: "테스트 답변", used_fact_ids: [], used_evidence_ids: [] });

// --- D.1: pure JSON content is allowed ------------------------------------
test("D.1: pure JSON content (no fence, no surrounding text) is accepted", () => withKey(async () => {
  const result = await generateWith(VALID_ANSWER_JSON);
  assert.equal(result.text, "테스트 답변");
  assert.equal(result.diagnostics.assistant_content_class, "PLAIN_JSON");
}));

test("D.1b: pure JSON content with surrounding whitespace/newlines is still accepted", () => withKey(async () => {
  const result = await generateWith(`\n  ${VALID_ANSWER_JSON}  \n`);
  assert.equal(result.text, "테스트 답변");
}));

// --- D.2: a single ```json fence wrapping the whole content is allowed ---
test("D.2: a single ```json fence wrapping the entire content is accepted and unwrapped", () => withKey(async () => {
  const fenced = "```json\n" + VALID_ANSWER_JSON + "\n```";
  const result = await generateWith(fenced);
  assert.equal(result.text, "테스트 답변");
  assert.equal(result.diagnostics.assistant_content_class, "FENCED_JSON");
}));

// --- D.3: explanatory text before/after the fence is rejected -------------
test("D.3: explanatory text BEFORE a json fence is rejected, never silently stripped", () => withKey(async () => {
  const content = "다음은 답변입니다:\n```json\n" + VALID_ANSWER_JSON + "\n```";
  await expectMalformed(content);
}));

test("D.3b: explanatory text AFTER a json fence is rejected", () => withKey(async () => {
  const content = "```json\n" + VALID_ANSWER_JSON + "\n```\n이상입니다.";
  await expectMalformed(content);
}));

test("D.3c: explanatory text with no fence at all (JSON embedded in a sentence) is rejected", () => withKey(async () => {
  const content = `다음과 같이 답변합니다: ${VALID_ANSWER_JSON}`;
  await expectMalformed(content);
}));

// --- D.4: two or more JSON/fence blocks are rejected -----------------------
test("D.4: two separate json fence blocks in one content string are rejected", () => withKey(async () => {
  const content = "```json\n" + VALID_ANSWER_JSON + "\n```\n```json\n" + VALID_ANSWER_JSON + "\n```";
  await expectMalformed(content);
}));

test("D.4b: two bare JSON objects concatenated (no fence) are rejected -- not silently taking the first", () => withKey(async () => {
  const content = `${VALID_ANSWER_JSON}\n${VALID_ANSWER_JSON}`;
  await expectMalformed(content);
}));

// --- D.5: truncated JSON is rejected ---------------------------------------
test("D.5: truncated JSON (missing closing brace) is rejected", () => withKey(async () => {
  await expectMalformed('{"answer": "잘린 응답"');
}));

test("D.5b: truncated JSON inside an otherwise-single fence is rejected", () => withKey(async () => {
  const content = '```json\n{"answer": "잘린 응답"\n```';
  await expectMalformed(content);
}));

// --- D.6: empty content is rejected -----------------------------------------
test("D.6: empty string content is rejected", () => withKey(async () => {
  await expectMalformed("");
}));

test("D.6b: whitespace-only content is rejected", () => withKey(async () => {
  await expectMalformed("   \n  ");
}));

// --- D.7: missing required field is rejected --------------------------------
test("D.7: valid JSON missing the required 'answer' field is rejected", () => withKey(async () => {
  await expectMalformed(JSON.stringify({ used_fact_ids: [], used_evidence_ids: [] }));
}));

// --- D.8: wrong field type is rejected ---------------------------------------
test("D.8: 'answer' present but not a string is rejected", () => withKey(async () => {
  await expectMalformed(JSON.stringify({ answer: 12345, used_fact_ids: [], used_evidence_ids: [] }));
}));

test("D.8b: 'used_fact_ids' present but not an array of strings is rejected", () => withKey(async () => {
  await expectMalformed(JSON.stringify({ answer: "x", used_fact_ids: [1, 2], used_evidence_ids: [] }));
}));

// --- D.9: unknown/invalid HCX envelope shapes are rejected -------------------
test("D.9: classifyHcxOuterEnvelope: missing status.code -> MISSING_STATUS_CODE", () => {
  assert.equal(classifyHcxOuterEnvelope({ result: { message: { content: "x" } } }), "MISSING_STATUS_CODE");
});
test("D.9b: classifyHcxOuterEnvelope: status.code present but not 20000 -> STATUS_NOT_SUCCESS", () => {
  assert.equal(classifyHcxOuterEnvelope({ status: { code: "40000" }, result: { message: { content: "x" } } }), "STATUS_NOT_SUCCESS");
});
test("D.9c: classifyHcxOuterEnvelope: valid status but missing result.message.content -> MISSING_MESSAGE_CONTENT", () => {
  assert.equal(classifyHcxOuterEnvelope({ status: { code: "20000" }, result: {} }), "MISSING_MESSAGE_CONTENT");
});
test("D.9d: classifyHcxOuterEnvelope: a fully valid envelope shape -> VALID", () => {
  assert.equal(classifyHcxOuterEnvelope({ status: { code: "20000" }, result: { message: { content: "x" } } }), "VALID");
});
test("D.9e: an HTTP response whose body is not JSON at all is MODEL_CALL_MALFORMED_RESPONSE with outer_envelope_class NOT_JSON", () => withKey(async () => {
  const adapter = createModelAdapter(hcxConfig(), {
    allowLoopbackMockCalls: true,
    fetchImpl: async () => ({ ok: true, headers: { get: () => "text/html" }, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
  });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    assert.equal(error.diagnostics.outer_envelope_class, "NOT_JSON");
    assert.equal(error.diagnostics.content_type_mime, "text/html");
    return true;
  });
}));

// --- D.10: the shared generic parser / generic adapter path is unchanged ----
test("D.10: the shared parseStructuredAnswer (used by the generic HTTP_CHAT_COMPLETIONS adapter) is NOT fence-tolerant -- fence tolerance is HCX-adapter-only", () => {
  const fenced = "```json\n" + VALID_ANSWER_JSON + "\n```";
  assert.throws(() => parseStructuredAnswer(fenced), (error) => {
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
});
test("D.10b: the shared parseStructuredAnswer still accepts plain JSON exactly as before", () => {
  const result = parseStructuredAnswer(VALID_ANSWER_JSON);
  assert.equal(result.text, "테스트 답변");
});

// --- D.11: no secret/raw-content leakage into diagnostics -------------------
test("D.11: diagnostics never contain any substring of the raw assistant content, even when it holds sensitive-looking text", () => withKey(async () => {
  const secretLike = "다음은 절대 노출되면 안되는 SENSITIVE_MARKER_XYZ 문장입니다.";
  await assert.rejects(() => generateWith(secretLike), (error) => {
    const serialized = JSON.stringify(error.diagnostics);
    assert.doesNotMatch(serialized, /SENSITIVE_MARKER_XYZ/);
    assert.doesNotMatch(serialized, /노출되면/);
    assert.equal(error.diagnostics.assistant_content_length, secretLike.length);
    return true;
  });
}));
test("D.11b: classifyHcxAssistantContent's own return value never echoes back any content substring", () => {
  const secretLike = "AUTH_HEADER_LOOKS_LIKE sk-should-not-appear";
  const { content_class, extractedJsonText } = classifyHcxAssistantContent(secretLike);
  assert.equal(content_class, "NOT_JSON_AT_ALL");
  assert.equal(extractedJsonText, null);
});

// --- successful-path diagnostics sanity (not required by D, but guards the shape used by the smoke harness) ---
test("a successful call's returned diagnostics report VALID/PLAIN_JSON and a plausible content length", () => withKey(async () => {
  const result = await generateWith(VALID_ANSWER_JSON);
  assert.equal(result.diagnostics.outer_envelope_class, "VALID");
  assert.equal(result.diagnostics.assistant_content_class, "PLAIN_JSON");
  assert.equal(result.diagnostics.assistant_content_length, VALID_ANSWER_JSON.length);
  assert.equal(result.diagnostics.http_status, null); // the injected mock response has no numeric .status
}));

// --- Turn P11-C section E: runHcxRealSmoke's maxRequestsOverride can only LOWER the hard request ceiling, never raise it ---
const RELEVANT_ENV_VARS = ["HCX_API_KEY", "HCX_ENDPOINT_URL", "HCX_MODEL_ID"];
function withFakeSmokeConfig(run) {
  const saved = Object.fromEntries(RELEVANT_ENV_VARS.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { HCX_API_KEY: "test-only-fake-key-never-real", HCX_ENDPOINT_URL: "https://example.invalid/hcx/v3/chat-completions", HCX_MODEL_ID: "test-fixture-model" });
  return Promise.resolve()
    .then(() => run(loadHcxRealSmokeConfig()))
    .finally(() => {
      for (const name of RELEVANT_ENV_VARS) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });
}

test("maxRequestsOverride lower than the hard limit is honored (run stops itself at the lower ceiling)", () => withFakeSmokeConfig(async (loaded) => {
  const result = await runHcxRealSmoke(loaded, {
    maxRequestsOverride: 2,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.ok(result.requestsAttempted <= 2, `made ${result.requestsAttempted} requests, override ceiling was 2`);
}));

test("maxRequestsOverride HIGHER than HARD_LIMITS.MAXIMUM_REQUESTS is clamped down -- it can never raise the hard ceiling", () => withFakeSmokeConfig(async (loaded) => {
  let callCount = 0;
  const result = await runHcxRealSmoke(loaded, {
    maxRequestsOverride: HARD_LIMITS.MAXIMUM_REQUESTS + 1000,
    fetchImpl: async () => { callCount += 1; return { ok: false, status: 500, json: async () => ({}) }; },
  });
  assert.ok(callCount <= HARD_LIMITS.MAXIMUM_REQUESTS, `made ${callCount} calls, hard limit is ${HARD_LIMITS.MAXIMUM_REQUESTS}`);
  assert.ok(result.requestsAttempted <= HARD_LIMITS.MAXIMUM_REQUESTS);
}));
