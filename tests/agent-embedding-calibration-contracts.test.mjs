// Turn P9: CalibrationConfig schema/contract tests. No bundle, no
// PostgreSQL, no network -- pure schema/mapping logic only.
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCalibrationConfig, isValidCalibrationConfig, toEmbeddingConfig,
  CALIBRATION_ADAPTER_KINDS, RETRYABLE_EMBEDDING_CALL_ERROR_CODES,
  InvalidCalibrationConfigError, CalibrationBudgetExceededError, CalibrationAuthorizationError, CalibrationAdapterError,
} from "../domain/agent-comparison/embedding-calibration/contracts.mjs";
import { validateEmbeddingConfig } from "../domain/agent-comparison/retrieval/contracts.mjs";

function baseFakeConfig(overrides = {}) {
  return {
    schema_version: "0.1.0", calibration_id: "calibration_test_v01", adapter_kind: "FAKE_DETERMINISTIC",
    provider_id: "test-fixture", model_id: "deterministic-fake-embedding-v1", endpoint: "unused",
    expected_dimension: 8, batch_size: 10, request_timeout_ms: 5000,
    maximum_item_count: 50, maximum_request_count: 10, maximum_total_input_units: 10000,
    sample_salt: "salt-v1", dataset_manifest_sha256: "a".repeat(64), code_revision: "rev1",
    cache_policy: { enabled: true },
    retry_policy: { max_attempts_per_request: 2, retryable_error_codes: ["EMBEDDING_CALL_TIMEOUT"], backoff_ms: 0 },
    input_price_per_million_units: null, actual_external_call_authorized: false,
    ...overrides,
  };
}

test("a valid FAKE_DETERMINISTIC CalibrationConfig passes validation with zero errors", () => {
  const errors = validateCalibrationConfig(baseFakeConfig());
  assert.deepEqual(errors, []);
  assert.equal(isValidCalibrationConfig(baseFakeConfig()), true);
});

test("HTTP_EMBEDDINGS requires api_key_env_var and a real endpoint; omitting api_key_env_var fails validation", () => {
  const withoutKey = baseFakeConfig({ adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings" });
  const errors = validateCalibrationConfig(withoutKey);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes("api_key_env_var")));

  const withKey = { ...withoutKey, api_key_env_var: "SOME_ENV_VAR" };
  assert.deepEqual(validateCalibrationConfig(withKey), []);
});

test("every required field's absence is individually rejected", () => {
  const required = [
    "schema_version", "calibration_id", "adapter_kind", "provider_id", "model_id", "endpoint",
    "expected_dimension", "batch_size", "request_timeout_ms", "maximum_item_count", "maximum_request_count",
    "maximum_total_input_units", "sample_salt", "dataset_manifest_sha256", "code_revision",
    "cache_policy", "retry_policy", "input_price_per_million_units", "actual_external_call_authorized",
  ];
  for (const field of required) {
    const config = baseFakeConfig();
    delete config[field];
    assert.ok(validateCalibrationConfig(config).length > 0, `expected a validation error when "${field}" is missing`);
  }
});

test("maximum_item_count is capped at 200 by the schema itself (never a caller-adjustable-beyond-bound field)", () => {
  assert.ok(validateCalibrationConfig(baseFakeConfig({ maximum_item_count: 201 })).length > 0);
  assert.deepEqual(validateCalibrationConfig(baseFakeConfig({ maximum_item_count: 200 })), []);
});

test("dataset_manifest_sha256 must be a real lowercase hex-64 digest, never a placeholder shape", () => {
  assert.ok(validateCalibrationConfig(baseFakeConfig({ dataset_manifest_sha256: "not-a-hash" })).length > 0);
  assert.ok(validateCalibrationConfig(baseFakeConfig({ dataset_manifest_sha256: "A".repeat(64) })).length > 0, "uppercase hex must be rejected");
});

test("input_price_per_million_units accepts null or a non-negative number, rejects a negative number", () => {
  assert.deepEqual(validateCalibrationConfig(baseFakeConfig({ input_price_per_million_units: null })), []);
  assert.deepEqual(validateCalibrationConfig(baseFakeConfig({ input_price_per_million_units: 0.02 })), []);
  assert.ok(validateCalibrationConfig(baseFakeConfig({ input_price_per_million_units: -1 })).length > 0);
});

test("retry_policy.retryable_error_codes only accepts the closed set of retryable EmbeddingCallError codes", () => {
  assert.ok(validateCalibrationConfig(baseFakeConfig({ retry_policy: { max_attempts_per_request: 1, retryable_error_codes: ["EMBEDDING_CALL_MALFORMED_RESPONSE"], backoff_ms: 0 } })).length > 0, "MALFORMED_RESPONSE must never be declared retryable");
  assert.deepEqual(RETRYABLE_EMBEDDING_CALL_ERROR_CODES.includes("EMBEDDING_CALL_MALFORMED_RESPONSE"), false);
  assert.deepEqual(RETRYABLE_EMBEDDING_CALL_ERROR_CODES.includes("EMBEDDING_ADAPTER_UNAVAILABLE"), false);
});

test("adapter_kind is restricted to the same closed set embedding-adapter.mjs's own EmbeddingConfig supports", () => {
  assert.deepEqual([...CALIBRATION_ADAPTER_KINDS].sort(), ["FAKE_DETERMINISTIC", "HTTP_EMBEDDINGS"]);
  assert.ok(validateCalibrationConfig(baseFakeConfig({ adapter_kind: "SOME_OTHER_KIND" })).length > 0);
});

test("additionalProperties:false -- an unexpected field (e.g. a stray provider name literal) is rejected, not silently ignored", () => {
  assert.ok(validateCalibrationConfig({ ...baseFakeConfig(), unexpected_field: "openai" }).length > 0);
});

test("toEmbeddingConfig produces a config that itself validates against the UNCHANGED, existing EmbeddingConfig schema", () => {
  const embeddingConfig = toEmbeddingConfig(baseFakeConfig());
  assert.deepEqual(validateEmbeddingConfig(embeddingConfig), []);
  assert.equal(embeddingConfig.kind, "FAKE_DETERMINISTIC");
  assert.equal(embeddingConfig.provider, "test-fixture");
  assert.equal(embeddingConfig.dimension, 8);
});

test("toEmbeddingConfig for HTTP_EMBEDDINGS carries endpoint_url/api_key_env_var through, and NEVER copies calibration-only fields (budgets/salt/dataset sha) into it", () => {
  const httpConfig = baseFakeConfig({ adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings", api_key_env_var: "TEST_KEY_VAR" });
  const embeddingConfig = toEmbeddingConfig(httpConfig);
  assert.equal(embeddingConfig.endpoint_url, "https://example.invalid/v1/embeddings");
  assert.equal(embeddingConfig.api_key_env_var, "TEST_KEY_VAR");
  assert.deepEqual(validateEmbeddingConfig(embeddingConfig), []);
  for (const leaked of ["calibration_id", "maximum_item_count", "maximum_request_count", "maximum_total_input_units", "sample_salt", "dataset_manifest_sha256", "cache_policy", "retry_policy", "actual_external_call_authorized"]) {
    assert.equal(embeddingConfig[leaked], undefined, `toEmbeddingConfig must never leak "${leaked}" onto the EmbeddingConfig`);
  }
});

test("error classes carry a stable .code and never a network-shaped message by construction", () => {
  const budgetError = new CalibrationBudgetExceededError("maximum_item_count", { limit: 10, wouldBe: 20 });
  assert.equal(budgetError.code, "CALIBRATION_BUDGET_EXCEEDED");
  const authError = new CalibrationAuthorizationError("not authorized");
  assert.equal(authError.code, "CALIBRATION_EXTERNAL_CALL_NOT_AUTHORIZED");
  const adapterError = new CalibrationAdapterError("EMBEDDING_CALL_TIMEOUT", "timed out");
  assert.equal(adapterError.code, "EMBEDDING_CALL_TIMEOUT");
  const invalidConfigError = new InvalidCalibrationConfigError(["x is required"]);
  assert.ok(invalidConfigError.message.includes("x is required"));
});
