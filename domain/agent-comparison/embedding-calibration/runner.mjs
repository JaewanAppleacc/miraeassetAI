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
//
// Turn P9.2 (additive, backward-compatible): two new OPTIONAL parameters.
//   prepareText(text, mode) -- when supplied, every item is embedded TWICE
//     (once as "query", once as "document"), letting an asymmetric-prefix
//     candidate (e.g. PIXIE-Rune-v1.5) be calibrated correctly. Omitting it
//     reproduces the exact pre-P9.2 single-embedding-per-item behavior --
//     every one of Turn P9's own 49 tests calls this function without it.
//   isMockServer -- caller's own explicit declaration that the endpoint
//     being called is a test-only mock, never a real model server. Used
//     ONLY to populate the new loopback/mock telemetry fields (Section G);
//     it has no effect on budgets, retries, or the handshake.
// Also new (both optional, both additive): calibrationConfig.server_pin
// (a preflight GET /info identity handshake -- see server-handshake.mjs)
// and calibrationConfig.auth_mode/network_scope (see embedding-adapter.mjs).
import { createEmbeddingAdapter } from "../retrieval/embedding-adapter.mjs";
import { createHash } from "node:crypto";
import {
  toEmbeddingConfig, validateCalibrationConfig, InvalidCalibrationConfigError,
  CalibrationBudgetExceededError, CalibrationAuthorizationError, CalibrationAdapterError,
  RETRYABLE_EMBEDDING_CALL_ERROR_CODES,
} from "./contracts.mjs";
import {
  computeRecallAtK, computeMRR, rankingIsReproducible, corpCodeFilterAccuracy,
} from "./metrics.mjs";
import { verifyServerIdentity, fetchServerAttestation, ServerIdentityHandshakeError } from "./server-handshake.mjs";

// Must stay in sync with embedding-adapter.mjs's own LOOPBACK_HOSTNAMES --
// duplicated rather than imported so this module never depends on that
// file's internals (only its public createEmbeddingAdapter export).
const LOOPBACK_HOSTNAMES = Object.freeze(new Set(["127.0.0.1", "localhost", "::1"]));

function isLoopbackEndpoint(endpoint) {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

// Builds the work-unit map for ONE mode: text -> { itemIds, textContent }.
// `textOf(item)` returns the (possibly mode-prefixed) string to embed for
// that item; caching dedupes by the SHA256 of that PREPARED string, so a
// query-mode and document-mode copy of the same underlying item NEVER share
// a cache entry unless their prepared strings are byte-identical (which is
// only true for a candidate whose query_prefix === document_prefix).
function buildWorkUnits(datasetItems, textOf, cacheEnabled) {
  const byHash = new Map();
  for (const item of datasetItems) {
    const text = textOf(item);
    const hash = sha256Hex(text);
    if (!byHash.has(hash)) byHash.set(hash, { itemIds: [item.calibrationItemId], textContent: text });
    else byHash.get(hash).itemIds.push(item.calibrationItemId);
  }
  return cacheEnabled
    ? [...byHash.entries()]
    : datasetItems.map((item) => [sha256Hex(textOf(item)), { itemIds: [item.calibrationItemId], textContent: textOf(item) }]);
}

export async function runEmbeddingCalibration({
  calibrationConfig, datasetItems, signal, fetchImpl, prepareText, isMockServer = false,
} = {}) {
  const errors = validateCalibrationConfig(calibrationConfig);
  if (errors.length > 0) throw new InvalidCalibrationConfigError(errors);
  if (!Array.isArray(datasetItems)) throw new TypeError("datasetItems is required");

  if (calibrationConfig.adapter_kind === "HTTP_EMBEDDINGS" && calibrationConfig.actual_external_call_authorized !== true) {
    throw new CalibrationAuthorizationError(
      "adapter_kind=HTTP_EMBEDDINGS requires actual_external_call_authorized === true -- refusing to construct a real network-calling adapter without explicit authorization",
    );
  }

  const dualMode = typeof prepareText === "function";

  // --- pre-flight item-count budget: checked before ANY embedding call --
  if (datasetItems.length > calibrationConfig.maximum_item_count) {
    throw new CalibrationBudgetExceededError("maximum_item_count", { limit: calibrationConfig.maximum_item_count, wouldBe: datasetItems.length });
  }

  const documentWorkUnits = buildWorkUnits(
    datasetItems,
    (item) => (dualMode ? prepareText(item.textContent, "document") : item.textContent),
    calibrationConfig.cache_policy?.enabled === true,
  );
  const queryWorkUnits = dualMode
    ? buildWorkUnits(datasetItems, (item) => prepareText(item.textContent, "query"), calibrationConfig.cache_policy?.enabled === true)
    : null;
  const allWorkUnits = dualMode ? [...documentWorkUnits, ...queryWorkUnits] : documentWorkUnits;

  const totalInputUnits = allWorkUnits.reduce((sum, [, work]) => sum + estimateInputUnits(work.textContent), 0);
  if (totalInputUnits > calibrationConfig.maximum_total_input_units) {
    throw new CalibrationBudgetExceededError("maximum_total_input_units", { limit: calibrationConfig.maximum_total_input_units, wouldBe: totalInputUnits });
  }
  const plannedRequestCount = Math.ceil(documentWorkUnits.length / calibrationConfig.batch_size)
    + (dualMode ? Math.ceil(queryWorkUnits.length / calibrationConfig.batch_size) : 0);
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

  const state = {
    requestCount: 0, retryCount: 0, successCount: 0, failureCount: 0, invalidVectorCount: 0,
    cacheHitCount: 0, cacheMissCount: 0, inputUnitsSubmitted: 0, latenciesMs: [],
  };
  let runStatus = "SUCCESS";
  let failureCode = null;
  let serverAttestationSha256 = null;
  const startedAt = Date.now();

  const retryable = new Set(RETRYABLE_EMBEDDING_CALL_ERROR_CODES.filter((code) => (calibrationConfig.retry_policy?.retryable_error_codes ?? []).includes(code)));
  const maxAttempts = calibrationConfig.retry_policy?.max_attempts_per_request ?? 1;
  const backoffMs = calibrationConfig.retry_policy?.backoff_ms ?? 0;

  // Processes ONE mode's work units into `targetEmbeddingMap`, mutating the
  // shared `state` counters. Identical logic to Turn P9's own single-pass
  // loop -- just extracted so dual-mode can call it twice with the SAME
  // budget/retry/validation discipline, never a second, divergent copy.
  async function processWorkUnits(workUnits, targetEmbeddingMap) {
    for (const batch of batches(workUnits, calibrationConfig.batch_size)) {
      if (signal?.aborted) throw new CalibrationAdapterError("CALIBRATION_ABORTED", "calibration run aborted by signal");
      const texts = batch.map(([, work]) => work.textContent);
      state.inputUnitsSubmitted += texts.reduce((sum, t) => sum + estimateInputUnits(t), 0);

      let attempt = 0;
      let vectors = null;
      for (;;) {
        attempt += 1;
        if (state.requestCount >= calibrationConfig.maximum_request_count) {
          throw new CalibrationBudgetExceededError("maximum_request_count", { limit: calibrationConfig.maximum_request_count, wouldBe: state.requestCount + 1 });
        }
        state.requestCount += 1;
        const requestStartedAt = Date.now();
        try {
          // eslint-disable-next-line no-await-in-loop
          vectors = await adapter.embedDocuments(texts, toEmbeddingConfig(calibrationConfig));
          state.latenciesMs.push(Date.now() - requestStartedAt);
          break;
        } catch (error) {
          state.latenciesMs.push(Date.now() - requestStartedAt);
          const code = error?.code ?? "EMBEDDING_CALL_UNKNOWN_ERROR";
          const canRetry = retryable.has(code) && attempt < maxAttempts;
          if (!canRetry) {
            state.failureCount += batch.length;
            throw new CalibrationAdapterError(code, `embedding call failed (code=${code}) after ${attempt} attempt(s)`, { cause: error });
          }
          state.retryCount += 1;
          // eslint-disable-next-line no-await-in-loop
          if (backoffMs > 0) await new Promise((resolve) => { setTimeout(resolve, backoffMs); });
        }
      }

      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        state.invalidVectorCount += batch.length;
        state.failureCount += batch.length;
        throw new CalibrationAdapterError("MALFORMED_BATCH", `embedDocuments returned ${Array.isArray(vectors) ? vectors.length : typeof vectors} vectors for ${batch.length} inputs`);
      }
      batch.forEach(([, work], index) => {
        const vector = vectors[index];
        if (!assertFiniteVector(vector, calibrationConfig.expected_dimension)) {
          state.invalidVectorCount += 1;
          state.failureCount += 1;
          return;
        }
        for (const itemId of work.itemIds) targetEmbeddingMap.set(itemId, vector);
        if (work.itemIds.length > 1) state.cacheHitCount += work.itemIds.length - 1;
        state.cacheMissCount += 1;
        state.successCount += 1;
      });
    }
  }

  const documentEmbeddingByItemId = new Map();
  const queryEmbeddingByItemId = dualMode ? new Map() : documentEmbeddingByItemId;

  try {
    if (calibrationConfig.server_pin) {
      const pin = calibrationConfig.server_pin;
      let attestation;
      try {
        attestation = await verifyServerIdentity({
          serverInfoUrl: pin.server_info_url, expectedRepositoryId: pin.expected_repository_id,
          expectedModelRevision: pin.expected_model_revision, expectedDimension: calibrationConfig.expected_dimension,
          expectedMaxInputLength: pin.expected_max_input_length, fetchImpl: fetchImpl ?? fetch,
          requestTimeoutMs: calibrationConfig.request_timeout_ms,
        });
      } catch (error) {
        if (error instanceof ServerIdentityHandshakeError) throw new CalibrationAdapterError(error.code, error.message);
        throw error;
      }
      serverAttestationSha256 = attestation.attestationSha256;
    }

    await processWorkUnits(documentWorkUnits, documentEmbeddingByItemId);
    if (dualMode) await processWorkUnits(queryWorkUnits, queryEmbeddingByItemId);

    if (state.invalidVectorCount > 0) {
      throw new CalibrationAdapterError("INVALID_VECTOR", `${state.invalidVectorCount} embedding(s) were rejected (dimension mismatch or non-finite values) -- refusing to compute quality metrics over a partial/corrupted embedding set`);
    }

    // Turn P9.2: post-run identity re-check -- if the server's own revision
    // (or any other attested field) drifted DURING this run, or the server
    // can no longer be re-confirmed at all, every embedding above is now
    // unattributable to the pinned model and must never be scored/selected
    // on. This deliberately does NOT re-validate against the original
    // expected_* pins (that would throw a hard mismatch error rather than
    // surface as drift) -- it only compares attestation SHAs.
    if (calibrationConfig.server_pin) {
      const pin = calibrationConfig.server_pin;
      let postRunAttestationSha256 = null;
      try {
        const postRun = await fetchServerAttestation({
          serverInfoUrl: pin.server_info_url, fetchImpl: fetchImpl ?? fetch,
          requestTimeoutMs: calibrationConfig.request_timeout_ms,
        });
        postRunAttestationSha256 = postRun.attestationSha256;
      } catch {
        postRunAttestationSha256 = null; // unreachable/malformed post-run -- treated as drift below, never silently ignored
      }
      if (postRunAttestationSha256 !== serverAttestationSha256) {
        runStatus = "INVALID_SERVER_IDENTITY_DRIFT";
        failureCode = "INVALID_SERVER_IDENTITY_DRIFT";
      }
    }
  } catch (error) {
    runStatus = "FAILED";
    failureCode = error?.code ?? "CALIBRATION_RUN_FAILED";
  }

  clearInterval(sampler);
  const elapsedMs = Date.now() - startedAt;
  return buildResult({
    calibrationConfig, datasetItems, documentEmbeddingByItemId, queryEmbeddingByItemId, state, elapsedMs,
    peakRssBytes, runStatus, failureCode, isMockServer, serverAttestationSha256,
  });
}

function buildResult({
  calibrationConfig, datasetItems, documentEmbeddingByItemId, queryEmbeddingByItemId, state, elapsedMs,
  peakRssBytes, runStatus, failureCode, isMockServer, serverAttestationSha256,
}) {
  const {
    requestCount, retryCount, successCount, failureCount, invalidVectorCount,
    cacheHitCount, cacheMissCount, inputUnitsSubmitted, latenciesMs,
  } = state;
  const embeddedItems = datasetItems.filter((item) => documentEmbeddingByItemId.has(item.calibrationItemId) && queryEmbeddingByItemId.has(item.calibrationItemId));
  const quality = runStatus === "SUCCESS" && embeddedItems.length > 0
    ? {
      self_match_recall_at_1: computeRecallAtK(embeddedItems, documentEmbeddingByItemId, 1, queryEmbeddingByItemId),
      self_match_recall_at_5: computeRecallAtK(embeddedItems, documentEmbeddingByItemId, 5, queryEmbeddingByItemId),
      self_match_recall_at_10: computeRecallAtK(embeddedItems, documentEmbeddingByItemId, 10, queryEmbeddingByItemId),
      mrr: computeMRR(embeddedItems, documentEmbeddingByItemId, queryEmbeddingByItemId),
      ranking_reproducible: rankingIsReproducible(embeddedItems, documentEmbeddingByItemId, queryEmbeddingByItemId),
      corp_code_filter: corpCodeFilterAccuracy(embeddedItems, documentEmbeddingByItemId, queryEmbeddingByItemId),
    }
    : null;

  const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
  const estimatedCost = calibrationConfig.input_price_per_million_units == null
    ? null
    : (inputUnitsSubmitted / 1_000_000) * calibrationConfig.input_price_per_million_units;

  const isHttp = calibrationConfig.adapter_kind === "HTTP_EMBEDDINGS";
  const isLoopback = isHttp && isLoopbackEndpoint(calibrationConfig.endpoint);
  const loopbackProtocolTestPerformed = isHttp && requestCount > 0 && isLoopback;

  return Object.freeze({
    schema_version: "0.1.0",
    calibration_id: calibrationConfig.calibration_id,
    run_status: runStatus,
    failure_code: failureCode,
    server_identity_attestation_sha256: serverAttestationSha256,
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
    // Turn P9.2 (refinement, additive): an HTTP call to a LOOPBACK endpoint
    // (a local mock or, in a future Turn, a real local model server) is
    // never "external" -- no existing Turn P9 test ever pointed at a
    // loopback endpoint_url, so this refinement changes nothing for them.
    actual_external_embedding_call_performed: isHttp && requestCount > 0 && !isLoopback,
    loopback_protocol_test_performed: loopbackProtocolTestPerformed,
    mock_embedding_call_performed: loopbackProtocolTestPerformed && isMockServer === true,
    actual_model_embedding_call_performed: loopbackProtocolTestPerformed && isMockServer !== true,
  });
}
