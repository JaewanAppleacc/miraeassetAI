// Synthetic (non-production) contract tests for DOCUMENT_FIRST_RAG (Turn
// P2-D). Every id/value here is made up for this fixture only -- it is not
// derived from, and never asserted to match, any real Seed/production
// record (same convention as tests/lib/agent-comparison-fixture.mjs, which
// this file does not touch or import -- DOCUMENT_FIRST_RAG needs a
// Retriever adapter the shared fixture does not provide, so this file
// builds its own self-contained fixture instead of extending a shared
// one it is not allowed to modify).
//
// A real, approved-bundle-backed smoke suite (Retriever candidate search
// over the actual v0.20-r3 corpus, cross-validated against real VERIFIED
// Facts) lives in this same file's own `describe("real v0.20-r3 bundle
// smoke"...)` block below -- it is skipped automatically if the bundle
// files are not present in this worktree, and is otherwise run the same
// way `npm run test:agent-comparison:real-bundle-smoke` runs
// tests/agent-comparison-real-bundle-smoke.test.mjs (STRUCTURED_FIRST's
// own, unmodified, real-bundle smoke suite) -- via
// `node --test tests/agent-comparison-document-first-rag.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createDocumentFirstRagFlow } from "../domain/agent-comparison/flows/document-first-rag-agent.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { validateFinalResponse } from "../domain/runtime/final-response-validator.mjs";
import { instrumentModelAdapter, buildTelemetryEvent } from "../domain/agent-comparison/telemetry.mjs";
import { validateTelemetryEvent } from "../domain/agent-comparison/contracts.mjs";
import {
  registerAgentVariant, getAgentVariantFactory, listRegisteredAgentVariantIds, _clearRegistryForTests,
} from "../domain/agent-comparison/variant-registry.mjs";

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 5, maxToolCalls: 30, timeoutMs: 5000 });

// --- fixture identifiers ---------------------------------------------------

const CORPUS_SNAPSHOT_ID = "corpus_document_first_fixture_0001";
const FACT_COVERAGE_SNAPSHOT_ID = "fact_coverage_document_first_fixture_0001";
const CHUNKING_CONFIG_ID = "chunking_document_first_fixture_0001";
const INDEX_SNAPSHOT_ID = "index_document_first_fixture_0001";
const AS_OF_DATE = "2026-01-15";

const CORP_CODE = "10000001";
const OTHER_CORP_CODE = "10000002";

function docId(prefix, n) {
  return `${prefix}_${String(n).padStart(14, "0")}`;
}
function fileId(n) {
  return `file_${n.toString(16).padStart(24, "0")}`;
}
function chunkId(n) {
  return `chunk_${n.toString(16).padStart(24, "0")}`;
}
function evidenceId(n) {
  return `evidence_${n.toString(16).padStart(24, "0")}`;
}
function factId(n) {
  return `fact_${n.toString(16).padStart(24, "0")}`;
}
function relationId(n) {
  return `relation_${n.toString(16).padStart(24, "0")}`;
}
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// A grounded, well-behaved document: Fact + Evidence agree.
const DOC_GROUNDED = docId("periodic", 1);
// A high-scoring lookalike with NO structured data at all.
const DOC_LOOKALIKE = docId("periodic", 2);
// Evidence exists (VERIFIED, resolves against the corpus) but is never
// referenced by any Fact's evidence_ids -- "evidence-only" content.
const DOC_EVIDENCE_ONLY = docId("exchange", 3);
// Fact exists but for a DIFFERENT corp_code than the request asks about.
const DOC_WRONG_CORP = docId("periodic", 4);
// Fact + Evidence are linked, but the Evidence's own quoted number
// disagrees with the Fact's normalized_value.
const DOC_VALUE_CONFLICT = docId("periodic", 5);
// A genuine correction pair, linked by a real RELATION record.
const DOC_REL_SOURCE = docId("periodic", 6);
const DOC_REL_TARGET = docId("periodic", 7);
// Same corp_code/receipt-date "look" as DOC_REL_SOURCE, but NO relation
// record actually links it to anything.
const DOC_REL_LOOKALIKE = docId("periodic", 8);
// A different, unauthorized document/evidence pair, used only to prove a
// model citing it is rejected -- never queried/authorized by any test's
// own request.
const DOC_UNAUTHORIZED = docId("periodic", 9);

function makeEvidence({ id, documentId, quotedText }) {
  const file = fileId(id);
  const sourceLocator = `${documentId}/${file.slice("file_".length)}.xml#node=1`;
  return {
    evidence_id: evidenceId(id),
    document_id: documentId,
    file_id: file,
    chunk_id: chunkId(id),
    source_locator: sourceLocator,
    quoted_text: quotedText,
    quote_sha256: sha256Hex(quotedText),
    extraction_method: "RULE",
    confidence: 1,
    verification_status: "VERIFIED",
    metadata: {},
  };
}

function makeFact({ id, corpCode, documentId, metricCode, normalizedValue, rawValueText, evidenceIds }) {
  return {
    fact_id: factId(id),
    corp_code: corpCode,
    event_id: null,
    source_document_id: documentId,
    metric_code: metricCode,
    raw_label: metricCode,
    value_type: "NUMERIC",
    value_status: "DISCLOSED",
    value_certainty: "CONFIRMED",
    raw_value_text: rawValueText,
    raw_unit_text: "원",
    normalized_value: normalizedValue,
    unit: "KRW",
    currency: "KRW",
    scale: 1,
    scope: "CONSOLIDATED",
    period_type: "ANNUAL",
    period_start: "2025-01-01",
    period_end: "2025-12-31",
    as_of_date: "2025-12-31",
    known_at: "2026-01-01T00:00:00.000Z",
    valid_from: "2025-01-01",
    valid_to: null,
    withheld_until: null,
    extraction_method: "RULE",
    confidence: 1,
    verification_status: "VERIFIED",
    evidence_ids: evidenceIds,
    attributes: {},
  };
}

const EVIDENCE_GROUNDED = makeEvidence({ id: 1, documentId: DOC_GROUNDED, quotedText: "매출액은 1,000,000,000원입니다." });
const FACT_GROUNDED = makeFact({
  id: 1, corpCode: CORP_CODE, documentId: DOC_GROUNDED, metricCode: "REVENUE",
  normalizedValue: 1_000_000_000, rawValueText: "1,000,000,000", evidenceIds: [EVIDENCE_GROUNDED.evidence_id],
});

const EVIDENCE_ONLY_RECORD = makeEvidence({ id: 2, documentId: DOC_EVIDENCE_ONLY, quotedText: "이 사업은 신규 투자 계획을 포함하고 있습니다." });

const EVIDENCE_WRONG_CORP = makeEvidence({ id: 4, documentId: DOC_WRONG_CORP, quotedText: "영업이익은 500,000,000원입니다." });
const FACT_WRONG_CORP = makeFact({
  id: 4, corpCode: OTHER_CORP_CODE, documentId: DOC_WRONG_CORP, metricCode: "OPERATING_PROFIT",
  normalizedValue: 500_000_000, rawValueText: "500,000,000", evidenceIds: [EVIDENCE_WRONG_CORP.evidence_id],
});

const EVIDENCE_VALUE_CONFLICT = makeEvidence({ id: 5, documentId: DOC_VALUE_CONFLICT, quotedText: "매출액은 9,999,999,999원입니다." });
const FACT_VALUE_CONFLICT = makeFact({
  id: 5, corpCode: CORP_CODE, documentId: DOC_VALUE_CONFLICT, metricCode: "REVENUE",
  normalizedValue: 2_000_000_000, rawValueText: "2,000,000,000", evidenceIds: [EVIDENCE_VALUE_CONFLICT.evidence_id],
});

const EVIDENCE_REL_SOURCE = makeEvidence({ id: 6, documentId: DOC_REL_SOURCE, quotedText: "본 공시는 정정 신고서입니다." });
const FACT_REL_SOURCE = makeFact({
  id: 6, corpCode: CORP_CODE, documentId: DOC_REL_SOURCE, metricCode: "CONTRACT_AMOUNT",
  normalizedValue: 3_000_000_000, rawValueText: "3,000,000,000", evidenceIds: [EVIDENCE_REL_SOURCE.evidence_id],
});
const EVIDENCE_REL_TARGET = makeEvidence({ id: 7, documentId: DOC_REL_TARGET, quotedText: "원 공시의 계약금액은 3,000,000,000원입니다." });
const FACT_REL_TARGET = makeFact({
  id: 7, corpCode: CORP_CODE, documentId: DOC_REL_TARGET, metricCode: "CONTRACT_AMOUNT",
  normalizedValue: 3_000_000_000, rawValueText: "3,000,000,000", evidenceIds: [EVIDENCE_REL_TARGET.evidence_id],
});
const RELATION_REAL = {
  relation_id: relationId(1),
  source_document_id: DOC_REL_SOURCE,
  target_document_id: DOC_REL_TARGET,
  event_id: null,
  relation_type: "AMENDS",
  known_at: "2026-01-01T00:00:00.000Z",
  extraction_method: "RULE",
  confidence: 1,
  evidence_id: EVIDENCE_REL_SOURCE.evidence_id,
  verification_status: "VERIFIED",
  attributes: {},
};

const EVIDENCE_REL_LOOKALIKE = makeEvidence({ id: 8, documentId: DOC_REL_LOOKALIKE, quotedText: "계약금액은 3,000,000,000원입니다." });
const FACT_REL_LOOKALIKE = makeFact({
  id: 8, corpCode: CORP_CODE, documentId: DOC_REL_LOOKALIKE, metricCode: "CONTRACT_AMOUNT",
  normalizedValue: 3_000_000_000, rawValueText: "3,000,000,000", evidenceIds: [EVIDENCE_REL_LOOKALIKE.evidence_id],
});

const EVIDENCE_UNAUTHORIZED = makeEvidence({ id: 9, documentId: DOC_UNAUTHORIZED, quotedText: "매출액은 7,000,000,000원입니다." });
const FACT_UNAUTHORIZED = makeFact({
  id: 9, corpCode: CORP_CODE, documentId: DOC_UNAUTHORIZED, metricCode: "REVENUE",
  normalizedValue: 7_000_000_000, rawValueText: "7,000,000,000", evidenceIds: [EVIDENCE_UNAUTHORIZED.evidence_id],
});

// --- world: every Fact/Evidence/Relation this fixture knows about ---------

const ALL_FACTS = [FACT_GROUNDED, FACT_WRONG_CORP, FACT_VALUE_CONFLICT, FACT_REL_SOURCE, FACT_REL_TARGET, FACT_REL_LOOKALIKE, FACT_UNAUTHORIZED];
const ALL_EVIDENCE = [
  EVIDENCE_GROUNDED, EVIDENCE_ONLY_RECORD, EVIDENCE_WRONG_CORP, EVIDENCE_VALUE_CONFLICT,
  EVIDENCE_REL_SOURCE, EVIDENCE_REL_TARGET, EVIDENCE_REL_LOOKALIKE, EVIDENCE_UNAUTHORIZED,
];
const ALL_RELATIONS = [RELATION_REAL];

function structuredRecord(recordType, recordId, sourceDocumentIds, evidenceIds, payload) {
  return {
    record_type: recordType,
    record_id: recordId,
    verification_status: "VERIFIED",
    known_at: "2026-01-01T00:00:00.000Z",
    source_document_ids: sourceDocumentIds,
    evidence_ids: evidenceIds,
    payload,
  };
}

function buildRecords({ facts = ALL_FACTS, evidence = ALL_EVIDENCE, relations = ALL_RELATIONS } = {}) {
  return [
    ...facts.map((fact) => structuredRecord("FACT", fact.fact_id, [fact.source_document_id], fact.evidence_ids, fact)),
    ...evidence.map((ev) => structuredRecord("EVIDENCE", ev.evidence_id, [ev.document_id], [ev.evidence_id], ev)),
    ...relations.map((rel) => structuredRecord(
      "RELATION", rel.relation_id, [rel.source_document_id, rel.target_document_id], [rel.evidence_id], rel,
    )),
  ];
}

function matchesFilters(query, record) {
  if (!query.targets.includes(record.record_type)) return false;
  if (query.corp_codes?.length > 0 && record.payload.corp_code && !query.corp_codes.includes(record.payload.corp_code)) return false;
  if (query.predicates.document_ids?.length > 0 && !record.source_document_ids.some((id) => query.predicates.document_ids.includes(id))) return false;
  if (!query.verification_statuses.includes(record.verification_status)) return false;
  return true;
}

function createStructuredStoreAdapter(records = buildRecords()) {
  return {
    async query(query) {
      const matching = records.filter((record) => matchesFilters(query, record));
      return {
        corpus_snapshot_id: query.corpus_snapshot_id,
        fact_coverage_snapshot_id: query.fact_coverage_snapshot_id,
        status: matching.length > 0 ? "OK" : "NOT_FOUND",
        error_codes: [],
        records: matching.slice(0, query.limit),
      };
    },
  };
}

function createDocumentStoreAdapter(evidenceList = ALL_EVIDENCE) {
  const byDocumentId = new Map();
  for (const ev of evidenceList) {
    const blocks = byDocumentId.get(ev.document_id) ?? [];
    blocks.push({ file_id: ev.file_id, source_locator: ev.source_locator, text: ev.quoted_text });
    byDocumentId.set(ev.document_id, blocks);
  }
  return {
    async getDocument(documentId) {
      const blocks = byDocumentId.get(documentId);
      if (!blocks) return null;
      return { document_id: documentId, corpus_snapshot_id: CORPUS_SNAPSHOT_ID, blocks };
    },
  };
}

function createEvidenceStoreAdapter(evidenceList = ALL_EVIDENCE) {
  const byId = new Map(evidenceList.map((ev) => [ev.evidence_id, ev]));
  return {
    async getEvidence(evidenceId) {
      const record = byId.get(evidenceId);
      if (!record) return null;
      return { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, record };
    },
  };
}

function syntheticContext(overrides = {}) {
  return {
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
    chunking_config_id: CHUNKING_CONFIG_ID,
    index_snapshot_id: INDEX_SNAPSHOT_ID,
    as_of_date: AS_OF_DATE,
    ...overrides,
  };
}

// --- Retriever fixture ------------------------------------------------------
//
// `hits` is [{ documentId, evidence, chunkType }, ...], already in the
// desired rank order (best first) -- score is assigned descending so
// retrieval-result.schema.json's non-increasing-score invariant holds.
// `evidence` (when supplied) supplies the chunk's raw_text/file/locator
// from this fixture's own Evidence records purely for schema-conformant
// realism -- the Flow under test never trusts this raw_text as a fact by
// itself; only what Structured Store independently returns for the
// resulting candidate document_id matters (see this file's header
// comment and document-first-rag-agent.mjs's own header comment).
function createRetrieverAdapter(hits) {
  return {
    async retrieve(request) {
      const results = hits.map((hit, index) => {
        const rank = index + 1;
        const score = hits.length - index + 1;
        const ev = hit.evidence;
        const fileIdValue = ev?.file_id ?? fileId(9000 + rank);
        const sourceLocator = ev?.source_locator ?? `${hit.documentId}/synthetic.xml#node=1`;
        const rawText = ev?.quoted_text ?? `문서 ${hit.documentId} 관련 검색 결과 ${rank}`;
        return {
          rank,
          score,
          score_type: "BM25",
          component_scores: { bm25: score, dense: null, rrf: null, reranker: null },
          document_id: hit.documentId,
          chunk_id: chunkId(9000 + rank),
          chunk_type: hit.chunkType ?? "PARAGRAPH_CHILD",
          parent_chunk_id: null,
          text_provenance: ev ? "SOURCE_VERBATIM" : "STRUCTURAL_CONTEXT",
          citation_authority: "SOURCE_SPANS",
          raw_text: rawText,
          source_locator: sourceLocator,
          source_spans: [{
            file_id: fileIdValue,
            rel_path: `${fileIdValue.slice("file_".length)}.xml`,
            node_id: `${hit.documentId}::n1`,
            order_index: 0,
            row_start: null, row_end: null, col_start: null, col_end: null,
            source_locator: sourceLocator,
          }],
        };
      });
      return {
        schema_version: "0.2.0",
        query_id: request.query_id,
        retrieval_method: request.retrieval_method,
        corpus_snapshot_id: request.corpus_snapshot_id,
        chunking_config_id: request.chunking_config_id,
        index_snapshot_id: request.index_snapshot_id,
        applied_filters: request.metadata_filters,
        top_k: request.top_k,
        latency_ms: 1,
        results,
      };
    },
  };
}

function serviceAdapters({ hits, records, evidenceList } = {}) {
  return {
    retriever: createRetrieverAdapter(hits ?? [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }]),
    structuredStoreAdapter: createStructuredStoreAdapter(records),
    documentStoreAdapter: createDocumentStoreAdapter(evidenceList),
    evidenceStoreAdapter: createEvidenceStoreAdapter(evidenceList),
  };
}

function baseInput(overrides = {}) {
  return { question: "매출액이 얼마인가요?", question_id: "q_document_first_01", hints: { corp_codes: [CORP_CODE], metric_codes: ["REVENUE"] }, ...overrides };
}

function countingResponder(fn) {
  let calls = 0;
  const responder = (request) => { calls += 1; return fn(request); };
  return { responder, callCount: () => calls };
}

// --- unit tests --------------------------------------------------------------

test("DOCUMENT_FIRST_RAG: Retriever returns 0 candidates -> safe information limit, model never called", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.reason, "NO_RETRIEVAL_RESULTS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(callCount(), 0);
});

test("DOCUMENT_FIRST_RAG: no Retriever adapter wired -> fail-closed information limit, model never called", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = { ...serviceAdapters(), retriever: undefined };
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.reason, "RETRIEVAL_UNAVAILABLE");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(callCount(), 0);
});

test("DOCUMENT_FIRST_RAG: retrieved candidate's Evidence fails Evidence Validator (unresolvable against corpus) -> discarded, not surfaced as fact", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  // documentStoreAdapter/evidenceStoreAdapter omitted -> EVIDENCE_STORE_UNAVAILABLE -> validateEvidence always throws.
  const adapters = { ...serviceAdapters(), documentStoreAdapter: undefined, evidenceStoreAdapter: undefined };
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.reason, "EVIDENCE_ONLY_UNCONFIRMED");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(callCount(), 0);
  assert.doesNotMatch(outcome.final_response.answer, /1,000,000,000/);
});

test("DOCUMENT_FIRST_RAG: Retrieval success + Structured Store agreement -> grounded PASS, citation-bound to the real Fact/Evidence", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FACT_GROUNDED.normalized_value}원입니다.`,
    used_fact_ids: [FACT_GROUNDED.fact_id],
    used_evidence_ids: [EVIDENCE_GROUNDED.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(outcome.final_response.answer, `매출액은 ${FACT_GROUNDED.normalized_value}원입니다.`);
  assert.deepEqual(outcome.execution_trace.selected_evidence, [EVIDENCE_GROUNDED.evidence_id]);
});

test("DOCUMENT_FIRST_RAG: Retrieval success + Structured Store VALUE conflict -> fail-closed, conflicting document excluded", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_VALUE_CONFLICT, evidence: EVIDENCE_VALUE_CONFLICT }] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.reason, "STRUCTURED_CONFLICT");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(callCount(), 0);
  assert.doesNotMatch(outcome.final_response.answer, /9,999,999,999/);
  assert.doesNotMatch(outcome.final_response.answer, /2,000,000,000|2000000000/);
});

test("DOCUMENT_FIRST_RAG: an unlinked (evidence-only) candidate is stated with source attribution and an explicit information limit, never as a confirmed fact", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_EVIDENCE_ONLY, evidence: EVIDENCE_ONLY_RECORD }] });
  const outcome = await runAgentFlow(flow, baseInput({ hints: { corp_codes: [], metric_codes: [] } }), syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.validation.reason, "EVIDENCE_ONLY_UNCONFIRMED");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(callCount(), 0);
  assert.match(outcome.final_response.answer, new RegExp(DOC_EVIDENCE_ONLY));
  assert.doesNotMatch(outcome.final_response.answer, /신규 투자 계획/);
});

test("DOCUMENT_FIRST_RAG: a candidate document with a Fact for a DIFFERENT corp_code than requested is excluded (corp_code, not a name string, is the identity key)", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_WRONG_CORP, evidence: EVIDENCE_WRONG_CORP }] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.equal(outcome.final_response.think_trace.validation.reason, "STRUCTURED_CONFLICT");
  assert.equal(callCount(), 0);
  assert.doesNotMatch(outcome.final_response.answer, /500,000,000/);
  assert.doesNotMatch(outcome.final_response.answer, new RegExp(OTHER_CORP_CODE));
});

test("DOCUMENT_FIRST_RAG: a model answer citing a DIFFERENT document's evidence_id (never retrieved/authorized this request) is discarded wholesale", async () => {
  const { responder } = countingResponder(() => ({
    text: "그럴듯하지만 근거 없는 답변입니다.",
    used_fact_ids: [FACT_UNAUTHORIZED.fact_id],
    used_evidence_ids: [EVIDENCE_UNAUTHORIZED.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
  assert.doesNotMatch(outcome.final_response.answer, /그럴듯하지만/);
  assert.doesNotMatch(outcome.final_response.answer, /7,000,000,000/);
  assert.match(outcome.final_response.answer, new RegExp(String(FACT_GROUNDED.normalized_value)));
});

test("DOCUMENT_FIRST_RAG: a model answer inserting a fabricated NUMBER not present in grounded Fact/Evidence data is discarded wholesale", async () => {
  const { responder } = countingResponder(() => ({
    text: "매출액은 4,242,424,242원입니다.",
    used_fact_ids: [FACT_GROUNDED.fact_id],
    used_evidence_ids: [EVIDENCE_GROUNDED.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.unsupported_claim_count >= 1, true);
  assert.doesNotMatch(outcome.final_response.answer, /4,242,424,242/);
});

test("DOCUMENT_FIRST_RAG: a model answer inserting a fabricated DATE not present in grounded Fact/Evidence data is discarded wholesale", async () => {
  const { responder } = countingResponder(() => ({
    text: "이 값은 2031-09-09 기준입니다.",
    used_fact_ids: [FACT_GROUNDED.fact_id],
    used_evidence_ids: [EVIDENCE_GROUNDED.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.unsupported_claim_count >= 1, true);
});

test("DOCUMENT_FIRST_RAG: a model answer inserting a DIFFERENT company's corp_code is discarded wholesale", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FACT_GROUNDED.normalized_value}원입니다 (관련 기업 코드 ${OTHER_CORP_CODE}).`,
    used_fact_ids: [FACT_GROUNDED.fact_id],
    used_evidence_ids: [EVIDENCE_GROUNDED.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.doesNotMatch(outcome.final_response.answer, new RegExp(OTHER_CORP_CODE));
});

test("DOCUMENT_FIRST_RAG: a high-scoring lookalike document with no Structured Store corroboration is never cited, even though it out-ranks the genuinely grounded document", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FACT_GROUNDED.normalized_value}원입니다.`,
    used_fact_ids: [FACT_GROUNDED.fact_id],
    used_evidence_ids: [EVIDENCE_GROUNDED.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  // DOC_LOOKALIKE ranked FIRST (highest score) but has no Fact/Evidence at all.
  const adapters = serviceAdapters({ hits: [
    { documentId: DOC_LOOKALIKE },
    { documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED },
  ] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.equal(outcome.final_response.think_trace.validation.grounded_fact_count, 1);
  assert.deepEqual(outcome.execution_trace.selected_evidence, [EVIDENCE_GROUNDED.evidence_id]);
  assert.ok(
    outcome.final_response.retrieved_context.some((entry) => entry.document_id === DOC_LOOKALIKE && entry.structured_confirmation === "NONE"),
  );
});

test("DOCUMENT_FIRST_RAG: a document correction chain is only ever surfaced via a real RELATION record, never inferred from a matching receipt date/contract name", async () => {
  const { responder } = countingResponder((request) => ({
    text: `계약금액은 ${FACT_REL_SOURCE.normalized_value}원입니다.`,
    used_fact_ids: [FACT_REL_SOURCE.fact_id],
    used_evidence_ids: [EVIDENCE_REL_SOURCE.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  const adapters = serviceAdapters({ hits: [
    { documentId: DOC_REL_SOURCE, evidence: EVIDENCE_REL_SOURCE },
    { documentId: DOC_REL_LOOKALIKE, evidence: EVIDENCE_REL_LOOKALIKE },
  ] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  const relationEntries = outcome.final_response.retrieved_context.filter((entry) => "relation_id" in entry);
  assert.deepEqual(relationEntries.map((entry) => entry.relation_id), [RELATION_REAL.relation_id]);
});

test("DOCUMENT_FIRST_RAG: duplicate chunks/Evidence for the same document are de-duplicated into a single grounded claim", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FACT_GROUNDED.normalized_value}원입니다.`,
    used_fact_ids: [FACT_GROUNDED.fact_id],
    used_evidence_ids: [EVIDENCE_GROUNDED.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createDocumentFirstRagFlow(modelAdapter);
  // Two retrieval hits for the SAME document (duplicate chunk), AND the
  // structured store adapter reports the same Evidence record twice
  // (simulating a duplicated storage row) -- both must collapse to one.
  const duplicatedRecords = [
    ...buildRecords(),
    structuredRecord("EVIDENCE", EVIDENCE_GROUNDED.evidence_id, [EVIDENCE_GROUNDED.document_id], [EVIDENCE_GROUNDED.evidence_id], EVIDENCE_GROUNDED),
  ];
  const adapters = serviceAdapters({
    hits: [
      { documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED },
      { documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED },
    ],
    records: duplicatedRecords,
  });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.equal(outcome.final_response.think_trace.validation.grounded_fact_count, 1);
  assert.deepEqual(outcome.execution_trace.selected_evidence, [EVIDENCE_GROUNDED.evidence_id]);
});

test("DOCUMENT_FIRST_RAG: the final grounded answer is deterministic regardless of the Retriever's result ORDER", async () => {
  const fixedText = `매출액은 ${FACT_GROUNDED.normalized_value}원입니다.`;
  const responderFn = () => ({ text: fixedText, used_fact_ids: [FACT_GROUNDED.fact_id], used_evidence_ids: [EVIDENCE_GROUNDED.evidence_id] });

  const flowA = createDocumentFirstRagFlow(createDeterministicFakeModelAdapter({ responder: responderFn }));
  const adaptersA = serviceAdapters({ hits: [
    { documentId: DOC_LOOKALIKE },
    { documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED },
  ] });
  const outcomeA = await runAgentFlow(flowA, baseInput(), syntheticContext(), LIMITS, adaptersA);

  const flowB = createDocumentFirstRagFlow(createDeterministicFakeModelAdapter({ responder: responderFn }));
  const adaptersB = serviceAdapters({ hits: [
    { documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED },
    { documentId: DOC_LOOKALIKE },
  ] });
  const outcomeB = await runAgentFlow(flowB, baseInput(), syntheticContext(), LIMITS, adaptersB);

  assert.equal(outcomeA.final_response.answer, outcomeB.final_response.answer);
  assert.equal(outcomeA.final_response.think_trace.validation.grounded_fact_count, outcomeB.final_response.think_trace.validation.grounded_fact_count);
  assert.deepEqual(outcomeA.execution_trace.selected_evidence, outcomeB.execution_trace.selected_evidence);
});

test("DOCUMENT_FIRST_RAG: a model CALL failure falls back to a deterministic, fully-grounded answer -- citation_binding_status=NOT_CHECKED, model_fallback_used=true, scoring_eligible=false", async () => {
  const failingModelAdapter = { generate: async () => { throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout"); } };
  const flow = createDocumentFirstRagFlow(failingModelAdapter);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }] });
  const outcome = await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.match(outcome.final_response.answer, new RegExp(String(FACT_GROUNDED.normalized_value)));
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "NOT_CHECKED");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
});

test("DOCUMENT_FIRST_RAG only ever queries execution_scope OFFICIAL / verification_statuses VERIFIED", async () => {
  let sawNonOfficialQuery = false;
  const baseAdapters = serviceAdapters({ hits: [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }] });
  const guardedAdapters = {
    ...baseAdapters,
    structuredStoreAdapter: {
      async query(query) {
        if (query.execution_scope !== "OFFICIAL" || query.verification_statuses.some((s) => s !== "VERIFIED")) sawNonOfficialQuery = true;
        return baseAdapters.structuredStoreAdapter.query(query);
      },
    },
  };
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createDocumentFirstRagFlow(modelAdapter);
  await runAgentFlow(flow, baseInput(), syntheticContext(), LIMITS, guardedAdapters);
  assert.equal(sawNonOfficialQuery, false);
});

test("DOCUMENT_FIRST_RAG telemetry: structured_query_count / document_retrieval_count / evidence_validation_success_rate reflect real calls, not retrieval hit count", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FACT_GROUNDED.normalized_value}원입니다.`,
    used_fact_ids: [FACT_GROUNDED.fact_id],
    used_evidence_ids: [EVIDENCE_GROUNDED.evidence_id],
  }));
  const baseModel = createDeterministicFakeModelAdapter({ responder });
  const { adapter: instrumented, usage } = instrumentModelAdapter(baseModel);
  const flow = createDocumentFirstRagFlow(instrumented);
  const adapters = serviceAdapters({ hits: [{ documentId: DOC_GROUNDED, evidence: EVIDENCE_GROUNDED }] });
  const input = baseInput();
  const outcome = await runAgentFlow(flow, input, syntheticContext(), LIMITS, adapters);

  const event = buildTelemetryEvent({
    benchmarkRunId: "unit_test_run", agentVariantId: "DOCUMENT_FIRST_RAG", modelConfigId: "model_fake-deterministic-v1",
    executionScope: "OFFICIAL", question: input.question, questionId: input.question_id, agentOutcome: outcome, modelUsage: usage(),
  });
  assert.deepEqual(validateTelemetryEvent(event), []);
  assert.equal(event.document_retrieval_count, 1);
  assert.equal(event.structured_query_count >= 1, true);
  assert.equal(event.evidence_validation_success_rate, 1);
  assert.equal(event.citation_binding_status, "PASS");
  assert.equal(event.scoring_eligible, true);
  assert.equal(event.execution_mode, "BOTH");
  assert.equal(event.agent_variant_id, "DOCUMENT_FIRST_RAG");
});

test.afterEach(() => _clearRegistryForTests());

test("DOCUMENT_FIRST_RAG registration leaves every other variant id's registry state unchanged", async () => {
  await import("../domain/agent-comparison/register-document-first-rag-variant.mjs");
  assert.deepEqual(listRegisteredAgentVariantIds(), ["DOCUMENT_FIRST_RAG"]);
  assert.throws(() => getAgentVariantFactory("STRUCTURED_FIRST"), /no AgentFlow is registered/);
  assert.throws(() => getAgentVariantFactory("HYBRID_RETRIEVAL"), /no AgentFlow is registered/);
  assert.throws(() => getAgentVariantFactory("PLANNER"), /no AgentFlow is registered/);
});

// --- real v0.20-r3 bundle smoke ---------------------------------------------
//
// Mirrors tests/agent-comparison-real-bundle-smoke.test.mjs's own pattern
// (STRUCTURED_FIRST's smoke suite, unmodified by this Turn) but exercises
// DOCUMENT_FIRST_RAG's retrieval-first path: a real VERIFIED Fact/Evidence
// pair is probed from the approved bundle via the same
// createSeedBundleHarness construction point, then wrapped as a single,
// schema-conformant RetrieverResult -- an "approved bundle-based read-only"
// Retriever adapter (never a real network/vector-DB call, never a new
// Fact/Evidence/Event/Relation record; see this Flow's own header comment's
// "HARD RULES" list) built ONLY from data the bundle's own Structured Store
// already returned. Skipped automatically if the bundle files are not
// present in this worktree (a git-tracked bundle is expected in every
// clone, but this guard keeps this file runnable standalone even if that
// ever changes).
const BUNDLE_DIR = path.resolve(process.cwd(), "domain/releases/bundles/seed-release-v0.20-r3.candidate");
const bundleAvailable = existsSync(BUNDLE_DIR);

test("real v0.20-r3 bundle smoke", { skip: !bundleAvailable ? "seed-release-v0.20-r3.candidate bundle not present in this worktree" : false }, async (t) => {
  const { createSeedBundleHarness } = await import("../domain/agent-comparison/seed-bundle-harness.mjs");
  let harness;
  let sample;
  let sampleEvidence;

  t.before(async () => {
    harness = await createSeedBundleHarness({ root: process.cwd() });
    const probeQuery = {
      schema_version: "0.2.0", query_id: "query_document_first_bundle_probe", execution_scope: "OFFICIAL",
      corpus_snapshot_id: harness.context.corpus_snapshot_id, fact_coverage_snapshot_id: harness.context.fact_coverage_snapshot_id,
      targets: ["FACT"], corp_codes: [],
      predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
      period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
      verification_statuses: ["VERIFIED"], as_of_date: "2030-01-01", limit: 1,
    };
    const probeResult = await harness.serviceAdapters.structuredStoreAdapter.query(probeQuery);
    assert.equal(probeResult.status, "OK", "the real v0.20-r3 bundle must expose at least one VERIFIED Fact");
    sample = probeResult.records[0].payload;

    const evidenceQuery = {
      ...probeQuery, query_id: "query_document_first_bundle_evidence_probe", targets: ["EVIDENCE"],
      predicates: { ...probeQuery.predicates, evidence_ids: sample.evidence_ids },
    };
    const evidenceResult = await harness.serviceAdapters.structuredStoreAdapter.query(evidenceQuery);
    assert.equal(evidenceResult.status, "OK", "the real v0.20-r3 bundle must expose VERIFIED Evidence for the probed Fact");
    sampleEvidence = evidenceResult.records[0].payload;
  });

  t.after(async () => {
    if (harness) await harness.dispose();
  });

  await t.test("a well-behaved model answer over a REAL VERIFIED Fact discovered via document-first retrieval PASSES citation binding end-to-end", async () => {
    const bundleContext = { ...harness.context, chunking_config_id: "document_first_bundle_smoke_chunking_v1", index_snapshot_id: "document_first_bundle_smoke_index_v1", as_of_date: "2030-01-01" };
    const bundleServiceAdapters = {
      ...harness.serviceAdapters,
      retriever: createRetrieverAdapter([{ documentId: sample.source_document_id, evidence: sampleEvidence }]),
    };
    const baseModel = createDeterministicFakeModelAdapter({
      responder: () => ({ text: `값은 ${sample.normalized_value}입니다.`, used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
    });
    const { adapter: instrumented, usage } = instrumentModelAdapter(baseModel);
    const flow = createDocumentFirstRagFlow(instrumented);
    const input = { question: "document-first real bundle smoke question", question_id: "q_document_first_bundle_smoke_01", hints: { corp_codes: [sample.corp_code] } };
    const outcome = await runAgentFlow(flow, input, bundleContext, LIMITS, bundleServiceAdapters);

    assert.deepEqual(validateFinalResponse(outcome.final_response), []);
    assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
    assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
    assert.deepEqual(outcome.execution_trace.selected_evidence, sample.evidence_ids);

    const event = buildTelemetryEvent({
      benchmarkRunId: "document_first_real_bundle_smoke", agentVariantId: "DOCUMENT_FIRST_RAG", modelConfigId: "model_fake-deterministic-v1",
      executionScope: "OFFICIAL", question: input.question, questionId: input.question_id, agentOutcome: outcome, modelUsage: usage(),
    });
    assert.deepEqual(validateTelemetryEvent(event), []);
    assert.equal(event.citation_binding_status, "PASS");
    assert.equal(event.scoring_eligible, true);
  });

  await t.test("a hallucinated number never present in the real VERIFIED Fact/Evidence is discarded, and the deterministic fallback contains the REAL value instead", async () => {
    const bundleContext = { ...harness.context, chunking_config_id: "document_first_bundle_smoke_chunking_v1", index_snapshot_id: "document_first_bundle_smoke_index_v1", as_of_date: "2030-01-01" };
    const bundleServiceAdapters = {
      ...harness.serviceAdapters,
      retriever: createRetrieverAdapter([{ documentId: sample.source_document_id, evidence: sampleEvidence }]),
    };
    const baseModel = createDeterministicFakeModelAdapter({
      responder: () => ({ text: "값은 888,888,888,888,888입니다.", used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
    });
    const flow = createDocumentFirstRagFlow(baseModel);
    const input = { question: "document-first real bundle smoke hallucination question", question_id: "q_document_first_bundle_smoke_02", hints: { corp_codes: [sample.corp_code] } };
    const outcome = await runAgentFlow(flow, input, bundleContext, LIMITS, bundleServiceAdapters);

    assert.deepEqual(validateFinalResponse(outcome.final_response), []);
    assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
    assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
    assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
    assert.doesNotMatch(outcome.final_response.answer, /888,888,888,888,888/);
    assert.match(outcome.final_response.answer, new RegExp(String(sample.normalized_value)));
  });

  await t.test("a fabricated document_id inserted into the model's answer is discarded even though the real document/Fact was genuinely grounded", async () => {
    const bundleContext = { ...harness.context, chunking_config_id: "document_first_bundle_smoke_chunking_v1", index_snapshot_id: "document_first_bundle_smoke_index_v1", as_of_date: "2030-01-01" };
    const bundleServiceAdapters = {
      ...harness.serviceAdapters,
      retriever: createRetrieverAdapter([{ documentId: sample.source_document_id, evidence: sampleEvidence }]),
    };
    const fabricatedDocumentId = "major_99999999999999";
    const baseModel = createDeterministicFakeModelAdapter({
      responder: () => ({
        text: `값은 ${sample.normalized_value}입니다 (출처: ${fabricatedDocumentId}).`,
        used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids,
      }),
    });
    const flow = createDocumentFirstRagFlow(baseModel);
    const input = { question: "document-first real bundle smoke fabricated document id question", question_id: "q_document_first_bundle_smoke_03", hints: { corp_codes: [sample.corp_code] } };
    const outcome = await runAgentFlow(flow, input, bundleContext, LIMITS, bundleServiceAdapters);

    assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
    assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
    assert.doesNotMatch(outcome.final_response.answer, new RegExp(fabricatedDocumentId));
    assert.match(outcome.final_response.answer, new RegExp(String(sample.normalized_value)));
  });
});
