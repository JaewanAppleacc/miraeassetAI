// pgvector 기반 검색용 임베딩 어댑터 인터페이스. 구성 주도 kind, API 키 없으면
// fail-closed, typed EmbeddingCallError, 코드에 제공자/모델명 하드코딩 없음.
//
// 프로토콜 범위: kind:"HTTP_EMBEDDINGS"는 하나의 범용 임베딩 엔드포인트 프로토콜
// (POST {model, input: string[]} -> {data:[{embedding: number[]},...]})이다. 응답 모양이
// 실질적으로 다른 제공자는 자기 kind와 생성 분기가 필요하며, 이 범용 분기 안에서 덮어
// 가리지 않는다.
//
// 응답 계약: embedDocuments(texts, config)는 `texts`와 같은 길이·같은 순서의 number[]
// 배열로 확정된다(결과의 i번째가 texts[i]의 임베딩 — 재정렬·중복 제거 없음).
// embedQuery(text, config)는 단일 number[] 벡터. 모든 벡터는 정확히 config.dimension
// 길이의 유한 수(NaN/Infinity 없음)이며 빈 배열이 아니다. 실패는 항상 안정된 `.code`를
// 가진 EmbeddingCallError로 던져진다 — 0/빈 벡터로 조용히 축소되지 않고, 메시지에 원 응답
// 본문·원 예외 메시지·API 키가 담기지 않는다.
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

// The ONLY hostnames auth_mode=NONE may ever be used against.
// Checked against endpoint_url's OWN parsed hostname -- never against a
// caller-supplied network_scope claim, which is informational only.
const LOOPBACK_HOSTNAMES = Object.freeze(new Set(["127.0.0.1", "localhost", "::1"]));

function createHttpEmbeddingsAdapter(config, { fetchImpl = fetch } = {}) {
  // Absent auth_mode means BEARER_ENV -- identical to every
  // config this adapter has ever accepted before. This branch is
  // unreachable for such configs; nothing about their behavior changes.
  const authMode = config.auth_mode ?? "BEARER_ENV";
  let apiKey = null;

  if (authMode === "BEARER_ENV") {
    apiKey = process.env[config.api_key_env_var];
    if (typeof apiKey !== "string" || apiKey === "") {
      throw new EmbeddingAdapterUnavailableError(
        `environment variable ${config.api_key_env_var} is not set; refusing to call ${config.provider}/${config.model} without an API key`,
      );
    }
  } else if (authMode === "NONE") {
    // Fail-closed BEFORE any request is ever sent (this constructor runs
    // once, before embedDocuments/embedQuery can be called at all) -- a
    // dummy/placeholder key is never used as a workaround; auth_mode=NONE
    // sends no Authorization header, and is refused outright for anything
    // that does not parse to a real loopback hostname.
    let hostname;
    try {
      hostname = new URL(config.endpoint_url).hostname;
    } catch {
      throw new EmbeddingAdapterUnavailableError(`endpoint_url is not a valid URL; refusing to permit auth_mode=NONE without a verifiable loopback hostname`);
    }
    if (!LOOPBACK_HOSTNAMES.has(hostname)) {
      throw new EmbeddingAdapterUnavailableError(
        `auth_mode=NONE is only permitted for a loopback endpoint (127.0.0.1, localhost, or ::1) -- refusing to call "${hostname}" without authentication`,
      );
    }
  } else {
    throw new EmbeddingAdapterUnavailableError(`unsupported auth_mode: ${authMode}`);
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
          headers: authMode === "BEARER_ENV"
            ? { "content-type": "application/json", authorization: `Bearer ${apiKey}` }
            : { "content-type": "application/json" },
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
