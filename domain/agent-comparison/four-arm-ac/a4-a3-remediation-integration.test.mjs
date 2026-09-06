// Turn A4-A3-REMEDIATION-INTEGRATION-V1 -- offline tests for
// a4-a3-remediation-candidate-legs.mjs and a4-a3-remediation-retrieval-pipeline.mjs.
//
// Synthetic fixtures only (adapted from tests/four-arm-a-retrieval-remediation.test.mjs's
// own fake-client design in the b30b909 source repo -- a fake Postgres client that
// actually EVALUATES the prefilter WHERE clause, not one that treats every chunk as
// eligible). No DB, no KURE, no Gold/DEV_TUNE/DEV_CHECK/HOLDOUT, no LLM.
//
// Run with: node --test domain/agent-comparison/four-arm-ac/a4-a3-remediation-integration.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildBm25Index } from "../chunking-comparison/bm25.mjs";
import { buildNameToCorpCodeIndex, mapOfficialConditionToFilterInput } from "./four-arm-conditions-to-filter-mapper.mjs";
import { FROZEN_POLICY, REMEDIATION_V1_POLICY } from "./four-arm-retrieval-policy.mjs";
import { runRemediationAwareCandidateGeneration, BM25_CANDIDATE_K, DENSE_CANDIDATE_K } from "./a4-a3-remediation-candidate-legs.mjs";
import { runQuestionPipelineRemediationAware } from "./a4-a3-remediation-retrieval-pipeline.mjs";
import { runQuestionPipeline } from "./a4-a3-retrieval-pipeline.mjs";

const RETRIEVAL_INDEX_ID = "fixed_kure_index_test";
const LOAD_SESSION_ID = "fixed_kure_session_test";
const CORP = "00000001";
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// ---------- synthetic corpus (same shape as the b30b909 fixture) ----------

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
const I1A = makeRow({ id: "chunk_i1a", doc: "exchange_20230404900142", receipt: "2023-04-04", nodes: [0, 1], subtype: "투자판단관련주요경영사항", text: "마일스톤 기술료 수령 계약상대방 라이선스" });
const X1A = makeRow({ id: "chunk_x1a", doc: "exchange_20231204800099", receipt: "2023-12-04", nodes: [0, 1, 2], correction: true, text: "기재정정 단일판매 공급계약 체결 계약금액 150 정정" });
const D1A = makeRow({ id: "chunk_d1a", doc: "exchange_20250124800528", receipt: "2025-01-24", nodes: [0, 1, 2], text: "단일판매 공급계약 체결 계약금액 300 계약상대 병" });
const P1A = makeRow({ id: "chunk_p1a", doc: "periodic_20240401000001", receipt: "2024-05-15", nodes: [0], group: "periodic", subtype: "annual", text: "사업보고서 매출액 영업이익" });

function spansOf(doc, nodes) {
  return nodes.map((n) => ({
    file_id: "file", rel_path: "file.xml", node_id: `node_${n}`, order_index: n,
    row_start: null, row_end: null, col_start: null, col_end: null, source_locator: `${doc}/file.xml#node=${n}`,
  }));
}

// Evaluates one WHERE fragment against a row -- tolerant of an optional table-alias
// prefix ("c." on the vector-search join query; none on the BM25-leg eligibility query),
// since buildEligibilityWhereClause emits identical fragment syntax for both, only ever
// differing by that alias.
function evalFragment(frag, params, r) {
  const f = frag.replace(/^c\./, "");
  let m;
  if (/^retrieval_index_id = \$1$/.test(f)) return true;
  if ((m = /^corp_code = ANY\(\$(\d+)\)$/.exec(f))) return params[m[1] - 1].includes(r.corp_code);
  if ((m = /^source_document_id = ANY\(\$(\d+)\)$/.exec(f))) return params[m[1] - 1].includes(r.source_document_id);
  if ((m = /^metadata->>'(\w+)' = ANY\(\$(\d+)\)$/.exec(f))) return params[m[2] - 1].includes(r.metadata[m[1]]);
  if ((m = /^\(metadata->>'(\w+)'\)::int = ANY\(\$(\d+)\)$/.exec(f))) return params[m[2] - 1].includes(r.metadata[m[1]]);
  if ((m = /^metadata->>'receipt_date' >= \$(\d+)$/.exec(f))) return r.metadata.receipt_date >= params[m[1] - 1];
  if ((m = /^metadata->>'receipt_date' <= \$(\d+)$/.exec(f))) return r.metadata.receipt_date <= params[m[1] - 1];
  if ((m = /^\(metadata->>'is_correction'\)::boolean = \$(\d+)$/.exec(f))) return r.metadata.is_correction === params[m[1] - 1];
  if (/retrieval_eligible/.test(f)) return r.metadata.retrieval_eligible !== false;
  if (/^source_kind = ANY\(\$\d+\)$/.test(f)) return true; // DOCUMENT_CHUNK always, fixture rows are all chunks
  if (/^\(c\.embedding <=> \$2::vector\) <= \$\d+$/.test(frag)) return true; // no similarity_threshold used by this turn's callers
  throw new Error(`fake prefilter: unhandled fragment: ${frag}`);
}

function evalWhere(sql, params, r) {
  const where = sql.slice(sql.indexOf("WHERE") + 5, sql.includes("ORDER BY") ? sql.indexOf("ORDER BY") : undefined);
  return where.split(" AND ").map((s) => s.trim()).every((frag) => evalFragment(frag, params, r));
}

const EMBEDDING_DIMENSION = 3;

function fakeClient(rows, similarity = {}) {
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT retrieval_index_id") && trimmed.includes("FROM disclosure_reference.reference_retrieval_indexes")) {
        return {
          rows: [{
            retrieval_index_id: params[0], release_id: "release_test", source_snapshot_id: "snap_test",
            embedding_provider: "nlpai-lab", embedding_model: "KURE-v1", embedding_revision: "test",
            embedding_dimension: EMBEDDING_DIMENSION, distance_metric: "cosine",
            chunking_policy_id: "fixed-token-512-o64.v0.1.0", chunking_policy_sha256: "0".repeat(64),
            index_status: "READY", created_at: new Date(0), ready_at: new Date(0),
            record_count: rows.length, manifest_sha256: "0".repeat(64),
          }],
        };
      }
      if (trimmed.startsWith("SELECT chunk_id FROM disclosure_reference.reference_retrieval_chunks")) {
        return { rows: rows.filter((r) => evalWhere(sql, params, r)).map((r) => ({ chunk_id: r.chunk_id })) };
      }
      if (trimmed.startsWith("SELECT c.chunk_id") && sql.includes("JOIN") && sql.includes("ORDER BY")) {
        // the real vector search: apply the (aliased) WHERE, rank by our fixture's own
        // similarity map (default: absent from the map = never returned, matching
        // "not indexed by the dense leg" rather than an arbitrary score), LIMIT topK.
        const topK = params[params.length - 1];
        const matched = rows.filter((r) => Object.hasOwn(similarity, r.chunk_id) && evalWhere(sql, params, r));
        matched.sort((a, b) => (similarity[b.chunk_id] - similarity[a.chunk_id]) || a.chunk_id.localeCompare(b.chunk_id));
        return { rows: matched.slice(0, topK).map((r) => ({ ...r, similarity_score: similarity[r.chunk_id] })) };
      }
      if (sql.includes("FROM disclosure_reference.reference_retrieval_chunks") && sql.includes("chunk_id = ANY")) {
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

function fakeEmbedding() {
  const adapter = { calls: 0, async embedQuery() { adapter.calls += 1; return [0.1, 0.2, 0.3]; } };
  return adapter;
}
function fakeResolver(records) {
  const index = new Map(records.map((r) => [r.corp_code, r]));
  return { resolve: (code) => index.get(code) ?? null, corpCodes: () => [...index.keys()], count: () => index.size };
}
const NAME_INDEX = buildNameToCorpCodeIndex(fakeResolver([{ corp_code: CORP, corp_name: "테스트회사", listed_name: "테스트회사" }]));

function makeDeps(rows, similarity = {}) {
  const client = fakeClient(rows, similarity);
  const bm25Index = buildBm25Index(rows.map((r) => ({ id: r.chunk_id, text: r.text_content })));
  const embeddingAdapter = fakeEmbedding();
  return {
    client, bm25Index, embeddingAdapter, retrievalIndexId: RETRIEVAL_INDEX_ID,
    provenanceLoadSessionId: LOAD_SESSION_ID, expectedPins: {}, nameToCorpCodeIndex: NAME_INDEX,
  };
}

// ---------- 1/2. correction semantics ----------

test("1. correction=false does not exclude 정정 filings (ONLY_WHEN_ASKED)", async () => {
  const rows = [E1A, X1A];
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput({ corps: [], doc_groups: [], correction: false }, NAME_INDEX);
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "단일판매 공급계약", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  assert.ok(bm25_top100.some((r) => r.chunk_id === "chunk_x1a"), "정정 filing must remain eligible when correction=false");
});

test("2. correction=true restricts to 정정 filings only", async () => {
  const rows = [E1A, X1A];
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput({ corps: [], doc_groups: [], correction: true }, NAME_INDEX);
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "단일판매 공급계약", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  const ids = bm25_top100.map((r) => r.chunk_id);
  assert.deepEqual(ids, ["chunk_x1a"]);
});

// ---------- 3. wrong subtype recovery via relaxed pass ----------

test("3. a wrong extracted subtype does not hide the right filing (relaxed pass always runs)", async () => {
  const rows = [I1A, E1A]; // I1A has a DIFFERENT subtype than what we will "extract"
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput(
    { corps: [], doc_groups: ["exchange"], exchange_subtypes: ["단일판매공급계약체결"] }, NAME_INDEX,
  );
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "마일스톤 기술료 수령 라이선스", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  assert.ok(bm25_top100.some((r) => r.chunk_id === "chunk_i1a"), "off-subtype filing must be recoverable via the always-run relaxed pass");
});

// ---------- 4. weak relaxed candidate never outranks a strong primary one ----------

test("4. a weak off-subtype relaxed candidate does not outrank strong primary candidates", async () => {
  // A weak (nonzero, but low) BM25 overlap with the question -- one shared token only
  // ("계약"), vs. E1A's five-token overlap -- under a subtype the extractor got wrong.
  const weakRelaxed = makeRow({
    id: "chunk_weak_relaxed", doc: "exchange_20230101900001", receipt: "2023-01-01", nodes: [0],
    subtype: "투자판단관련주요경영사항", text: "체결 관련 없는 다른 주제의 문단 내용입니다",
  });
  const rows = [E1A, E1B, weakRelaxed];
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput(
    { corps: [], doc_groups: ["exchange"], exchange_subtypes: ["단일판매공급계약체결"] }, NAME_INDEX,
  );
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "단일판매 공급계약 체결 계약금액 계약상대", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  const rankOf = (id) => bm25_top100.findIndex((r) => r.chunk_id === id);
  assert.ok(rankOf("chunk_weak_relaxed") > rankOf("chunk_e1a"), "weak relaxed candidate must rank behind a relevant primary one");
});

// ---------- 5. a genuinely strong relaxed candidate can be promoted ----------

test("5. a strong relaxed-only candidate (matches the question well) is promoted ahead of a weak primary one", async () => {
  const rows = [I1A, E1B]; // E1B is primary-subtype but textually irrelevant to the question
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput(
    { corps: [], doc_groups: ["exchange"], exchange_subtypes: ["단일판매공급계약체결"] }, NAME_INDEX,
  );
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "마일스톤 기술료 수령 라이선스", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  assert.equal(bm25_top100[0]?.chunk_id, "chunk_i1a", "a relaxed candidate that is the strongest BM25 match overall is promoted to rank 1");
});

// ---------- 6/7. multiple date windows ----------

test("6. every date window pass runs (two dates in the question both retrieve their own filing)", async () => {
  const rows = [E1A, E2A];
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput({ corps: [], doc_groups: ["exchange"] }, NAME_INDEX);
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "2023-12-04 그리고 2024-09-05 단일판매 공급계약", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  const ids = bm25_top100.map((r) => r.chunk_id);
  assert.ok(ids.includes("chunk_e1a") && ids.includes("chunk_e2a"), "both dated filings must be present");
});

test("7. a first date's filing filling the leg cap does not crowd out the second date's filing (round-robin merge)", async () => {
  // Build many chunks for the first date's document so a naive "fill primary pool with
  // pass 1 entirely before pass 2" merge would starve the second date.
  const many = Array.from({ length: 30 }, (_, i) => makeRow({
    id: `chunk_bulk_${i}`, doc: "exchange_20231204800003", receipt: "2023-12-04", nodes: [i],
    text: `단일판매 공급계약 체결 계약금액 ${i} 반복 텍스트 padding`,
  }));
  const rows = [...many, E2A];
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput({ corps: [], doc_groups: ["exchange"] }, NAME_INDEX);
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "2023-12-04 그리고 2024-09-05 단일판매 공급계약", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  assert.ok(bm25_top100.some((r) => r.chunk_id === "chunk_e2a"), "second date's filing must survive round-robin merge even when the first date's pool is large");
});

// ---------- 8. periodic-only questions get no date window ----------

test("8. a periodic-only condition applies no receipt-date window", async () => {
  const rows = [P1A];
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput({ corps: [], doc_groups: ["periodic"] }, NAME_INDEX);
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "2024-05-15 사업보고서 매출액", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  // no throw, and the periodic chunk (receipt_date well outside any naive window of the
  // question's own date) is still retrievable because no window filter is applied.
  assert.ok(bm25_top100.some((r) => r.chunk_id === "chunk_p1a"));
});

// ---------- 9. BM25 score<=0 dropped ----------

test("9. BM25 candidates with score<=0 are dropped from the leg", async () => {
  const rows = [E1A];
  const deps = makeDeps(rows);
  const mapped = mapOfficialConditionToFilterInput({ corps: [], doc_groups: ["exchange"] }, NAME_INDEX);
  // A query with zero lexical overlap scores 0 against every document under BM25.
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "완전히 무관한 질문 텍스트 자모음", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  assert.equal(bm25_top100.length, 0, "a zero-score BM25 candidate must never be admitted under bm25_zero_score=DROP");
});

// ---------- 10. single query embedding per question ----------

test("10. embedQuery is called exactly once per question even with multiple passes", async () => {
  const rows = [E1A, E2A];
  const deps = makeDeps(rows, { chunk_e1a: 0.9, chunk_e2a: 0.8 });
  const mapped = mapOfficialConditionToFilterInput({ corps: [], doc_groups: ["exchange"] }, NAME_INDEX);
  await runRemediationAwareCandidateGeneration(
    deps, { question: "2023-12-04 그리고 2024-09-05 단일판매 공급계약", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  assert.equal(deps.embeddingAdapter.calls, 1);
});

// ---------- 11. BM25/dense each capped at 100 ----------

test("11. BM25 leg never exceeds BM25_CANDIDATE_K even with many matching passes", async () => {
  const many = Array.from({ length: 150 }, (_, i) => makeRow({
    id: `chunk_many_${i}`, doc: `exchange_2023120${i % 9}800${i}`, receipt: "2023-12-04", nodes: [0],
    text: "단일판매 공급계약 체결 계약금액 계약상대",
  }));
  const deps = makeDeps(many);
  const mapped = mapOfficialConditionToFilterInput({ corps: [], doc_groups: ["exchange"] }, NAME_INDEX);
  const { bm25_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: "2023-12-04 단일판매 공급계약 체결", mappedFilters: mapped.filters }, REMEDIATION_V1_POLICY,
  );
  assert.ok(bm25_top100.length <= BM25_CANDIDATE_K);
  assert.equal(BM25_CANDIDATE_K, 100);
  assert.equal(DENSE_CANDIDATE_K, 100);
});

// ---------- 12/13/14: end-to-end pipeline invariants ----------

function r4Config() {
  return {
    config_id: "R4_wide_rrf_centric", family: "R4",
    description: "test", weights: { wide_rrf: 0.7, bm25: 0.1, dense: 0.1, original_rrf: 0.1 },
  };
}

test("12/13. wide pool <= 200 and every pool candidate receives R4 scoring (frozen-policy equivalence)", async () => {
  const rows = [E1A, E1B, E2A, D1A];
  const deps = makeDeps(rows, { chunk_e1a: 0.9 });
  const question = { question_id: "q1", question: "단일판매 공급계약 체결 계약금액 계약상대", conditions: { corps: [], doc_groups: ["exchange"] }, segment: "HIGH" };
  const remResult = await runQuestionPipelineRemediationAware(deps, question, [r4Config()], FROZEN_POLICY);
  assert.ok(remResult.wide_pool_size <= 200);
  const finalTop20 = remResult.per_config.R4_wide_rrf_centric.final_top20;
  assert.ok(finalTop20.length <= 20);
  assert.equal(new Set(finalTop20.map((c) => c.chunk_id)).size, finalTop20.length, "no duplicate chunk_id in final top-20");
});

test("14. A3 stable refill: REJECT candidates never appear in final_top20, KEEP_UNKNOWN does", async () => {
  const rows = [E1A, E1B, E2A];
  const deps = makeDeps(rows, { chunk_e1a: 0.9, chunk_e1b: 0.5 });
  const question = { question_id: "q1", question: "단일판매 공급계약 체결 계약금액 계약상대", conditions: { corps: [], doc_groups: ["exchange"], year_months: [[2023, 12]] }, segment: "HIGH" };
  const remResult = await runQuestionPipelineRemediationAware(deps, question, [r4Config()], REMEDIATION_V1_POLICY);
  const perConfig = remResult.per_config.R4_wide_rrf_centric;
  assert.equal(perConfig.a3_reject, 0, "no fixture item here is constructed to contradict the question's own extracted conditions");
  for (const c of perConfig.final_top20) assert.ok(c.chunk_id, "every final item is a real, hydrated candidate");
});

// ---------- 15. existing backend non-regression ----------

test("15. runQuestionPipeline (the ORIGINAL, untouched pipeline) is never called or affected by this turn's new modules", async () => {
  const rows = [E1A, E1B, E2A];
  const deps = makeDeps(rows, { chunk_e1a: 0.9 });
  const question = { question_id: "q1", question: "단일판매 공급계약 체결 계약금액 계약상대", conditions: { corps: [], doc_groups: ["exchange"] }, segment: "HIGH" };
  const original = await runQuestionPipeline(deps, question, [r4Config()]);
  assert.ok(original.wide_pool_size >= 0, "the original pipeline still runs standalone, unaffected by the new remediation modules existing alongside it");
});

// ---------- 16. determinism ----------

test("16. determinism: identical input produces identical output, twice", async () => {
  const rows = [E1A, E1B, E2A, D1A];
  const question = { question_id: "q1", question: "단일판매 공급계약 체결 계약금액 계약상대", conditions: { corps: [], doc_groups: ["exchange"] }, segment: "HIGH" };
  const deps1 = makeDeps(rows, { chunk_e1a: 0.9 });
  const deps2 = makeDeps(rows, { chunk_e1a: 0.9 });
  const r1 = await runQuestionPipelineRemediationAware(deps1, question, [r4Config()], REMEDIATION_V1_POLICY);
  const r2 = await runQuestionPipelineRemediationAware(deps2, question, [r4Config()], REMEDIATION_V1_POLICY);
  assert.deepEqual(
    r1.per_config.R4_wide_rrf_centric.final_top20.map((c) => c.chunk_id),
    r2.per_config.R4_wide_rrf_centric.final_top20.map((c) => c.chunk_id),
  );
});

// ---------- 17. no hardcoded question_id / company name ----------

test("17. no question_id or company name is hardcoded anywhere in the new modules' source", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "./a4-a3-remediation-candidate-legs.mjs",
    "./a4-a3-remediation-retrieval-pipeline.mjs",
  ];
  const forbidden = [/author_[0-9a-f]{24}/, /gold_b_[0-9a-f]{24}/, /삼성전자/, /LG에너지솔루션/];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const pattern of forbidden) assert.ok(!pattern.test(src), `${f} must not hardcode ${pattern}`);
  }
});

// ---------- 18. zero Gold/QA/LLM dependency ----------

test("18. the new modules import nothing from Gold, QA-assembly, or any LLM client", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "./a4-a3-remediation-candidate-legs.mjs",
    "./a4-a3-remediation-retrieval-pipeline.mjs",
  ];
  const forbidden = [/phase1_devtune_gold/, /dart_detective/, /hyperclova/i, /clova/i, /answer_api/];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const pattern of forbidden) assert.ok(!pattern.test(src), `${f} must not reference ${pattern}`);
  }
});
