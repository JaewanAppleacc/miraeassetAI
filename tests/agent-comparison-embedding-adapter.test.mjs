import assert from "node:assert/strict";
import test from "node:test";
import { createEmbeddingAdapter, EmbeddingAdapterUnavailableError, InvalidEmbeddingConfigError, EmbeddingCallError } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "../domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs";

test("createDeterministicFakeEmbeddingAdapter: the same text always produces the same vector, and order is preserved across embedDocuments", async () => {
  const adapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const first = await adapter.embedDocuments(["a", "b", "c"]);
  const second = await adapter.embedDocuments(["a", "b", "c"]);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  for (const vector of first) {
    assert.equal(vector.length, 8);
    assert.ok(vector.every((v) => Number.isFinite(v)));
  }
  assert.notDeepEqual(first[0], first[1]);
});

test("createDeterministicFakeEmbeddingAdapter: embedQuery matches embedDocuments for the identical text", async () => {
  const adapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const [docVector] = await adapter.embedDocuments(["hello world"]);
  const queryVector = await adapter.embedQuery("hello world");
  assert.deepEqual(docVector, queryVector);
});

test("createEmbeddingAdapter rejects an invalid EmbeddingConfig before constructing anything", () => {
  assert.throws(() => createEmbeddingAdapter({ schema_version: "0.1.0", kind: "FAKE_DETERMINISTIC", provider: "p", model: "m", revision: "v1" }), InvalidEmbeddingConfigError);
});

test("createEmbeddingAdapter(HTTP_EMBEDDINGS) fails closed with EmbeddingAdapterUnavailableError when the API key env var is unset -- no fetchImpl is ever invoked", () => {
  let fetchCalled = false;
  delete process.env.AGENT_COMPARISON_TEST_EMBED_KEY_UNSET;
  assert.throws(
    () => createEmbeddingAdapter(
      { schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "test", model: "embed-test", revision: "v1", dimension: 8, endpoint_url: "https://example.invalid/v1/embeddings", api_key_env_var: "AGENT_COMPARISON_TEST_EMBED_KEY_UNSET" },
      { fetchImpl: async () => { fetchCalled = true; throw new Error("must not be called"); } },
    ),
    EmbeddingAdapterUnavailableError,
  );
  assert.equal(fetchCalled, false);
});

function withKey(envVar, run) {
  process.env[envVar] = "fake-key-for-test";
  return run().finally(() => { delete process.env[envVar]; });
}

test("createEmbeddingAdapter(HTTP_EMBEDDINGS): a successful call returns vectors in the same order as the input texts", () => withKey("AGENT_COMPARISON_TEST_EMBED_KEY_OK", async () => {
  const adapter = createEmbeddingAdapter(
    { schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "test", model: "embed-test", revision: "v1", dimension: 3, api_key_env_var: "AGENT_COMPARISON_TEST_EMBED_KEY_OK", endpoint_url: "https://example.invalid/v1/embeddings" },
    { fetchImpl: async (url, { body }) => {
      const { input } = JSON.parse(body);
      return { ok: true, json: async () => ({ data: input.map((_, i) => ({ embedding: [i, i + 1, i + 2] })) }) };
    } },
  );
  const vectors = await adapter.embedDocuments(["x", "y", "z"]);
  assert.deepEqual(vectors, [[0, 1, 2], [1, 2, 3], [2, 3, 4]]);
}));

test("createEmbeddingAdapter(HTTP_EMBEDDINGS): a non-OK HTTP response is EmbeddingCallError EMBEDDING_CALL_HTTP_ERROR, message never echoes the raw response body", () => withKey("AGENT_COMPARISON_TEST_EMBED_KEY_HTTP", async () => {
  const adapter = createEmbeddingAdapter(
    { schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "test", model: "embed-test", revision: "v1", dimension: 3, api_key_env_var: "AGENT_COMPARISON_TEST_EMBED_KEY_HTTP", endpoint_url: "https://example.invalid/v1/embeddings" },
    { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "sk-should-not-leak" }) }) },
  );
  await assert.rejects(() => adapter.embedDocuments(["x"]), (error) => {
    assert.ok(error instanceof EmbeddingCallError);
    assert.equal(error.code, "EMBEDDING_CALL_HTTP_ERROR");
    assert.doesNotMatch(error.message, /sk-should-not-leak/);
    return true;
  });
}));

test("createEmbeddingAdapter(HTTP_EMBEDDINGS): a response with the wrong vector count/dimension is EMBEDDING_CALL_MALFORMED_RESPONSE, never silently truncated/padded", () => withKey("AGENT_COMPARISON_TEST_EMBED_KEY_MALFORMED", async () => {
  const adapter = createEmbeddingAdapter(
    { schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "test", model: "embed-test", revision: "v1", dimension: 3, api_key_env_var: "AGENT_COMPARISON_TEST_EMBED_KEY_MALFORMED", endpoint_url: "https://example.invalid/v1/embeddings" },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2] }] }) }) }, // wrong dimension
  );
  await assert.rejects(() => adapter.embedDocuments(["x"]), (error) => {
    assert.equal(error.code, "EMBEDDING_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("createEmbeddingAdapter(HTTP_EMBEDDINGS): a NaN/Infinity value anywhere in a returned vector is rejected, never silently accepted", () => withKey("AGENT_COMPARISON_TEST_EMBED_KEY_NAN", async () => {
  const adapter = createEmbeddingAdapter(
    { schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "test", model: "embed-test", revision: "v1", dimension: 2, api_key_env_var: "AGENT_COMPARISON_TEST_EMBED_KEY_NAN", endpoint_url: "https://example.invalid/v1/embeddings" },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, Number.NaN] }] }) }) },
  );
  await assert.rejects(() => adapter.embedDocuments(["x"]), (error) => {
    assert.equal(error.code, "EMBEDDING_CALL_MALFORMED_RESPONSE");
    return true;
  });
}));

test("createEmbeddingAdapter(HTTP_EMBEDDINGS): a real transport timeout is EMBEDDING_CALL_TIMEOUT", () => withKey("AGENT_COMPARISON_TEST_EMBED_KEY_TIMEOUT", async () => {
  const adapter = createEmbeddingAdapter(
    { schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "test", model: "embed-test", revision: "v1", dimension: 2, api_key_env_var: "AGENT_COMPARISON_TEST_EMBED_KEY_TIMEOUT", endpoint_url: "https://example.invalid/v1/embeddings" },
    { fetchImpl: async () => { const err = new Error("aborted"); err.name = "AbortError"; throw err; } },
  );
  await assert.rejects(() => adapter.embedDocuments(["x"]), (error) => {
    assert.equal(error.code, "EMBEDDING_CALL_TIMEOUT");
    return true;
  });
}));
