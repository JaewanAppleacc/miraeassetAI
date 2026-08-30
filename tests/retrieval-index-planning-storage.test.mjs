import test from "node:test";
import assert from "node:assert/strict";
import {
  VECTOR_DIMENSION_SCENARIOS,
  rawVectorStorageBytes,
  computeEmbeddingCostRange,
  buildStorageScenario,
} from "../domain/agent-comparison/retrieval/index-planning/embedding-size-model.mjs";
import { buildStrategyComparison } from "../domain/agent-comparison/retrieval/index-planning/strategy-comparison.mjs";

test("raw vector storage is exactly payloadCount * dimension * 4 bytes (float32)", () => {
  assert.equal(rawVectorStorageBytes(1000, 384), 1000 * 384 * 4);
  assert.equal(rawVectorStorageBytes(1, 1536), 1536 * 4);
});

test("all 4 required vector dimension scenarios are present and storage scales linearly with dimension", () => {
  assert.deepEqual(VECTOR_DIMENSION_SCENARIOS, [384, 768, 1024, 1536]);
  const scenario = buildStorageScenario({ payloadCount: 100, occurrenceCount: 100, totalUtf8Bytes: 50000 });
  const dims = Object.keys(scenario.vector_storage_by_dimension).map(Number);
  assert.deepEqual(dims.sort((a, b) => a - b), [384, 768, 1024, 1536]);
  assert.equal(scenario.vector_storage_by_dimension[768].raw_vector_bytes, 2 * scenario.vector_storage_by_dimension[384].raw_vector_bytes);
  assert.equal(scenario.vector_storage_by_dimension[1536].raw_vector_bytes, 2 * scenario.vector_storage_by_dimension[768].raw_vector_bytes);
});

test("index overhead ranges are always >= 1x raw (never claim overhead reduces size) and no-ANN <= with-ANN", () => {
  const scenario = buildStorageScenario({ payloadCount: 100, occurrenceCount: 100, totalUtf8Bytes: 1000 });
  for (const dim of VECTOR_DIMENSION_SCENARIOS) {
    const withOverhead = scenario.vector_storage_by_dimension[dim].total_with_overhead_bytes_range;
    const raw = scenario.vector_storage_by_dimension[dim].raw_vector_bytes;
    assert.ok(withOverhead.no_ann_index.low >= raw);
    assert.ok(withOverhead.no_ann_index.high >= withOverhead.no_ann_index.low);
    assert.ok(withOverhead.with_ann_index_hypothetical.low >= withOverhead.no_ann_index.high || withOverhead.with_ann_index_hypothetical.low >= raw);
  }
});

test("embedding cost is a pure formula requiring an explicit caller-supplied unit price -- never evaluated at a hard-coded price", () => {
  assert.throws(() => computeEmbeddingCostRange({ totalTokensLow: 100, totalTokensHigh: 200 }), TypeError);
  const cost = computeEmbeddingCostRange({ totalTokensLow: 1_000_000, totalTokensHigh: 2_000_000, pricePerMillionTokenUnits: 10 });
  assert.equal(cost.low, 10);
  assert.equal(cost.high, 20);
});

test("embedding-size-model.mjs source never contains a hard-coded provider/model price literal", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../domain/agent-comparison/retrieval/index-planning/embedding-size-model.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\$\d/, "no literal dollar-amount price may appear in the cost model source");
  assert.doesNotMatch(source, /openai|anthropic|cohere|voyage/i, "no specific embedding provider name may be hard-coded");
});

function fakeLengthAnalysis(overrides = {}) {
  return {
    total_chunks: 1000,
    utf8_byte_length: { total_bytes: 300000 },
    korean_aware_token_proxy_range: { total_low: 100000, total_high: 200000 },
    extreme_shape_candidates: { title_only_chunk_count: 50 },
    ...overrides,
  };
}
function fakeDuplicateAnalysis(overrides = {}) {
  return {
    unique_text_count: 600,
    embedding_calls_avoidable: 400,
    unique_text_totals: { total_utf8_bytes: 180000, korean_aware_token_proxy_range: { total_low: 60000, total_high: 120000 } },
    ...overrides,
  };
}
function fakeBoilerplateAnalysis(overrides = {}) {
  return { boilerplate_candidate_occurrence_count: 100, boilerplate_candidate_unique_text_count: 50, ...overrides };
}

test("strategy comparison produces all 4 required strategies with provenance_preserved=true for every one", () => {
  const comparison = buildStrategyComparison({
    lengthAnalysis: fakeLengthAnalysis(),
    duplicateAnalysis: fakeDuplicateAnalysis(),
    boilerplateAnalysis: fakeBoilerplateAnalysis(),
    totalDocuments: 100,
  });
  assert.deepEqual(Object.keys(comparison).sort(), ["EXACT_TEXT_DEDUP_INDEX", "FULL_CHUNK_INDEX", "HIERARCHICAL_INDEX", "PRIMARY_PLUS_COLD_FALLBACK"].sort());
  for (const strategy of Object.values(comparison)) {
    assert.equal(strategy.provenance_preserved, true, `${strategy.strategy_id} must never claim provenance loss`);
  }
});

test("strategy B (dedup) always has fewer or equal embedding_payload_count than strategy A (full)", () => {
  const comparison = buildStrategyComparison({
    lengthAnalysis: fakeLengthAnalysis(),
    duplicateAnalysis: fakeDuplicateAnalysis(),
    boilerplateAnalysis: fakeBoilerplateAnalysis(),
    totalDocuments: 100,
  });
  assert.ok(comparison.EXACT_TEXT_DEDUP_INDEX.embedding_payload_count <= comparison.FULL_CHUNK_INDEX.embedding_payload_count);
});

test("strategy D (primary+cold) never claims to delete cold chunks -- provenance_note says they remain searchable", () => {
  const comparison = buildStrategyComparison({
    lengthAnalysis: fakeLengthAnalysis(),
    duplicateAnalysis: fakeDuplicateAnalysis(),
    boilerplateAnalysis: fakeBoilerplateAnalysis(),
    totalDocuments: 100,
  });
  assert.match(comparison.PRIMARY_PLUS_COLD_FALLBACK.provenance_note, /never deleted/i);
});

test("strategy comparison is a pure, deterministic function of its inputs", () => {
  const inputs = { lengthAnalysis: fakeLengthAnalysis(), duplicateAnalysis: fakeDuplicateAnalysis(), boilerplateAnalysis: fakeBoilerplateAnalysis(), totalDocuments: 100 };
  const a = JSON.stringify(buildStrategyComparison(inputs));
  const b = JSON.stringify(buildStrategyComparison(inputs));
  assert.equal(a, b);
});
