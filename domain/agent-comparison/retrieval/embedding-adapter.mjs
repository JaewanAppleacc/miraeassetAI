// Turn P4: embedding adapter interface for pgvector-backed retrieval.
// Deliberately mirrors ../model-adapter.mjs's own shape (config-driven
// kind, fail-closed with no API key, typed EmbeddingCallError, never a
// hardcoded provider/model name in code, no real network call anywhere in
// this Turn's tests/scripts) -- this is a SEPARATE contract from
// ModelAdapter (a chat/completion model is a different capability from an
// embedding model, even when the same provider happens to offer both), so
// it is its own file rather than an added method on model-adapter.mjs.
//
// PROTOCOL SCOPE: kind:"HTTP_EMBEDDINGS" is ONE generic embeddings-endpoint
// protocol adapter (POST {model, input: string[]} -> {data: [{embedding:
// number[]}, ...]}), the same "one compatible shape, not every provider"
// framing model-adapter.mjs's own HTTP_CHAT_COMPLETIONS documents. A
// provider with a materially different embeddings API shape needs its own
// EMBEDDING_ADAPTER_KIND and construction branch -- never papered over
// inside this one generic branch.
//
// RESPONSE CONTRACT: embedDocuments(texts, config) resolves to an array of
// number[] vectors, SAME LENGTH and SAME ORDER as `texts` (index i of the
// result is the embedding of texts[i] -- never re-sorted or deduplicated).
// embedQuery(text, config) resolves to a single number[] vector. Every
// vector has exactly `config.dimension` entries, all finite (no NaN/
// Infinity), and is never an empty array. A failure ALWAYS throws an
// EmbeddingCallError with a stable `.code` -- it is never silently reduced
// to a zero/empty vector, and its `.message` never contains the raw
// provider response body, the raw underlying exception message, or the API
// key.
import { validateEmbeddingConfig } from "./contracts.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "./fake-deterministic-embedding-adapter.mjs";

export class EmbeddingAdapterUnavailableError extends Error {
  constructor(reason) {
    super(`embedding adapter unavailable: ${reason}`);
    this.name = "EmbeddingAdapterUnavailableError";
    this.code = "EMBEDDING_ADAPTER_UNAVAILABLE";
  }
}

export class InvalidEmbeddingConfigError extends Error {
  constructor(errors) {
    super(`invalid EmbeddingConfig: ${errors.join("; ")}`);
    this.name = "InvalidEmbeddingConfigError";
    this.errors = errors;
  }
}

export class EmbeddingCallError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = "EmbeddingCallError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function assertVectorsShape(vectors, expectedCount, dimension, label) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new EmbeddingCallError("EMBEDDING_CALL_MALFORMED_RESPONSE", `${label}: expected ${expectedCount} vectors, got ${Array.isArray(vectors) ? vectors.length : typeof vectors}`);
  }
  for (const [index, vector] of vectors.entries()) {
    if (!Array.isArray(vector) || vector.length !== dimension) {
      throw new EmbeddingCallError("EMBEDDING_CALL_MALFORMED_RESPONSE", `${label}[${index}]: expected a ${dimension}-dimension vector, got ${Array.isArray(vector) ? vector.length : typeof vector}`);
    }
    if (vector.length === 0 || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new EmbeddingCallError("EMBEDDING_CALL_MALFORMED_RESPONSE", `${label}[${index}]: embedding vector must be non-empty and contain only finite numbers (no NaN/Infinity)`);
    }
  }
}

function createHttpEmbeddingsAdapter(config, { fetchImpl = fetch } = {}) {
  const apiKey = process.env[config.api_key_env_var];
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new EmbeddingAdapterUnavailableError(
      `environment variable ${config.api_key_env_var} is not set; refusing to call ${config.provider}/${config.model} without an API key`,
    );
  }

  async function callEmbeddingsEndpoint(texts) {
    const controller = new AbortController();
    const timeoutMs = config.timeout_ms ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(config.endpoint_url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: config.model, input: texts }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === "AbortError") throw new EmbeddingCallError("EMBEDDING_CALL_TIMEOUT", "embedding call timed out", { cause: error });
        throw new EmbeddingCallError("EMBEDDING_CALL_UNKNOWN_ERROR", "embedding call failed before a response was received", { cause: error });
      }
      if (!response.ok) throw new EmbeddingCallError("EMBEDDING_CALL_HTTP_ERROR", `embedding endpoint returned a non-OK HTTP status (${response.status})`);
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new EmbeddingCallError("EMBEDDING_CALL_MALFORMED_RESPONSE", "embedding response body was not valid JSON", { cause: error });
      }
      if (!Array.isArray(body?.data)) throw new EmbeddingCallError("EMBEDDING_CALL_MALFORMED_RESPONSE", "embedding response did not contain a data array");
      const vectors = body.data.map((item) => item?.embedding);
      assertVectorsShape(vectors, texts.length, config.dimension, "embedding response data");
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    provider: config.provider,
    model: config.model,
    async embedDocuments(texts) {
      if (!Array.isArray(texts) || texts.length === 0) throw new TypeError("embedDocuments requires a non-empty array of texts");
      return callEmbeddingsEndpoint(texts);
    },
    async embedQuery(text) {
      if (typeof text !== "string" || text === "") throw new TypeError("embedQuery requires a non-empty string");
      const [vector] = await callEmbeddingsEndpoint([text]);
      return vector;
    },
  });
}

export function createEmbeddingAdapter(config, options = {}) {
  const errors = validateEmbeddingConfig(config);
  if (errors.length > 0) throw new InvalidEmbeddingConfigError(errors);
  if (config.kind === "FAKE_DETERMINISTIC") {
    return createDeterministicFakeEmbeddingAdapter({ provider: config.provider, model: config.model, dimension: config.dimension, ...options.fake });
  }
  if (config.kind === "HTTP_EMBEDDINGS") {
    return createHttpEmbeddingsAdapter(config, options);
  }
  throw new InvalidEmbeddingConfigError([`unsupported kind: ${config.kind}`]);
}
