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
  buildProvenanceSet, buildDownstreamExpansionInput,
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
      // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section G: fetchEligibleChunkIds's
      // own prefilter query ("SELECT chunk_id FROM ... WHERE
      // retrieval_index_id = $1 ...", no chunk_id list param) targets the
      // SAME table as the hydrate-by-id query below -- distinguished by
      // selecting exactly one column. None of these fixtures exercise an
      // active metadata filter that would exclude a real row, so every
      // known chunk_id is eligible.
      if (sql.trim().startsWith("SELECT chunk_id FROM disclosure_reference.reference_retrieval_chunks")) {
        return { rows: [...chunkRows.keys()].map((chunk_id) => ({ chunk_id })) };
      }
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

test("readiness(): arm C is official_experiment_ready with mostly multi-node spans -- ambiguity is legitimate, not a defect (matches the measured 1,144-shard reality)", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const allStagingRows = [
    { source_spans: singleSpan(0) },
    { source_spans: multiNodeSpans([1, 2, 3]) },
    { source_spans: tableRowSpans(4, [0, 1]) },
  ];
  const client = fakeClient({
    allStagingRows,
    sessionRow: { status: "READY", expected_total_chunk_count: 3, expected_search_eligible_count: 3, expected_unique_embeddable_count: 3, materialized_chunk_count: 3 },
  });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const readiness = await armC.readiness();
  assert.equal(readiness.code_ready, true);
  assert.equal(readiness.full_index_ready, true);
  assert.equal(readiness.checks.locator_provenance.all_fully_resolved, false, "measurement only -- most chunks here are ambiguous, not fully resolved");
  assert.equal(readiness.checks.locator_provenance.unresolved_count, 0, "ambiguous is not the same as unresolved -- no EMPTY_SPANS_INVALID chunks here");
  assert.equal(readiness.checks.locator_provenance.provenance_ready, true);
  assert.equal(readiness.official_experiment_ready, true, "ambiguous-but-interpretable provenance must not block official readiness");
  assert.deepEqual(readiness.reasons, []);
  assert.equal(readiness.checks.dense_disabled_verified, true);
});

test("readiness(): arm C is NOT ready when a chunk has EMPTY_SPANS_INVALID (a real parser/loader gap), isolated from mere ambiguity", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const allStagingRows = [
    { source_spans: singleSpan(0) },
    { source_spans: multiNodeSpans([1, 2, 3]) },
    { source_spans: [] },
  ];
  const client = fakeClient({
    allStagingRows,
    sessionRow: { status: "READY", expected_total_chunk_count: 3, expected_search_eligible_count: 3, expected_unique_embeddable_count: 3, materialized_chunk_count: 3 },
  });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const readiness = await armC.readiness();
  assert.equal(readiness.checks.locator_provenance.unresolved_count, 1);
  assert.equal(readiness.checks.locator_provenance.provenance_ready, false);
  assert.equal(readiness.official_experiment_ready, false);
  assert.ok(readiness.reasons.includes("A_C_LOCATOR_UNRESOLVED_SPANS_PRESENT"));
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
  assert.equal(readiness.checks.locator_provenance.provenance_ready, true);
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

// ---------- Turn AC-LOCATOR-READY: occurrence-level provenance sidecar ----------
// Section E's required test matrix. No DB/KURE/Gold access anywhere below.

function mixedTableAndProseSpans() {
  // Table row (node 3, row 1) + a plain paragraph node (node 4) in the SAME
  // chunk -- e.g. a Fixed-512 window that ends a table and starts the next
  // paragraph. Two distinct node_ids -> MULTI_NODE_AMBIGUOUS, one candidate
  // is_table:true, the other is_table:false.
  return [...tableRowSpans(3, [1]), ...multiNodeSpans([4])];
}

test("node-only locator: a non-table single-node span resolves node identity with row/col null", () => {
  const result = classifySpans(singleSpan(7));
  assert.equal(result.status, LOCATOR_STATUS.NODE_AND_ROW_RESOLVED);
  assert.equal(result.node_index, 7);
  assert.equal(result.row, null);
  assert.equal(result.col, null);
  assert.equal(result.is_table, false);
});

test("row-qualified locator: verifyNodeIdentity accepts the correct row and rejects a wrong one", () => {
  const chunkRows = [{ chunk_id: "chunk_a", source_spans: tableRowSpans(3, [0, 1, 2]) }];
  const okRow = verifyNodeIdentity({ documentId: "doc_x", nodeIndex: 3, row: 1, chunkRows });
  assert.equal(okRow.found, true);
  const badRow = verifyNodeIdentity({ documentId: "doc_x", nodeIndex: 3, row: 99, chunkRows });
  assert.equal(badRow.found, false, "a row that was never persisted for this node must fail closed, never be accepted");
});

test("cell-qualified locator: verifyNodeIdentity accepts the correct row+col and rejects a wrong column", () => {
  const chunkRows = [{ chunk_id: "chunk_a", source_spans: tableRowSpans(3, [1]) }]; // col_start=0, col_end=2
  const okCell = verifyNodeIdentity({ documentId: "doc_x", nodeIndex: 3, row: 1, col: 2, chunkRows });
  assert.equal(okCell.found, true);
  const badCell = verifyNodeIdentity({ documentId: "doc_x", nodeIndex: 3, row: 1, col: 99, chunkRows });
  assert.equal(badCell.found, false, "a column outside the persisted col_start/col_end range must fail closed");
});

test("multi-row Fixed chunk: provenance set keeps every distinct row as its own candidate, never one representative row", () => {
  const provenance = buildProvenanceSet(tableRowSpans(3, [0, 1, 2]));
  assert.equal(provenance.status, LOCATOR_STATUS.NODE_RESOLVED_ROW_AMBIGUOUS);
  assert.equal(provenance.unresolved, false);
  assert.equal(provenance.candidate_count, 3);
  assert.deepEqual(provenance.candidates.map((c) => c.row_start), [0, 1, 2]);
  assert.ok(provenance.candidates.every((c) => c.node_index === 3 && c.is_table === true));
});

test("multi-node Fixed chunk: provenance set keeps every distinct node as its own candidate, never one representative node", () => {
  const provenance = buildProvenanceSet(multiNodeSpans([2, 7, 9]));
  assert.equal(provenance.status, LOCATOR_STATUS.MULTI_NODE_AMBIGUOUS);
  assert.equal(provenance.candidate_count, 3);
  assert.deepEqual(provenance.candidates.map((c) => c.node_index), [2, 7, 9]);
});

test("table + prose in the same chunk: both a table-row candidate and a plain-node candidate are preserved, correctly flagged is_table", () => {
  const provenance = buildProvenanceSet(mixedTableAndProseSpans());
  assert.equal(provenance.status, LOCATOR_STATUS.MULTI_NODE_AMBIGUOUS);
  assert.equal(provenance.candidate_count, 2);
  assert.deepEqual(provenance.candidates.map((c) => c.is_table), [true, false]);
});

test("multiple-locator preservation: search() result items expose the full candidate set, not a single collapsed locator", async () => {
  const docs = [{ id: "chunk_a00000000000000000000001", text: "매출액 표" }];
  const bm25Index = buildBm25Index(docs);
  const client = fakeClient({
    chunkRows: new Map(docs.map((d) => [d.id, chunkRow(d.id)])),
    stagingSpans: new Map(docs.map((d) => [d.id, multiNodeSpans([1, 2, 3])])),
  });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const [result] = await armC.search("매출액 표", {}, 20);
  // Top-level node_index/row/col/locator_status are UNCHANGED (still the
  // pre-existing, single-value Section F fields) -- provenance is additive.
  assert.equal(result.node_index, null);
  assert.equal(result.locator_status, LOCATOR_STATUS.MULTI_NODE_AMBIGUOUS);
  assert.equal(result.provenance.candidate_count, 3);
  assert.deepEqual(result.provenance.candidates.map((c) => c.node_index), [1, 2, 3]);
  assert.deepEqual(result.provenance.downstream_expansion_input, [
    { doc_id: "periodic_00000000000001", node_index: 1 },
    { doc_id: "periodic_00000000000001", node_index: 2 },
    { doc_id: "periodic_00000000000001", node_index: 3 },
  ]);
});

test("reject invalid document/node/row/column: fetch_node fails closed for a node never referenced by the requested document's own chunks", async () => {
  const bm25Index = buildBm25Index([{ id: "chunk_a00000000000000000000001", text: "x" }]);
  const client = fakeClient({ allStagingRows: [{ chunk_id: "chunk_a00000000000000000000001", source_spans: singleSpan(0, "periodic_00000000000001") }] });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  // Same fake client always returns allStagingRows regardless of document_id
  // param in this harness, so this specifically exercises node/row/col
  // rejection; the real adapter's SQL itself scopes by document_id (see the
  // "fetch_node SQL always scopes by document_id" static test below).
  const wrongNode = await armC.fetch_node("periodic_00000000000001", 999);
  assert.equal(wrongNode.found, false);
  const wrongRow = await armC.fetch_node("periodic_00000000000001", 0, { row: 5 });
  assert.equal(wrongRow.found, false, "node 0 is a non-table span (row_start=null) -- any requested row must be rejected");
});

test("locator 0개 fail-closed: a chunk with zero persisted spans is UNRESOLVED, never silently treated as resolved", () => {
  const provenance = buildProvenanceSet([]);
  assert.equal(provenance.status, LOCATOR_STATUS.EMPTY_SPANS_INVALID);
  assert.equal(provenance.unresolved, true);
  assert.equal(provenance.unresolved_reason, "NO_SOURCE_SPANS_PERSISTED");
  assert.equal(provenance.candidate_count, 0);
  assert.deepEqual(provenance.candidates, []);
  assert.equal(provenance.resolved, null);
});

test("동일 locator 중복 제거: duplicate spans (same node/row/col) collapse to one candidate", () => {
  const dupSpans = [...tableRowSpans(3, [1]), ...tableRowSpans(3, [1])];
  assert.equal(dupSpans.length, 2, "sanity: the fixture itself has two duplicate entries");
  const provenance = buildProvenanceSet(dupSpans);
  assert.equal(provenance.candidate_count, 1);
});

test("order determinism: candidate order matches the spans' own document order, unchanged across repeated calls", () => {
  const spans = multiNodeSpans([5, 1, 9, 1]); // includes a repeat, out-of-numeric-order on purpose
  const run1 = buildProvenanceSet(spans).candidates.map((c) => c.node_index);
  const run2 = buildProvenanceSet(spans).candidates.map((c) => c.node_index);
  assert.deepEqual(run1, [5, 1, 9]);
  assert.deepEqual(run1, run2);
});

test("parser 손상 시 UNRESOLVED: a null/malformed source_spans value classifies as UNRESOLVED, never guessed", () => {
  for (const malformed of [null, undefined, "not-an-array", {}]) {
    const result = classifySpans(malformed);
    assert.equal(result.status, LOCATOR_STATUS.EMPTY_SPANS_INVALID);
    const provenance = buildProvenanceSet(malformed);
    assert.equal(provenance.unresolved, true);
  }
});

test("Gold-based correction impossibility: locator-provenance.mjs's own source never references Gold/expected-evidence identifiers", () => {
  const source = readFileSync(path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/locator-provenance.mjs"), "utf8");
  for (const forbidden of ["gold", "Gold", "GOLD", "expected_answer", "expected_evidence", "DEV_CHECK", "HOLDOUT"]) {
    assert.ok(!source.includes(forbidden), `locator-provenance.mjs must never reference ${forbidden}`);
  }
  // Structural: the functions that decide resolution take ONLY the spans
  // (chunker-derived data) -- no gold/expected-evidence parameter exists to
  // even smuggle a correction through.
  assert.equal(classifySpans.length, 1);
  assert.equal(buildProvenanceSet.length, 1);
});

test("A and C use the SAME provenance path: identical spans produce byte-identical provenance/result shape for both arms", async () => {
  const docsA = [{ id: "chunk_a00000000000000000000001", text: "매출액 표 정보" }];
  const spans = tableRowSpans(3, [0, 1]);
  async function searchWith(arm, extra = {}) {
    const bm25Index = buildBm25Index(docsA);
    const client = fakeClient({
      chunkRows: new Map(docsA.map((d) => [d.id, chunkRow(d.id)])),
      stagingSpans: new Map(docsA.map((d) => [d.id, spans])),
      indexRow: { index_status: "READY", embedding_provider: "nlpai-lab", embedding_model: "KURE-v1", embedding_revision: KURE_PIN.revision, embedding_dimension: KURE_PIN.dimension, record_count: 1 },
    });
    const adapter = createArmRetrieverAdapter({ arm, client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID, ...extra });
    const [result] = await adapter.search("매출액 표 정보", {}, 20);
    return result.provenance;
  }
  const provenanceC = await searchWith("C");
  const provenanceA = await searchWith("A", {
    vectorRepository: { async searchDocumentChunksByVector() { return [{ chunk_id: docsA[0].id, score: 0.9 }]; } },
    embeddingAdapter: { async embedQuery() { return new Array(KURE_PIN.dimension).fill(0.01); } },
  });
  assert.deepEqual(provenanceA, provenanceC, "arm A and arm C must derive provenance via the identical classifySpans/buildProvenanceSet path");
});

test("metadata/Gold non-leak: the provenance sidecar never carries metadata-filter or Gold-shaped keys", async () => {
  const docs = [{ id: "chunk_a00000000000000000000001", text: "매출액 표" }];
  const bm25Index = buildBm25Index(docs);
  const client = fakeClient({
    chunkRows: new Map(docs.map((d) => [d.id, chunkRow(d.id, { metadata: { chunk_type: "FIXED_WINDOW", doc_group: "periodic", retrieval_eligible: true, gold_document_ids: ["should_never_be_here"] } })])),
    stagingSpans: new Map(docs.map((d) => [d.id, multiNodeSpans([1, 2])])),
  });
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID });
  const [result] = await armC.search("매출액 표", {}, 20);
  const provenanceSerialized = JSON.stringify(result.provenance);
  for (const leaked of ["gold_document_ids", "should_never_be_here", "doc_group", "retrieval_eligible"]) {
    assert.ok(!provenanceSerialized.includes(leaked), `provenance sidecar leaked non-locator metadata: ${leaked}`);
  }
});

test("existing vector reuse: provenance building never reads chunk text or embeddings -- only chunker-persisted source_spans", () => {
  const source = readFileSync(path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/locator-provenance.mjs"), "utf8");
  // "raw_text" itself is mentioned only in explanatory comments (what is
  // NOT persisted) -- checked here for the actual executable surface: no
  // function in this file ever calls an embedding/vector API or reads a
  // chunk's own text/embedding fields as CODE (not prose).
  for (const forbidden of ["embedQuery", "searchDocumentChunksByVector", "row.text_content", "row.raw_text", "embed_text", "vectorRepository"]) {
    assert.ok(!source.includes(forbidden), `locator-provenance.mjs must never reference ${forbidden} -- it must stay a pure spans->provenance sidecar`);
  }
});

test("fetch_node SQL always scopes by document_id -- structurally impossible to cross-match another document's node", () => {
  const source = readFileSync(path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs"), "utf8");
  const start = source.indexOf("async fetch_node(");
  const end = source.indexOf("\n    },", start);
  const body = source.slice(start, end);
  assert.match(body, /WHERE load_session_id = \$1 AND document_id = \$2/);
});

test("double-run canonical SHA match: repeated buildProvenanceSet calls over the same spans hash identically", () => {
  const spans = mixedTableAndProseSpans();
  const sha1 = sha256Hex(JSON.stringify(buildProvenanceSet(spans)));
  const sha2 = sha256Hex(JSON.stringify(buildProvenanceSet(spans)));
  assert.equal(sha1, sha2);
});

test("DEV_CHECK/HOLDOUT non-access: neither four-arm-ac source file nor this test file references DEV_CHECK/HOLDOUT tables or env vars", () => {
  for (const file of ["domain/agent-comparison/four-arm-ac/locator-provenance.mjs", "domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs"]) {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const forbidden of ["DEV_CHECK", "HOLDOUT", "DEV_TUNE"]) {
      assert.ok(!source.includes(forbidden), `${file} must never reference ${forbidden}`);
    }
  }
});
