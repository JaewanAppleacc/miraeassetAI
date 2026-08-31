// Turn P9: Embedding Calibration runner.
//
// IMPORTANT: everything this module measures is a SELF-SUPERVISED SMOKE --
// "does embedding X's own text, re-queried, rank itself highly among this
// SAME small run's other items." It is NEVER a DEV_GOLD retrieval-quality
// measurement, NEVER an Agent-quality measurement, and NEVER a basis for
// selecting a "winning" provider/model on its own. Every CalibrationResult
// this module returns pins ranking_performed=true (self-supervised ranking
// DID run) alongside dev_gold_accessed=false, holdout_accessed=false,
// final_model_selected=false -- so a report reader can never mistake this
// smoke for a real retrieval-quality benchmark.
//
// SAFETY BOUNDARY THIS FILE EXISTS TO ENFORCE: an HTTP_EMBEDDINGS adapter
// is constructed and called ONLY when actual_external_call_authorized ===
// true. Every budget (item/request/input-unit) is checked BEFORE the work
// it would bound is attempted, never after. No raw API response, API key,
// Authorization header, or full vector is ever placed on the returned
// CalibrationResult object -- only aggregated counts/metrics and per-item
// sha256/scores.
import { createEmbeddingAdapter } from "../retrieval/embedding-adapter.mjs";
import {
  toEmbeddingConfig, validateCalibrationConfig, InvalidCalibrationConfigError,
  CalibrationBudgetExceededError, CalibrationAuthorizationError, CalibrationAdapterError,
  RETRYABLE_EMBEDDING_CALL_ERROR_CODES,
} from "./contracts.mjs";
import {
  computeRecallAtK, computeMRR, rankingIsReproducible, corpCodeFilterAccuracy,
} from "./metrics.mjs";

function estimateInputUnits(text) {
  // Character count -- a deliberately simple, provider-neutral proxy.
  // Never claimed to equal a real provider's own token count; the result
  // records this explicitly as "estimated", never "provider reported"
  // unless a future Turn wires through real usage.
  return text.length;
}

function assertFiniteVector(vector, dimension) {
  return Array.isArray(vector) && vector.length === dimension
    && vector.every((v) => typeof v === "number" && Number.isFinite(v));
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

// Batches an ordered array without ever holding more than one batch's
// worth of NEW work in flight at a time (sequential, not Promise.all --
// mirrors every other loader in this repo's own "one request pipeline at a
// time" discipline).
function* batches(array, size) {
  for (let i = 0; i < array.length; i += size) yield array.slice(i, i + size);
}

export async function runEmbeddingCalibration({ calibrationConfig, datasetItems, signal, fetchImpl } = {}) {
  const errors = validateCalibrationConfig(calibrationConfig);
  if (errors.length > 0) throw new InvalidCalibrationConfigError(errors);
  if (!Array.isArray(datasetItems)) throw new TypeError("datasetItems is required");

  if (calibrationConfig.adapter_kind === "HTTP_EMBEDDINGS" && calibrationConfig.actual_external_call_authorized !== true) {
    throw new CalibrationAuthorizationError(
      "adapter_kind=HTTP_EMBEDDINGS requires actual_external_call_authorized === true -- refusing to construct a real network-calling adapter without explicit authorization",
    );
  }

  // --- pre-flight budgets: checked before ANY embedding call -----------
  if (datasetItems.length > calibrationConfig.maximum_item_count) {
    throw new CalibrationBudgetExceededError("maximum_item_count", { limit: calibrationConfig.maximum_item_count, wouldBe: datasetItems.length });
  }
  const totalInputUnits = datasetItems.reduce((sum, item) => sum + estimateInputUnits(item.textContent), 0);
  if (totalInputUnits > calibrationConfig.maximum_total_input_units) {
    throw new CalibrationBudgetExceededError("maximum_total_input_units", { limit: calibrationConfig.maximum_total_input_units, wouldBe: totalInputUnits });
  }

  const cacheEnabled = calibrationConfig.cache_policy?.enabled === true;
  const uniqueByTextSha256 = new Map(); // input_text_sha256 -> { itemIds: [], textContent }
  for (const item of datasetItems) {
    if (!uniqueByTextSha256.has(item.inputTextSha256)) {
      uniqueByTextSha256.set(item.inputTextSha256, { itemIds: [item.calibrationItemId], textContent: item.textContent });
    } else {
      uniqueByTextSha256.get(item.inputTextSha256).itemIds.push(item.calibrationItemId);
    }
  }
  const workUnits = cacheEnabled ? [...uniqueByTextSha256.entries()] : datasetItems.map((item) => [item.inputTextSha256, { itemIds: [item.calibrationItemId], textContent: item.textContent }]);

  const plannedRequestCount = Math.ceil(workUnits.length / calibrationConfig.batch_size);
  if (plannedRequestCount > calibrationConfig.maximum_request_count) {
    throw new CalibrationBudgetExceededError("maximum_request_count", { limit: calibrationConfig.maximum_request_count, wouldBe: plannedRequestCount });
  }

  const adapter = createEmbeddingAdapter(toEmbeddingConfig(calibrationConfig), { fetchImpl });

  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, 50);
  sampler.unref?.();

  const embeddingByItemId = new Map();
  const latenciesMs = [];
  let requestCount = 0;
  let retryCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let invalidVectorCount = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;
  let inputUnitsSubmitted = 0;
  let runStatus = "SUCCESS";
  let failureCode = null;
  const startedAt = Date.now();

  const retryable = new Set(RETRYABLE_EMBEDDING_CALL_ERROR_CODES.filter((code) => (calibrationConfig.retry_policy?.retryable_error_codes ?? []).includes(code)));
  const maxAttempts = calibrationConfig.retry_policy?.max_attempts_per_request ?? 1;
  const backoffMs = calibrationConfig.retry_policy?.backoff_ms ?? 0;

  try {
    for (const batch of batches(workUnits, calibrationConfig.batch_size)) {
      if (signal?.aborted) throw new CalibrationAdapterError("CALIBRATION_ABORTED", "calibration run aborted by signal");
      const texts = batch.map(([, work]) => work.textContent);
      inputUnitsSubmitted += texts.reduce((sum, t) => sum + estimateInputUnits(t), 0);

      let attempt = 0;
      let vectors = null;
      for (;;) {
        attempt += 1;
        if (requestCount >= calibrationConfig.maximum_request_count) {
          throw new CalibrationBudgetExceededError("maximum_request_count", { limit: calibrationConfig.maximum_request_count, wouldBe: requestCount + 1 });
        }
        requestCount += 1;
        const requestStartedAt = Date.now();
        try {
          // eslint-disable-next-line no-await-in-loop
          vectors = await adapter.embedDocuments(texts, toEmbeddingConfig(calibrationConfig));
          latenciesMs.push(Date.now() - requestStartedAt);
          break;
        } catch (error) {
          latenciesMs.push(Date.now() - requestStartedAt);
          const code = error?.code ?? "EMBEDDING_CALL_UNKNOWN_ERROR";
          const canRetry = retryable.has(code) && attempt < maxAttempts;
          if (!canRetry) {
            failureCount += batch.length;
            // The wrapped error's OWN message never contains raw response
            // bodies/keys (embedding-adapter.mjs's own contract) -- passed
            // through as `.cause` for diagnostics, never re-embedded into
            // THIS error's own message string.
            throw new CalibrationAdapterError(code, `embedding call failed (code=${code}) after ${attempt} attempt(s)`, { cause: error });
          }
          retryCount += 1;
          // eslint-disable-next-line no-await-in-loop
          if (backoffMs > 0) await new Promise((resolve) => { setTimeout(resolve, backoffMs); });
        }
      }

      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        invalidVectorCount += batch.length;
        failureCount += batch.length;
        throw new CalibrationAdapterError("MALFORMED_BATCH", `embedDocuments returned ${Array.isArray(vectors) ? vectors.length : typeof vectors} vectors for ${batch.length} inputs`);
      }
      batch.forEach(([, work], index) => {
        const vector = vectors[index];
        if (!assertFiniteVector(vector, calibrationConfig.expected_dimension)) {
          invalidVectorCount += 1;
          failureCount += 1;
          return;
        }
        for (const itemId of work.itemIds) embeddingByItemId.set(itemId, vector);
        if (work.itemIds.length > 1) cacheHitCount += work.itemIds.length - 1;
        cacheMissCount += 1;
        successCount += 1;
      });
    }

    if (invalidVectorCount > 0) {
      throw new CalibrationAdapterError("INVALID_VECTOR", `${invalidVectorCount} embedding(s) were rejected (dimension mismatch or non-finite values) -- refusing to compute quality metrics over a partial/corrupted embedding set`);
    }
  } catch (error) {
    runStatus = "FAILED";
    failureCode = error?.code ?? "CALIBRATION_RUN_FAILED";
    clearInterval(sampler);
    const elapsedMs = Date.now() - startedAt;
    return buildResult({
      calibrationConfig, datasetItems, embeddingByItemId, requestCount, retryCount, successCount, failureCount,
      invalidVectorCount, cacheHitCount, cacheMissCount, inputUnitsSubmitted, latenciesMs, elapsedMs,
      peakRssBytes, runStatus, failureCode,
    });
  }
  clearInterval(sampler);
  const elapsedMs = Date.now() - startedAt;
  return buildResult({
    calibrationConfig, datasetItems, embeddingByItemId, requestCount, retryCount, successCount, failureCount,
    invalidVectorCount, cacheHitCount, cacheMissCount, inputUnitsSubmitted, latenciesMs, elapsedMs,
    peakRssBytes, runStatus, failureCode,
  });
}

function buildResult({
  calibrationConfig, datasetItems, embeddingByItemId, requestCount, retryCount, successCount, failureCount,
  invalidVectorCount, cacheHitCount, cacheMissCount, inputUnitsSubmitted, latenciesMs, elapsedMs,
  peakRssBytes, runStatus, failureCode,
}) {
  const embeddedItems = datasetItems.filter((item) => embeddingByItemId.has(item.calibrationItemId));
  const quality = runStatus === "SUCCESS" && embeddedItems.length > 0
    ? {
      self_match_recall_at_1: computeRecallAtK(embeddedItems, embeddingByItemId, 1),
      self_match_recall_at_5: computeRecallAtK(embeddedItems, embeddingByItemId, 5),
      self_match_recall_at_10: computeRecallAtK(embeddedItems, embeddingByItemId, 10),
      mrr: computeMRR(embeddedItems, embeddingByItemId),
      ranking_reproducible: rankingIsReproducible(embeddedItems, embeddingByItemId),
      corp_code_filter: corpCodeFilterAccuracy(embeddedItems, embeddingByItemId),
    }
    : null;

  const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
  const estimatedCost = calibrationConfig.input_price_per_million_units == null
    ? null
    : (inputUnitsSubmitted / 1_000_000) * calibrationConfig.input_price_per_million_units;

  return Object.freeze({
    schema_version: "0.1.0",
    calibration_id: calibrationConfig.calibration_id,
    run_status: runStatus,
    failure_code: failureCode,
    operational: {
      item_count: datasetItems.length,
      request_count: requestCount,
      retry_count: retryCount,
      success_count: successCount,
      failure_count: failureCount,
      invalid_vector_count: invalidVectorCount,
      cache_hit_count: cacheHitCount,
      cache_miss_count: cacheMissCount,
      latency_ms_p50: percentile(sortedLatencies, 0.5),
      latency_ms_p95: percentile(sortedLatencies, 0.95),
      latency_ms_max: sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1] : null,
      throughput_items_per_sec: elapsedMs > 0 ? (successCount / elapsedMs) * 1000 : null,
      estimated_input_units: inputUnitsSubmitted,
      vector_dimension: calibrationConfig.expected_dimension,
      estimated_cost: estimatedCost,
      peak_rss_mb: peakRssBytes / 1024 / 1024,
      elapsed_ms: elapsedMs,
    },
    quality,
    ranking_performed: quality !== null,
    dev_gold_accessed: false,
    holdout_accessed: false,
    final_model_selected: false,
    actual_external_embedding_call_performed: calibrationConfig.adapter_kind === "HTTP_EMBEDDINGS" && requestCount > 0,
  });
}
