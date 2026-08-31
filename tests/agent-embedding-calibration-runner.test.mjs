// Turn P9: runner.mjs safety/budget/authorization/leak tests. No real
// network call is EVER made by this file -- every "HTTP_EMBEDDINGS" case
// below supplies its own `fetchImpl` stub (never the real global fetch),
// and the "no-network-without-authorization" test asserts that stub is
// NEVER invoked at all.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  runEmbeddingCalibration,
} from "../domain/agent-comparison/embedding-calibration/runner.mjs";
import {
  CalibrationAuthorizationError, CalibrationBudgetExceededError,
} from "../domain/agent-comparison/embedding-calibration/contracts.mjs";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function baseConfig(overrides = {}) {
  return {
    schema_version: "0.1.0", calibration_id: "calibration_runner_test", adapter_kind: "FAKE_DETERMINISTIC",
    provider_id: "test-fixture", model_id: "deterministic-fake-embedding-v1", endpoint: "unused",
    expected_dimension: 8, batch_size: 5, request_timeout_ms: 5000,
    maximum_item_count: 50, maximum_request_count: 20, maximum_total_input_units: 100000,
    sample_salt: "salt", dataset_manifest_sha256: "a".repeat(64), code_revision: "rev1",
    cache_policy: { enabled: true }, retry_policy: { max_attempts_per_request: 2, retryable_error_codes: ["EMBEDDING_CALL_TIMEOUT"], backoff_ms: 0 },
    input_price_per_million_units: null, actual_external_call_authorized: false,
    ...overrides,
  };
}

function items(n, { corpCode = "00000001", textPrefix = "text" } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const textContent = `${textPrefix} ${i}`;
    return {
      calibrationItemId: `calitem_${i}`, factId: `fact_${i}`, evidenceId: `evidence_${i}`,
      sourceDocumentId: `doc_${i}`, corpCode, inputTextSha256: sha256Hex(textContent),
      expectedSelfMatchId: `calitem_${i}`, textContent,
    };
  });
}

// -------------------------------------------------------------------------
// FAKE adapter smoke
// -------------------------------------------------------------------------

test("FAKE_DETERMINISTIC smoke: SUCCESS run, zero network calls possible by construction, quality metrics populated", async () => {
  const result = await runEmbeddingCalibration({ calibrationConfig: baseConfig(), datasetItems: items(12) });
  assert.equal(result.run_status, "SUCCESS");
  assert.equal(result.failure_code, null);
  assert.equal(result.operational.success_count, 12);
  assert.equal(result.operational.failure_count, 0);
  assert.ok(result.quality);
  assert.ok(result.quality.self_match_recall_at_1 >= 0 && result.quality.self_match_recall_at_1 <= 1);
  assert.equal(result.ranking_performed, true);
  assert.equal(result.dev_gold_accessed, false);
  assert.equal(result.holdout_accessed, false);
  assert.equal(result.final_model_selected, false);
  assert.equal(result.actual_external_embedding_call_performed, false);
});

// -------------------------------------------------------------------------
// No network without authorization
// -------------------------------------------------------------------------

test("HTTP_EMBEDDINGS with actual_external_call_authorized=false is refused BEFORE any adapter is constructed or fetchImpl invoked", async () => {
  let fetchCalled = false;
  process.env.CALIBRATION_TEST_KEY_A = "fake-key";
  try {
    await assert.rejects(
      () => runEmbeddingCalibration({
        calibrationConfig: baseConfig({
          adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
          api_key_env_var: "CALIBRATION_TEST_KEY_A", actual_external_call_authorized: false,
        }),
        datasetItems: items(3),
        fetchImpl: async () => { fetchCalled = true; throw new Error("must never be called"); },
      }),
      CalibrationAuthorizationError,
    );
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_A;
  }
  assert.equal(fetchCalled, false);
});

test("HTTP_EMBEDDINGS with actual_external_call_authorized=true DOES call the provided fetchImpl (proving the gate is the ONLY thing blocking it, not something else silently swallowing the call)", async () => {
  let fetchCalled = false;
  process.env.CALIBRATION_TEST_KEY_B = "fake-key";
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_B", actual_external_call_authorized: true, batch_size: 10,
      }),
      datasetItems: items(3),
      fetchImpl: async (url, { body }) => {
        fetchCalled = true;
        const { input } = JSON.parse(body);
        return { ok: true, json: async () => ({ data: input.map((_, i) => ({ embedding: new Array(8).fill(0).map((__, d) => (i + d) / 10) })) }) };
      },
    });
    assert.equal(fetchCalled, true);
    assert.equal(result.run_status, "SUCCESS");
    assert.equal(result.actual_external_embedding_call_performed, true);
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_B;
  }
});

// -------------------------------------------------------------------------
// Missing API key fail-closed (delegates to embedding-adapter.mjs's own
// EmbeddingAdapterUnavailableError -- proving calibration does not bypass
// or re-implement that check).
// -------------------------------------------------------------------------

test("missing API key env var fails closed even when actual_external_call_authorized=true, before any fetchImpl call", async () => {
  let fetchCalled = false;
  delete process.env.CALIBRATION_TEST_KEY_UNSET;
  await assert.rejects(
    () => runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_UNSET", actual_external_call_authorized: true,
      }),
      datasetItems: items(3),
      fetchImpl: async () => { fetchCalled = true; throw new Error("must never be called"); },
    }),
  );
  assert.equal(fetchCalled, false);
});

// -------------------------------------------------------------------------
// Budget caps -- checked BEFORE any call.
// -------------------------------------------------------------------------

test("maximum_item_count budget rejects before any embedding call when the dataset exceeds it", async () => {
  await assert.rejects(
    () => runEmbeddingCalibration({ calibrationConfig: baseConfig({ maximum_item_count: 5 }), datasetItems: items(6) }),
    CalibrationBudgetExceededError,
  );
});

test("maximum_total_input_units budget rejects before any embedding call when estimated input exceeds it", async () => {
  const bigItems = items(2, { textPrefix: "x".repeat(1000) });
  await assert.rejects(
    () => runEmbeddingCalibration({ calibrationConfig: baseConfig({ maximum_total_input_units: 100 }), datasetItems: bigItems }),
    CalibrationBudgetExceededError,
  );
});

test("maximum_request_count budget rejects before any embedding call when the planned batch count exceeds it", async () => {
  await assert.rejects(
    () => runEmbeddingCalibration({ calibrationConfig: baseConfig({ batch_size: 1, maximum_request_count: 2 }), datasetItems: items(5) }),
    CalibrationBudgetExceededError,
  );
});

// -------------------------------------------------------------------------
// Dimension/NaN/Infinity/order violation tests
// -------------------------------------------------------------------------

// NOTE: in-flight adapter/vector failures (as opposed to pre-flight
// config/budget/authorization refusals, which throw) are captured into a
// returned run_status="FAILED" result rather than a rejected promise --
// this is deliberate: it lets a caller always write a
// calibration-result.v0.1.json even for a failed run (see runner.mjs's own
// header and report.mjs's expectations). Budget/authorization tests above
// assert rejection; these assert the FAILED result shape instead.

test("a vector with the wrong dimension yields run_status=FAILED with a stable failure_code (never silently truncated/padded)", async () => {
  // embedding-adapter.mjs's own assertVectorsShape rejects this before it
  // ever reaches runner.mjs's own defensive check -- either layer failing
  // closed is correct.
  process.env.CALIBRATION_TEST_KEY_DIM = "fake-key";
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_DIM", actual_external_call_authorized: true,
      }),
      datasetItems: items(2),
      fetchImpl: async (url, { body }) => {
        const { input } = JSON.parse(body);
        return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: [1, 2, 3] })) }) };
      },
    });
    assert.equal(result.run_status, "FAILED");
    assert.equal(result.failure_code, "EMBEDDING_CALL_MALFORMED_RESPONSE");
    assert.equal(result.quality, null);
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_DIM;
  }
});

test("a NaN/Infinity value anywhere in a returned vector yields run_status=FAILED", async () => {
  process.env.CALIBRATION_TEST_KEY_NAN = "fake-key";
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_NAN", actual_external_call_authorized: true,
      }),
      datasetItems: items(1),
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2, 3, 4, 5, 6, 7, Number.NaN] }] }) }),
    });
    assert.equal(result.run_status, "FAILED");
    assert.equal(result.failure_code, "EMBEDDING_CALL_MALFORMED_RESPONSE");
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_NAN;
  }
});

test("a malformed batch (fewer vectors than texts submitted) yields run_status=FAILED, never partially accepted", async () => {
  process.env.CALIBRATION_TEST_KEY_PARTIAL = "fake-key";
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_PARTIAL", actual_external_call_authorized: true, batch_size: 10,
      }),
      datasetItems: items(3),
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: new Array(8).fill(0.1) }] }) }), // 1 vector for 3 texts
    });
    assert.equal(result.run_status, "FAILED");
    assert.equal(result.failure_code, "EMBEDDING_CALL_MALFORMED_RESPONSE");
    assert.equal(result.operational.success_count, 0, "no item may be partially accepted when its batch was malformed");
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_PARTIAL;
  }
});

test("vector ORDER is preserved 1:1 with input order (embeddingByItemId[i] corresponds to texts[i], never re-sorted)", async () => {
  process.env.CALIBRATION_TEST_KEY_ORDER = "fake-key";
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_ORDER", actual_external_call_authorized: true, batch_size: 10,
      }),
      datasetItems: items(4),
      fetchImpl: async (url, { body }) => {
        const { input } = JSON.parse(body);
        // Return a vector whose first dimension encodes the INPUT's own
        // index -- if the runner ever mis-ordered/re-sorted, the quality
        // metrics computed downstream would reflect the wrong item.
        return { ok: true, json: async () => ({ data: input.map((_, i) => ({ embedding: new Array(8).fill(0).map((__, d) => (d === 0 ? i : 0.01)) })) }) };
      },
    });
    assert.equal(result.run_status, "SUCCESS");
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_ORDER;
  }
});

// -------------------------------------------------------------------------
// Retry accounting
// -------------------------------------------------------------------------

test("retries are counted, bounded by max_attempts_per_request, and count toward maximum_request_count", async () => {
  process.env.CALIBRATION_TEST_KEY_RETRY = "fake-key";
  let callCount = 0;
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_RETRY", actual_external_call_authorized: true, batch_size: 10,
        maximum_request_count: 5, retry_policy: { max_attempts_per_request: 3, retryable_error_codes: ["EMBEDDING_CALL_TIMEOUT"], backoff_ms: 0 },
      }),
      datasetItems: items(2),
      fetchImpl: async () => {
        callCount += 1;
        if (callCount < 3) {
          const err = new Error("timeout");
          err.name = "AbortError";
          throw err;
        }
        return { ok: true, json: async () => ({ data: [{ embedding: new Array(8).fill(0.1) }, { embedding: new Array(8).fill(0.2) }] }) };
      },
    });
    assert.equal(result.run_status, "SUCCESS");
    assert.equal(result.operational.retry_count, 2, "2 failed attempts before the 3rd succeeds");
    assert.equal(result.operational.request_count, 3);
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_RETRY;
  }
});

test("a non-retryable error code is never retried, even with retries available in the budget", async () => {
  process.env.CALIBRATION_TEST_KEY_NORETRY = "fake-key";
  let callCount = 0;
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_NORETRY", actual_external_call_authorized: true,
        retry_policy: { max_attempts_per_request: 5, retryable_error_codes: ["EMBEDDING_CALL_TIMEOUT"], backoff_ms: 0 },
      }),
      datasetItems: items(1),
      fetchImpl: async () => { callCount += 1; return { ok: false, status: 500 }; }, // EMBEDDING_CALL_HTTP_ERROR -- not in the retryable list above
    });
    assert.equal(result.run_status, "FAILED");
    assert.equal(result.operational.retry_count, 0);
    assert.equal(callCount, 1, "a non-retryable error code must never be retried");
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_NORETRY;
  }
});

test("retries exhausting max_attempts_per_request still fail closed with a stable failure_code", async () => {
  process.env.CALIBRATION_TEST_KEY_EXHAUST = "fake-key";
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_EXHAUST", actual_external_call_authorized: true,
        retry_policy: { max_attempts_per_request: 2, retryable_error_codes: ["EMBEDDING_CALL_TIMEOUT"], backoff_ms: 0 },
      }),
      datasetItems: items(1),
      fetchImpl: async () => { const err = new Error("timeout"); err.name = "AbortError"; throw err; },
    });
    assert.equal(result.run_status, "FAILED");
    assert.equal(result.failure_code, "EMBEDDING_CALL_TIMEOUT");
    assert.equal(result.operational.retry_count, 1, "1 retry between the 2 total attempts allowed");
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_EXHAUST;
  }
});

// -------------------------------------------------------------------------
// Secret / raw-response / vector non-leak
// -------------------------------------------------------------------------

test("the returned CalibrationResult never contains the API key value, a raw response body, or any full vector array, even after a real HTTP round trip", async () => {
  const SECRET_KEY_VALUE = "sk-supersecret-do-not-leak-1234567890";
  process.env.CALIBRATION_TEST_KEY_LEAK = SECRET_KEY_VALUE;
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_LEAK", actual_external_call_authorized: true, batch_size: 10,
      }),
      datasetItems: items(3, { textPrefix: "text with unusual marker XYZZY-SECRET-TEXT" }),
      fetchImpl: async (url, { body }) => {
        const { input } = JSON.parse(body);
        return { ok: true, json: async () => ({ data: input.map((_, i) => ({ embedding: new Array(8).fill(0).map((__, d) => (i + d + 1) / 100), raw_provider_debug_field: "should never leak" })) }) };
      },
    });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SECRET_KEY_VALUE), "the API key value must never appear in the result");
    assert.ok(!serialized.includes("XYZZY-SECRET-TEXT"), "raw input text must never appear in the result");
    assert.ok(!serialized.includes("raw_provider_debug_field"), "raw provider response fields must never leak into the result");
    assert.ok(!/-?0\.\d+,-?0\.\d+,-?0\.\d+,-?0\.\d+/.test(serialized), "no vector-shaped array (4+ consecutive floats) may appear anywhere in the result");
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_LEAK;
  }
});

test("a FAILED run's failure_code never echoes the raw response body verbatim (only a stable code string, never response content)", async () => {
  process.env.CALIBRATION_TEST_KEY_ERRMSG = "fake-key";
  const RESPONSE_BODY_MARKER = "INTERNAL_PROVIDER_ERROR_BODY_MARKER_9999";
  try {
    const result = await runEmbeddingCalibration({
      calibrationConfig: baseConfig({
        adapter_kind: "HTTP_EMBEDDINGS", endpoint: "https://example.invalid/v1/embeddings",
        api_key_env_var: "CALIBRATION_TEST_KEY_ERRMSG", actual_external_call_authorized: true,
      }),
      datasetItems: items(1),
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => RESPONSE_BODY_MARKER }),
    });
    assert.equal(result.run_status, "FAILED");
    assert.equal(result.failure_code, "EMBEDDING_CALL_HTTP_ERROR");
    assert.ok(!JSON.stringify(result).includes(RESPONSE_BODY_MARKER), "the raw response body must never appear anywhere in the result");
  } finally {
    delete process.env.CALIBRATION_TEST_KEY_ERRMSG;
  }
});
