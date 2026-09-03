// Turn AC-IMPL: scoped, offline tests for domain/agent-comparison/four-arm-ac/*
// -- mock Postgres client, real (small, synthetic) BM25 index via
// buildBm25Index, synthetic vectorRepository/embeddingAdapter for arm A.
// No real DB, no real KURE server, no Gold, no DEV_TUNE/DEV_CHECK/HOLDOUT
// access. Real-DB re-validation of the 1,144-chunk shard lives in the
// separate tests/four-arm-fixed-ac-postgres16-integration.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import {
  createArmRetrieverAdapter, ARM_DEFS, KURE_PIN, BM25_TOP_K,
} from "../domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs";
import {
  buildMetadataFiltersFromConditions, METADATA_FILTER_KEYS, SYNTHETIC_CONDITIONS_FIXTURES, computeConditionSegment,
} from "../domain/agent-comparison/four-arm-ac/conditions-fixture.mjs";
import {
  classifySpans, summarizeLocatorCoverage, verifyNodeIdentity, LOCATOR_STATUS,
} from "../domain/agent-comparison/four-arm-ac/locator-provenance.mjs";
import { computeConfigPairDiff, assertConfigPairValid, ConfigPairMismatchError } from "../domain/agent-comparison/four-arm-ac/pair-diff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

function sha256Hex(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }

// ---------- shared fixtures ----------

const RETRIEVAL_INDEX_ID = "fixed_kure_index_test";
const LOAD_SESSION_ID = "fixed_kure_session_test";

function chunkRow(id, overrides = {}) {
  return {
    chunk_id: id, source_document_id: "periodic_00000000000001", corp_code: "00000001",
    source_locator: `periodic_00000000000001/file_1#node=0`,
    chunk_ordinal: 0, text_content: `본문 ${id}`, text_sha256: sha256Hex(`본문 ${id}`),
    metadata: { chunk_type: "FIXED_WINDOW", parent_chunk_id: null, doc_group: "periodic", retrieval_eligible: true },
    ...overrides,
  };
}

function singleSpan(nodeIndex = 0, docId = "periodic_00000000000001") {
  return [{
    file_id: "file_1", rel_path: "file_1.xml", node_id: `node_${nodeIndex}`, order_index: nodeIndex,
    row_start: null, row_end: null, col_start: null, col_end: null,
    source_locator: `${docId}/file_1.xml#node=${nodeIndex}`,
  }];
}

function tableRowSpans(nodeIndex, rows) {
  return rows.map((rowIndex) => ({
    file_id: "file_1", rel_path: "file_1.xml", node_id: `node_${nodeIndex}`, order_index: nodeIndex,
    row_start: rowIndex, row_end: rowIndex, col_start: 0, col_end: 2,
    source_locator: `periodic_00000000000001/file_1.xml#node=${nodeIndex};row=${rowIndex}-${rowIndex};col=0-2`,
  }));
}

function multiNodeSpans(nodeIndices) {
  return nodeIndices.map((nodeIndex) => ({
    file_id: "file_1", rel_path: "file_1.xml", node_id: `node_${nodeIndex}`, order_index: nodeIndex,
    row_start: null, row_end: null, col_start: null, col_end: null,
    source_locator: `periodic_00000000000001/file_1.xml#node=${nodeIndex}`,
  }));
}

// Fake client dispatches on SQL substrings -- lets one fake stand in for
// every query the adapter issues (chunk hydration, staging spans, readiness
// queries) without a real Postgres connection.
function fakeClient({ chunkRows = new Map(), stagingSpans = new Map(), indexRow = null, sessionRow = null, allStagingRows = [] } = {}) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (sql.includes("FROM disclosure_reference.reference_retrieval_chunks")) {
        const ids = params[1];
        return { rows: ids.filter((id) => chunkRows.has(id)).map((id) => chunkRows.get(id)) };
      }
      if (sql.includes("FROM disclosure_reference.reference_fixed_kure_chunk_staging") && sql.includes("chunk_id = ANY")) {
        const ids = params[1];
        return { rows: ids.filter((id) => stagingSpans.has(id)).map((id) => ({ chunk_id: id, source_spans: stagingSpans.get(id) })) };
      }
      if (sql.includes("FROM disclosure_reference.reference_fixed_kure_chunk_staging") && sql.includes("document_id = $2")) {
        return { rows: allStagingRows };
      }
      if (sql.includes("FROM disclosure_reference.reference_fixed_kure_chunk_staging")) {
        return { rows: allStagingRows };
      }
      if (sql.includes("FROM disclosure_reference.reference_retrieval_indexes")) {
        return { rows: indexRow ? [indexRow] : [] };
      }
      if (sql.includes("FROM disclosure_reference.reference_fixed_kure_load_sessions")) {
        return { rows: sessionRow ? [sessionRow] : [] };
      }
      throw new Error(`fakeClient: unhandled SQL: ${sql}`);
    },
  };
}

function throwingVectorRepository(label) {
  return { async searchDocumentChunksByVector() { throw new Error(`${label}: searchDocumentChunksByVector must never be called for arm C`); } };
}
function throwingEmbeddingAdapter(label) {
  return { async embedQuery() { throw new Error(`${label}: embedQuery must never be called for arm C`); } };
}

// ---------- construction guards (fail-closed pins / structural dense-off) ----------

test("construction: arm must be A or C", () => {
  assert.throws(() => createArmRetrieverAdapter({
    arm: "B", client: fakeClient(), bm25Index: buildBm25Index([]), retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
  }), /arm must be "A" or "C"/);
});

test("construction: arm A requires vectorRepository and embeddingAdapter", () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "매출" }]);
  assert.throws(() => createArmRetrieverAdapter({
    arm: "A", client: fakeClient(), bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
  }), /requires a vectorRepository/);
});

test("construction: arm A fails closed on KURE revision pin mismatch", () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "매출" }]);
  assert.throws(() => createArmRetrieverAdapter({
    arm: "A", client: fakeClient(), bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
    vectorRepository: { async searchDocumentChunksByVector() { return []; } },
    embeddingAdapter: { async embedQuery() { return [0.1]; } },
    expectedPins: { embedding_revision: "WRONG_REVISION", embedding_dimension: 1024 },
  }), /KURE_PIN_MISMATCH/);
});

test("construction: arm A fails closed on KURE dimension pin mismatch", () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "매출" }]);
  assert.throws(() => createArmRetrieverAdapter({
    arm: "A", client: fakeClient(), bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
    vectorRepository: { async searchDocumentChunksByVector() { return []; } },
    embeddingAdapter: { async embedQuery() { return [0.1]; } },
    expectedPins: { embedding_revision: KURE_PIN.revision, embedding_dimension: 768 },
  }), /KURE_PIN_MISMATCH/);
});

test("construction: arm C (DENSE_OFF) refuses a vectorRepository -- structural guarantee, not behavioral", () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "매출" }]);
  assert.throws(() => createArmRetrieverAdapter({
    arm: "C", client: fakeClient(), bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
    vectorRepository: throwingVectorRepository("ctor-guard"),
  }), /must not be constructed with a vectorRepository/);
});

test("construction: arm C (DENSE_OFF) refuses an embeddingAdapter -- structural guarantee, not behavioral", () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "매출" }]);
  assert.throws(() => createArmRetrieverAdapter({
    arm: "C", client: fakeClient(), bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
    embeddingAdapter: throwingEmbeddingAdapter("ctor-guard"),
  }), /must not be constructed with a vectorRepository/);
});

test("static: searchArmC's own source never references reciprocalRankFusion, embedQuery, or searchDocumentChunksByVector", () => {
  const source = readFileSync(path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs"), "utf8");
  const start = source.indexOf("async function searchArmC");
  assert.ok(start >= 0, "searchArmC not found in source");
  const end = source.indexOf("\n  return Object.freeze({", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  for (const forbidden of ["reciprocalRankFusion", "embedQuery", "searchDocumentChunksByVector", "vectorRepository", "embeddingAdapter"]) {
    assert.ok(!body.includes(forbidden), `searchArmC body must never reference ${forbidden}`);
  }
});

// ---------- arm C uses A's own BM25 candidates/ranking, zero dense/RRF calls ----------

test("arm C's ranked results match bm25Search() over the SAME index/topK, in the same order", async () => {
  const docs = [
    { id: "chunk_a00000000000000000000001", text: "매출액은 1000원 입니다 매출 매출" },
    { id: "chunk_b00000000000000000000002", text: "매출 이익 그리고 비용" },
    { id: "chunk_c00000000000000000000003", text: "완전히 관련 없는 문장" },
  ];
  const bm25Index = buildBm25Index(docs);
  const chunkRows = new Map(docs.map((d) => [d.id, chunkRow(d.id)]));
  const stagingSpans = new Map(docs.map((d) => [d.id, singleSpan(0)]));
  const client = fakeClient({ chunkRows, stagingSpans });

  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const results = await armC.search("매출 이익", {}, 20);

  const expected = bm25Search(bm25Index, "매출 이익", { topK: BM25_TOP_K }).map((r) => r.id);
  assert.deepEqual(results.map((r) => r.chunk_id), expected);
  for (let i = 0; i < results.length; i += 1) {
    assert.equal(results[i].rank, i + 1);
    assert.equal(results[i].score_type, "BM25");
    assert.equal(results[i].component_scores.dense, null);
    assert.equal(results[i].component_scores.rrf, null);
    assert.equal(results[i].arm_code, "C");
    assert.equal(results[i].arm_id, "FIXED+DENSE_OFF");
  }
});

test("arm C never calls the fake client with a dense/vector-shaped query and only issues BM25-hydration/staging SQL", async () => {
  const docs = [{ id: "chunk_a00000000000000000000001", text: "매출액 테스트" }];
  const bm25Index = buildBm25Index(docs);
  const client = fakeClient({
    chunkRows: new Map(docs.map((d) => [d.id, chunkRow(d.id)])),
    stagingSpans: new Map(docs.map((d) => [d.id, singleSpan(0)])),
  });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  await armC.search("매출액 테스트", {}, 20);
  for (const call of client.calls) {
    assert.ok(
      call.sql.includes("reference_retrieval_chunks") || call.sql.includes("reference_fixed_kure_chunk_staging"),
      `unexpected SQL issued by arm C: ${call.sql}`,
    );
  }
});

// ---------- metadata non-leak ----------

test("buildMetadataFiltersFromConditions strips any non-allowed (e.g. Gold-shaped) fields", () => {
  const goldLeak = {
    corp_codes: ["00000001"], doc_groups: ["periodic"],
    gold_document_ids: ["doc_should_never_leak"], expected_answer: "매출 1000원",
    required_slot_ids: ["slot_x"], evidence_locator: "doc/file#node=99", other_arm_results: [{ chunk_id: "chunk_from_arm_a" }],
  };
  const filters = buildMetadataFiltersFromConditions(goldLeak);
  assert.deepEqual(Object.keys(filters).sort(), [...METADATA_FILTER_KEYS].sort());
  const serialized = JSON.stringify(filters);
  for (const leaked of ["gold_document_ids", "doc_should_never_leak", "expected_answer", "매출 1000원", "required_slot_ids", "slot_x", "evidence_locator", "node=99", "other_arm_results", "chunk_from_arm_a"]) {
    assert.ok(!serialized.includes(leaked), `metadata filter leaked Gold-shaped content: ${leaked}`);
  }
});

test("SYNTHETIC_CONDITIONS_FIXTURES never carry a Gold-shaped field", () => {
  const forbidden = ["gold_document_ids", "expected_answer", "required_slot", "evidence_locator", "other_arm", "gold_corp_codes", "gold_doc_groups"];
  for (const fixture of SYNTHETIC_CONDITIONS_FIXTURES) {
    const serialized = JSON.stringify(fixture);
    for (const term of forbidden) assert.ok(!serialized.includes(term), `fixture ${fixture.fixture_id} contains forbidden term ${term}`);
  }
});

test("computeConditionSegment reproduces vFINAL section 1's LOW/HIGH rule", () => {
  assert.deepEqual(computeConditionSegment({ corp_codes: ["1"], base_years: [2024] }), { n_hard_conditions: 2, segment: "LOW" });
  assert.deepEqual(computeConditionSegment({ corp_codes: ["1"], base_years: [2024], doc_groups: ["periodic"] }), { n_hard_conditions: 3, segment: "HIGH" });
  assert.deepEqual(computeConditionSegment({}), { n_hard_conditions: 0, segment: "LOW" });
});

// ---------- pair-diff ----------

const CONFIG_A = JSON.parse(readFileSync(path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/config.A.json"), "utf8"));
const CONFIG_C = JSON.parse(readFileSync(path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/config.C.json"), "utf8"));

test("config.A.json vs config.C.json: pair-diff only touches allowed keys", () => {
  const diff = computeConfigPairDiff(CONFIG_A, CONFIG_C);
  assert.deepEqual(diff.disallowed_keys, []);
  assert.ok(diff.ok);
  assert.doesNotThrow(() => assertConfigPairValid(CONFIG_A, CONFIG_C));
});

test("pair-diff rejects a disallowed divergence (e.g. chunker) as CONFIG_PAIR_MISMATCH", () => {
  const mutatedC = { ...CONFIG_C, chunker: { ...CONFIG_C.chunker, chunk_size: 256 } };
  const diff = computeConfigPairDiff(CONFIG_A, mutatedC);
  assert.ok(diff.disallowed_keys.includes("chunker"));
  assert.throws(() => assertConfigPairValid(CONFIG_A, mutatedC), ConfigPairMismatchError);
});

test("pair-diff rejects a disallowed divergence (e.g. corpus_snapshot_id) as CONFIG_PAIR_MISMATCH", () => {
  const mutatedC = { ...CONFIG_C, corpus_snapshot_id: "corpus_other" };
  assert.throws(() => assertConfigPairValid(CONFIG_A, mutatedC), ConfigPairMismatchError);
});

// ---------- locator provenance ----------

test("classifySpans: empty spans is invalid", () => {
  assert.equal(classifySpans([]).status, LOCATOR_STATUS.EMPTY_SPANS_INVALID);
});

test("classifySpans: single-span chunk resolves node exactly, never arbitrary", () => {
  const result = classifySpans(singleSpan(5));
  assert.equal(result.status, LOCATOR_STATUS.NODE_AND_ROW_RESOLVED);
  assert.equal(result.node_index, 5);
  assert.equal(result.row, null);
});

test("classifySpans: multi-node chunk is MULTI_NODE_AMBIGUOUS, never collapsed to one representative node", () => {
  const result = classifySpans(multiNodeSpans([2, 7, 9]));
  assert.equal(result.status, LOCATOR_STATUS.MULTI_NODE_AMBIGUOUS);
  assert.equal(result.node_index, null);
  assert.deepEqual(result.candidate_node_indices, [2, 7, 9]);
});

test("classifySpans: same table node, multiple rows -- node resolved, row ambiguous (the 'overlap' case)", () => {
  const result = classifySpans(tableRowSpans(3, [0, 1, 2]));
  assert.equal(result.status, LOCATOR_STATUS.NODE_RESOLVED_ROW_AMBIGUOUS);
  assert.equal(result.node_index, 3);
  assert.equal(result.row, null);
  assert.ok(result.is_table);
});

test("classifySpans: single table row resolves node AND row/col", () => {
  const result = classifySpans(tableRowSpans(3, [1]));
  assert.equal(result.status, LOCATOR_STATUS.NODE_AND_ROW_RESOLVED);
  assert.equal(result.node_index, 3);
  assert.equal(result.row, 1);
  assert.equal(result.col, 0);
  assert.ok(result.is_table);
});

test("summarizeLocatorCoverage measures the real single- vs multi-node mix, never assumes 100%", () => {
  const rows = [
    { source_spans: singleSpan(0) },
    { source_spans: multiNodeSpans([1, 2]) },
    { source_spans: multiNodeSpans([3, 4, 5]) },
  ];
  const coverage = summarizeLocatorCoverage(rows);
  assert.equal(coverage.total_chunks, 3);
  assert.equal(coverage.counts[LOCATOR_STATUS.NODE_AND_ROW_RESOLVED], 1);
  assert.equal(coverage.counts[LOCATOR_STATUS.MULTI_NODE_AMBIGUOUS], 2);
  assert.equal(coverage.all_fully_resolved, false);
  assert.ok(Math.abs(coverage.fully_resolved_fraction - (1 / 3)) < 1e-9);
});

test("verifyNodeIdentity: fail-closed when the requested node is not found in any chunk's spans", () => {
  const result = verifyNodeIdentity({ documentId: "doc_x", nodeIndex: 99, chunkRows: [{ chunk_id: "chunk_a", source_spans: singleSpan(0) }] });
  assert.equal(result.found, false);
  assert.equal(result.node_text_available, false);
  assert.equal(result.node_text, null);
});

test("verifyNodeIdentity: found + consistent when the node appears in one or more chunks' spans", () => {
  const result = verifyNodeIdentity({
    documentId: "doc_x", nodeIndex: 0,
    chunkRows: [{ chunk_id: "chunk_a", source_spans: singleSpan(0) }, { chunk_id: "chunk_b", source_spans: multiNodeSpans([0, 1]) }],
  });
  assert.equal(result.found, true);
  assert.equal(result.matches.length, 2);
  assert.equal(result.locator_consistent, true);
  assert.equal(result.node_text_available, false, "node text is never fabricated -- not persisted independently of chunk raw_text");
});

// ---------- deterministic ranking SHA ----------

test("arm C: identical (question, conditions) produces byte-identical ordered chunk_id list across repeated calls", async () => {
  const docs = [
    { id: "chunk_a00000000000000000000001", text: "매출 매출 이익" },
    { id: "chunk_b00000000000000000000002", text: "매출 비용" },
    { id: "chunk_c00000000000000000000003", text: "이익 비용 매출" },
  ];
  const bm25Index = buildBm25Index(docs);
  const chunkRows = new Map(docs.map((d) => [d.id, chunkRow(d.id)]));
  const stagingSpans = new Map(docs.map((d) => [d.id, singleSpan(0)]));

  async function run() {
    const client = fakeClient({ chunkRows, stagingSpans });
    const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
    const results = await armC.search("매출 이익", {}, 20);
    return sha256Hex(JSON.stringify(results.map((r) => r.chunk_id)));
  }
  const [sha1, sha2] = await Promise.all([run(), run()]);
  assert.equal(sha1, sha2);
});

// ---------- Section F result-shape validation ----------

test("arm C results carry every Section F field with the right shape", async () => {
  const docs = [{ id: "chunk_a00000000000000000000001", text: "매출액 테스트" }];
  const bm25Index = buildBm25Index(docs);
  const client = fakeClient({
    chunkRows: new Map(docs.map((d) => [d.id, chunkRow(d.id)])),
    stagingSpans: new Map(docs.map((d) => [d.id, singleSpan(2)])),
  });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const [result] = await armC.search("매출액 테스트", {}, 20);
  assert.equal(result.rank, 1);
  assert.equal(typeof result.chunk_id, "string");
  assert.equal(typeof result.doc_id, "string");
  assert.equal(result.node_index, 2);
  assert.equal(typeof result.locator, "string");
  assert.match(result.chunk_text_sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof result.score, "number");
  assert.equal(typeof result.metadata, "object");
  assert.equal(result.arm_code, ARM_DEFS.C.arm_code);
  assert.equal(result.arm_id, ARM_DEFS.C.arm_id);
});

test("search() rejects an empty question and a non-positive-integer k -- fail-closed on malformed input", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const armC = createArmRetrieverAdapter({ arm: "C", client: fakeClient(), bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  await assert.rejects(() => armC.search("", {}, 20), /non-empty string/);
  await assert.rejects(() => armC.search("q", {}, 0), /positive integer/);
});

// ---------- readiness() ----------

test("readiness(): arm C reports A_C_LOCATOR_PROVENANCE_NOT_READY when spans are mostly multi-node (matches the measured 1,144-shard reality)", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const allStagingRows = [
    { source_spans: singleSpan(0) },
    { source_spans: multiNodeSpans([1, 2, 3]) },
    { source_spans: multiNodeSpans([4, 5]) },
  ];
  const client = fakeClient({
    allStagingRows,
    sessionRow: { status: "READY", expected_total_chunk_count: 3, expected_search_eligible_count: 3, expected_unique_embeddable_count: 3, materialized_chunk_count: 3 },
  });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const readiness = await armC.readiness();
  assert.equal(readiness.code_ready, true);
  assert.equal(readiness.full_index_ready, true);
  assert.equal(readiness.official_experiment_ready, false);
  assert.ok(readiness.reasons.includes("A_C_LOCATOR_PROVENANCE_NOT_READY"));
  assert.equal(readiness.checks.dense_disabled_verified, true);
});

test("readiness(): arm A reports NOT ready when the dense index pin does not match KURE_PIN", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const client = fakeClient({
    indexRow: { index_status: "READY", embedding_provider: "nlpai-lab", embedding_model: "KURE-v1", embedding_revision: "WRONG", embedding_dimension: 1024, record_count: 3 },
    sessionRow: { status: "READY", expected_total_chunk_count: 1, expected_search_eligible_count: 1, expected_unique_embeddable_count: 1, materialized_chunk_count: 1 },
    allStagingRows: [{ source_spans: singleSpan(0) }],
  });
  const armA = createArmRetrieverAdapter({
    arm: "A", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
    vectorRepository: { async searchDocumentChunksByVector() { return []; } }, embeddingAdapter: { async embedQuery() { return [0.1]; } },
  });
  const readiness = await armA.readiness();
  assert.equal(readiness.checks.dense_index_ready, false);
  assert.ok(readiness.reasons.includes("A_DENSE_INDEX_NOT_READY_OR_PIN_MISMATCH"));
  assert.equal(readiness.official_experiment_ready, false);
});

test("readiness(): fully resolved locator coverage + ready session/index reports official_experiment_ready true", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const client = fakeClient({
    indexRow: { index_status: "READY", embedding_provider: "nlpai-lab", embedding_model: "KURE-v1", embedding_revision: KURE_PIN.revision, embedding_dimension: KURE_PIN.dimension, record_count: 1 },
    sessionRow: { status: "READY", expected_total_chunk_count: 1, expected_search_eligible_count: 1, expected_unique_embeddable_count: 1, materialized_chunk_count: 1 },
    allStagingRows: [{ source_spans: singleSpan(0) }],
  });
  const armA = createArmRetrieverAdapter({
    arm: "A", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
    vectorRepository: { async searchDocumentChunksByVector() { return []; } }, embeddingAdapter: { async embedQuery() { return [0.1]; } },
  });
  const readiness = await armA.readiness();
  assert.equal(readiness.official_experiment_ready, true);
  assert.deepEqual(readiness.reasons, []);
});

// ---------- fetch_node ----------

test("fetch_node: fail-closed NOT FOUND for an unknown node_index", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const client = fakeClient({ allStagingRows: [{ chunk_id: "chunk_a00000000000000000000001", source_spans: singleSpan(0) }] });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const result = await armC.fetch_node("periodic_00000000000001", 42);
  assert.equal(result.found, false);
});

test("fetch_node: verified FOUND, but never returns fabricated node text", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const client = fakeClient({ allStagingRows: [{ chunk_id: "chunk_a00000000000000000000001", source_spans: singleSpan(0) }] });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const result = await armC.fetch_node("periodic_00000000000001", 0);
  assert.equal(result.found, true);
  assert.equal(result.node_text_available, false);
  assert.equal(result.node_text, null);
});
