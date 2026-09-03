// Turn P11-F0: scoped, offline tests for
// fixed-kure-hybrid-retriever-adapter.mjs -- mock Postgres client,
// synthetic BM25 index, synthetic vectorRepository/embeddingAdapter. No
// real DB, no real KURE server, no Gold. Focused especially on the
// HYBRID_RRF intersection invariant (domain/contracts.mjs's
// RETRIEVAL_METHOD_REQUIRED_COMPONENTS.HYBRID_RRF = ["bm25","dense","rrf"]
// -- every result must carry BOTH a non-null bm25 AND dense component
// score, so RRF here fuses the INTERSECTION of the two candidate sets).
import assert from "node:assert/strict";
import test from "node:test";
import { createFixedKureHybridRetrieverAdapter } from "../domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs";
import { validateRetrievalResult, validateRetrievalRequestResultPair } from "../domain/contracts.mjs";

function chunkRow(id, overrides = {}) {
  return {
    chunk_id: id, source_document_id: "periodic_00000000000001", corp_code: "00000001",
    source_locator: `periodic_00000000000001/file_1#node=${id.slice(-1)}`,
    chunk_ordinal: 0, text_content: `본문 ${id}`, metadata: { chunk_type: "FIXED_WINDOW", parent_chunk_id: null, doc_group: "periodic" },
    ...overrides,
  };
}

function fakeClient(rowsById) {
  return {
    async query(sql, params) {
      // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section G: the adapter now
      // also issues an eligibility-prefilter query
      // (fetchEligibleChunkIds, "SELECT chunk_id FROM ... WHERE
      // retrieval_index_id = $1 ...", no chunk_id list param) BEFORE
      // bm25Search -- distinguished here from the "hydrate BM25 candidates
      // by id" query (which selects multiple columns and always carries a
      // chunk_id list as params[1]). None of these fixtures exercise an
      // active metadata filter that would exclude a real row, so every
      // known chunk_id is eligible.
      if (sql.trim().startsWith("SELECT chunk_id FROM")) {
        return { rows: [...rowsById.keys()].map((chunk_id) => ({ chunk_id })) };
      }
      const ids = params[1];
      return { rows: ids.filter((id) => rowsById.has(id)).map((id) => rowsById.get(id)) };
    },
  };
}

// bm25Search itself (from bm25.mjs) is a pure function of a REAL index
// structure this test does not want to reconstruct token-by-token --
// instead this test constructs a minimal real BM25 index via the actual
// buildBm25Index so bm25Search behaves for real, and controls ranking by
// choosing document TEXT content deterministically.
import { buildBm25Index } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";

function realBm25Index(docs) {
  return buildBm25Index(docs);
}

test("HYBRID_RRF result set is the INTERSECTION of BM25 and dense candidates -- a chunk found by only one leg is dropped, never emitted with a null component", async () => {
  // BM25 candidates: chunk_a, chunk_b (chunk_b unique lexical term "고유단어체크");
  // dense candidates: chunk_a, chunk_c (chunk_c never appears in the bm25 corpus).
  const bm25Index = realBm25Index([
    { id: "chunk_a00000000000000000000001", text: "매출액은 1000원 입니다" },
    { id: "chunk_b00000000000000000000002", text: "고유단어체크 그리고 매출액" },
  ]);
  const rowsById = new Map([
    ["chunk_a00000000000000000000001", chunkRow("chunk_a00000000000000000000001")],
    ["chunk_b00000000000000000000002", chunkRow("chunk_b00000000000000000000002")],
    ["chunk_c00000000000000000000003", chunkRow("chunk_c00000000000000000000003")],
  ]);
  const client = fakeClient(rowsById);
  const vectorRepository = {
    async searchDocumentChunksByVector() {
      return [
        { chunk_id: "chunk_a00000000000000000000001", similarity_score: 0.9, ...rowsById.get("chunk_a00000000000000000000001") },
        { chunk_id: "chunk_c00000000000000000000003", similarity_score: 0.8, ...rowsById.get("chunk_c00000000000000000000003") },
      ];
    },
  };
  const embeddingAdapter = { async embedQuery() { return [0.1, 0.2]; } };

  const adapter = createFixedKureHybridRetrieverAdapter({
    client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId: "fixed_kure_index_test",
  });

  const request = {
    schema_version: "0.1.0", query_id: "query_test_01", question: "매출액",
    corpus_snapshot_id: "corpus_test", chunking_config_id: "fixed-token-512-o64.v0.1.0", index_snapshot_id: "fixed_kure_index_test",
    metadata_filters: { corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true },
    top_k: 10, retrieval_method: "HYBRID_RRF",
  };
  const result = await adapter.retrieve(request, {});

  // Only chunk_a is in BOTH bm25 and dense candidate sets.
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].chunk_id, "chunk_a00000000000000000000001");
  assert.notEqual(result.results[0].component_scores.bm25, null);
  assert.notEqual(result.results[0].component_scores.dense, null);
  assert.notEqual(result.results[0].component_scores.rrf, null);

  // Independently re-validated against the SAME frozen contract functions
  // retriever-store.mjs itself uses -- this test's own pass/fail is not
  // just "my adapter thinks it's fine".
  assert.deepEqual(validateRetrievalResult(result), []);
  assert.deepEqual(validateRetrievalRequestResultPair(request, result), []);
});

test("HYBRID_RRF with zero intersection returns an empty (still schema-valid) results array, never an error", async () => {
  const bm25Index = realBm25Index([{ id: "chunk_a00000000000000000000001", text: "완전히 다른 문장" }]);
  const rowsById = new Map([["chunk_a00000000000000000000001", chunkRow("chunk_a00000000000000000000001")], ["chunk_z00000000000000000000009", chunkRow("chunk_z00000000000000000000009")]]);
  const client = fakeClient(rowsById);
  const vectorRepository = { async searchDocumentChunksByVector() { return [{ chunk_id: "chunk_z00000000000000000000009", similarity_score: 0.5, ...rowsById.get("chunk_z00000000000000000000009") }]; } };
  const embeddingAdapter = { async embedQuery() { return [0.1]; } };
  const adapter = createFixedKureHybridRetrieverAdapter({ client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId: "fixed_kure_index_test" });

  const request = {
    schema_version: "0.1.0", query_id: "query_test_02", question: "완전히 다른 문장",
    corpus_snapshot_id: "corpus_test", chunking_config_id: "fixed-token-512-o64.v0.1.0", index_snapshot_id: "fixed_kure_index_test",
    metadata_filters: { corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true },
    top_k: 10, retrieval_method: "HYBRID_RRF",
  };
  const result = await adapter.retrieve(request, {});
  assert.deepEqual(result.results, []);
  assert.deepEqual(validateRetrievalResult(result), []);
});

test("results are ranked contiguous 1-based and score non-increasing", async () => {
  const bm25Index = realBm25Index([
    { id: "chunk_a00000000000000000000001", text: "매출 매출 매출 이익" },
    { id: "chunk_b00000000000000000000002", text: "매출 이익" },
  ]);
  const rowsById = new Map([
    ["chunk_a00000000000000000000001", chunkRow("chunk_a00000000000000000000001")],
    ["chunk_b00000000000000000000002", chunkRow("chunk_b00000000000000000000002")],
  ]);
  const client = fakeClient(rowsById);
  const vectorRepository = {
    async searchDocumentChunksByVector() {
      return [
        { chunk_id: "chunk_a00000000000000000000001", similarity_score: 0.95, ...rowsById.get("chunk_a00000000000000000000001") },
        { chunk_id: "chunk_b00000000000000000000002", similarity_score: 0.5, ...rowsById.get("chunk_b00000000000000000000002") },
      ];
    },
  };
  const embeddingAdapter = { async embedQuery() { return [0.1]; } };
  const adapter = createFixedKureHybridRetrieverAdapter({ client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId: "fixed_kure_index_test" });

  const request = {
    schema_version: "0.1.0", query_id: "query_test_03", question: "매출 이익",
    corpus_snapshot_id: "corpus_test", chunking_config_id: "fixed-token-512-o64.v0.1.0", index_snapshot_id: "fixed_kure_index_test",
    metadata_filters: { corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true },
    top_k: 10, retrieval_method: "HYBRID_RRF",
  };
  const result = await adapter.retrieve(request, {});
  assert.equal(result.results.length, 2);
  for (let i = 0; i < result.results.length; i += 1) assert.equal(result.results[i].rank, i + 1);
  assert.ok(result.results[0].score >= result.results[1].score);
});

test("metadata_filters.corp_codes excludes a BM25 candidate whose stored corp_code does not match", async () => {
  const bm25Index = realBm25Index([{ id: "chunk_a00000000000000000000001", text: "매출액 테스트" }]);
  const rowsById = new Map([["chunk_a00000000000000000000001", chunkRow("chunk_a00000000000000000000001", { corp_code: "99999999" })]]);
  const client = fakeClient(rowsById);
  const vectorRepository = { async searchDocumentChunksByVector() { return [{ chunk_id: "chunk_a00000000000000000000001", similarity_score: 0.9, ...rowsById.get("chunk_a00000000000000000000001") }]; } };
  const embeddingAdapter = { async embedQuery() { return [0.1]; } };
  const adapter = createFixedKureHybridRetrieverAdapter({ client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId: "fixed_kure_index_test" });

  const request = {
    schema_version: "0.1.0", query_id: "query_test_04", question: "매출액 테스트",
    corpus_snapshot_id: "corpus_test", chunking_config_id: "fixed-token-512-o64.v0.1.0", index_snapshot_id: "fixed_kure_index_test",
    metadata_filters: { corp_codes: ["00000001"], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true },
    top_k: 10, retrieval_method: "HYBRID_RRF",
  };
  const result = await adapter.retrieve(request, {});
  assert.deepEqual(result.results, []); // the only candidate's corp_code (99999999) does not match the filter (00000001)
});
