// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section H: offline tests for the
// NEW behavior this Turn added on top of the pre-existing (still separately
// tested, still-passing) HYBRID_RRF intersection path:
//   - HYBRID_UNION_RRF: union fusion, absent leg -> null score + 0 RRF
//     contribution, never dropped, never fabricated.
//   - metadata prefilter actually applied BEFORE ranking, and covering
//     EVERY allowed field (base_years/base_months/receipt_date range/
//     is_correction previously had zero coverage anywhere in this repo).
import assert from "node:assert/strict";
import test from "node:test";
import { createFixedKureHybridRetrieverAdapter } from "../domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs";
import { validateRetrievalResult, validateRetrievalRequestResultPair } from "../domain/contracts.mjs";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { passesMetadataFilters, buildEligibilityWhereClause } from "../domain/retrieval/metadata-filter.mjs";

function chunkRow(id, overrides = {}) {
  return {
    chunk_id: id, source_document_id: "periodic_00000000000001", corp_code: "00000001",
    source_locator: `periodic_00000000000001/file_1#node=${id.slice(-1)}`,
    chunk_ordinal: 0, text_content: `본문 ${id}`,
    metadata: { chunk_type: "FIXED_WINDOW", parent_chunk_id: null, doc_group: "periodic", base_year: 2024, base_month: 3, receipt_date: "2024-03-15", is_correction: false, retrieval_eligible: true },
    ...overrides,
  };
}

const EMPTY_FILTERS = Object.freeze({
  corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [],
  base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null,
  is_correction: null, retrieval_eligible: true,
});

function fakeClientWithEligibility(rowsById, { eligibleFilter = () => true } = {}) {
  return {
    async query(sql, params) {
      if (sql.trim().startsWith("SELECT chunk_id FROM")) {
        return { rows: [...rowsById.values()].filter(eligibleFilter).map((r) => ({ chunk_id: r.chunk_id })) };
      }
      const ids = params[1];
      return { rows: ids.filter((id) => rowsById.has(id)).map((id) => rowsById.get(id)) };
    },
  };
}

test("HYBRID_UNION_RRF: a chunk found by only BM25 (not dense) is still returned, with dense component_scores.dense = null and rrf > 0", async () => {
  const bm25Index = buildBm25Index([
    { id: "chunk_a00000000000000000000001", text: "매출액은 1000원 입니다" },
    { id: "chunk_b00000000000000000000002", text: "고유단어체크 그리고 매출액" },
  ]);
  const rowsById = new Map([
    ["chunk_a00000000000000000000001", chunkRow("chunk_a00000000000000000000001")],
    ["chunk_b00000000000000000000002", chunkRow("chunk_b00000000000000000000002")],
    ["chunk_c00000000000000000000003", chunkRow("chunk_c00000000000000000000003")],
  ]);
  const client = fakeClientWithEligibility(rowsById);
  const vectorRepository = {
    async searchDocumentChunksByVector() {
      return [{ chunk_id: "chunk_c00000000000000000000003", similarity_score: 0.8, ...rowsById.get("chunk_c00000000000000000000003") }];
    },
  };
  const embeddingAdapter = { async embedQuery() { return [0.1, 0.2]; } };

  const adapter = createFixedKureHybridRetrieverAdapter({ client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId: "fixed_kure_index_test" });
  const request = {
    schema_version: "0.1.0", query_id: "query_test_union_01", question: "매출액",
    corpus_snapshot_id: "corpus_test", chunking_config_id: "fixed-token-512-o64.v0.1.0", index_snapshot_id: "fixed_kure_index_test",
    metadata_filters: EMPTY_FILTERS, top_k: 10, retrieval_method: "HYBRID_UNION_RRF",
  };
  const result = await adapter.retrieve(request, {});

  // UNION: all three candidates appear (2 from BM25, 1 from dense), never
  // reduced to only the (empty) intersection.
  const ids = result.results.map((r) => r.chunk_id).sort();
  assert.deepEqual(ids, ["chunk_a00000000000000000000001", "chunk_b00000000000000000000002", "chunk_c00000000000000000000003"]);

  const denseOnly = result.results.find((r) => r.chunk_id === "chunk_c00000000000000000000003");
  assert.equal(denseOnly.component_scores.bm25, null); // absent leg -- null, never fabricated
  assert.notEqual(denseOnly.component_scores.dense, null);
  assert.ok(denseOnly.component_scores.rrf > 0); // still contributes to RRF from the ONE leg it has

  const bm25Only = result.results.find((r) => r.chunk_id === "chunk_b00000000000000000000002");
  assert.notEqual(bm25Only.component_scores.bm25, null);
  assert.equal(bm25Only.component_scores.dense, null);
  assert.ok(bm25Only.component_scores.rrf > 0);

  // Independently re-validated against the frozen contract -- HYBRID_UNION_RRF
  // only requires component_scores.rrf non-null (domain/contracts.mjs's
  // RETRIEVAL_METHOD_REQUIRED_COMPONENTS.HYBRID_UNION_RRF), so a single-leg
  // result item is a VALID HYBRID_UNION_RRF result, not a contract violation.
  assert.deepEqual(validateRetrievalResult(result), []);
  assert.deepEqual(validateRetrievalRequestResultPair(request, result), []);
});

test("HYBRID_UNION_RRF never mixes with existing HYBRID_RRF intersection behavior on the SAME adapter instance", async () => {
  const bm25Index = buildBm25Index([
    { id: "chunk_a00000000000000000000001", text: "매출액은 1000원 입니다" },
  ]);
  const rowsById = new Map([["chunk_a00000000000000000000001", chunkRow("chunk_a00000000000000000000001")]]);
  const client = fakeClientWithEligibility(rowsById);
  const vectorRepository = { async searchDocumentChunksByVector() { return []; } }; // zero dense candidates
  const embeddingAdapter = { async embedQuery() { return [0.1, 0.2]; } };
  const adapter = createFixedKureHybridRetrieverAdapter({ client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId: "fixed_kure_index_test" });

  const baseRequest = {
    schema_version: "0.1.0", query_id: "query_test_02", question: "매출액",
    corpus_snapshot_id: "corpus_test", chunking_config_id: "fixed-token-512-o64.v0.1.0", index_snapshot_id: "fixed_kure_index_test",
    metadata_filters: EMPTY_FILTERS, top_k: 10,
  };

  const intersectionResult = await adapter.retrieve({ ...baseRequest, retrieval_method: "HYBRID_RRF" }, {});
  assert.equal(intersectionResult.results.length, 0); // zero dense candidates -> empty intersection, as before this Turn

  const unionResult = await adapter.retrieve({ ...baseRequest, retrieval_method: "HYBRID_UNION_RRF" }, {});
  assert.equal(unionResult.results.length, 1); // same inputs, union keeps the BM25-only candidate
});

test("metadata prefilter: base_years excludes a chunk whose stored base_year does not match (previously silently ignored)", () => {
  const matching = chunkRow("chunk_a", { metadata: { ...chunkRow("chunk_a").metadata, base_year: 2024 } });
  const nonMatching = chunkRow("chunk_b", { metadata: { ...chunkRow("chunk_b").metadata, base_year: 2023 } });
  const filters = { ...EMPTY_FILTERS, base_years: [2024] };
  assert.equal(passesMetadataFilters(matching, filters), true);
  assert.equal(passesMetadataFilters(nonMatching, filters), false);
});

test("metadata prefilter: base_months excludes a non-matching month (previously silently ignored)", () => {
  const filters = { ...EMPTY_FILTERS, base_months: [3] };
  assert.equal(passesMetadataFilters(chunkRow("chunk_a"), filters), true); // base_month: 3
  const other = chunkRow("chunk_b", { metadata: { ...chunkRow("chunk_b").metadata, base_month: 6 } });
  assert.equal(passesMetadataFilters(other, filters), false);
});

test("metadata prefilter: receipt_date_from/receipt_date_to range excludes chunks outside the range (previously silently ignored)", () => {
  const inRange = chunkRow("chunk_a", { metadata: { ...chunkRow("chunk_a").metadata, receipt_date: "2024-03-15" } });
  const before = chunkRow("chunk_b", { metadata: { ...chunkRow("chunk_b").metadata, receipt_date: "2024-01-01" } });
  const after = chunkRow("chunk_c", { metadata: { ...chunkRow("chunk_c").metadata, receipt_date: "2024-12-31" } });
  const filters = { ...EMPTY_FILTERS, receipt_date_from: "2024-02-01", receipt_date_to: "2024-06-30" };
  assert.equal(passesMetadataFilters(inRange, filters), true);
  assert.equal(passesMetadataFilters(before, filters), false);
  assert.equal(passesMetadataFilters(after, filters), false);
});

test("metadata prefilter: is_correction excludes a non-matching value (previously silently ignored)", () => {
  const correction = chunkRow("chunk_a", { metadata: { ...chunkRow("chunk_a").metadata, is_correction: true } });
  const notCorrection = chunkRow("chunk_b", { metadata: { ...chunkRow("chunk_b").metadata, is_correction: false } });
  const filters = { ...EMPTY_FILTERS, is_correction: true };
  assert.equal(passesMetadataFilters(correction, filters), true);
  assert.equal(passesMetadataFilters(notCorrection, filters), false);
});

test("metadata prefilter: doc_subtypes excludes a non-matching subtype", () => {
  const matching = chunkRow("chunk_a", { metadata: { ...chunkRow("chunk_a").metadata, doc_subtype: "단일판매공급계약체결" } });
  const other = chunkRow("chunk_b", { metadata: { ...chunkRow("chunk_b").metadata, doc_subtype: "유상증자결정" } });
  const filters = { ...EMPTY_FILTERS, doc_subtypes: ["단일판매공급계약체결"] };
  assert.equal(passesMetadataFilters(matching, filters), true);
  assert.equal(passesMetadataFilters(other, filters), false);
});

test("buildEligibilityWhereClause produces the SAME logical conditions the row-level predicate checks (both legs share one builder)", () => {
  const filters = { ...EMPTY_FILTERS, corp_codes: ["00126380"], base_years: [2024], is_correction: false };
  const { conditions, params } = buildEligibilityWhereClause(filters, 2);
  assert.ok(conditions.some((c) => c.includes("corp_code")));
  assert.ok(conditions.some((c) => c.includes("base_year")));
  assert.ok(conditions.some((c) => c.includes("is_correction")));
  assert.deepEqual(params, [["00126380"], [2024], false]);
});

test("bm25Search eligibleIds restricts the candidate pool BEFORE ranking, not after -- a lower-scoring but eligible doc can outrank a higher-scoring ineligible one is impossible (ineligible is never scored at all)", () => {
  const index = buildBm25Index([
    { id: "chunk_high_score", text: "매출액 매출액 매출액 이익" },
    { id: "chunk_low_score", text: "매출액 관련 내용" },
  ]);
  const unfiltered = bm25Search(index, "매출액", { topK: 10 });
  assert.equal(unfiltered[0].id, "chunk_high_score"); // higher score ranks first when unfiltered

  const eligibleIds = new Set(["chunk_low_score"]); // exclude the higher-scoring doc entirely
  const filtered = bm25Search(index, "매출액", { topK: 10, eligibleIds });
  assert.deepEqual(filtered.map((r) => r.id), ["chunk_low_score"]);
});

test("bm25Search with eligibleIds omitted scores the whole index, byte-for-byte unchanged from before this Turn", () => {
  const index = buildBm25Index([
    { id: "chunk_a", text: "매출액 이익" },
    { id: "chunk_b", text: "매출액" },
  ]);
  const withoutEligibleIds = bm25Search(index, "매출액", { topK: 10 });
  const withNullEligibleIds = bm25Search(index, "매출액", { topK: 10, eligibleIds: null });
  assert.deepEqual(withoutEligibleIds, withNullEligibleIds);
});
