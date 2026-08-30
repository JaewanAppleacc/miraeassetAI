// Synthetic contract tests for the HYBRID_RETRIEVAL Agent variant (Turn
// P2-H). Built the same way tests/agent-comparison-structured-first-agent.test.mjs
// is: every id/value below is made up for THIS file only -- none of it is
// derived from, or asserted to match, any real Seed/production/Gold record.
// This file extends the SHARED synthetic fixture (tests/lib/agent-comparison-
// fixture.mjs) by IMPORTING its exports read-only and layering its own
// additional local records/adapters on top -- it never edits that shared
// file (per this Turn's file-scope constraints).
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createHybridRetrievalFlow } from "../domain/agent-comparison/flows/hybrid-retrieval-agent.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import { instrumentModelAdapter, buildTelemetryEvent } from "../domain/agent-comparison/telemetry.mjs";
import { validateTelemetryEvent } from "../domain/agent-comparison/contracts.mjs";
import { validateFinalResponse } from "../domain/runtime/final-response-validator.mjs";
import {
  registerAgentVariant, getAgentVariantFactory, listRegisteredAgentVariantIds, _clearRegistryForTests,
} from "../domain/agent-comparison/variant-registry.mjs";
import "../domain/agent-comparison/register-hybrid-retrieval-variant.mjs";
import { createStructuredFirstFlow } from "../domain/agent-comparison/flows/structured-first-agent.mjs";
import {
  CORPUS_SNAPSHOT_ID, FACT_COVERAGE_SNAPSHOT_ID, FIXTURE_FACT, FIXTURE_EVIDENCE,
  syntheticContext, syntheticServiceAdapters,
} from "./lib/agent-comparison-fixture.mjs";
import { createSeedBundleHarness } from "../domain/agent-comparison/seed-bundle-harness.mjs";

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 5, maxToolCalls: 30, timeoutMs: 5000 });
const SUFFICIENT_INPUT = Object.freeze({
  question: "매출액이 얼마인가요?", question_id: "q_hybrid_sufficient",
  hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] },
});

function countingResponder(fn) {
  let calls = 0;
  const responder = (request) => { calls += 1; return fn(request); };
  return { responder, callCount: () => calls };
}

function retrieverCallCount(outcome) {
  return outcome.execution_trace.tool_calls.filter((entry) => entry.service === "Retriever" && entry.method === "retrieve").length;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- local (this-file-only) synthetic "evidence gap" fixture ---------------
// Simulates the scenario Retrieval is meant to recover from: a VERIFIED Fact
// whose OWN declared evidence_id is NOT returned by the Structured Store's
// EVIDENCE query (so structured-only grounding leaves it ungrounded), but
// which the SEPARATE, trusted EvidenceStore (the same boundary
// services.validator.validateEvidence always uses) genuinely has a VERIFIED
// record for.
const CHUNKING_CONFIG_ID = "chunking_synthetic_hybrid_fixture_0001";
const INDEX_SNAPSHOT_ID = "index_synthetic_hybrid_fixture_0001";

function padded(n, length) {
  return String(n).padStart(length, "0");
}
const factId = (n) => `fact_${padded(n, 24)}`;
const evidenceId = (n) => `evidence_${padded(n, 24)}`;
const fileId = (n) => `file_${padded(n, 24)}`;
const chunkId = (n) => `chunk_${padded(n, 24)}`;
const documentId = (n) => `periodic_${padded(n, 14)}`;

function makeGapFact({ n, corpCode, evidenceIdValue, quote }) {
  return Object.freeze({
    fact_id: factId(n),
    corp_code: corpCode,
    event_id: null,
    source_document_id: documentId(n),
    metric_code: "OPERATING_PROFIT",
    raw_label: "영업이익",
    value_type: "NUMERIC",
    value_status: "DISCLOSED",
    value_certainty: "CONFIRMED",
    raw_value_text: "500,000,000",
    raw_unit_text: "원",
    normalized_value: 500_000_000,
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
    evidence_ids: [evidenceIdValue],
    attributes: {},
  });
}

function makeGapEvidence({ n, evidenceIdValue, quote }) {
  const docId = documentId(n);
  const fId = fileId(n);
  return Object.freeze({
    evidence_id: evidenceIdValue,
    document_id: docId,
    file_id: fId,
    chunk_id: null,
    source_locator: `${docId}/${fId}#node=1`,
    quoted_text: quote,
    quote_sha256: sha256Hex(quote),
    extraction_method: "RULE",
    confidence: 1,
    verification_status: "VERIFIED",
    metadata: {},
  });
}

function structuredRecord(recordType, recordId, verificationStatus, knownAt, sourceDocumentIds, evidenceIds, payload) {
  return { record_type: recordType, record_id: recordId, verification_status: verificationStatus, known_at: knownAt, source_document_ids: sourceDocumentIds, evidence_ids: evidenceIds, payload };
}

function matchesQuery(query, record) {
  if (!query.targets.includes(record.record_type)) return false;
  if (query.corp_codes?.length > 0 && record.payload.corp_code && !query.corp_codes.includes(record.payload.corp_code)) return false;
  if (query.predicates.metric_codes?.length > 0 && record.payload.metric_code && !query.predicates.metric_codes.includes(record.payload.metric_code)) return false;
  if (query.predicates.fact_ids?.length > 0 && record.record_type === "FACT" && !query.predicates.fact_ids.includes(record.record_id)) return false;
  if (query.predicates.evidence_ids?.length > 0 && record.record_type === "EVIDENCE" && !query.predicates.evidence_ids.includes(record.record_id)) return false;
  if (query.predicates.event_ids?.length > 0 && record.record_type === "EVENT" && !query.predicates.event_ids.includes(record.record_id)) return false;
  if (query.predicates.document_ids?.length > 0 && !record.source_document_ids.some((id) => query.predicates.document_ids.includes(id))) return false;
  if (!query.verification_statuses.includes(record.verification_status)) return false;
  return true;
}

// `includeEvidenceRecord: false` is the deliberate gap: the FACT record is
// present (so factResult.status === "OK"), but no matching EVIDENCE record
// is ever returned by this adapter's own EVIDENCE target -- exactly the
// structural gap this variant's Retrieval-recovery step exists for.
function createGapStructuredStoreAdapter(fact, { includeEvidenceRecord = false, evidenceRecord = null } = {}) {
  const records = [structuredRecord("FACT", fact.fact_id, "VERIFIED", fact.known_at, [fact.source_document_id], fact.evidence_ids, fact)];
  if (includeEvidenceRecord && evidenceRecord) {
    records.push(structuredRecord("EVIDENCE", evidenceRecord.evidence_id, "VERIFIED", fact.known_at, [fact.source_document_id], [evidenceRecord.evidence_id], evidenceRecord));
  }
  return {
    async query(query) {
      const matching = records.filter((record) => matchesQuery(query, record));
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

function createGapEvidenceStoreAdapter(evidenceRecord) {
  return {
    async getEvidence(id) {
      if (!evidenceRecord || id !== evidenceRecord.evidence_id) return null;
      return { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, record: evidenceRecord };
    },
  };
}

function createGapDocumentStoreAdapter(fact, quote) {
  const docId = fact.source_document_id;
  return {
    async getDocument(id) {
      if (id !== docId) return null;
      return {
        document_id: docId,
        corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
        blocks: [{ file_id: fileId(Number(docId.replace("periodic_", ""))), source_locator: `${docId}/${fileId(Number(docId.replace("periodic_", "")))}#node=1`, text: quote }],
      };
    },
  };
}

function retrievalItem({ documentId: docId, fId, sourceLocator, rawText, chunkIdValue, score = 5, retrievalMethod = "BM25" }) {
  const scoreTypeByMethod = { BM25: "BM25", DENSE: "COSINE", HYBRID_RRF: "RRF", HYBRID_RRF_RERANKER: "RERANKER" };
  return {
    score,
    score_type: scoreTypeByMethod[retrievalMethod] ?? "BM25",
    component_scores: { bm25: retrievalMethod === "BM25" ? score : null, dense: null, rrf: null, reranker: null },
    document_id: docId,
    chunk_id: chunkIdValue,
    chunk_type: "SECTION_FLAT",
    parent_chunk_id: null,
    text_provenance: "SOURCE_VERBATIM",
    citation_authority: "SOURCE_SPANS",
    raw_text: rawText,
    source_locator: sourceLocator,
    source_spans: [{ file_id: fId, rel_path: "synthetic.xml", node_id: "n1", order_index: 1, row_start: null, row_end: null, col_start: null, col_end: null, source_locator: sourceLocator }],
  };
}

function createSyntheticRetrieverAdapter(itemsFactory) {
  return {
    async retrieve(request) {
      const items = itemsFactory(request);
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
        results: items.map((item, index) => ({ ...item, rank: index + 1 })),
      };
    },
  };
}

function createFailingRetrieverAdapter() {
  return { async retrieve() { throw new Error("simulated retriever backend failure"); } };
}

function hybridContext(overrides = {}) {
  return syntheticContext({ chunking_config_id: CHUNKING_CONFIG_ID, index_snapshot_id: INDEX_SNAPSHOT_ID, ...overrides });
}

// One consistent "gap" Fact/Evidence pair reused by several tests below.
const GAP_N = 900;
const GAP_CORP_CODE = "00000090";
const GAP_QUOTE = "영업이익은 500,000,000원입니다.";
const GAP_EVIDENCE_ID = evidenceId(GAP_N);
const GAP_FACT = makeGapFact({ n: GAP_N, corpCode: GAP_CORP_CODE, evidenceIdValue: GAP_EVIDENCE_ID, quote: GAP_QUOTE });
const GAP_EVIDENCE = makeGapEvidence({ n: GAP_N, evidenceIdValue: GAP_EVIDENCE_ID, quote: GAP_QUOTE });
const GAP_INPUT = Object.freeze({
  question: "영업이익이 얼마인가요?", question_id: "q_hybrid_gap",
  hints: { corp_codes: [GAP_FACT.corp_code], metric_codes: [GAP_FACT.metric_code] },
});

function gapServiceAdapters({ retriever } = {}) {
  return {
    structuredStoreAdapter: createGapStructuredStoreAdapter(GAP_FACT, { includeEvidenceRecord: false }),
    evidenceStoreAdapter: createGapEvidenceStoreAdapter(GAP_EVIDENCE),
    documentStoreAdapter: createGapDocumentStoreAdapter(GAP_FACT, GAP_QUOTE),
    retriever,
  };
}

function successfulGapRetriever() {
  return createSyntheticRetrieverAdapter((request) =>
    request.metadata_filters.document_ids.includes(GAP_FACT.source_document_id)
      ? [retrievalItem({
          documentId: GAP_FACT.source_document_id,
          fId: fileId(GAP_N),
          sourceLocator: `${GAP_FACT.source_document_id}/${fileId(GAP_N)}#node=1`,
          rawText: GAP_QUOTE,
          chunkIdValue: chunkId(GAP_N),
        })]
      : []);
}

// ---------------------------------------------------------------------------

test("HYBRID_RETRIEVAL: sufficient structured coverage (all Fact evidence already validated) -> the Retriever is never called", async () => {
  const { responder } = countingResponder(() => ({
    text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`,
    used_fact_ids: [FIXTURE_FACT.fact_id],
    used_evidence_ids: [FIXTURE_EVIDENCE.evidence_id],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, SUFFICIENT_INPUT, hybridContext(), LIMITS, syntheticServiceAdapters());

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(retrieverCallCount(outcome), 0);
  assert.equal(outcome.final_response.think_trace.execution_mode, "STRUCTURED");
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.deepEqual(outcome.execution_trace.selected_evidence, [FIXTURE_EVIDENCE.evidence_id]);
});

test("HYBRID_RETRIEVAL reports an information limit (never a guess) when no company/metric/document condition can be identified -- neither the Structured Store nor the Retriever is ever called, execution_mode=EARLY_EXIT", async () => {
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const input = { question: "이 회사는 어떤가요?", question_id: "q_hybrid_no_conditions" };
  const outcome = await runAgentFlow(flow, input, hybridContext(), LIMITS, syntheticServiceAdapters());

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(outcome.final_response.think_trace.validation.reason, "NO_CONDITIONS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(callCount(), 0);
  assert.equal(retrieverCallCount(outcome), 0);
});

test("HYBRID_RETRIEVAL reports NOT_FOUND without ever calling the Retriever when the Structured Store has no Fact at all -- there is no Fact-declared evidence_id for Retrieval to recover against", async () => {
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createHybridRetrievalFlow(modelAdapter);
  const input = { question: "매출액이 얼마인가요?", question_id: "q_hybrid_not_found", hints: { corp_codes: ["99999999"], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, hybridContext(), LIMITS, syntheticServiceAdapters());

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(outcome.final_response.think_trace.validation.reason, "NOT_FOUND");
  assert.equal(retrieverCallCount(outcome), 0);
});

test("HYBRID_RETRIEVAL only ever queries execution_scope OFFICIAL / verification_statuses VERIFIED against the Structured Store", async () => {
  let sawNonOfficialQuery = false;
  const baseAdapters = syntheticServiceAdapters();
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
  const flow = createHybridRetrievalFlow(modelAdapter);
  await runAgentFlow(flow, SUFFICIENT_INPUT, hybridContext(), LIMITS, guardedAdapters);
  assert.equal(sawNonOfficialQuery, false);
});

test("HYBRID_RETRIEVAL: insufficient structured coverage (Fact found, its own evidence_id not returned by the Structured Store's EVIDENCE query) triggers exactly ONE Retriever call, whose recovered+validated Evidence is combined with the structured Fact -- execution_mode=BOTH", async () => {
  const { responder } = countingResponder(() => ({
    text: `영업이익은 ${GAP_FACT.normalized_value}원입니다.`,
    used_fact_ids: [GAP_FACT.fact_id],
    used_evidence_ids: [GAP_EVIDENCE_ID],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, gapServiceAdapters({ retriever: successfulGapRetriever() }));

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(retrieverCallCount(outcome), 1);
  assert.equal(outcome.final_response.think_trace.execution_mode, "BOTH");
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.deepEqual(outcome.execution_trace.selected_evidence, [GAP_EVIDENCE_ID]);
  assert.match(outcome.final_response.answer, new RegExp(String(GAP_FACT.normalized_value)));
});

test("HYBRID_RETRIEVAL: an UNVALIDATED retrieval chunk (no matching VERIFIED Evidence record at all) is discarded, never merged in -- with nothing else grounded this is an honest EARLY_EXIT information limit, not a model fallback", async () => {
  const retriever = createSyntheticRetrieverAdapter((request) =>
    request.metadata_filters.document_ids.includes(GAP_FACT.source_document_id)
      ? [retrievalItem({
          documentId: GAP_FACT.source_document_id,
          fId: fileId(GAP_N),
          sourceLocator: `${GAP_FACT.source_document_id}/${fileId(GAP_N)}#node=1`,
          rawText: GAP_QUOTE,
          chunkIdValue: chunkId(GAP_N),
        })]
      : []);
  const adapters = gapServiceAdapters({ retriever });
  // The trusted EvidenceStore has NOTHING for GAP_EVIDENCE_ID at all in this
  // test -- simulates a retrieved chunk that cannot be confirmed as real
  // Evidence by any registered record (EVIDENCE_NOT_FOUND), distinct from a
  // chunk that resolves but disagrees with what's on record (see the
  // "conflict" test below).
  adapters.evidenceStoreAdapter = { async getEvidence() { return null; } };
  const { responder, callCount } = countingResponder(() => ({ text: "should never run", used_fact_ids: [], used_evidence_ids: [] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(retrieverCallCount(outcome), 1);
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(outcome.final_response.think_trace.validation.reason, "NO_GROUNDED_EVIDENCE");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(callCount(), 0);
});

test("HYBRID_RETRIEVAL: a retrieved chunk whose text CONFLICTS with the trusted Evidence record for that same evidence_id (quote/hash mismatch) is fail-closed -- never arbitrarily merged in as if it agreed", async () => {
  const conflictingText = "영업이익은 999,999,999원입니다.";
  const retriever = createSyntheticRetrieverAdapter((request) =>
    request.metadata_filters.document_ids.includes(GAP_FACT.source_document_id)
      ? [retrievalItem({
          documentId: GAP_FACT.source_document_id,
          fId: fileId(GAP_N),
          sourceLocator: `${GAP_FACT.source_document_id}/${fileId(GAP_N)}#node=1`,
          rawText: conflictingText, // disagrees with GAP_EVIDENCE.quoted_text (GAP_QUOTE)
          chunkIdValue: chunkId(GAP_N),
        })]
      : []);
  const adapters = gapServiceAdapters({ retriever }); // GAP_EVIDENCE (the real, VERIFIED record) is still registered and disagrees
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(outcome.final_response.think_trace.validation.reason, "NO_GROUNDED_EVIDENCE");
  assert.doesNotMatch(outcome.final_response.answer, /999,999,999/);
  const conflictOps = outcome.execution_trace.operations.filter((op) => op.service === "AgentFlow"); // sanity: no unexpected AgentFlow-level rejection
  assert.equal(conflictOps.length, 0);
});

test("HYBRID_RETRIEVAL: duplicate retrieved chunks for the same evidence_id are deduplicated -- only one VALIDATE_RETRIEVED_EVIDENCE attempt is made and selected_evidence has no duplicates", async () => {
  const retriever = createSyntheticRetrieverAdapter((request) =>
    request.metadata_filters.document_ids.includes(GAP_FACT.source_document_id)
      ? [
          retrievalItem({ documentId: GAP_FACT.source_document_id, fId: fileId(GAP_N), sourceLocator: `${GAP_FACT.source_document_id}/${fileId(GAP_N)}#node=1`, rawText: GAP_QUOTE, chunkIdValue: chunkId(GAP_N), score: 5 }),
          retrievalItem({ documentId: GAP_FACT.source_document_id, fId: fileId(GAP_N), sourceLocator: `${GAP_FACT.source_document_id}/${fileId(GAP_N)}#node=1`, rawText: GAP_QUOTE, chunkIdValue: chunkId(GAP_N), score: 5 }),
        ]
      : []);
  const adapters = gapServiceAdapters({ retriever });
  const { responder } = countingResponder(() => ({ text: `영업이익은 ${GAP_FACT.normalized_value}원입니다.`, used_fact_ids: [GAP_FACT.fact_id], used_evidence_ids: [GAP_EVIDENCE_ID] }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.deepEqual(outcome.execution_trace.selected_evidence, [GAP_EVIDENCE_ID]);
  const validateEvidenceAttempts = outcome.execution_trace.tool_calls.filter((entry) => entry.service === "Validator" && entry.method === "validateEvidence");
  // One structured-pass attempt is impossible here (the structured EVIDENCE
  // query never returns a record for this gap fixture), so every
  // validateEvidence attempt in this trace is retrieval-sourced -- exactly
  // one, despite two identical retrieved chunks.
  assert.equal(validateEvidenceAttempts.length, 1);
});

test("HYBRID_RETRIEVAL: a Retriever adapter failure is recorded explicitly (RETRIEVAL_FAILED) -- never disguised as a model success or reduced to the generic NOT_FOUND reason", async () => {
  const adapters = gapServiceAdapters({ retriever: createFailingRetrieverAdapter() });
  const baseModel = createDeterministicFakeModelAdapter();
  const { adapter: instrumented, usage } = instrumentModelAdapter(baseModel);
  const flow = createHybridRetrievalFlow(instrumented);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, adapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(retrieverCallCount(outcome), 1);
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(outcome.final_response.think_trace.validation.reason, "RETRIEVAL_FAILED");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, true);
  assert.equal(usage().model_call_attempt_count, 0);

  const event = buildTelemetryEvent({
    benchmarkRunId: "synthetic", agentVariantId: "HYBRID_RETRIEVAL", modelConfigId: "model_fake-deterministic-v1",
    executionScope: "OFFICIAL", question: GAP_INPUT.question, questionId: GAP_INPUT.question_id, agentOutcome: outcome, modelUsage: usage(),
  });
  assert.deepEqual(validateTelemetryEvent(event), []);
  assert.equal(event.document_retrieval_count, 1);
  assert.equal(event.model_call_attempt_count, 0);
  assert.equal(event.scoring_eligible, true);
  assert.equal(event.model_fallback_used, false);
});

test("HYBRID_RETRIEVAL: a model CALL failure AFTER a successful retrieval recovery still falls back to a deterministic, fully-grounded answer -- citation_binding_status=NOT_CHECKED, model_fallback_used=true, scoring_eligible=false", async () => {
  const failingModelAdapter = { generate: async () => { throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout"); } };
  const flow = createHybridRetrievalFlow(failingModelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, gapServiceAdapters({ retriever: successfulGapRetriever() }));

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(outcome.final_response.think_trace.execution_mode, "BOTH");
  assert.match(outcome.final_response.answer, new RegExp(String(GAP_FACT.normalized_value)));
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "NOT_CHECKED");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
});

test("HYBRID_RETRIEVAL: a model answer inserting an unsupported NUMBER not present in either the structured Fact or the retrieval-recovered Evidence is discarded wholesale -- citation_binding_status=FAIL", async () => {
  const { responder } = countingResponder(() => ({
    text: "영업이익은 9,999,999,999원입니다.",
    used_fact_ids: [GAP_FACT.fact_id],
    used_evidence_ids: [GAP_EVIDENCE_ID],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, gapServiceAdapters({ retriever: successfulGapRetriever() }));

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
  assert.equal(outcome.final_response.think_trace.validation.unsupported_claim_count >= 1, true);
  assert.doesNotMatch(outcome.final_response.answer, /9,999,999,999/);
});

test("HYBRID_RETRIEVAL: a model answer inserting an unsupported DATE is discarded wholesale -- citation_binding_status=FAIL", async () => {
  const { responder } = countingResponder(() => ({
    text: "이 값은 2031-06-30 기준입니다.",
    used_fact_ids: [GAP_FACT.fact_id],
    used_evidence_ids: [GAP_EVIDENCE_ID],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, gapServiceAdapters({ retriever: successfulGapRetriever() }));

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.unsupported_claim_count >= 1, true);
});

test("HYBRID_RETRIEVAL: a model answer inserting a DIFFERENT company's corp_code (this codebase's own identity/join key) is discarded wholesale -- citation_binding_status=FAIL", async () => {
  const { responder } = countingResponder(() => ({
    text: `영업이익은 ${GAP_FACT.normalized_value}원입니다 (관련 기업 코드 ${FIXTURE_FACT.corp_code}).`,
    used_fact_ids: [GAP_FACT.fact_id],
    used_evidence_ids: [GAP_EVIDENCE_ID],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, gapServiceAdapters({ retriever: successfulGapRetriever() }));

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.doesNotMatch(outcome.final_response.answer, new RegExp(FIXTURE_FACT.corp_code));
});

test("HYBRID_RETRIEVAL: a model answer citing an unauthorized fact_id (never queried/grounded this request) is discarded wholesale -- citation_binding_status=FAIL", async () => {
  const { responder } = countingResponder(() => ({
    text: "그럴듯하지만 근거 없는 답변입니다.",
    used_fact_ids: [FIXTURE_FACT.fact_id],
    used_evidence_ids: [],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, gapServiceAdapters({ retriever: successfulGapRetriever() }));

  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.doesNotMatch(outcome.final_response.answer, /그럴듯하지만/);
});

test("HYBRID_RETRIEVAL: exceeding the execution budget's maxRetrievals blocks the Retriever call entirely -- the request fails closed via runAgentFlow's own BUDGET_EXCEEDED accounting, never a disguised model success", async () => {
  const zeroRetrievalLimits = Object.freeze({ ...LIMITS, maxRetrievals: 0 });
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), zeroRetrievalLimits, gapServiceAdapters({ retriever: successfulGapRetriever() }));

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(typeof outcome.execution_trace.fallback_reason, "string");
  assert.match(outcome.execution_trace.fallback_reason, /^BUDGET_EXCEEDED:maxRetrievals$/);
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
});

test("HYBRID_RETRIEVAL: identical input produces a deterministic answer and telemetry on repeated runs", async () => {
  async function runOnce() {
    const { responder } = countingResponder(() => ({
      text: `영업이익은 ${GAP_FACT.normalized_value}원입니다.`,
      used_fact_ids: [GAP_FACT.fact_id],
      used_evidence_ids: [GAP_EVIDENCE_ID],
    }));
    const baseModel = createDeterministicFakeModelAdapter({ responder });
    const { adapter: instrumented, usage } = instrumentModelAdapter(baseModel);
    const flow = createHybridRetrievalFlow(instrumented);
    const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, gapServiceAdapters({ retriever: successfulGapRetriever() }));
    const event = buildTelemetryEvent({
      benchmarkRunId: "synthetic_deterministic", agentVariantId: "HYBRID_RETRIEVAL", modelConfigId: "model_fake-deterministic-v1",
      executionScope: "OFFICIAL", question: GAP_INPUT.question, questionId: GAP_INPUT.question_id, agentOutcome: outcome, modelUsage: usage(),
      createdAt: "2026-01-01T00:00:00.000Z", telemetryEventId: "telemetry_deterministic_test",
    });
    return { finalResponse: outcome.final_response, event };
  }

  const first = await runOnce();
  const second = await runOnce();
  assert.deepEqual(first.finalResponse, second.finalResponse);
  // latency_ms is a genuine wall-clock measurement (Date.now() deltas), not
  // part of this Flow's own decision logic -- everything else on the
  // TelemetryEvent (answer text, ids, counts, statuses) must still match
  // exactly.
  const { latency_ms: firstLatency, ...firstRest } = first.event;
  const { latency_ms: secondLatency, ...secondRest } = second.event;
  assert.deepEqual(firstRest, secondRest);
  assert.equal(typeof firstLatency, "number");
  assert.equal(typeof secondLatency, "number");
});

test("HYBRID_RETRIEVAL: raw prompt/response text is never stored on the outcome or execution_trace -- only ids/codes/counts", async () => {
  const { responder } = countingResponder(() => ({
    text: `영업이익은 ${GAP_FACT.normalized_value}원입니다.`,
    used_fact_ids: [GAP_FACT.fact_id],
    used_evidence_ids: [GAP_EVIDENCE_ID],
  }));
  const modelAdapter = createDeterministicFakeModelAdapter({ responder });
  const flow = createHybridRetrievalFlow(modelAdapter);
  const outcome = await runAgentFlow(flow, GAP_INPUT, hybridContext(), LIMITS, gapServiceAdapters({ retriever: successfulGapRetriever() }));
  const serialized = JSON.stringify(outcome.execution_trace);
  assert.doesNotMatch(serialized, /매출액|영업이익/);
});

test("registering HYBRID_RETRIEVAL does not disturb STRUCTURED_FIRST's own registration or any other variant's registry state", () => {
  _clearRegistryForTests();
  try {
    registerAgentVariant("STRUCTURED_FIRST", (modelAdapter, options) => createStructuredFirstFlow(modelAdapter, options));
    registerAgentVariant("HYBRID_RETRIEVAL", (modelAdapter, options) => createHybridRetrievalFlow(modelAdapter, options));

    const ids = listRegisteredAgentVariantIds();
    assert.ok(ids.includes("STRUCTURED_FIRST"));
    assert.ok(ids.includes("HYBRID_RETRIEVAL"));
    assert.equal(ids.length, 2);

    const structuredFactory = getAgentVariantFactory("STRUCTURED_FIRST");
    const hybridFactory = getAgentVariantFactory("HYBRID_RETRIEVAL");
    const structuredFlow = structuredFactory(createDeterministicFakeModelAdapter());
    const hybridFlow = hybridFactory(createDeterministicFakeModelAdapter());
    assert.equal(structuredFlow.id, "STRUCTURED_FIRST");
    assert.equal(hybridFlow.id, "HYBRID_RETRIEVAL");
  } finally {
    _clearRegistryForTests();
  }
});

test("sanity: fixture context/snapshot ids are what the shared fixture module exports (no drift between this test and the shared fixture)", () => {
  assert.equal(CORPUS_SNAPSHOT_ID, "corpus_synthetic_fixture_0001");
  assert.equal(FACT_COVERAGE_SNAPSHOT_ID, "fact_coverage_snapshot_synthetic_fixture_0001");
});

// --- real v0.20-r3 bundle smoke (read-only) ---------------------------
// Mirrors tests/agent-comparison-real-bundle-smoke.test.mjs's own pattern
// exactly (same createSeedBundleHarness construction point production
// uses), applied to HYBRID_RETRIEVAL instead of STRUCTURED_FIRST. No real
// Retriever adapter is wired here (none exists in this codebase yet -- see
// retriever-store.mjs's own KNOWN LIMITATION), so every scenario below
// deliberately stays within this variant's structured-sufficient path,
// which never calls the Retriever at all -- exactly what
// "구조화 정보가 충분한 경우 Retrieval 미호출 확인" asks this smoke test to
// demonstrate. The harness materializes the approved bundle into a private
// mkdtemp() directory and removes it in test.after -- no git-tracked bundle
// or production file is ever written to.
let harness;
let realSample;

test.before(async () => {
  harness = await createSeedBundleHarness({ root: process.cwd() });
  const probeQuery = {
    schema_version: "0.2.0", query_id: "query_hybrid_real_bundle_smoke_probe", execution_scope: "OFFICIAL",
    corpus_snapshot_id: harness.context.corpus_snapshot_id, fact_coverage_snapshot_id: harness.context.fact_coverage_snapshot_id,
    targets: ["FACT"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: "2030-01-01", limit: 1,
  };
  const probeResult = await harness.serviceAdapters.structuredStoreAdapter.query(probeQuery);
  assert.equal(probeResult.status, "OK", "the real v0.20-r3 bundle must expose at least one VERIFIED Fact");
  realSample = probeResult.records[0].payload;
});

test.after(async () => {
  if (harness) await harness.dispose();
});

test("HYBRID_RETRIEVAL real bundle smoke: a well-behaved model answer over a REAL VERIFIED Fact PASSES citation binding end-to-end, and the Retriever is never called because structured coverage is already sufficient", async () => {
  const baseModel = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `값은 ${realSample.normalized_value}입니다.`, used_fact_ids: [realSample.fact_id], used_evidence_ids: realSample.evidence_ids }),
  });
  const { adapter: instrumented, usage } = instrumentModelAdapter(baseModel);
  const flow = createHybridRetrievalFlow(instrumented);
  const input = { question: "hybrid retrieval real bundle smoke question", question_id: "q_hybrid_real_bundle_smoke_01", hints: { corp_codes: [realSample.corp_code], metric_codes: [realSample.metric_code] } };
  const context = { ...harness.context, as_of_date: "2030-01-01" };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, harness.serviceAdapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(retrieverCallCount(outcome), 0);
  assert.equal(outcome.final_response.think_trace.execution_mode, "STRUCTURED");
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
  assert.deepEqual(outcome.execution_trace.selected_evidence, realSample.evidence_ids);

  const event = buildTelemetryEvent({
    benchmarkRunId: "hybrid_real_bundle_smoke", agentVariantId: "HYBRID_RETRIEVAL", modelConfigId: "model_fake-deterministic-v1",
    executionScope: "OFFICIAL", question: input.question, questionId: input.question_id, agentOutcome: outcome, modelUsage: usage(),
  });
  assert.deepEqual(validateTelemetryEvent(event), []);
  assert.equal(event.document_retrieval_count, 0);
  assert.equal(event.citation_binding_status, "PASS");
  assert.equal(event.scoring_eligible, true);
});

test("HYBRID_RETRIEVAL real bundle smoke: a hallucinated number never present in the real VERIFIED Fact/Evidence is discarded (FAIL -> deterministic fallback), and the fallback contains the REAL value instead", async () => {
  const baseModel = createDeterministicFakeModelAdapter({
    responder: () => ({ text: "값은 999,999,999,999,999입니다.", used_fact_ids: [realSample.fact_id], used_evidence_ids: realSample.evidence_ids }),
  });
  const flow = createHybridRetrievalFlow(baseModel);
  const input = { question: "hybrid retrieval real bundle smoke hallucination question", question_id: "q_hybrid_real_bundle_smoke_02", hints: { corp_codes: [realSample.corp_code], metric_codes: [realSample.metric_code] } };
  const context = { ...harness.context, as_of_date: "2030-01-01" };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, harness.serviceAdapters);

  assert.deepEqual(validateFinalResponse(outcome.final_response), []);
  assert.equal(retrieverCallCount(outcome), 0);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "FAIL");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, true);
  assert.equal(outcome.final_response.think_trace.validation.scoring_eligible, false);
  assert.doesNotMatch(outcome.final_response.answer, /999,999,999,999,999/);
  assert.match(outcome.final_response.answer, new RegExp(String(realSample.normalized_value)));
});
