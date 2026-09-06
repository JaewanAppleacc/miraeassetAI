// Turn A-RETRIEVAL-REMEDIATION-V1 (+ review round 1): offline tests for the
// opt-in retrieval policy (four-arm-retrieval-policy.mjs) and its wiring
// into the conditions mapper, the hybrid adapter and the arm A/C adapter.
// Synthetic fixtures only -- a fake Postgres client that actually EVALUATES
// the prefilter WHERE clause (the four-arm-fixed-ac fixtures treat every
// chunk as eligible, which cannot exercise a filter), a fake dense
// repository that applies the shared passesMetadataFilters, and a call-
// counting fake embedding adapter. No DB, no KURE, no Gold/DEV_TUNE/
// DEV_CHECK/HOLDOUT.
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
  FROZEN_POLICY, REMEDIATION_V1_POLICY, POLICY_IDS, resolvePolicy, questionFullDates, shiftIsoDate, daysBetween,
  deriveReceiptWindows, buildRetrievalPlan, buildFilterPasses, orderCandidates, interleaveRelaxed, promoteRelaxed, partnerPassOf, rankCandidates,
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
const WINDOW = (from, to, dates, after) => ({ from, to, question_dates: dates, before_days: 1, after_days: after });

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
  assert.equal(daysBetween("2023-12-04", "2024-01-03"), 30);
});

test("deriveReceiptWindows: exchange/major -1..+3 days, holding +30, periodic-only none, unknown doc_groups widest, frozen none", () => {
  assert.deepEqual(deriveReceiptWindows(["2023-12-04"], ["exchange"], "remediation-v1"), [WINDOW("2023-12-03", "2023-12-07", ["2023-12-04"], 3)]);
  assert.deepEqual(deriveReceiptWindows(["2023-10-11"], ["holding"], "remediation-v1"), [WINDOW("2023-10-10", "2023-11-10", ["2023-10-11"], 30)]);
  assert.deepEqual(deriveReceiptWindows(["2023-09-30", "2025-09-30"], ["periodic"], "remediation-v1"), []);
  assert.equal(deriveReceiptWindows(["2024-06-25"], ["exchange", "periodic"], "remediation-v1")[0].to, "2024-06-28");
  assert.equal(deriveReceiptWindows(["2024-06-25"], [], "remediation-v1")[0].to, "2024-07-25");
  assert.deepEqual(deriveReceiptWindows(["2024-06-25"], ["exchange"], "frozen-a-v1"), []);
  assert.deepEqual(deriveReceiptWindows([], ["exchange"], "remediation-v1"), []);
});

test("deriveReceiptWindows: one narrow window PER date -- distant dates never become one wide range; overlapping windows merge; capped at max_receipt_windows", () => {
  assert.deepEqual(deriveReceiptWindows(["2025-01-01", "2023-01-01"], ["exchange"], "remediation-v1"), [
    WINDOW("2022-12-31", "2023-01-04", ["2023-01-01"], 3),
    WINDOW("2024-12-31", "2025-01-04", ["2025-01-01"], 3),
  ]);
  assert.deepEqual(deriveReceiptWindows(["2024-06-25", "2024-06-27"], ["exchange"], "remediation-v1"), [WINDOW("2024-06-24", "2024-06-30", ["2024-06-25", "2024-06-27"], 3)]);
  assert.deepEqual(deriveReceiptWindows(["2024-06-25", "2024-06-29"], ["exchange"], "remediation-v1"), [WINDOW("2024-06-24", "2024-07-02", ["2024-06-25", "2024-06-29"], 3)]);   // gap 4 = before+after -> touch -> merge
  assert.equal(deriveReceiptWindows(["2024-06-25", "2024-06-30"], ["exchange"], "remediation-v1").length, 2);                                                                // gap 5 -> separate
  const five = ["2023-01-01", "2023-06-01", "2024-01-01", "2024-06-01", "2025-01-01"];
  assert.deepEqual(deriveReceiptWindows(five, ["exchange"], "remediation-v1").map((w) => w.question_dates[0]), ["2023-01-01", "2023-06-01", "2024-01-01"]);
});

test("resolvePolicy: default frozen, known ids, object override merges over frozen, unknown id throws; remediation defaults are what the handoff says", () => {
  assert.equal(resolvePolicy(null), FROZEN_POLICY);
  assert.equal(resolvePolicy(POLICY_IDS.REMEDIATION_V1), REMEDIATION_V1_POLICY);
  assert.equal(resolvePolicy({ id: "custom", per_doc_cap: 2 }).per_doc_cap, 2);
  assert.equal(resolvePolicy({ id: "custom", per_doc_cap: 2 }).bm25_zero_score, "KEEP");
  assert.throws(() => resolvePolicy("no-such-policy"), /unknown retrieval policy id/);
  assert.equal(REMEDIATION_V1_POLICY.dedupe_contained_windows, false);
  assert.equal(REMEDIATION_V1_POLICY.per_doc_cap, 0);
  assert.equal(REMEDIATION_V1_POLICY.fusion_pool_k, 40);
  assert.equal(REMEDIATION_V1_POLICY.dense_candidate_k, 20);
  assert.equal(REMEDIATION_V1_POLICY.relaxed_interleave_every, 0);   // review round 2: fixed-stride insertion is off
  assert.equal(REMEDIATION_V1_POLICY.relaxed_promote_top, 5);
  assert.equal(FROZEN_POLICY.relaxed_promote_top, 0);
});

test("buildFilterPasses: two windows + subtype -> window, window:2, window_relaxed, window_relaxed:2, base, base_relaxed with groups; nothing to relax -> base only; frozen -> base", () => {
  const filters = buildMetadataFiltersFromConditions({ corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] });
  const plan = buildRetrievalPlan({ question: "2023-01-01 공시와 2025-01-01 공시 비교", filters, policy: "remediation-v1" });
  const passes = buildFilterPasses(filters, plan);
  assert.deepEqual(passes.map((p) => [p.label, p.group]), [
    ["window", "primary"], ["window:2", "primary"], ["window_relaxed", "relaxed"], ["window_relaxed:2", "relaxed"], ["base", "primary"], ["base_relaxed", "relaxed"],
  ]);
  assert.equal(passes[0].filters.receipt_date_from, "2022-12-31");
  assert.equal(passes[1].filters.receipt_date_from, "2024-12-31");
  assert.deepEqual(passes[0].filters.doc_subtypes, ["단일판매공급계약체결"]);
  assert.deepEqual(passes[2].filters.doc_subtypes, []);
  assert.equal(passes[4].filters.receipt_date_from, null);
  const plain = buildMetadataFiltersFromConditions({ corp_codes: [CORP], doc_groups: ["holding"] });
  assert.deepEqual(buildFilterPasses(plain, buildRetrievalPlan({ question: "보유목적은?", filters: plain, policy: "remediation-v1" })).map((p) => p.label), ["base"]);
  assert.equal(buildRetrievalPlan({ question: "2023-12-04", filters, policy: "frozen-a-v1" }), null);
  assert.deepEqual(buildFilterPasses(filters, null).map((p) => [p.label, p.group]), [["base", "primary"]]);
});

test("orderCandidates: containment is decided by VERIFIED text only -- different rows of the same table node are never 'contained'; unverifiable text never defers", () => {
  const item = (id, doc, nodes) => ({ chunk_id: id, doc_id: doc, node_index: nodes[0], provenance: { candidates: nodes.map((n) => ({ node_index: n })) } });
  const texts = { r0: "행0 행1 행2 행3 | 매출액 1 2 3", r100: "행100 행101 행102 행103 | 영업이익 4 5 6", c: "다른 문서", dup: "행1 행2", far: "행0 행1 행2 행3 | 매출액 1 2 3" };
  const textOf = (id) => texts[id];
  // reviewer's reproduction: same document, same node, rows 0-3 vs rows 100-103, then another document
  const rows = [item("r0", "T", [5]), item("r100", "T", [5]), item("c", "U", [0])];
  assert.deepEqual(ids(orderCandidates(rows, { dedupeContainedWindows: true, textOf })), ["r0", "r100", "c"]);
  assert.deepEqual(ids(orderCandidates(rows, { dedupeContainedWindows: true, textOf }).slice(0, 2)), ["r0", "r100"]);
  // a window whose whole text sits inside an already-kept chunk of the same document IS deferred
  assert.deepEqual(ids(orderCandidates([item("r0", "T", [5]), item("dup", "T", [5]), item("c", "U", [0])], { dedupeContainedWindows: true, textOf })), ["r0", "c", "dup"]);
  // identical text in a DIFFERENT document is not a duplicate of this document's evidence
  assert.deepEqual(ids(orderCandidates([item("r0", "T", [5]), item("far", "V", [5])], { dedupeContainedWindows: true, textOf })), ["r0", "far"]);
  // no text available -> nothing is provably contained -> nothing deferred
  assert.deepEqual(ids(orderCandidates([item("r0", "T", [5]), item("dup", "T", [5])], { dedupeContainedWindows: true, textOf: () => undefined })), ["r0", "dup"]);
  assert.deepEqual(ids(orderCandidates([item("r0", "T", [5]), item("dup", "T", [5])], { dedupeContainedWindows: false, textOf })), ["r0", "dup"]);
  // per-document cap defers beyond the cap, never discards
  assert.deepEqual(ids(orderCandidates(rows, { perDocCap: 1 })), ["r0", "c", "r100"]);
});

test("interleaveRelaxed: every 4th rank goes to the next relaxed candidate; the ranking is one list for every k (prefix property)", () => {
  const p = (n) => ({ chunk_id: `p${n}`, g: "primary" });
  const r = (n) => ({ chunk_id: `r${n}`, g: "relaxed" });
  const isRelaxed = (x) => x.g === "relaxed";
  const ordered = [p(1), p(2), p(3), p(4), p(5), p(6), p(7), p(8), r(1), r(2), r(3)];
  const full = ids(interleaveRelaxed(ordered, { every: 4, isRelaxed }));
  assert.deepEqual(full, ["p1", "p2", "p3", "r1", "p4", "p5", "p6", "r2", "p7", "p8", "r3"]);
  for (const k of [1, 3, 4, 7, 10]) assert.deepEqual(full.slice(0, k), ids(interleaveRelaxed(ordered, { every: 4, isRelaxed })).slice(0, k));
  assert.deepEqual(ids(interleaveRelaxed(ordered, { every: 0, isRelaxed })), ids(ordered));
  assert.deepEqual(ids(interleaveRelaxed([r(1), r(2)], { every: 4, isRelaxed })), ["r1", "r2"]);
  assert.deepEqual(ids(interleaveRelaxed([p(1), p(2)], { every: 4, isRelaxed })), ["p1", "p2"]);
  assert.deepEqual(ids(rankCandidates(ordered, { interleaveEvery: 4, isRelaxed })), full);
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
  assert.deepEqual(remedied.plan.receipt_windows, [WINDOW("2023-12-03", "2023-12-07", ["2023-12-04"], 3)]);
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

test("adapter: an extracted doc_subtype that is wrong for the real filing yields 0 results when frozen; under remediation the relaxed pass finds it", async () => {
  const rows = [E1A, E2A, E3A, I1A];
  const question = "마일스톤 기술료 수령 계약상대방은 누구인가";
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] };
  const frozen = makeArm("A", rows, { similarity: { chunk_i1a: 0.95 } });
  assert.equal(ids(await frozen.adapter.search(question, conditions, 20)).includes("chunk_i1a"), false);
  const remedied = makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity: { chunk_i1a: 0.95 } });
  const results = await remedied.adapter.search(question, conditions, 20);
  assert.equal(results[0].chunk_id, "chunk_i1a");
  assert.equal(results[0].retrieval_pass, "base_relaxed");
  assert.equal(results[0].retrieval_group, "relaxed");
  assert.equal(results[0].rank, 1);
  const last = remedied.adapter.lastSearch();
  assert.equal(last.policy_id, "remediation-v1");
  assert.equal(last.pool, 40);
  assert.deepEqual(last.passes.map((p) => [p.label, p.group, p.skipped, p.returned]), [["base", "primary", false, 0], ["base_relaxed", "relaxed", false, 1]]);
  assert.equal(remedied.embeddingAdapter.calls, 1);   // embedded once across both passes
});

test("adapter: a wrong extracted subtype that FILLS the pool no longer hides the right filing -- the relaxed pass always runs and its best candidate is promoted by evidence", async () => {
  const wrong = Array.from({ length: 40 }, (_, i) => makeRow({
    id: `chunk_w${String(i).padStart(2, "0")}`, doc: `exchange_2024010${String(i).padStart(2, "0")}00`, receipt: "2024-01-05", nodes: [0],
    text: `마일스톤 안내 문서 ${i} 단일판매 공급계약`,
  }));
  const target = I1A;
  const rows = [...wrong, target];
  const similarity = Object.fromEntries([...wrong.map((r) => [r.chunk_id, 0.5]), [target.chunk_id, 0.99]]);
  const question = "마일스톤 기술료 수령 계약상대방은 누구인가";
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] };
  const frozen = await makeArm("A", rows, { similarity }).adapter.search(question, conditions, 20);
  assert.equal(ids(frozen).includes(target.chunk_id), false);
  const remedied = makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity });
  const results = await remedied.adapter.search(question, conditions, 20);
  const last = remedied.adapter.lastSearch();
  assert.equal(last.passes[0].label, "base");
  assert.equal(last.passes[0].returned, 40);                 // the wrong subtype saturates the primary pool ...
  assert.equal(last.passes[1].label, "base_relaxed");
  assert.equal(last.passes[1].skipped, false);              // ... and the relaxed pass still runs
  assert.equal(results[0].chunk_id, target.chunk_id);        // rank 1 in base_relaxed (the superset) beats every primary item there -> promoted to the top
  assert.equal(results[0].retrieval_group, "relaxed");
  assert.equal(results.length, 20);
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
  assert.deepEqual(last.passes.map((p) => p.label), ["window", "window_relaxed", "base", "base_relaxed"]);
  assert.equal(last.passes[0].returned, 2);
  assert.deepEqual(last.plan.receipt_windows[0].question_dates, ["2023-12-04"]);
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
});

test("adapter: the k-prefix property holds on the reviewer's fixture (window returns 12 chunks of one document, base adds 15 other documents) -- with and without dedupe/cap", async () => {
  const same = Array.from({ length: 12 }, (_, i) => makeRow({
    id: `chunk_s${String(i).padStart(2, "0")}`, doc: "exchange_20231204800003", receipt: "2023-12-04", nodes: [i], text: `계약 조항 ${i} 계약금액 안내 단일판매 공급계약`,
  }));
  const others = Array.from({ length: 15 }, (_, i) => makeRow({
    id: `chunk_o${String(i).padStart(2, "0")}`, doc: `exchange_2024030${String(i).padStart(2, "0")}00`, receipt: "2024-03-05", nodes: [0], text: `다른 계약 ${i} 계약금액 단일판매 공급계약`,
  }));
  const rows = [...same, ...others];
  const similarity = Object.fromEntries(rows.map((r, i) => [r.chunk_id, 0.9 - i * 0.01]));
  const question = "한화에어로스페이스의 2023-12-04 단일판매 공급계약 계약금액은?";
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] };
  for (const policy of [REMEDIATION_V1_POLICY, { ...REMEDIATION_V1_POLICY, id: "remediation-v1+dedupe+cap", dedupe_contained_windows: true, per_doc_cap: 3 }]) {
    const run = (k) => makeArm("A", rows, { policy, similarity }).adapter.search(question, conditions, k);
    const [three, ten, twenty, forty] = await Promise.all([run(3), run(10), run(20), run(40)]);
    assert.equal(twenty.length, 20);
    assert.deepEqual(ids(ten), ids(twenty).slice(0, 10), policy.id);
    assert.deepEqual(ids(three), ids(twenty).slice(0, 3), policy.id);
    assert.deepEqual(ids(twenty), ids(forty).slice(0, 20), policy.id);
    const remedied = makeArm("A", rows, { policy, similarity });
    await remedied.adapter.search(question, conditions, 10);
    assert.equal(remedied.adapter.lastSearch().passes[0].returned, 12);      // the window pass alone does not end collection
    assert.equal(remedied.adapter.lastSearch().passes.find((p) => p.label === "base").skipped, false);
  }
  await assert.rejects(() => makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity }).adapter.search(question, conditions, 41), /exceeds the policy's fixed candidate pool/);
});

test("adapter: verified-text dedupe is OFF by default; when enabled it defers only a chunk whose text is inside an already-kept chunk of the same document -- never different rows of one table", async () => {
  const R0 = makeRow({ id: "chunk_r0", doc: "periodic_20240320000001", group: "periodic", subtype: "annual", receipt: "2024-03-20", nodes: [5], text: "매출액 | 100 | 110 | 120 재무제표 표 앞부분" });
  const R100 = makeRow({ id: "chunk_r100", doc: "periodic_20240320000001", group: "periodic", subtype: "annual", receipt: "2024-03-20", nodes: [5], text: "영업이익 | 7 | 8 | 9 재무제표 표 뒷부분" });
  // same document, same node, text entirely inside R0's text -> the only genuinely contained window
  const DUP = makeRow({ id: "chunk_rdup", doc: "periodic_20240320000001", group: "periodic", subtype: "annual", receipt: "2024-03-20", nodes: [5], text: "매출액 | 100 | 110 | 120 재무제표" });
  const C = makeRow({ id: "chunk_c", doc: "periodic_20250320000002", group: "periodic", subtype: "annual", receipt: "2025-03-20", nodes: [0], text: "매출액 | 300 재무제표" });
  const rows = [R0, R100, DUP, C];
  const similarity = { chunk_r0: 0.95, chunk_rdup: 0.9, chunk_r100: 0.85, chunk_c: 0.7 };
  const question = "재무제표 매출액";
  const conditions = { corp_codes: [CORP], doc_groups: ["periodic"] };
  const off = ids(await makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity }).adapter.search(question, conditions, 20));
  assert.equal(off.length, 4);
  assert.deepEqual(off.slice(0, 2), ["chunk_r0", "chunk_rdup"]);          // default: nothing deferred, the contained window keeps its fused rank
  const dedupe = { ...REMEDIATION_V1_POLICY, id: "remediation-v1+dedupe", dedupe_contained_windows: true };
  const on = ids(await makeArm("A", rows, { policy: dedupe, similarity }).adapter.search(question, conditions, 20));
  assert.deepEqual(on, [...off.filter((id) => id !== "chunk_rdup"), "chunk_rdup"]);   // only the contained window moves, to the tail; rows 100-103 keep their place
  const two = ids(await makeArm("A", rows, { policy: dedupe, similarity }).adapter.search(question, conditions, 2));
  assert.deepEqual(two, on.slice(0, 2));
  assert.equal(two.includes("chunk_rdup"), false);
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

// ---------- review round 2 ----------

test("promoteRelaxed: a relaxed-only candidate moves up only by evidence -- within the top N of its own relaxed pass and only past partner-pass items it outranks there; weak ones stay behind every primary item", () => {
  const P = (id, pass) => ({ chunk_id: id, g: "primary", pass });
  const R = (id, pass) => ({ chunk_id: id, g: "relaxed", pass });
  const isRelaxed = (x) => x.g === "relaxed";
  const passOf = (x) => x.pass;
  const primaryOrder = ["window", "base"];
  assert.equal(partnerPassOf("window_relaxed:2"), "window:2");
  assert.equal(partnerPassOf("base_relaxed"), "base");
  assert.equal(partnerPassOf("window"), null);
  // ranks in the relaxed passes (the superset rankings)
  const ranks = {
    base_relaxed: { p1: 1, p2: 2, p3: 4, weak: 30, strong: 3, top: 1 },
    window_relaxed: { w1: 2, w2: 3, wr: 1 },
  };
  const rankIn = (x, label) => ranks[label]?.[x.chunk_id] ?? Infinity;
  // reviewer's case: correct subtype, strong primary items, a very weak off-subtype relaxed candidate -> stays behind
  const weak = promoteRelaxed([P("p1", "base"), P("p2", "base"), P("p3", "base"), R("weak", "base_relaxed")], { top: 5, rankIn, passOf, primaryOrder, isRelaxed });
  assert.deepEqual(ids(weak), ["p1", "p2", "p3", "weak"]);
  // a relaxed candidate ranked 3rd in base_relaxed goes before the first base item ranked worse there (p3 at 4), never before p1/p2
  const strong = promoteRelaxed([P("p1", "base"), P("p2", "base"), P("p3", "base"), R("strong", "base_relaxed")], { top: 5, rankIn, passOf, primaryOrder, isRelaxed });
  assert.deepEqual(ids(strong), ["p1", "p2", "strong", "p3"]);
  // a base_relaxed candidate can never move above window-block items, however strong (ranks are per pass: one item per rank)
  const blockRanks = { base_relaxed: { p1: 2, top: 1 }, window_relaxed: { w1: 2, w2: 3, wr: 1 } };
  const rankInBlocks = (x, label) => blockRanks[label]?.[x.chunk_id] ?? Infinity;
  const blocks = promoteRelaxed([P("w1", "window"), P("w2", "window"), P("p1", "base"), R("top", "base_relaxed"), R("wr", "window_relaxed")], { top: 5, rankIn: rankInBlocks, passOf, primaryOrder, isRelaxed });
  assert.deepEqual(ids(blocks), ["wr", "w1", "w2", "top", "p1"]);
  // a primary item the relaxed pass did not return at all (Infinity) ranks worse than any promotable candidate
  const missing = promoteRelaxed([P("px", "base"), R("strong", "base_relaxed")], { top: 5, rankIn, passOf, primaryOrder, isRelaxed });
  assert.deepEqual(ids(missing), ["strong", "px"]);
  // empty partner block: the candidate fills the block's position (before lower-priority blocks)
  const empty = promoteRelaxed([P("p1", "base"), R("wr", "window_relaxed")], { top: 5, rankIn, passOf, primaryOrder, isRelaxed });
  assert.deepEqual(ids(empty), ["wr", "p1"]);
  // off
  assert.deepEqual(ids(promoteRelaxed([P("p1", "base"), R("top", "base_relaxed")], { top: 0, rankIn, passOf, primaryOrder, isRelaxed })), ["p1", "top"]);
});

test("adapter: with a CORRECT extracted subtype, a weak off-subtype relaxed candidate never enters the top-10; a genuinely stronger one is promoted by its own rank, not by a fixed slot", async () => {
  const strong = Array.from({ length: 10 }, (_, i) => makeRow({
    id: `chunk_p${String(i).padStart(2, "0")}`, doc: `exchange_2024020${String(i).padStart(2, "0")}00`, receipt: "2024-02-05", nodes: [0],
    text: `단일판매 공급계약 체결 계약금액 ${100 + i} 계약상대 갑`,
  }));
  const weak = makeRow({ id: "chunk_weak", doc: "exchange_20240301900001", receipt: "2024-03-01", nodes: [0], subtype: "투자판단관련주요경영사항", text: "임상시험 계획 승인 안내" });
  const question = "단일판매 공급계약 계약금액은?";
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] };
  const similarity = Object.fromEntries([...strong.map((r, i) => [r.chunk_id, 0.9 - i * 0.01]), ["chunk_weak", 0.01]]);
  const remedied = makeArm("A", [...strong, weak], { policy: REMEDIATION_V1_POLICY, similarity });
  const results = await remedied.adapter.search(question, conditions, 20);
  assert.deepEqual(ids(results).slice(0, 10), strong.map((r) => r.chunk_id));   // the 10 correct-subtype chunks keep the whole top-10
  assert.equal(results[10].chunk_id, "chunk_weak");                              // the weak off-subtype candidate is last
  assert.equal(remedied.adapter.lastSearch().passes.find((p) => p.label === "base_relaxed").skipped, false);
  // the same off-subtype filing, now the best match on both legs -> promoted to rank 1 by its base_relaxed rank, not by a slot
  const best = makeRow({ id: "chunk_weak", doc: "exchange_20240301900001", receipt: "2024-03-01", nodes: [0], subtype: "투자판단관련주요경영사항", text: "단일판매 공급계약 체결 계약금액 999 계약상대 갑 계약금액 공급계약" });
  const promoted = await makeArm("A", [...strong, best], { policy: REMEDIATION_V1_POLICY, similarity: { ...similarity, chunk_weak: 0.99 } }).adapter.search(question, conditions, 20);
  assert.equal(promoted[0].chunk_id, "chunk_weak");
  assert.equal(promoted[0].retrieval_group, "relaxed");
  assert.deepEqual(ids(promoted).slice(1, 11), strong.map((r) => r.chunk_id));
});

test("adapter: every receipt-date window runs and windows merge round-robin -- a first date whose filing fills the pool cannot crowd the second date's filing out", async () => {
  const first = Array.from({ length: 45 }, (_, i) => makeRow({
    id: `chunk_a${String(i).padStart(2, "0")}`, doc: "exchange_20230105800001", receipt: "2023-01-05", nodes: [i],
    text: `계약 조항 ${i} 계약금액 단일판매 공급계약`,
  }));
  const second = [
    makeRow({ id: "chunk_b00", doc: "exchange_20250105800002", receipt: "2025-01-05", nodes: [0], text: "계약금액 500 단일판매 공급계약 계약상대 을" }),
    makeRow({ id: "chunk_b01", doc: "exchange_20250105800002", receipt: "2025-01-05", nodes: [1], text: "계약기간 2025 단일판매 공급계약 종료일" }),
  ];
  const rows = [...first, ...second];
  const similarity = Object.fromEntries(rows.map((r, i) => [r.chunk_id, 0.9 - i * 0.005]));
  const question = "한화에어로스페이스의 2023-01-05 공시와 2025-01-05 공시 계약금액 비교";
  const conditions = { corp_codes: [CORP], doc_groups: ["exchange"], doc_subtypes: ["단일판매공급계약체결"] };
  const remedied = makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity });
  const results = await remedied.adapter.search(question, conditions, 20);
  const last = remedied.adapter.lastSearch();
  assert.deepEqual(last.plan.receipt_windows.map((w) => w.question_dates[0]), ["2023-01-05", "2025-01-05"]);
  const w1 = last.passes.find((p) => p.label === "window");
  const w2 = last.passes.find((p) => p.label === "window:2");
  assert.equal(w1.returned, 40);                                   // the first date's filing alone fills the pool ...
  assert.deepEqual([w2.skipped, w2.returned, w2.added], [false, 2, 2]);   // ... yet the second window still runs and both of its chunks are admitted
  assert.deepEqual([results[1].chunk_id, results[3].chunk_id], ["chunk_b00", "chunk_b01"]);   // round-robin: 2nd and 4th
  assert.equal(results[0].doc_id, "exchange_20230105800001");
  assert.equal(last.passes.find((p) => p.label === "base").skipped, true);   // primary pool full after the windows
  assert.equal(last.passes.find((p) => p.label === "base_relaxed").skipped, false);
  const ten = await makeArm("A", rows, { policy: REMEDIATION_V1_POLICY, similarity }).adapter.search(question, conditions, 10);
  assert.deepEqual(ids(ten), ids(results).slice(0, 10));
});
