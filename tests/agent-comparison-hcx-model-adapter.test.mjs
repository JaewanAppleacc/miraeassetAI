// Turn P11-A: unit tests for the HCX_CHAT_COMPLETIONS ModelAdapter --
// config/security fail-closed behavior, request/response parsing, and
// error-code mapping. Every test injects its own fetchImpl (mirrors
// tests/agent-comparison-model-adapter.test.mjs's own established
// pattern) -- NO test here ever calls the real global fetch, and no test
// ever sets actual_external_call_authorized:true and then actually invokes
// a network-touching fetchImpl (the one test that sets it true still
// injects a fetchImpl that never performs real I/O, purely to prove the
// authorization-gate LOGIC, not to make a real call).
import assert from "node:assert/strict";
import test from "node:test";
import { createModelAdapter, ModelAdapterUnavailableError, InvalidModelConfigError, ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";

function hcxConfig(overrides = {}) {
  return {
    schema_version: "0.1.0",
    model_config_id: "model_hcx-test-v1",
    kind: "HCX_CHAT_COMPLETIONS",
    provider: "hcx",
    model: "test-fixture-model",
    endpoint_url: "http://127.0.0.1:9/hcx/v3/chat-completions",
    api_key_env_var: "AGENT_COMPARISON_HCX_TEST_KEY",
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

function structuredEnvelope({ answer = "generated answer", usedFactIds = [], usedEvidenceIds = [], statusCode = "20000" } = {}, extraResult = {}) {
  return {
    ok: true,
    json: async () => ({
      status: { code: statusCode, message: "OK" },
      result: { message: { content: JSON.stringify({ answer, used_fact_ids: usedFactIds, used_evidence_ids: usedEvidenceIds }) }, usage: { promptTokens: 12, completionTokens: 6 }, ...extraResult },
    }),
  };
}

function withKey(envVar, run) {
  process.env[envVar] = "fake-key-for-test";
  return run().finally(() => { delete process.env[envVar]; });
}

test("HCX_CHAT_COMPLETIONS: refuses construction (fail-closed) when the API key env var is unset -- MODEL_ADAPTER_UNAVAILABLE, no fetchImpl ever invoked", () => {
  delete process.env.AGENT_COMPARISON_HCX_UNSET_KEY;
  let fetchCalled = false;
  assert.throws(
    () => createModelAdapter(
      hcxConfig({ api_key_env_var: "AGENT_COMPARISON_HCX_UNSET_KEY" }),
      { allowLoopbackMockCalls: true, fetchImpl: async () => { fetchCalled = true; throw new Error("must not be called"); } },
    ),
    (error) => {
      assert.ok(error instanceof ModelAdapterUnavailableError);
      assert.equal(error.code, "MODEL_ADAPTER_UNAVAILABLE");
      return true;
    },
  );
  assert.equal(fetchCalled, false);
});

test("HCX_CHAT_COMPLETIONS: an unrecognized request_schema_version fails closed at construction, zero fetch calls", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let fetchCalled = false;
  assert.throws(
    () => createModelAdapter(
      hcxConfig({ request_schema_version: "some-future-shape-v9" }),
      { allowLoopbackMockCalls: true, fetchImpl: async () => { fetchCalled = true; return structuredEnvelope(); } },
    ),
    ModelAdapterUnavailableError,
  );
  assert.equal(fetchCalled, false);
}));

test("HCX_CHAT_COMPLETIONS: an unrecognized response_schema_version fails closed at construction, zero fetch calls", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let fetchCalled = false;
  assert.throws(
    () => createModelAdapter(
      hcxConfig({ response_schema_version: "some-future-shape-v9" }),
      { allowLoopbackMockCalls: true, fetchImpl: async () => { fetchCalled = true; return structuredEnvelope(); } },
    ),
    ModelAdapterUnavailableError,
  );
  assert.equal(fetchCalled, false);
}));

test("HCX_CHAT_COMPLETIONS: a loopback endpoint WITHOUT the explicit allowLoopbackMockCalls option refuses construction (actual_external_call_authorized=false), zero fetch calls", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let fetchCalled = false;
  assert.throws(
    () => createModelAdapter(hcxConfig(), { fetchImpl: async () => { fetchCalled = true; return structuredEnvelope(); } }),
    (error) => {
      assert.ok(error instanceof ModelAdapterUnavailableError);
      assert.equal(error.code, "MODEL_ADAPTER_UNAVAILABLE");
      return true;
    },
  );
  assert.equal(fetchCalled, false);
}));

test("HCX_CHAT_COMPLETIONS: a non-loopback endpoint with actual_external_call_authorized=false refuses construction regardless of allowLoopbackMockCalls, zero fetch calls", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let fetchCalled = false;
  assert.throws(
    () => createModelAdapter(
      hcxConfig({ endpoint_url: "https://example.invalid/hcx/v3/chat-completions" }),
      { allowLoopbackMockCalls: true, fetchImpl: async () => { fetchCalled = true; return structuredEnvelope(); } },
    ),
    ModelAdapterUnavailableError,
  );
  assert.equal(fetchCalled, false);
}));

test("HCX_CHAT_COMPLETIONS: a non-loopback endpoint that is not https:// refuses construction even when actual_external_call_authorized=true, zero fetch calls", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let fetchCalled = false;
  assert.throws(
    () => createModelAdapter(
      hcxConfig({ endpoint_url: "http://example.invalid/hcx/v3/chat-completions", actual_external_call_authorized: true }),
      { fetchImpl: async () => { fetchCalled = true; return structuredEnvelope(); } },
    ),
    ModelAdapterUnavailableError,
  );
  assert.equal(fetchCalled, false);
}));

test("HCX_CHAT_COMPLETIONS: a loopback endpoint WITH allowLoopbackMockCalls:true is permitted to call the injected fetchImpl and reports the parsed structured answer plus real usage/cost", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let callCount = 0;
  const adapter = createModelAdapter(
    hcxConfig({ input_cost_per_1k_tokens: 1, output_cost_per_1k_tokens: 2 }),
    { allowLoopbackMockCalls: true, fetchImpl: async () => { callCount += 1; return structuredEnvelope({ answer: "생성된 답변", usedFactIds: ["fact_x"], usedEvidenceIds: ["evidence_x"] }); } },
  );
  const result = await adapter.generate({ prompt: "무엇인가요?" });
  assert.equal(callCount, 1);
  assert.equal(result.text, "생성된 답변");
  assert.deepEqual(result.used_fact_ids, ["fact_x"]);
  assert.deepEqual(result.used_evidence_ids, ["evidence_x"]);
  assert.equal(result.input_tokens, 12);
  assert.equal(result.output_tokens, 6);
  assert.equal(result.estimated_cost, (12 / 1000) * 1 + (6 / 1000) * 2);
}));

test("HCX_CHAT_COMPLETIONS: actual_external_call_authorized=true permits a non-loopback https endpoint to be constructed (still never a real network call -- fetchImpl is injected)", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let callCount = 0;
  const adapter = createModelAdapter(
    hcxConfig({ endpoint_url: "https://example.invalid/hcx/v3/chat-completions", actual_external_call_authorized: true }),
    { fetchImpl: async () => { callCount += 1; return structuredEnvelope(); } },
  );
  assert.equal(adapter.endpointIsLoopback, false);
  await adapter.generate({ prompt: "x" });
  assert.equal(callCount, 1);
}));

test("HCX_CHAT_COMPLETIONS: an empty generated answer text is MODEL_CALL_MALFORMED_RESPONSE (D: 'text가 비어 있지 않음')", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => structuredEnvelope({ answer: "" }) });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: a duplicate id in used_fact_ids is MODEL_CALL_MALFORMED_RESPONSE (D: '중복 ID 없음')", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => structuredEnvelope({ usedFactIds: ["fact_x", "fact_x"] }) });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: a duplicate id in used_evidence_ids is MODEL_CALL_MALFORMED_RESPONSE", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => structuredEnvelope({ usedEvidenceIds: ["evidence_x", "evidence_x"] }) });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: status.code != 20000 is MODEL_CALL_MALFORMED_RESPONSE", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => ({ ok: true, json: async () => ({ status: { code: "40000", message: "bad request" }, result: null }) }) });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: a response missing result.message.content is MODEL_CALL_MALFORMED_RESPONSE", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => ({ ok: true, json: async () => ({ status: { code: "20000" }, result: {} }) }) });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: content that is not valid JSON is MODEL_CALL_MALFORMED_RESPONSE", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => ({ ok: true, json: async () => ({ status: { code: "20000" }, result: { message: { content: "not json" } } }) }) });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: a non-OK HTTP response is MODEL_CALL_HTTP_ERROR, message never echoes the raw body", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: "super secret internal detail sk-should-not-leak" }) }) });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_HTTP_ERROR");
    assert.doesNotMatch(error.message, /sk-should-not-leak/);
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: HTTP 401/403/429 all map to MODEL_CALL_HTTP_ERROR (distinguishable by the embedded status code, never a separate leaking code)", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  for (const status of [401, 403, 429]) {
    const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }) });
     
    await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
      assert.equal(error.code, "MODEL_CALL_HTTP_ERROR");
      assert.match(error.message, new RegExp(String(status)));
      return true;
    });
  }
}));

test("HCX_CHAT_COMPLETIONS: an AbortError (internal timeout) is MODEL_CALL_TIMEOUT", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => { const err = new Error("The operation was aborted"); err.name = "AbortError"; throw err; } });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_TIMEOUT");
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: an externally-supplied AbortSignal that fires before the response is also MODEL_CALL_TIMEOUT", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const controller = new AbortController();
  const adapter = createModelAdapter(hcxConfig(), {
    allowLoopbackMockCalls: true,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { const err = new Error("aborted"); err.name = "AbortError"; reject(err); });
    }),
  });
  const pending = adapter.generate({ prompt: "x", signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => {
    assert.equal(error.code, "MODEL_CALL_TIMEOUT");
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: a raw connection failure (fetchImpl throws a generic Error) is MODEL_CALL_UNKNOWN_ERROR, never re-thrown with its own message", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  const adapter = createModelAdapter(hcxConfig(), { allowLoopbackMockCalls: true, fetchImpl: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9 secret-detail"); } });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_UNKNOWN_ERROR");
    assert.doesNotMatch(error.message, /secret-detail/);
    return true;
  });
}));

test("HCX_CHAT_COMPLETIONS: the Authorization header carries the real key but is never present in a thrown error's message", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let seenAuth = null;
  const adapter = createModelAdapter(hcxConfig(), {
    allowLoopbackMockCalls: true,
    fetchImpl: async (url, opts) => { seenAuth = opts.headers.authorization; return { ok: false, status: 500, json: async () => ({}) }; },
  });
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.doesNotMatch(error.message, /fake-key-for-test/);
    return true;
  });
  assert.equal(seenAuth, "Bearer fake-key-for-test");
}));

test("HCX_CHAT_COMPLETIONS: seed is included in the request body only when seed_supported=true and the caller's request supplies one", () => withKey("AGENT_COMPARISON_HCX_TEST_KEY", async () => {
  let capturedBodyNoSeedSupport;
  const adapterNoSeedSupport = createModelAdapter(hcxConfig({ seed_supported: false }), {
    allowLoopbackMockCalls: true,
    fetchImpl: async (url, opts) => { capturedBodyNoSeedSupport = JSON.parse(opts.body); return structuredEnvelope(); },
  });
  await adapterNoSeedSupport.generate({ prompt: "x", seed: 42 });
  assert.equal("seed" in capturedBodyNoSeedSupport, false);

  let capturedBodyWithSeedSupport;
  const adapterWithSeedSupport = createModelAdapter(hcxConfig({ seed_supported: true }), {
    allowLoopbackMockCalls: true,
    fetchImpl: async (url, opts) => { capturedBodyWithSeedSupport = JSON.parse(opts.body); return structuredEnvelope(); },
  });
  await adapterWithSeedSupport.generate({ prompt: "x", seed: 42 });
  assert.equal(capturedBodyWithSeedSupport.seed, 42);
}));

test("createModelAdapter(HCX_CHAT_COMPLETIONS) rejects an invalid ModelConfig (missing top_p/seed_supported/etc.) before constructing anything", () => {
  assert.throws(
    () => createModelAdapter({ schema_version: "0.1.0", model_config_id: "model_hcx-invalid", kind: "HCX_CHAT_COMPLETIONS", provider: "hcx", model: "x" }),
    InvalidModelConfigError,
  );
});
