// Turn A-RETRIEVAL-REMEDIATION-V1: offline tests for the opt-in retrieval
// policy (four-arm-retrieval-policy.mjs) and its wiring into the conditions
// mapper, the hybrid adapter and the arm A/C adapter. Synthetic fixtures
// only -- a fake Postgres client that actually EVALUATES the prefilter
// WHERE clause (the existing four-arm-fixed-ac fixtures treat every chunk
// as eligible, which cannot exercise a filter), a fake dense repository
// that applies the same shared passesMetadataFilters, and a call-counting
// fake embedding adapter. No DB, no KURE, no Gold/DEV_TUNE/DEV_CHECK/HOLDOUT.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildBm25Index } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { createArmRetrieverAdapter } from "../domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs";
import { createFixedKureHybridRetrieverAdapter } from "../domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs";
import { passesMetadataFilters } from "../domain/retrieval/metadata-filter.mjs";
import { buildMetadataFiltersFromConditions } from "../domain/agent-comparison/four-arm-ac/conditions-fixture.mjs";
import { buildNameToCorpCodeIndex, mapOfficialConditionToFilterInput } from "../domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs";
import {
  FROZEN_POLICY, REMEDIATION_V1_POLICY, POLICY_IDS, resolvePolicy, questionFullDates, shiftIsoDate,
  deriveReceiptWindow, buildRetrievalPlan, buildFilterPasses, diversifyResults,
} from "../domain/agent-comparison/four-arm-ac/four-arm-retrieval-policy.mjs";

const RETRIEVAL_INDEX_ID = "fixed_kure_index_test";
const LOAD_SESSION_ID = "fixed_kure_session_test";
const CORP = "00000001";
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// ---------- synthetic corpus ----------

function makeRow({ id, doc, text, nodes, corp = CORP, group = "exchange", subtype = "단일판매공급계약체결", receipt, correction = false }) {
  return {
    chunk_id: id, source_document_id: doc, corp_code: corp, source_locator: `${doc}/file.xml#node=${nodes[0]}`,
    chunk_ordinal: 0, text_content: text, text_sha256: sha(text),
    metadata: { chunk_type: "FIXED_WINDOW", parent_chunk_id: null, doc_group: group, doc_subtype: subtype, receipt_date: receipt, is_correction: correction, retrieval_eligible: true },
    _nodes: nodes,
  };
}
const E1A = makeRow({ id: "chunk_e1a", doc: "exchange_20231204800003", receipt: "2023-12-04", nodes: [0, 1, 2], text: "단일판매 공급계약 체결 계약금액 100 계약상대 갑" });
const E1B = makeRow({ id: "chunk_e1b", doc: "exchange_20231204800003", receipt: "2023-12-04", nodes: [2, 3, 4], text: "계약기간 시작일 종료일 매출액 대비 비율 5" });
const E2A = makeRow({ id: "chunk_e2a", doc: "exchange_20240905800161", receipt: "2024-09-05", nodes: [0, 1, 2], text: "단일판매 공급계약 체결 계약금액 200 계약상대 을" });
const E3A = makeRow({ id: "chunk_e3a", doc: "exchange_20250124800528", receipt: "2025-01-24", nodes: [0, 1, 2], text: "단일판매 공급계약 체결 계약금액 300 계약상대 병" });
const I1A = makeRow({ id: "chunk_i1a", doc: "exchange_20230404900142", receipt: "2023-04-04", nodes: [0, 1], subtype: "투자판단관련주요경영사항", text: "마일스톤 기술료 수령 계약상대방 라이선스" });
const X1A = makeRow({ id: "chunk_x1a", doc: "exchange_20231204800099", receipt: "2023-12-04", nodes: [0, 1, 2], correction: true, text: "기재정정 단일판매 공급계약 체결 계약금액 150 정정" });
const O1A = makeRow({ id: "chunk_o1a", doc: "exchange_20231204800777", receipt: "2023-12-04", nodes: [0], corp: "00000002", text: "단일판매 공급계약 체결 계약금액 999" });

function spansOf(doc, nodes) {
  return nodes.map((n) => ({
    file_id: "file", rel_path: "file.xml", node_id: `node_${n}`, order_index: n,
    row_start: null, row_end: null, col_start: null, col_end: null, source_locator: `${doc}/file.xml#node=${n}`,
  }));
}

// Evaluates the parameterised prefilter WHERE clause metadata-filter.mjs
// builds (buildEligibilityWhereClause, paramStartIndex 2, no column prefix).
function evalPrefilter(sql, params, r) {
  const where = sql.slice(sql.indexOf("WHERE") + 5);
  for (const raw of where.split(" AND ")) {
    const frag = raw.trim();
    let m;
    if (/^retrieval_index_id = \$1$/.test(frag)) continue;
    if ((m = /^corp_code = ANY\(\$(\d+)\)$/.exec(frag))) { if (!params[m[1] - 1].includes(r.corp_code)) return false; continue; }
    if ((m = /^source_document_id = ANY\(\$(\d+)\)$/.exec(frag))) { if (!params[m[1] - 1].includes(r.source_document_id)) return false; continue; }
    if ((m = /^metadata->>'(\w+)' = ANY\(\$(\d+)\)$/.exec(frag))) { if (!params[m[2] - 1].includes(r.metadata[m[1]])) return false; continue; }
    if ((m = /^\(metadata->>'(\w+)'\)::int = ANY\(\$(\d+)\)$/.exec(frag))) { if (!params[m[2] - 1].includes(r.metadata[m[1]])) return false; continue; }
    if ((m = /^metadata->>'receipt_date' >= \$(\d+)$/.exec(frag))) { if (!(r.metadata.receipt_date >= params[m[1] - 1])) return false; continue; }
    if ((m = /^metadata->>'receipt_date' <= \$(\d+)$/.exec(frag))) { if (!(r.metadata.receipt_date <= params[m[1] - 1])) return false; continue; }
    if ((m = /^\(metadata->>'is_correction'\)::boolean = \$(\d+)$/.exec(frag))) { if (r.metadata.is_correction !== params[m[1] - 1]) return false; continue; }
    if (/retrieval_eligible/.test(frag)) { if (r.metadata.retrieval_eligible === false) return false; continue; }
    throw new Error(`fake prefilter: unhandled fragment: ${frag}`);
  }
  return true;
}

function fakeClient(rows) {
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (sql.trim().startsWith("SELECT chunk_id FROM disclosure_reference.reference_retrieval_chunks")) {
        return { rows: rows.filter((r) => evalPrefilter(sql, params, r)).map((r) => ({ chunk_id: r.chunk_id })) };
      }
      if (sql.includes("FROM disclosure_reference.reference_retrieval_chunks")) {
        const ids = params[1];
        return { rows: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)) };
      }
      if (sql.includes("FROM disclosure_reference.reference_fixed_kure_chunk_staging") && sql.includes("chunk_id = ANY")) {
        const ids = params[1];
        return { rows: ids.filter((id) => byId.has(id)).map((id) => ({ chunk_id: id, source_spans: spansOf(byId.get(id).source_document_id, byId.get(id)._nodes) })) };
      }
      throw new Error(`fakeClient: unhandled SQL: ${sql}`);
    },
  };
}

// Dense leg stand-in: only chunks listed in `similarity` are "found" by the
// vector index; the shared passesMetadataFilters predicate is applied
// exactly as the real repository's SQL WHERE would.
function fakeVectorRepo(rows, similarity = {}) {
  const calls = [];
  return {
    calls,
    async searchDocumentChunksByVector({ topK, filters }) {
      calls.push({ topK, filters });
      return rows
        .filter((r) => Object.hasOwn(similarity, r.chunk_id) && passesMetadataFilters(r, filters))
        .map((r) => ({ ...r, similarity_score: similarity[r.chunk_id] }))
        .sort((a, b) => (b.similarity_score - a.similarity_score) || a.chunk_id.localeCompare(b.chunk_id))
        .slice(0, topK);
    },
  };
}
function fakeEmbedding() {
  const adapter = { calls: 0, async embedQuery() { adapter.calls += 1; return [0.1, 0.2, 0.3]; } };
  return adapter;
}

function makeArm(arm, rows, { policy = null, similarity = {} } = {}) {
  const client = fakeClient(rows);
  const bm25Index = buildBm25Index(rows.map((r) => ({ id: r.chunk_id, text: r.text_content })));
  const vectorRepository = fakeVectorRepo(rows, similarity);
  const embeddingAdapter = fakeEmbedding();
  const adapter = createArmRetrieverAdapter({
    arm, client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
    ...(arm === "A" ? { vectorRepository, embeddingAdapter } : {}),
    ...(policy ? { policy } : {}),
  });
  return { adapter, client, vectorRepository, embeddingAdapter };
}

function fakeResolver(records) {
  const index = new Map(records.map((r) => [r.corp_code, r]));
  return { resolve: (code) => index.get(code) ?? null, corpCodes: () => [...index.keys()], count: () => index.size };
}
const NAME_INDEX = buildNameToCorpCodeIndex(fakeResolver([
  { corp_code: CORP, corp_name: "한화에어로스페이스", listed_name: "한화에어로스페이스" },
  { corp_code: "00000002", corp_name: "다른회사", listed_name: "다른회사" },
]));
const ids = (items) => items.map((r) => r.chunk_id);

// ---------- policy module: pure functions ----------

test("questionFullDates: ISO / dotted / Korean full dates only; year-month phrases and invalid dates ignored; deduped in order", () => {
  assert.deepEqual([...questionFullDates("한화에어로스페이스의 2023-12-04 단일판매 공시와 2024년 3월 22일 기준일, 2023.09.30 누적")], ["2023-12-04", "2024-03-22", "2023-09-30"]);
  assert.deepEqual([...questionFullDates("2023.1.1~2023.3.31 사이")], ["2023-01-01", "2023-03-31"]);
  assert.deepEqual([...questionFullDates("HMM이 2023년 4월 GS칼텍스와 체결한 계약")], []);
  assert.deepEqual([...questionFullDates("2023-13-45 같은 날짜는 없다")], []);
  assert.deepEqual([...questionFullDates("2023-12-04 그리고 다시 2023-12-04")], ["2023-12-04"]);
  assert.deepEqual([...questionFullDates("")], []);
  assert.equal(shiftIsoDate("2023-12-31", 1), "2024-01-01");
  assert.equal(shiftIsoDate("2024-03-01", -1), "2024-02-29");
});

test("deriveReceiptWindow: exchange/major -1..+3 days, holding +30 days, periodic-only none, unknown doc_groups widest, frozen policy none", () => {
  assert.deepEqual(deriveReceiptWindow(["2023-12-04"], ["exchange"], "remediation-v1"), { from: "2023-12-03", to: "2023-12-07", question_dates: ["2023-12-04"], before_days: 1, after_days: 3 });
  assert.deepEqual(deriveReceiptWindow(["2023-10-11"], ["holding"], "remediation-v1"), { from: "2023-10-10", to: "2023-11-10", question_dates: ["2023-10-11"], before_days: 1, after_days: 30 });
  assert.equal(deriveReceiptWindow(["2023-09-30", "2025-09-30"], ["periodic"], "remediation-v1"), null);
  assert.equal(deriveReceiptWindow(["2024-06-25"], ["exchange", "periodic"], "remediation-v1").to, "2024-06-28");
  assert.equal(deriveReceiptWindow(["2024-06-25"], [], "remediation-v1").to, "2024-07-25");
  assert.equal(deriveReceiptWindow(["2024-06-25"], ["exchange"], "frozen-a-v1"), null);
  assert.equal(deriveReceiptWindow([], ["exchange"], "remediation-v1"), null);
});

test("resolvePolicy: default frozen, known ids, object override merges over frozen, unknown id throws", () => {
  assert.equal(resolvePolicy(null), FROZEN_POLICY);
  assert.equal(resolvePolicy(POLICY_IDS.REMEDIATION_V1), REMEDIATION_V1_POLICY);
  assert.equal(resolvePolicy({ id: "custom", per_doc_cap: 2 }).per_doc_cap, 2);
  assert.equal(resolvePolicy({ id: "custom", per_doc_cap: 2 }).bm25_zero_score, "KEEP");
  assert.throws(() => resolvePolicy("no-such-policy"), /unknown retrieval policy id/);
});

test("buildFilterPasses: window+subtype -> 4 ordered passes; nothing to relax -> the single base pass; frozen plan -> base only", () => {
  const filters = buildMetadataFiltersFromConditions({ corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] });
  const plan = buildRetrievalPlan({ question: "2023-12-04 공시", filters, policy: "remediation-v1" });
  const passes = buildFilterPasses(filters, plan);
  assert.deepEqual(passes.map((p) => p.label), ["window", "window_relaxed", "base", "base_relaxed"]);
  assert.equal(passes[0].filters.receipt_date_from, "2023-12-03");
  assert.deepEqual(passes[0].filters.doc_subtypes, ["단일판매공급계약체결"]);
  assert.deepEqual(passes[1].filters.doc_subtypes, []);
  assert.equal(passes[2].filters.receipt_date_from, null);
  const plain = buildMetadataFiltersFromConditions({ corp_codes: [CORP], doc_groups: ["holding"] });
  assert.deepEqual(buildFilterPasses(plain, buildRetrievalPlan({ question: "보유목적은?", filters: plain, policy: "remediation-v1" })).map((p) => p.label), ["base"]);
  assert.equal(buildRetrievalPlan({ question: "2023-12-04", filters, policy: "frozen-a-v1" }), null);
  assert.deepEqual(buildFilterPasses(filters, null).map((p) => p.label), ["base"]);
});

test("diversifyResults: a window adding no new node of an already-kept document is deferred (never dropped); per_doc_cap defers beyond the cap", () => {
  const item = (id, doc, nodes) => ({ chunk_id: id, doc_id: doc, node_index: nodes[0], provenance: { candidates: nodes.map((n) => ({ node_index: n })) } });
  const items = [item("a1", "A", [0, 1, 2]), item("a2", "A", [1, 2]), item("b1", "B", [0]), item("a3", "A", [3])];
  assert.deepEqual(ids(diversifyResults(items, { k: 3, dedupeContainedWindows: true })), ["a1", "b1", "a3"]);
  assert.deepEqual(ids(diversifyResults(items, { k: 10, dedupeContainedWindows: true })), ["a1", "b1", "a3", "a2"]);
  assert.deepEqual(ids(diversifyResults(items, { k: 3, dedupeContainedWindows: false })), ["a1", "a2", "b1"]);
  assert.deepEqual(ids(diversifyResults(items, { k: 3, perDocCap: 1 })), ["a1", "b1", "a2"]);
  assert.deepEqual(ids(diversifyResults([item("n1", "A", [])], { k: 1, dedupeContainedWindows: true })), ["n1"]);
});

// ---------- mapper ----------

test("mapper: `correction:false` is a statement about the question -- frozen maps it to a hard is_correction=false prefilter, remediation maps it to no filter; `correction:true` filters under both", () => {
  const base = { corps: ["한화에어로스페이스"], doc_groups: ["exchange"], exchange_subtypes: ["단일판매공급계약체결"], years: [2023], year_months: [[2023, 12]], correction: false };
  const frozen = mapOfficialConditionToFilterInput(base, NAME_INDEX);
  assert.equal(frozen.filters.is_correction, false);
  assert.equal(frozen.policy_id, "frozen-a-v1");
  assert.equal(frozen.plan, null);
  assert.deepEqual(mapOfficialConditionToFilterInput(base, NAME_INDEX, { policy: "frozen-a-v1", question: "2023-12-04 공시" }).filters, frozen.filters);
  const remedied = mapOfficialConditionToFilterInput(base, NAME_INDEX, { policy: "remediation-v1", question: "한화에어로스페이스의 2023-12-04 단일판매ㆍ공급계약체결 공시에서 계약금액은?" });
  assert.equal(remedied.filters.is_correction, null);
  assert.deepEqual(remedied.filters.corp_codes, [CORP]);
  assert.deepEqual(remedied.filters.doc_subtypes, ["단일판매공급계약체결"]);
  assert.equal(remedied.plan.subtype_relaxable, true);
  assert.deepEqual(remedied.plan.receipt_window, { from: "2023-12-03", to: "2023-12-07", question_dates: ["2023-12-04"], before_days: 1, after_days: 3 });
  assert.equal(mapOfficialConditionToFilterInput({ ...base, correction: true }, NAME_INDEX, { policy: "remediation-v1" }).filters.is_correction, true);
  assert.equal(mapOfficialConditionToFilterInput({ ...base, correction: true }, NAME_INDEX).filters.is_correction, true);
});

// ---------- hybrid adapter ----------

function hybridRequest(question, topK = 20, filters = buildMetadataFiltersFromConditions({})) {
  return { schema_version: "0.1.0", query_id: "q", question, corpus_snapshot_id: "s", chunking_config_id: "c", index_snapshot_id: RETRIEVAL_INDEX_ID, metadata_filters: filters, top_k: topK, retrieval_method: "HYBRID_UNION_RRF" };
}

test("hybrid: score-0 BM25 candidates earn an RRF rank credit under the frozen policy and are dropped under remediation", async () => {
  const rows = [E1A, E2A, E3A];
  const question = "영업이익은 얼마인가";   // no lexical overlap with any chunk -> every BM25 score is 0
  const build = (policy) => {
    const vectorRepository = fakeVectorRepo(rows, { chunk_e2a: 0.9 });
    return createFixedKureHybridRetrieverAdapter({
      client: fakeClient(rows), bm25Index: buildBm25Index(rows.map((r) => ({ id: r.chunk_id, text: r.text_content }))),
      vectorRepository, embeddingAdapter: fakeEmbedding(), retrievalIndexId: RETRIEVAL_INDEX_ID, ...(policy ? { policy } : {}),
    });
  };
  const frozen = await build(null).retrieve(hybridRequest(question), {});
  assert.deepEqual(new Set(frozen.results.map((r) => r.chunk_id)), new Set(["chunk_e1a", "chunk_e2a", "chunk_e3a"]));
  const remedied = await build(REMEDIATION_V1_POLICY).retrieve(hybridRequest(question), {});
  assert.deepEqual(remedied.results.map((r) => r.chunk_id), ["chunk_e2a"]);
});

test("hybrid: dense candidate count follows request.top_k when frozen and is pinned by policy.dense_candidate_k under remediation; a supplied queryVector skips the embedding call", async () => {
  const rows = [E1A, E2A, E3A];
  const make = (policy) => {
    const vectorRepository = fakeVectorRepo(rows, { chunk_e2a: 0.9 });
    const embeddingAdapter = fakeEmbedding();
    const hybrid = createFixedKureHybridRetrieverAdapter({
      client: fakeClient(rows), bm25Index: buildBm25Index(rows.map((r) => ({ id: r.chunk_id, text: r.text_content }))),
      vectorRepository, embeddingAdapter, retrievalIndexId: RETRIEVAL_INDEX_ID, ...(policy ? { policy } : {}),
    });
    return { hybrid, vectorRepository, embeddingAdapter };
  };
  const f = make(null);
  await f.hybrid.retrieve(hybridRequest("계약금액", 40), {});
  assert.equal(f.vectorRepository.calls[0].topK, 40);
  assert.equal(f.embeddingAdapter.calls, 1);
  const r = make(REMEDIATION_V1_POLICY);
  await r.hybrid.retrieve(hybridRequest("계약금액", 40), { queryVector: [0.5, 0.5, 0.5] });
  assert.equal(r.vectorRepository.calls[0].topK, 20);
  assert.equal(r.embeddingAdapter.calls, 0);
});

// ---------- arm adapter: frozen path untouched ----------

test("adapter: omitting the policy and passing the frozen policy id produce identical results; nothing is recorded by lastSearch()", async () => {
  const rows = [E1A, E1B, E2A, E3A, I1A];
  const question = "단일판매 공급계약 계약금액";
  const plain = makeArm("A", rows, { similarity: { chunk_e3a: 0.9, chunk_e2a: 0.8 } });
  const frozen = makeArm("A", rows, { policy: "frozen-a-v1", similarity: { chunk_e3a: 0.9, chunk_e2a: 0.8 } });
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"] };
  const a = await plain.adapter.search(question, conditions, 20);
  const b = await frozen.adapter.search(question, conditions, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(plain.adapter.policy_id, "frozen-a-v1");
  assert.equal(plain.adapter.lastSearch(), null);
  assert.equal(frozen.adapter.lastSearch(), null);
  assert.equal(Object.hasOwn(a[0], "retrieval_pass"), false);
});

// ---------- arm adapter: remediation passes ----------

test("adapter: an extracted doc_subtype that is wrong for the real filing yields 0 results when frozen and is relaxed into a second pass under remediation", async () => {
  const rows = [E1A, E2A, E3A, I1A];
  const question = "마일스톤 기술료 수령 계약상대방은 누구인가";
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] };
  const frozen = makeArm("A", rows, { similarity: { chunk_i1a: 0.95 } });
  const frozenResults = await frozen.adapter.search(question, conditions, 20);
  assert.equal(ids(frozenResults).includes("chunk_i1a"), false);
  const remedied = makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity: { chunk_i1a: 0.95 } });
  const results = await remedied.adapter.search(question, conditions, 20);
  assert.equal(results[0].chunk_id, "chunk_i1a");
  assert.equal(results[0].retrieval_pass, "base_relaxed");
  assert.equal(results[0].rank, 1);
  const last = remedied.adapter.lastSearch();
  assert.equal(last.policy_id, "remediation-v1");
  assert.deepEqual(last.passes.map((p) => p.label), ["base", "base_relaxed"]);
  assert.equal(last.passes[0].returned, 0);
  assert.equal(remedied.embeddingAdapter.calls, 1);   // embedded once across both passes
});

test("adapter: a full date in the question binds a receipt-date window pass first; later passes only fill behind it", async () => {
  // A later filing that BOTH legs prefer (extra lexical overlap on 계약상대방 + top dense similarity).
  const E3X = makeRow({ id: "chunk_e3x", doc: "exchange_20250124800528", receipt: "2025-01-24", nodes: [0, 1, 2], text: "단일판매 공급계약 체결 계약금액 300 계약상대방 병" });
  const rows = [E1A, E1B, E2A, E3X];
  const question = "한화에어로스페이스의 2023-12-04 단일판매ㆍ공급계약체결 공시에서 계약상대방, 계약금액, 계약기간은?";
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] };
  const similarity = { chunk_e3x: 0.9, chunk_e2a: 0.8, chunk_e1a: 0.2, chunk_e1b: 0.1 };
  const frozen = await makeArm("A", rows, { similarity }).adapter.search(question, conditions, 20);
  assert.equal(frozen[0].doc_id, "exchange_20250124800528");     // the other-date filing both legs prefer wins when frozen
  const remedied = makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity });
  const results = await remedied.adapter.search(question, conditions, 20);
  assert.deepEqual(results.slice(0, 2).map((r) => r.doc_id), ["exchange_20231204800003", "exchange_20231204800003"]);
  assert.deepEqual(results.slice(0, 2).map((r) => r.retrieval_pass), ["window", "window"]);
  assert.deepEqual(ids(results).slice(2), ["chunk_e3x", "chunk_e2a"]);
  assert.deepEqual(results.map((r) => r.rank), [1, 2, 3, 4]);
  const last = remedied.adapter.lastSearch();
  assert.equal(last.passes[0].label, "window");
  assert.equal(last.passes[0].returned, 2);
  assert.deepEqual(last.plan.receipt_window.question_dates, ["2023-12-04"]);
});

test("adapter + mapper end to end: a `correction:false` condition excludes the 정정 filing when frozen and keeps it under remediation", async () => {
  const rows = [E1A, X1A, E2A];
  const conditions = { corps: ["한화에어로스페이스"], doc_groups: ["exchange"], exchange_subtypes: ["단일판매공급계약체결"], years: [2023], correction: false };
  const question = "한화에어로스페이스의 2023-12-04 단일판매 공급계약 계약금액은?";
  const frozenMapped = mapOfficialConditionToFilterInput(conditions, NAME_INDEX);
  const frozen = await makeArm("A", rows, { similarity: { chunk_x1a: 0.9, chunk_e1a: 0.8 } }).adapter.search(question, frozenMapped.filters, 20);
  assert.equal(ids(frozen).includes("chunk_x1a"), false);
  const mapped = mapOfficialConditionToFilterInput(conditions, NAME_INDEX, { policy: "remediation-v1", question });
  const remedied = makeArm("A", rows, { policy: "remediation-v1", similarity: { chunk_x1a: 0.9, chunk_e1a: 0.8 } });
  const results = await remedied.adapter.search(question, mapped.filters, 20, { plan: mapped.plan });
  assert.equal(ids(results).includes("chunk_x1a"), true);
  assert.equal(ids(results).includes("chunk_e1a"), true);
  assert.equal(ids(results).includes("chunk_o1a"), false);
});

test("adapter: corp/doc_group filters are never relaxed -- another company's same-day filing stays out of every pass", async () => {
  const rows = [E1A, O1A];
  const question = "2023-12-04 단일판매 공급계약 계약금액";
  const remedied = makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity: { chunk_o1a: 0.99, chunk_e1a: 0.5 } });
  const results = await remedied.adapter.search(question, { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["없는서식"] }, 20);
  assert.deepEqual(ids(results), ["chunk_e1a"]);
  assert.equal(remedied.adapter.lastSearch().passes.every((p) => p.label !== "base" || p.returned === 0), true);
});

test("adapter: under remediation the k=10 answer is the prefix of the k=20 answer (dense candidates and the fusion pool no longer follow k)", async () => {
  const rows = [E1A, E1B, E2A, E3A, I1A, X1A];
  const question = "단일판매 공급계약 계약금액";
  const similarity = { chunk_e3a: 0.9, chunk_e2a: 0.8, chunk_x1a: 0.7, chunk_e1a: 0.6 };
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"] };
  const ten = await makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity }).adapter.search(question, conditions, 10);
  const twenty = await makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity }).adapter.search(question, conditions, 20);
  assert.deepEqual(ids(ten), ids(twenty).slice(0, ten.length));
  const three = await makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity }).adapter.search(question, conditions, 3);
  assert.deepEqual(ids(three), ids(twenty).slice(0, 3));
});

test("adapter: contained windows of an already-represented document are deferred behind other documents", async () => {
  const inner = makeRow({ id: "chunk_e1c", doc: "exchange_20231204800003", receipt: "2023-12-04", nodes: [1, 2], text: "단일판매 공급계약 체결 계약금액 100 계약상대 갑 재확인" });
  const rows = [E1A, inner, E2A];
  const question = "단일판매 공급계약 계약금액";
  const similarity = { chunk_e1a: 0.9, chunk_e1c: 0.85, chunk_e2a: 0.5 };
  const results = await makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity }).adapter.search(question, { corp_codes: [CORP] }, 20);
  assert.deepEqual(ids(results), ["chunk_e1a", "chunk_e2a", "chunk_e1c"]);
  const frozen = await makeArm("A", rows, { similarity }).adapter.search(question, { corp_codes: [CORP] }, 20);
  assert.deepEqual(ids(frozen), ["chunk_e1a", "chunk_e1c", "chunk_e2a"]);
});

test("arm C: the remediation passes work on the BM25-only leg and the structural dense-off guarantee is unchanged", async () => {
  const rows = [E1A, E2A, I1A];
  const c = makeArm("C", rows, { policy: REMEDIATION_V1_POLICY });
  const results = await c.adapter.search("마일스톤 기술료 수령", { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] }, 20);
  assert.equal(results[0].chunk_id, "chunk_i1a");
  assert.equal(results[0].retrieval_pass, "base_relaxed");
  assert.equal(results[0].score_type, "BM25");
  assert.throws(() => createArmRetrieverAdapter({
    arm: "C", client: fakeClient(rows), bm25Index: buildBm25Index([]), retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
    vectorRepository: fakeVectorRepo(rows), policy: REMEDIATION_V1_POLICY,
  }), /must not be constructed with a vectorRepository/);
});
