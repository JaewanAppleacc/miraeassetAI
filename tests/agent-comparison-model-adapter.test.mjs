import assert from "node:assert/strict";
import test from "node:test";
import { createModelAdapter, ModelAdapterUnavailableError, InvalidModelConfigError, ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";

test("createModelAdapter(FAKE_DETERMINISTIC) never touches the network and is deterministic across repeated calls", async () => {
  const adapter = createModelAdapter({
    schema_version: "0.1.0", model_config_id: "model_fake-v1", kind: "FAKE_DETERMINISTIC", provider: "test", model: "fake",
  });
  const first = await adapter.generate({ prompt: "hello" });
  const second = await adapter.generate({ prompt: "hello" });
  assert.equal(first.text, second.text);
  assert.equal(first.estimated_cost, 0);
  assert.deepEqual(first.used_fact_ids, []);
  assert.deepEqual(first.used_evidence_ids, []);
});

test("createModelAdapter(HTTP_CHAT_COMPLETIONS) fails closed with ModelAdapterUnavailableError when the API key env var is unset -- code MODEL_ADAPTER_UNAVAILABLE, message never contains the endpoint URL or a raw provider error", () => {
  delete process.env.AGENT_COMPARISON_TEST_UNSET_KEY;
  assert.throws(
    () => createModelAdapter({
      schema_version: "0.1.0", model_config_id: "model_http-v1", kind: "HTTP_CHAT_COMPLETIONS",
      provider: "test", model: "gpt-test", endpoint_url: "https://example.invalid/v1/chat/completions",
      api_key_env_var: "AGENT_COMPARISON_TEST_UNSET_KEY",
    }),
    (error) => {
      assert.ok(error instanceof ModelAdapterUnavailableError);
      assert.equal(error.code, "MODEL_ADAPTER_UNAVAILABLE");
      return true;
    },
  );
});

test("createModelAdapter(HTTP_CHAT_COMPLETIONS) never calls fetch when constructed without an API key present -- no fetchImpl is ever invoked", () => {
  let fetchCalled = false;
  delete process.env.AGENT_COMPARISON_TEST_UNSET_KEY_2;
  assert.throws(() => createModelAdapter(
    {
      schema_version: "0.1.0", model_config_id: "model_http-v2", kind: "HTTP_CHAT_COMPLETIONS",
      provider: "test", model: "gpt-test", endpoint_url: "https://example.invalid/v1/chat/completions",
      api_key_env_var: "AGENT_COMPARISON_TEST_UNSET_KEY_2",
    },
    { fetchImpl: async () => { fetchCalled = true; throw new Error("must not be called"); } },
  ));
  assert.equal(fetchCalled, false);
});

function structuredJsonBody({ answer = "generated answer", used_fact_ids = [], used_evidence_ids = [] } = {}, extra = {}) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer, used_fact_ids, used_evidence_ids }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 }, ...extra }) };
}

test("createModelAdapter(HTTP_CHAT_COMPLETIONS): a successful call returns the structured {text, used_fact_ids, used_evidence_ids} shape parsed from the JSON content string, and reports real token usage/cost", async () => {
  process.env.AGENT_COMPARISON_TEST_KEY = "fake-key-for-test";
  try {
    let callCount = 0;
    const adapter = createModelAdapter(
      {
        schema_version: "0.1.0", model_config_id: "model_http-v3", kind: "HTTP_CHAT_COMPLETIONS",
        provider: "test", model: "gpt-test", endpoint_url: "https://example.invalid/v1/chat/completions",
        api_key_env_var: "AGENT_COMPARISON_TEST_KEY", input_cost_per_1k_tokens: 1, output_cost_per_1k_tokens: 2,
      },
      { fetchImpl: async () => { callCount += 1; return structuredJsonBody({ answer: "generated answer", used_fact_ids: ["fact_x"], used_evidence_ids: ["evidence_x"] }); } },
    );
    const result = await adapter.generate({ prompt: "what is x?" });
    assert.equal(callCount, 1);
    assert.equal(result.text, "generated answer");
    assert.deepEqual(result.used_fact_ids, ["fact_x"]);
    assert.deepEqual(result.used_evidence_ids, ["evidence_x"]);
    assert.equal(result.input_tokens, 10);
    assert.equal(result.output_tokens, 5);
    assert.equal(result.estimated_cost, (10 / 1000) * 1 + (5 / 1000) * 2);
  } finally {
    delete process.env.AGENT_COMPARISON_TEST_KEY;
  }
});

function withKey(envVar, run) {
  process.env[envVar] = "fake-key-for-test";
  return run().finally(() => { delete process.env[envVar]; });
}

test("HTTP_CHAT_COMPLETIONS: a real transport-level timeout (AbortError) is reported as ModelCallError code MODEL_CALL_TIMEOUT, never a raw exception", () => withKey("AGENT_COMPARISON_TEST_KEY_TIMEOUT", async () => {
  const adapter = createModelAdapter(
    { schema_version: "0.1.0", model_config_id: "model_http-timeout", kind: "HTTP_CHAT_COMPLETIONS", provider: "test", model: "x", endpoint_url: "https://example.invalid", api_key_env_var: "AGENT_COMPARISON_TEST_KEY_TIMEOUT" },
    { fetchImpl: async (url, { signal }) => { const err = new Error("The operation was aborted"); err.name = "AbortError"; throw err; } },
  );
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_TIMEOUT");
    return true;
  });
}));

test("HTTP_CHAT_COMPLETIONS: a non-OK HTTP response is reported as ModelCallError code MODEL_CALL_HTTP_ERROR, and the message never echoes the raw response body", () => withKey("AGENT_COMPARISON_TEST_KEY_HTTP", async () => {
  const adapter = createModelAdapter(
    { schema_version: "0.1.0", model_config_id: "model_http-error", kind: "HTTP_CHAT_COMPLETIONS", provider: "test", model: "x", endpoint_url: "https://example.invalid", api_key_env_var: "AGENT_COMPARISON_TEST_KEY_HTTP" },
    { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: "super secret internal detail sk-should-not-leak" }) }) },
  );
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_HTTP_ERROR");
    assert.doesNotMatch(error.message, /sk-should-not-leak/);
    return true;
  });
}));

test("HTTP_CHAT_COMPLETIONS: a response whose content is not valid JSON is reported as ModelCallError code MODEL_CALL_MALFORMED_RESPONSE", () => withKey("AGENT_COMPARISON_TEST_KEY_MALFORMED1", async () => {
  const adapter = createModelAdapter(
    { schema_version: "0.1.0", model_config_id: "model_http-malformed1", kind: "HTTP_CHAT_COMPLETIONS", provider: "test", model: "x", endpoint_url: "https://example.invalid", api_key_env_var: "AGENT_COMPARISON_TEST_KEY_MALFORMED1" },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not json at all" } }], usage: {} }) }) },
  );
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("HTTP_CHAT_COMPLETIONS: a response missing choices[0].message.content is reported as ModelCallError code MODEL_CALL_MALFORMED_RESPONSE", () => withKey("AGENT_COMPARISON_TEST_KEY_MALFORMED2", async () => {
  const adapter = createModelAdapter(
    { schema_version: "0.1.0", model_config_id: "model_http-malformed2", kind: "HTTP_CHAT_COMPLETIONS", provider: "test", model: "x", endpoint_url: "https://example.invalid", api_key_env_var: "AGENT_COMPARISON_TEST_KEY_MALFORMED2" },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }) },
  );
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("HTTP_CHAT_COMPLETIONS: valid JSON content missing the required used_fact_ids/used_evidence_ids array shape is MODEL_CALL_MALFORMED_RESPONSE, not silently coerced", () => withKey("AGENT_COMPARISON_TEST_KEY_MALFORMED3", async () => {
  const adapter = createModelAdapter(
    { schema_version: "0.1.0", model_config_id: "model_http-malformed3", kind: "HTTP_CHAT_COMPLETIONS", provider: "test", model: "x", endpoint_url: "https://example.invalid", api_key_env_var: "AGENT_COMPARISON_TEST_KEY_MALFORMED3" },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: "x", used_fact_ids: "not-an-array" }) } }] }) }) },
  );
  await assert.rejects(() => adapter.generate({ prompt: "x" }), (error) => {
    assert.equal(error.code, "MODEL_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("createModelAdapter rejects an invalid ModelConfig before constructing anything", () => {
  assert.throws(() => createModelAdapter({ schema_version: "0.1.0", model_config_id: "not a valid id", kind: "FAKE_DETERMINISTIC", provider: "x", model: "y" }), InvalidModelConfigError);
});

test("createDeterministicFakeModelAdapter with a custom responder never invents text outside what the responder returns, and can simulate a call failure by throwing", async () => {
  const adapter = createDeterministicFakeModelAdapter({ responder: (request) => ({ text: `ECHO:${request.prompt}`, used_fact_ids: [], used_evidence_ids: [] }) });
  const result = await adapter.generate({ prompt: "verified fact only" });
  assert.equal(result.text, "ECHO:verified fact only");

  const failingAdapter = createDeterministicFakeModelAdapter({ responder: () => { throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout"); } });
  await assert.rejects(() => failingAdapter.generate({ prompt: "x" }), (error) => {
    assert.equal(error.code, "MODEL_CALL_TIMEOUT");
    return true;
  });
});
