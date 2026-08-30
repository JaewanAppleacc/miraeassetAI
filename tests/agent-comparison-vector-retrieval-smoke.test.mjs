// Turn P4 Agent smoke: proves the pgvector-backed Retriever adapter
// (domain/agent-comparison/retrieval/pgvector-retriever-adapter.mjs) can be
// wired into HYBRID_RETRIEVAL and DOCUMENT_FIRST_RAG via
// domain/agent-comparison/integration/wire-vector-retriever.mjs WITHOUT
// modifying either variant's own flow file, and that each variant's
// documented retrieval semantics hold exactly as designed with a REAL
// (fake-backed, deterministic) vector search in the loop -- not just the
// non-vector retrieval path each variant's own dedicated test file already
// covers. This file does not re-derive those variants' full internal
// correctness (see tests/agent-comparison-{hybrid-retrieval,document-first-rag}.test.mjs
// for that).
import assert from "node:assert/strict";
import test from "node:test";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createHybridRetrievalFlow } from "../domain/agent-comparison/flows/hybrid-retrieval-agent.mjs";
import { createDocumentFirstRagFlow } from "../domain/agent-comparison/flows/document-first-rag-agent.mjs";
import { createStructuredFirstFlow } from "../domain/agent-comparison/flows/structured-first-agent.mjs";
import { createPlannerFlow } from "../domain/agent-comparison/flows/planner-agent.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { createPgvectorRetrieverAdapter } from "../domain/agent-comparison/retrieval/pgvector-retriever-adapter.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "../domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs";
import { withVectorRetrieval } from "../domain/agent-comparison/integration/wire-vector-retriever.mjs";
import {
  FIXTURE_FACT, FIXTURE_EVIDENCE, FIXTURE_UNAUTHORIZED_FACT, FIXTURE_UNAUTHORIZED_EVIDENCE,
  CORPUS_SNAPSHOT_ID, FACT_COVERAGE_SNAPSHOT_ID, syntheticServiceAdapters,
} from "./lib/agent-comparison-fixture.mjs";

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 5, maxToolCalls: 50, timeoutMs: 30000 });
const RETRIEVAL_INDEX_ID = "retrieval_index_test_synthetic";
const CHUNKING_CONFIG_ID = "chunking_config_test_synthetic";
const INDEX_SNAPSHOT_ID = "index_snapshot_test_synthetic";

function baseContext() {
  return { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID, as_of_date: "2026-01-15" };
}

// A structured store adapter that reports the Fact normally but returns a
// BROKEN (no quoted_text) Evidence payload -- this is what actually makes
// ungroundedCount > 0 and triggers HYBRID_RETRIEVAL's own gap-recovery
// path (see that file's own header comment, step 4/5).
function structuredAdapterWithEvidenceGap() {
  const base = syntheticServiceAdapters().structuredStoreAdapter;
  return {
    async query(query) {
      const result = await base.query(query);
      if (query.targets.includes("EVIDENCE")) {
        return { ...result, records: result.records.map((r) => ({ ...r, payload: { ...r.payload, quoted_text: null, quote_sha256: null } })) };
      }
      return result;
    },
  };
}

function fakeVectorRepositoryReturning(hits) {
  return { async search() { return hits; } };
}

function realEvidenceHit(overrides = {}) {
  return {
    chunk_id: "chunk_000000000000000000000099",
    source_kind: "VERIFIED_EVIDENCE",
    evidence_id: FIXTURE_EVIDENCE.evidence_id,
    source_document_id: FIXTURE_FACT.source_document_id,
    corp_code: FIXTURE_FACT.corp_code,
    source_locator: FIXTURE_EVIDENCE.source_locator,
    chunk_ordinal: 0,
    text_sha256: FIXTURE_EVIDENCE.quote_sha256,
    text_content: FIXTURE_EVIDENCE.quoted_text,
    metadata: { file_id: FIXTURE_EVIDENCE.file_id },
    similarity_score: 0.95,
    retrieval_index_id: RETRIEVAL_INDEX_ID,
    release_id: "synthetic-fixture",
    source_snapshot_id: CORPUS_SNAPSHOT_ID,
    ...overrides,
  };
}

function wire(vectorRepository, base = {}) {
  const retrieverAdapter = createPgvectorRetrieverAdapter({
    vectorRepository,
    embeddingAdapter: createDeterministicFakeEmbeddingAdapter({ dimension: 8 }),
    embeddingConfig: { dimension: 8 },
    retrievalIndexId: RETRIEVAL_INDEX_ID,
  });
  return withVectorRetrieval({
    context: base.context ?? baseContext(),
    serviceAdapters: base.serviceAdapters ?? syntheticServiceAdapters(),
    retrieverAdapter,
    chunkingConfigId: CHUNKING_CONFIG_ID,
    indexSnapshotId: INDEX_SNAPSHOT_ID,
  });
}

test("HYBRID_RETRIEVAL: a structural evidence GAP is recovered via the real (fake-backed) vector retriever, and the recovered Fact is grounded", async () => {
  const { context, serviceAdapters } = wire(fakeVectorRepositoryReturning([realEvidenceHit()]), {
    serviceAdapters: { ...syntheticServiceAdapters(), structuredStoreAdapter: structuredAdapterWithEvidenceGap() },
  });
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`, used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: [FIXTURE_EVIDENCE.evidence_id] }),
  });
  const flow = createHybridRetrievalFlow(modelAdapter, { retrievalMethod: "DENSE" });
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_01", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, serviceAdapters);

  assert.equal(outcome.execution_trace.tool_calls.filter((c) => c.service === "Retriever").length, 1, "exactly one Retriever call should have been made to recover the gap");
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
});

test("HYBRID_RETRIEVAL: when the Fact itself is entirely absent, the vector retriever is NEVER called (retrieval never substitutes for a missing Fact)", async () => {
  const { context, serviceAdapters } = wire(fakeVectorRepositoryReturning([realEvidenceHit()]));
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createHybridRetrievalFlow(modelAdapter, { retrievalMethod: "DENSE" });
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_02", hints: { corp_codes: ["99999999"], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, serviceAdapters);

  assert.equal(outcome.execution_trace.tool_calls.filter((c) => c.service === "Retriever").length, 0);
  assert.equal(outcome.final_response.think_trace.validation.answerability, "UNANSWERABLE");
});

test("HYBRID_RETRIEVAL: a fabricated (locator/hash-altered) retrieved candidate is rejected by validateEvidence -- never grounds a Fact from an unverifiable recovery", async () => {
  const tamperedHit = realEvidenceHit({ text_content: "조작된 문장입니다." }); // raw_text no longer matches the real EvidenceStore's quoted_text -> hash mismatch
  const { context, serviceAdapters } = wire(fakeVectorRepositoryReturning([tamperedHit]), {
    serviceAdapters: { ...syntheticServiceAdapters(), structuredStoreAdapter: structuredAdapterWithEvidenceGap() },
  });
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createHybridRetrievalFlow(modelAdapter, { retrievalMethod: "DENSE" });
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_03", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, serviceAdapters);

  assert.equal(outcome.final_response.think_trace.validation.answerability, "UNANSWERABLE");
  assert.equal(outcome.final_response.think_trace.validation.model_fallback_used, false);
});

test("DOCUMENT_FIRST_RAG: a vector-retrieved candidate cross-validated against Structured Store + Validator grounds the answer", async () => {
  const { context, serviceAdapters } = wire(fakeVectorRepositoryReturning([realEvidenceHit()]));
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`, used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: [FIXTURE_EVIDENCE.evidence_id] }),
  });
  const flow = createDocumentFirstRagFlow(modelAdapter, { retrievalMethod: "DENSE" });
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_04", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, serviceAdapters);

  assert.equal(outcome.execution_trace.tool_calls.some((c) => c.service === "Retriever"), true);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
});

test("DOCUMENT_FIRST_RAG: a high-similarity candidate for an UNAUTHORIZED/different company's document is never grounded, regardless of its similarity score", async () => {
  const foreignHit = realEvidenceHit({
    source_document_id: FIXTURE_UNAUTHORIZED_FACT.source_document_id,
    corp_code: FIXTURE_UNAUTHORIZED_FACT.corp_code,
    source_locator: FIXTURE_UNAUTHORIZED_EVIDENCE.source_locator,
    evidence_id: FIXTURE_UNAUTHORIZED_EVIDENCE.evidence_id,
    text_content: FIXTURE_UNAUTHORIZED_EVIDENCE.quoted_text,
    text_sha256: FIXTURE_UNAUTHORIZED_EVIDENCE.quote_sha256,
    metadata: { file_id: FIXTURE_UNAUTHORIZED_EVIDENCE.file_id },
    similarity_score: 0.999,
  });
  const { context, serviceAdapters } = wire(fakeVectorRepositoryReturning([foreignHit]));
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createDocumentFirstRagFlow(modelAdapter, { retrievalMethod: "DENSE" });
  // Requesting FIXTURE_FACT's company specifically -- the retriever
  // "helpfully" returns a different company's document instead.
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_05", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, serviceAdapters);

  assert.notEqual(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
  assert.doesNotMatch(outcome.final_response.answer, new RegExp(String(FIXTURE_UNAUTHORIZED_FACT.normalized_value)));
});

test("STRUCTURED_FIRST is unaffected by a wired vector retriever (no retrieval code path exists for it)", async () => {
  const { context, serviceAdapters } = wire(fakeVectorRepositoryReturning([realEvidenceHit()]));
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`, used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: [FIXTURE_EVIDENCE.evidence_id] }),
  });
  const flow = createStructuredFirstFlow(modelAdapter);
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_06", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, serviceAdapters);

  assert.equal(outcome.execution_trace.tool_calls.filter((c) => c.service === "Retriever").length, 0);
  assert.equal(outcome.final_response.think_trace.validation.citation_binding_status, "PASS");
});

test("PLANNER is unaffected by a wired vector retriever when enable_retrieval_fallback is not set", async () => {
  const { context, serviceAdapters } = wire(fakeVectorRepositoryReturning([realEvidenceHit()]));
  const modelAdapter = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`, used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: [FIXTURE_EVIDENCE.evidence_id] }),
  });
  const flow = createPlannerFlow(modelAdapter, { retrievalMethod: "DENSE" });
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_07", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, serviceAdapters);

  assert.equal(outcome.execution_trace.tool_calls.filter((c) => c.service === "Retriever").length, 0);
});

test("telemetry: document_retrieval_count is 0 for a run that never triggers retrieval, and > 0 for one that does", async () => {
  const noGapWiring = wire(fakeVectorRepositoryReturning([realEvidenceHit()]));
  const modelAdapterA = createDeterministicFakeModelAdapter({
    responder: () => ({ text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`, used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: [FIXTURE_EVIDENCE.evidence_id] }),
  });
  const flowNoGap = createHybridRetrievalFlow(modelAdapterA, { retrievalMethod: "DENSE" });
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_08", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcomeNoGap = await runAgentFlow(flowNoGap, input, noGapWiring.context, LIMITS, noGapWiring.serviceAdapters);
  const retrieverCallsNoGap = outcomeNoGap.execution_trace.tool_calls.filter((c) => c.service === "Retriever").length;
  assert.equal(retrieverCallsNoGap, 0);

  const gapWiring = wire(fakeVectorRepositoryReturning([realEvidenceHit()]), {
    serviceAdapters: { ...syntheticServiceAdapters(), structuredStoreAdapter: structuredAdapterWithEvidenceGap() },
  });
  const flowGap = createHybridRetrievalFlow(createDeterministicFakeModelAdapter({
    responder: () => ({ text: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`, used_fact_ids: [FIXTURE_FACT.fact_id], used_evidence_ids: [FIXTURE_EVIDENCE.evidence_id] }),
  }), { retrievalMethod: "DENSE" });
  const outcomeGap = await runAgentFlow(flowGap, input, gapWiring.context, LIMITS, gapWiring.serviceAdapters);
  const retrieverCallsGap = outcomeGap.execution_trace.tool_calls.filter((c) => c.service === "Retriever").length;
  assert.ok(retrieverCallsGap > 0);
});

test("model failure and retrieval failure are distinguished: a broken Retriever adapter fails closed to an information limit, never mistaken for a model failure", async () => {
  const throwingVectorRepository = { async search() { throw new Error("simulated vector search outage"); } };
  const { context, serviceAdapters } = wire(throwingVectorRepository, {
    serviceAdapters: { ...syntheticServiceAdapters(), structuredStoreAdapter: structuredAdapterWithEvidenceGap() },
  });
  const modelAdapter = createDeterministicFakeModelAdapter();
  const flow = createHybridRetrievalFlow(modelAdapter, { retrievalMethod: "DENSE" });
  const input = { question: "매출액이 얼마인가요?", question_id: "q_vretr_09", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } };
  const outcome = await runAgentFlow(flow, input, context, LIMITS, serviceAdapters);

  // The Retriever call itself is recorded as a failed tool_call, never as
  // a model-adapter failure -- model_call_attempt_count stays 0 for this
  // scenario since the Flow never even reaches a model call.
  const retrieverCall = outcome.execution_trace.tool_calls.find((c) => c.service === "Retriever");
  assert.ok(retrieverCall);
  assert.equal(retrieverCall.ok, false);
  assert.deepEqual(outcome.execution_trace.tool_calls.filter((c) => c.service === "HcxClient" || c.service === "ModelAdapter"), []);
});
