// Synthetic (non-production) fixture for Turn P6's Benchmark Runner / Gold-
// blind Scoring Infrastructure tests. Extends the SHARED
// tests/lib/agent-comparison-fixture.mjs (imported read-only) with a
// Retriever adapter (so DOCUMENT_FIRST_RAG -- the one variant that starts
// from services.retriever.retrieve() -- can also ground the SAME
// FIXTURE_FACT/FIXTURE_EVIDENCE the other three variants already ground via
// the Structured Store) and a canonical synthetic DatasetRecord. Every id/
// value here is made up for this fixture only -- never asserted to match
// any real Seed/production/Gold record.
import {
  CORPUS_SNAPSHOT_ID, FACT_COVERAGE_SNAPSHOT_ID, FIXTURE_FACT, FIXTURE_EVIDENCE,
  syntheticContext, syntheticServiceAdapters,
} from "./agent-comparison-fixture.mjs";

export { CORPUS_SNAPSHOT_ID, FACT_COVERAGE_SNAPSHOT_ID, FIXTURE_FACT, FIXTURE_EVIDENCE };

export const CHUNKING_CONFIG_ID = "chunking_synthetic_benchmark_infra_fixture_0001";
export const INDEX_SNAPSHOT_ID = "index_synthetic_benchmark_infra_fixture_0001";

const FILE_ID = "file_000000000000000000000001";

function retrievalItemForFixtureFact() {
  return {
    rank: 1,
    score: 5,
    score_type: "BM25",
    component_scores: { bm25: 5, dense: null, rrf: null, reranker: null },
    document_id: FIXTURE_FACT.source_document_id,
    chunk_id: "chunk_000000000000000000000001",
    chunk_type: "SECTION_FLAT",
    parent_chunk_id: null,
    text_provenance: "SOURCE_VERBATIM",
    citation_authority: "SOURCE_SPANS",
    raw_text: FIXTURE_EVIDENCE.quoted_text,
    source_locator: FIXTURE_EVIDENCE.source_locator,
    source_spans: [{
      file_id: FILE_ID, rel_path: "synthetic.xml", node_id: "n1", order_index: 1,
      row_start: null, row_end: null, col_start: null, col_end: null, source_locator: FIXTURE_EVIDENCE.source_locator,
    }],
  };
}

// DOCUMENT_FIRST_RAG's own buildRetrievalRequest scopes metadata_filters to
// conditions.corp_codes/document_ids (see flows/document-first-rag-agent.mjs) --
// this adapter matches on either, mirroring a real adapter that indexes by
// both, and echoes back request-derived fields exactly (query_id,
// retrieval_method, snapshot triple, applied_filters, top_k) so
// retriever-store.mjs's own request/result consistency check passes.
export function createBenchmarkFixtureRetrieverAdapter() {
  return {
    async retrieve(request) {
      const wantsFixtureDoc = request.metadata_filters.corp_codes.includes(FIXTURE_FACT.corp_code)
        || request.metadata_filters.document_ids.includes(FIXTURE_FACT.source_document_id);
      const results = wantsFixtureDoc ? [retrievalItemForFixtureFact()] : [];
      return {
        schema_version: "0.2.0",
        query_id: request.query_id,
        retrieval_method: request.retrieval_method,
        corpus_snapshot_id: request.corpus_snapshot_id,
        chunking_config_id: request.chunking_config_id,
        index_snapshot_id: request.index_snapshot_id,
        applied_filters: request.metadata_filters,
        top_k: request.top_k,
        latency_ms: 0.5,
        results,
      };
    },
  };
}

export function benchmarkFixtureContext(overrides = {}) {
  return syntheticContext({ chunking_config_id: CHUNKING_CONFIG_ID, index_snapshot_id: INDEX_SNAPSHOT_ID, ...overrides });
}

export function benchmarkFixtureServiceAdapters(overrides = {}) {
  return { ...syntheticServiceAdapters(), retriever: createBenchmarkFixtureRetrieverAdapter(), ...overrides };
}

export const FAKE_MODEL_CONFIG = Object.freeze({
  schema_version: "0.1.0",
  model_config_id: "model_fake-deterministic-v1",
  kind: "FAKE_DETERMINISTIC",
  provider: "test-fixture",
  model: "deterministic-fake-v1",
});

export const BENCHMARK_LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 5, maxToolCalls: 30, timeoutMs: 5000 });

// A grounded-answer responder every variant can use identically: all four
// variants ground the SAME FIXTURE_FACT/FIXTURE_EVIDENCE ids given the same
// corp_codes/metric_codes hints (+ the Retriever adapter above for
// DOCUMENT_FIRST_RAG), so a single fixed used_fact_ids/used_evidence_ids
// claim validates against every variant's own citation-binding scope.
export function groundedFixtureResponder() {
  return {
    text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`,
    used_fact_ids: [FIXTURE_FACT.fact_id],
    used_evidence_ids: [FIXTURE_EVIDENCE.evidence_id],
  };
}

export function makeFixtureDatasetRecord(overrides = {}) {
  return {
    schema_version: "0.1.0",
    evaluation_item_id: "evaluation_item_benchmark_infra_0001",
    question: "매출액이 얼마인가요?",
    as_of_date: "2026-01-15",
    hints: {
      corp_codes: [FIXTURE_FACT.corp_code],
      metric_codes: [FIXTURE_FACT.metric_code],
      document_ids: [],
      event_types: [],
      period_filter: { start: null, end: null, period_types: [] },
      scope_filter: [],
    },
    split: "DEV_TUNE",
    evaluation_group_id: null,
    chain_component_id: null,
    expected_answerability: "SUPPORTED",
    expected_facts: [
      { fact_id: FIXTURE_FACT.fact_id, semantic_slot: "revenue_fy_synthetic", corp_code: FIXTURE_FACT.corp_code, metric_code: FIXTURE_FACT.metric_code, required: true },
    ],
    expected_events: [],
    expected_relations: [],
    expected_numeric_claims: [
      { value: FIXTURE_FACT.normalized_value, unit: "KRW", unit_conversion_allowed: false, role: "revenue_amount" },
    ],
    expected_date_claims: [],
    allowed_evidence_ids: [FIXTURE_EVIDENCE.evidence_id],
    grading_policy_version: "grading_policy_synthetic_v0.1",
    ...overrides,
  };
}
