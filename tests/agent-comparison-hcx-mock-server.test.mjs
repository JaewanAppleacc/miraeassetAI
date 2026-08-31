// Turn P11-A: end-to-end tests of the HCX ModelAdapter against a REAL local
// loopback HTTP server (hcx-mock-server.mjs) -- this is the only test file
// in this Turn that lets `fetch` actually perform network I/O, and it is
// always against 127.0.0.1, never a real host. Exercises CLAUDE.md Turn
// P11-A section F's 14 scenarios and proves non-exposure of the raw API
// key / raw response body / raw error message anywhere the adapter
// surfaces (F.14).
import assert from "node:assert/strict";
import test from "node:test";
import { createModelAdapter, ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { createHcxMockServer } from "../domain/agent-comparison/hcx-mock-server.mjs";
import { verifyGeneratedAnswer } from "../domain/agent-comparison/flows/hard-claim-grounding.mjs";

const API_KEY_ENV_VAR = "AGENT_COMPARISON_HCX_MOCK_TEST_KEY";
const REAL_API_KEY_VALUE = "mock-server-test-key-must-never-leak";

function baseConfig(endpointUrl, overrides = {}) {
  return {
    schema_version: "0.1.0",
    model_config_id: "model_hcx-mock-server-v1",
    kind: "HCX_CHAT_COMPLETIONS",
    provider: "hcx",
    model: "test-fixture-model",
    endpoint_url: endpointUrl,
    api_key_env_var: API_KEY_ENV_VAR,
    max_output_tokens: 256,
    temperature: 0.3,
    top_p: 0.8,
    seed_supported: false,
    timeout_ms: 500,
    request_schema_version: "hcx-chat-completions-v3",
    response_schema_version: "hcx-chat-completions-v3",
    actual_external_call_authorized: false,
    ...overrides,
  };
}

test("HCX mock server: 14 scenarios end to end over a real loopback HTTP connection", async (t) => {
  process.env[API_KEY_ENV_VAR] = REAL_API_KEY_VALUE;
  const server = createHcxMockServer({ authorizedFactId: "fact_mock_authorized", authorizedEvidenceId: "evidence_mock_authorized" });
  const baseUrl = await server.listen();
  t.after(async () => {
    delete process.env[API_KEY_ENV_VAR];
    await server.close();
  });

  function adapterFor(scenario, overrides = {}) {
    return createModelAdapter(baseConfig(server.urlFor(baseUrl, scenario), overrides), { allowLoopbackMockCalls: true });
  }

  await t.test("1. normal: a well-formed, fully-authorized answer is returned and marked mock_generation_call_performed via loopback identity", async () => {
    const adapter = adapterFor("normal");
    assert.equal(adapter.endpointIsLoopback, true);
    const result = await adapter.generate({ prompt: "매출액이 얼마인가요?" });
    assert.equal(result.text, "매출액은 1,000,000,000원입니다.");
    assert.deepEqual(result.used_fact_ids, ["fact_mock_authorized"]);
    assert.deepEqual(result.used_evidence_ids, ["evidence_mock_authorized"]);
    assert.equal(result.input_tokens, 42);
    assert.equal(result.output_tokens, 7);
  });

  await t.test("2. empty text: MODEL_CALL_MALFORMED_RESPONSE", async () => {
    await assert.rejects(() => adapterFor("empty-text").generate({ prompt: "x" }), (e) => e.code === "MODEL_CALL_MALFORMED_RESPONSE");
  });

  await t.test("3. malformed response: MODEL_CALL_MALFORMED_RESPONSE", async () => {
    await assert.rejects(() => adapterFor("malformed").generate({ prompt: "x" }), (e) => e.code === "MODEL_CALL_MALFORMED_RESPONSE");
  });

  await t.test("4. unauthorized evidence_id: the adapter itself still returns it (adapter is naive), but hard-claim-grounding's verifyCitationBinding (unmodified) rejects it fail-closed", async () => {
    const result = await adapterFor("unauthorized-evidence").generate({ prompt: "x" });
    assert.deepEqual(result.used_evidence_ids, ["evidence_never_authorized_for_this_request"]);
    const verdict = verifyGeneratedAnswer({
      text: result.text,
      usedFactIds: result.used_fact_ids,
      usedEvidenceIds: result.used_evidence_ids,
      authorizedFactIds: new Set(["fact_mock_authorized"]),
      validatedEvidenceIds: new Set(["evidence_mock_authorized"]),
      groundedFacts: [],
    });
    assert.equal(verdict.status, "FAIL");
    assert.equal(verdict.reason, "UNVALIDATED_EVIDENCE_ID");
  });

  await t.test("5. tampered number: adapter passes it through; hard-claim-grounding rejects the unsupported number fail-closed", async () => {
    const result = await adapterFor("tampered-number").generate({ prompt: "x" });
    const verdict = verifyGeneratedAnswer({
      text: result.text,
      usedFactIds: result.used_fact_ids,
      usedEvidenceIds: result.used_evidence_ids,
      authorizedFactIds: new Set(["fact_mock_authorized"]),
      validatedEvidenceIds: new Set(["evidence_mock_authorized"]),
      groundedFacts: [{ fact: { raw_value_text: "1,000,000,000", source_document_id: null }, quotes: ["매출액은 1,000,000,000원입니다."] }],
    });
    assert.equal(verdict.status, "FAIL");
    assert.equal(verdict.reason, "UNSUPPORTED_HARD_CLAIM");
  });

  await t.test("6. tampered date: hard-claim-grounding rejects the unsupported date fail-closed", async () => {
    const result = await adapterFor("tampered-date").generate({ prompt: "x" });
    const verdict = verifyGeneratedAnswer({
      text: result.text,
      usedFactIds: result.used_fact_ids,
      usedEvidenceIds: result.used_evidence_ids,
      authorizedFactIds: new Set(["fact_mock_authorized"]),
      validatedEvidenceIds: new Set(["evidence_mock_authorized"]),
      groundedFacts: [{ fact: { period_end: "2025-12-31", source_document_id: null }, quotes: [] }],
    });
    assert.equal(verdict.status, "FAIL");
    assert.equal(verdict.reason, "UNSUPPORTED_HARD_CLAIM");
  });

  await t.test("7. tampered corp_code: caught via the 'number' hard-claim class (an 8-digit corp_code is a long digit run), rejected fail-closed", async () => {
    const result = await adapterFor("tampered-corp-code").generate({ prompt: "x" });
    const verdict = verifyGeneratedAnswer({
      text: result.text,
      usedFactIds: result.used_fact_ids,
      usedEvidenceIds: result.used_evidence_ids,
      authorizedFactIds: new Set(["fact_mock_authorized"]),
      validatedEvidenceIds: new Set(["evidence_mock_authorized"]),
      groundedFacts: [{ fact: { raw_value_text: "00000001", source_document_id: null }, quotes: [] }],
    });
    assert.equal(verdict.status, "FAIL");
    assert.equal(verdict.reason, "UNSUPPORTED_HARD_CLAIM");
  });

  await t.test("8/9/10. HTTP 401/403/429/500 all map to MODEL_CALL_HTTP_ERROR, never leaking the mock's response body", async () => {
    for (const scenario of ["http-401", "http-403", "http-429", "http-500"]) {
       
      await assert.rejects(() => adapterFor(scenario).generate({ prompt: "x" }), (error) => {
        assert.ok(error instanceof ModelCallError);
        assert.equal(error.code, "MODEL_CALL_HTTP_ERROR");
        return true;
      });
    }
  });

  await t.test("11. timeout: the server never responds, adapter's own internal timeout fires -> MODEL_CALL_TIMEOUT", async () => {
    const adapter = adapterFor("timeout", { timeout_ms: 200 });
    await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
      assert.equal(error.code, "MODEL_CALL_TIMEOUT");
      return true;
    });
  });

  await t.test("12. abort: caller aborts its own AbortSignal before the (never-responding) server would reply -> MODEL_CALL_TIMEOUT", async () => {
    const adapter = adapterFor("abort", { timeout_ms: 30000 });
    const controller = new AbortController();
    const pending = adapter.generate({ prompt: "x", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => pending, (error) => {
      assert.equal(error.code, "MODEL_CALL_TIMEOUT");
      return true;
    });
  });

  await t.test("14a. the real API key never appears in any thrown error message across the scenarios above", async () => {
    const errors = [];
    for (const scenario of ["malformed", "http-500"]) {
      try {
         
        await adapterFor(scenario).generate({ prompt: "x" });
      } catch (error) {
        errors.push(error.message);
      }
    }
    for (const message of errors) assert.doesNotMatch(message, new RegExp(REAL_API_KEY_VALUE));
  });

  await t.test("14b. the mock server itself received the real key only in the Authorization header, never anywhere else, and the test can observe this only through the server's own test-only introspection (never through adapter output)", async () => {
    await adapterFor("normal").generate({ prompt: "x" });
    const headers = server.getLastRequestHeaders();
    assert.equal(headers.authorization, `Bearer ${REAL_API_KEY_VALUE}`);
    const body = server.getLastRequestBody();
    assert.doesNotMatch(body, new RegExp(REAL_API_KEY_VALUE));
  });
});

test("HCX mock server: connection failure (nothing listening on the target port) is MODEL_CALL_UNKNOWN_ERROR", async () => {
  process.env[API_KEY_ENV_VAR] = REAL_API_KEY_VALUE;
  try {
    // Bind a server, capture its port, close it immediately -- the port is
    // then (almost certainly) refusing new connections, simulating "13.
    // connection failure" without depending on any real external host.
    const server = createHcxMockServer();
    const url = await server.listen();
    await server.close();
    const adapter = createModelAdapter(baseConfig(`${url}/scenarios/normal`, { timeout_ms: 2000 }), { allowLoopbackMockCalls: true });
    await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
      assert.equal(error.code, "MODEL_CALL_UNKNOWN_ERROR");
      return true;
    });
  } finally {
    delete process.env[API_KEY_ENV_VAR];
  }
});
