// Turn P5.1: pure storage/cost calculators. No provider or model price is
// ever hard-coded here -- every cost figure is a FORMULA the caller
// evaluates by supplying its own unit price. Every "byte" or "time" figure
// is presented as an explicit low/high RANGE with its own assumption
// documented, never a single falsely-precise number.
export const VECTOR_DIMENSION_SCENARIOS = Object.freeze([384, 768, 1024, 1536]);
const FLOAT32_BYTES = 4;

export function rawVectorStorageBytes(payloadCount, dimension) {
  return payloadCount * dimension * FLOAT32_BYTES;
}

// Index overhead is expressed as a MULTIPLIER RANGE over raw vector bytes,
// not an absolute number -- it depends entirely on which pgvector index
// type (if any) a future Turn chooses. Turn P4's own schema currently uses
// NO ANN index (brute-force `<=>` scan, see 003_reference_vector_retrieval.sql's
// own header comment) -- the "no_ann_index" range reflects that reality;
// "with_ann_index" is presented ONLY as a what-if for a possible future
// ivfflat/hnsw addition, not a plan this Turn adopts.
export const INDEX_OVERHEAD_MULTIPLIER_RANGES = Object.freeze({
  no_ann_index: { low: 1.1, high: 1.4, note: "row/page overhead only -- matches Turn P4's current brute-force <=> scan design (no ivfflat/hnsw index exists)." },
  with_ann_index_hypothetical: { low: 1.5, high: 2.5, note: "HYPOTHETICAL: only if a future Turn adds an ivfflat/hnsw ANN index. Not part of this Turn's plan." },
});

export function metadataJsonbBytesEstimateRange(payloadCount) {
  // A conservative range per row for the jsonb `metadata` column (source
  // locator, node id, chunking policy pins, etc.) -- observed snapshot
  // chunk metadata objects are small (a handful of short string/int
  // fields); this is a size ESTIMATE range, not a measurement of a real
  // jsonb-encoded byte count.
  return { low: payloadCount * 80, high: payloadCount * 400 };
}

export function textContentStorageBytes(totalUtf8Bytes) {
  // text_content is NOT NULL in 003_reference_vector_retrieval.sql's
  // reference_retrieval_chunks -- it is always stored alongside the vector,
  // regardless of index strategy.
  return totalUtf8Bytes;
}

// Cost is a pure function of (payload_count, token range, a caller-supplied
// unit price). No specific provider/model price is embedded in this module
// -- pricePerMillionTokenUnits is whatever currency/unit the caller means
// it to be (it is never evaluated at a hard-coded example value in a
// report; only the formula and the token counts are reported).
export function embeddingCostRangeFormula() {
  return "cost = (total_tokens / 1_000_000) * price_per_million_tokens; total_tokens uses the korean_aware_token_proxy_range's low/high bounds, itself a heuristic (see contracts.mjs)";
}

export function computeEmbeddingCostRange({ totalTokensLow, totalTokensHigh, pricePerMillionTokenUnits }) {
  if (typeof pricePerMillionTokenUnits !== "number" || !Number.isFinite(pricePerMillionTokenUnits) || pricePerMillionTokenUnits < 0) {
    throw new TypeError("pricePerMillionTokenUnits must be a non-negative finite number supplied by the caller");
  }
  return {
    low: (totalTokensLow / 1_000_000) * pricePerMillionTokenUnits,
    high: (totalTokensHigh / 1_000_000) * pricePerMillionTokenUnits,
  };
}

// Build-time is a pure linear extrapolation over an ASSUMED throughput
// range (embeddings/sec) -- explicitly an assumption, since no real
// embedding API is called this Turn and no real throughput was measured.
export const ASSUMED_EMBEDDING_THROUGHPUT_RANGE_PER_SEC = Object.freeze({ low: 10, high: 200 });

export function estimateBuildTimeSecondsRange(payloadCount, throughputRange = ASSUMED_EMBEDDING_THROUGHPUT_RANGE_PER_SEC) {
  return {
    low_seconds: payloadCount / throughputRange.high,
    high_seconds: payloadCount / throughputRange.low,
    assumption: `${throughputRange.low}-${throughputRange.high} embeddings/sec -- an ILLUSTRATIVE assumption, not a measured benchmark (no real embedding API was called this Turn).`,
  };
}

export function buildStorageScenario({ payloadCount, occurrenceCount, totalUtf8Bytes }) {
  const perDimension = {};
  for (const dimension of VECTOR_DIMENSION_SCENARIOS) {
    const rawBytes = rawVectorStorageBytes(payloadCount, dimension);
    perDimension[dimension] = {
      raw_vector_bytes: rawBytes,
      index_overhead_multiplier_ranges: INDEX_OVERHEAD_MULTIPLIER_RANGES,
      total_with_overhead_bytes_range: {
        no_ann_index: {
          low: Math.round(rawBytes * INDEX_OVERHEAD_MULTIPLIER_RANGES.no_ann_index.low),
          high: Math.round(rawBytes * INDEX_OVERHEAD_MULTIPLIER_RANGES.no_ann_index.high),
        },
        with_ann_index_hypothetical: {
          low: Math.round(rawBytes * INDEX_OVERHEAD_MULTIPLIER_RANGES.with_ann_index_hypothetical.low),
          high: Math.round(rawBytes * INDEX_OVERHEAD_MULTIPLIER_RANGES.with_ann_index_hypothetical.high),
        },
      },
    };
  }
  return {
    embedding_payload_count: payloadCount,
    occurrence_count: occurrenceCount,
    text_content_storage_bytes: textContentStorageBytes(totalUtf8Bytes),
    metadata_jsonb_bytes_estimate_range: metadataJsonbBytesEstimateRange(occurrenceCount),
    vector_storage_by_dimension: perDimension,
    build_time_seconds_range: estimateBuildTimeSecondsRange(payloadCount),
  };
}
