import assert from "node:assert/strict";
import test from "node:test";
import { createRetrieverStore, RETRIEVER_CODES, validateRetrievalRequest } from "../domain/runtime/retriever-store.mjs";

// The SharedContext this "request" is pinned to (CLAUDE.md's corpus/
// chunking/index snapshot triple). A request must target exactly this,
// independent of whatever an adapter might later echo back.
const RUN_CONTEXT = Object.freeze({
  corpus_snapshot_id: "corpus_04750795e1a2d5c3",
  chunking_config_id: "chunking_fixed512_v1",
  index_snapshot_id: "index_snapshot_bm25_v1",
});

function metadataFilters(overrides = {}) {
  return {
    corp_codes: [],
    document_ids: [],
    doc_groups: [],
    doc_subtypes: [],
    base_years: [],
    base_months: [],
    receipt_date_from: null,
    receipt_date_to: null,
    is_correction: null,
    retrieval_eligible: true,
    ...overrides,
  };
}

function retrievalRequest(overrides = {}) {
  return {
    schema_version: "0.1.0",
    query_id: "query_test_1",
    question: "테스트 질문",
    corpus_snapshot_id: RUN_CONTEXT.corpus_snapshot_id,
    chunking_config_id: RUN_CONTEXT.chunking_config_id,
    index_snapshot_id: RUN_CONTEXT.index_snapshot_id,
    metadata_filters: metadataFilters(),
    top_k: 5,
    retrieval_method: "BM25",
    ...overrides,
  };
}

function sourceSpan(overrides = {}) {
  return {
    file_id: "file_000000000000000000000001",
    rel_path: "doc/section1.xml",
    node_id: "node_1",
    order_index: 0,
    row_start: null,
    row_end: null,
    col_start: null,
    col_end: null,
    source_locator: "section.1.para.2",
    ...overrides,
  };
}

function resultItem(overrides = {}) {
  return {
    rank: 1,
    score: 1.5,
    score_type: "BM25",
    component_scores: { bm25: 1.5, dense: null, rrf: null, reranker: null },
    document_id: "doc_1",
    chunk_id: "chunk_000000000000000000000001",
    chunk_type: "FIXED_WINDOW",
    parent_chunk_id: null,
    text_provenance: "SOURCE_VERBATIM",
    citation_authority: "SOURCE_SPANS",
    raw_text: "근거 텍스트",
    source_locator: "section.1.para.2",
    source_spans: [sourceSpan()],
    ...overrides,
  };
}

function retrievalResult(request, overrides = {}) {
  return {
    schema_version: "0.2.0",
    query_id: request.query_id,
    retrieval_method: request.retrieval_method,
    corpus_snapshot_id: request.corpus_snapshot_id,
    chunking_config_id: request.chunking_config_id,
    index_snapshot_id: request.index_snapshot_id,
    applied_filters: request.metadata_filters,
    top_k: request.top_k,
    latency_ms: 5,
    results: [resultItem()],
    ...overrides,
  };
}

function spyAdapter(response) {
  let calls = 0;
  return {
    adapter: {
      async retrieve(request) {
        calls += 1;
        return typeof response === "function" ? response(request) : response;
      },
    },
    callCount: () => calls,
  };
}

// --- validateRetrievalRequest: the schema is the single source of truth ---

test("validateRetrievalRequest accepts a well-formed request", () => {
  assert.deepEqual(validateRetrievalRequest(retrievalRequest()), []);
});

test("validateRetrievalRequest rejects a request missing required fields", () => {
  const errors = validateRetrievalRequest({});
  assert.ok(errors.length > 0);
});

test("validateRetrievalRequest rejects an out-of-range top_k", () => {
  const errors = validateRetrievalRequest(retrievalRequest({ top_k: 0 }));
  assert.ok(errors.length > 0);
});

// --- requirement 1: invalid request rejected before the adapter is ever called ---

test("createRetrieverStore rejects a malformed request as RETRIEVER_INVALID_REQUEST before the adapter is ever called", async () => {
  const { adapter, callCount } = spyAdapter(retrievalResult(retrievalRequest()));
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve({ not: "a valid request" });
  assert.deepEqual(result.ok, false);
  assert.equal(result.code, "RETRIEVER_INVALID_REQUEST");
  assert.equal(callCount(), 0);
});

// --- requirement 2: no adapter wired -> fail closed ---

test("createRetrieverStore fails closed with RETRIEVER_UNAVAILABLE when no adapter is wired", async () => {
  const store = createRetrieverStore(null, RUN_CONTEXT);
  const result = await store.resolve(retrievalRequest());
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_UNAVAILABLE");
});

// --- requirement 3: request snapshot triple checked against context ---

test("createRetrieverStore rejects a request whose corpus_snapshot_id disagrees with context, before the adapter is called", async () => {
  const { adapter, callCount } = spyAdapter(retrievalResult(retrievalRequest()));
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(retrievalRequest({ corpus_snapshot_id: "corpus_some_other_snapshot" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_SNAPSHOT_MISMATCH");
  assert.equal(callCount(), 0);
});

test("createRetrieverStore rejects a request whose chunking_config_id disagrees with context, before the adapter is called", async () => {
  const { adapter, callCount } = spyAdapter(retrievalResult(retrievalRequest()));
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(retrievalRequest({ chunking_config_id: "chunking_some_other_config" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_SNAPSHOT_MISMATCH");
  assert.equal(callCount(), 0);
});

test("createRetrieverStore rejects a request whose index_snapshot_id disagrees with context, before the adapter is called", async () => {
  const { adapter, callCount } = spyAdapter(retrievalResult(retrievalRequest()));
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(retrievalRequest({ index_snapshot_id: "index_some_other_snapshot" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_SNAPSHOT_MISMATCH");
  assert.equal(callCount(), 0);
});

// --- requirement 8: adapter error vs legitimate "found nothing" ---

test("createRetrieverStore returns RETRIEVER_ADAPTER_ERROR when the adapter throws", async () => {
  const adapter = { retrieve: async () => { throw new Error("search backend down"); } };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(retrievalRequest());
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_ADAPTER_ERROR");
});

test("createRetrieverStore accepts a legitimate empty results array as a successful response, not an error", async () => {
  const request = retrievalRequest();
  const adapter = { retrieve: async () => retrievalResult(request, { results: [] }) };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.results, []);
});

// --- requirement 4: adapter result validated against retrieval-result.schema.json ---

test("createRetrieverStore returns RETRIEVER_INVALID_RESULT when the adapter response is missing a required schema field", async () => {
  const request = retrievalRequest();
  const malformed = retrievalResult(request);
  delete malformed.latency_ms;
  const adapter = { retrieve: async () => malformed };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_INVALID_RESULT");
});

test("createRetrieverStore returns RETRIEVER_INVALID_RESULT when a result item is missing source_spans", async () => {
  const request = retrievalRequest();
  const malformed = retrievalResult(request, { results: [resultItem({ source_spans: undefined })] });
  delete malformed.results[0].source_spans;
  const adapter = { retrieve: async () => malformed };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_INVALID_RESULT");
});

// --- requirement 6: rank continuity / score order / top_k overflow / component_scores ---

test("createRetrieverStore returns RETRIEVER_INVALID_RESULT when ranks are not contiguous", async () => {
  const request = retrievalRequest({ top_k: 5 });
  const adapter = {
    retrieve: async () => retrievalResult(request, { results: [resultItem({ rank: 1 }), resultItem({ rank: 3, chunk_id: "chunk_000000000000000000000002" })] }),
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_INVALID_RESULT");
});

test("createRetrieverStore returns RETRIEVER_INVALID_RESULT when score does not sort non-increasing by rank", async () => {
  const request = retrievalRequest({ top_k: 5 });
  const adapter = {
    retrieve: async () =>
      retrievalResult(request, {
        results: [
          resultItem({ rank: 1, score: 1.0 }),
          resultItem({ rank: 2, score: 2.0, chunk_id: "chunk_000000000000000000000002" }),
        ],
      }),
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_INVALID_RESULT");
});

test("createRetrieverStore returns RETRIEVER_INVALID_RESULT when results.length exceeds top_k", async () => {
  const request = retrievalRequest({ top_k: 1 });
  const adapter = {
    retrieve: async () =>
      retrievalResult(request, {
        results: [
          resultItem({ rank: 1, score: 2.0 }),
          resultItem({ rank: 2, score: 1.0, chunk_id: "chunk_000000000000000000000002" }),
        ],
      }),
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_INVALID_RESULT");
});

test("createRetrieverStore returns RETRIEVER_INVALID_RESULT when component_scores violates the retrieval_method's required components", async () => {
  const request = retrievalRequest({ retrieval_method: "BM25" });
  const adapter = {
    retrieve: async () =>
      retrievalResult(request, {
        results: [resultItem({ component_scores: { bm25: null, dense: null, rrf: null, reranker: null } })],
      }),
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_INVALID_RESULT");
});

test("createRetrieverStore returns RETRIEVER_INVALID_RESULT when score_type does not match retrieval_method", async () => {
  const request = retrievalRequest({ retrieval_method: "BM25" });
  const adapter = {
    retrieve: async () => retrievalResult(request, { results: [resultItem({ score_type: "COSINE" })] }),
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_INVALID_RESULT");
});

// --- requirement 5: request/result consistency ---

test("createRetrieverStore returns RETRIEVER_REQUEST_RESULT_MISMATCH when result.query_id disagrees with the request", async () => {
  const request = retrievalRequest();
  const adapter = { retrieve: async () => retrievalResult(request, { query_id: "query_different" }) };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_REQUEST_RESULT_MISMATCH");
});

test("createRetrieverStore returns RETRIEVER_REQUEST_RESULT_MISMATCH when result.retrieval_method disagrees with the request", async () => {
  const request = retrievalRequest({ retrieval_method: "BM25" });
  const adapter = {
    retrieve: async () =>
      retrievalResult(request, {
        retrieval_method: "DENSE",
        results: [resultItem({ score_type: "COSINE", component_scores: { bm25: null, dense: 0.9, rrf: null, reranker: null } })],
      }),
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_REQUEST_RESULT_MISMATCH");
});

test("createRetrieverStore returns RETRIEVER_REQUEST_RESULT_MISMATCH when result.top_k disagrees with the request", async () => {
  const request = retrievalRequest({ top_k: 5 });
  const adapter = { retrieve: async () => retrievalResult(request, { top_k: 10 }) };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_REQUEST_RESULT_MISMATCH");
});

test("createRetrieverStore returns RETRIEVER_REQUEST_RESULT_MISMATCH when result.applied_filters disagrees with request.metadata_filters", async () => {
  const request = retrievalRequest();
  const adapter = {
    retrieve: async () => retrievalResult(request, { applied_filters: metadataFilters({ document_ids: ["doc_9"] }) }),
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_REQUEST_RESULT_MISMATCH");
});

test("createRetrieverStore returns RETRIEVER_REQUEST_RESULT_MISMATCH when a result echoes a different corpus_snapshot_id than the request", async () => {
  const request = retrievalRequest();
  const adapter = { retrieve: async () => retrievalResult(request, { corpus_snapshot_id: "corpus_other" }) };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  // an echoed-back mismatched snapshot is caught either as an invalid
  // result (fails the request/result snapshot-pinning invariant) or a
  // request/result mismatch — either way it must never be accepted as ok.
  assert.ok(["RETRIEVER_REQUEST_RESULT_MISMATCH", "RETRIEVER_INVALID_RESULT"].includes(result.code));
});

// --- requirement 7: source_spans / citation_authority preserved, raw_text never treated as citation ---

test("createRetrieverStore preserves source_spans, citation_authority, and raw_text unmodified on a valid response", async () => {
  const request = retrievalRequest();
  const expected = retrievalResult(request);
  const adapter = { retrieve: async () => expected };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.results[0].source_spans, expected.results[0].source_spans);
  assert.equal(result.result.results[0].citation_authority, "SOURCE_SPANS");
  assert.equal(result.result.results[0].raw_text, expected.results[0].raw_text);
});

// --- happy path ---

test("createRetrieverStore returns ok:true with the adapter's valid result", async () => {
  const request = retrievalRequest();
  const expected = retrievalResult(request);
  const adapter = { retrieve: async () => expected };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.deepEqual(result, { ok: true, result: expected });
});

// --- failure code registry ---

test("RETRIEVER_CODES enumerates exactly the codes this module can return", () => {
  assert.deepEqual(
    [...RETRIEVER_CODES].sort(),
    [
      "RETRIEVER_UNAVAILABLE",
      "RETRIEVER_INVALID_REQUEST",
      "RETRIEVER_SNAPSHOT_MISMATCH",
      "RETRIEVER_ADAPTER_ERROR",
      "RETRIEVER_INVALID_RESULT",
      "RETRIEVER_REQUEST_RESULT_MISMATCH",
    ].sort(),
  );
});

// --- TOCTOU hardening: everything this module validates against must be
// an immutable snapshot, never a live object a caller or an adapter can
// still mutate after the fact. -------------------------------------------

test("mutating context.index_snapshot_id AFTER createRetrieverStore() does not change what the store considers valid — a request targeting the mutated value is still rejected", async () => {
  const context = { ...RUN_CONTEXT };
  const { adapter, callCount } = spyAdapter(retrievalResult(retrievalRequest()));
  const store = createRetrieverStore(adapter, context);

  context.index_snapshot_id = "index_MALICIOUS"; // mutate the caller's own context object after construction

  const request = retrievalRequest({ index_snapshot_id: "index_MALICIOUS" }); // targets the mutated value
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_SNAPSHOT_MISMATCH");
  assert.equal(callCount(), 0, "the adapter must never be reached for a snapshot bound only via a post-construction mutation");
});

test("an adapter that mutates request.top_k (1 -> 100) and returns a matching top_k=100 result is still rejected against the ORIGINAL top_k", async () => {
  const request = retrievalRequest({ top_k: 1 });
  const adapter = {
    retrieve: async (req) => {
      req.top_k = 100; // mutate whatever object the adapter was handed
      return retrievalResult({ ...req, top_k: 100 }, { top_k: 100 });
    },
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_REQUEST_RESULT_MISMATCH");
});

test("an adapter that mutates request.metadata_filters to match its own result is still rejected against the ORIGINAL metadata_filters", async () => {
  const request = retrievalRequest();
  const adapter = {
    retrieve: async (req) => {
      req.metadata_filters.document_ids.push("doc_injected"); // mutate the nested filters object
      return retrievalResult(req, { applied_filters: req.metadata_filters });
    },
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_REQUEST_RESULT_MISMATCH");
});

test("an adapter that mutates the request's snapshot id and echoes it back in the result is still rejected against the ORIGINAL snapshot id", async () => {
  const request = retrievalRequest();
  const adapter = {
    retrieve: async (req) => {
      req.corpus_snapshot_id = "corpus_injected";
      return retrievalResult(req, { corpus_snapshot_id: "corpus_injected" });
    },
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RETRIEVER_REQUEST_RESULT_MISMATCH");
});

test("the caller's original request object is never mutated by the adapter, even when the adapter tries to mutate what it receives", async () => {
  const request = retrievalRequest({ top_k: 1 });
  const pristine = JSON.parse(JSON.stringify(request));
  const adapter = {
    retrieve: async (req) => {
      req.top_k = 999;
      req.metadata_filters.document_ids.push("doc_injected");
      req.query_id = "query_hijacked";
      return retrievalResult(req);
    },
  };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  await store.resolve(request);
  assert.deepEqual(request, pristine, "the caller's own request object must be byte-for-byte unchanged after resolve()");
});

test("a normal, unmutated request and a genuinely matching result still pass exactly as before", async () => {
  const request = retrievalRequest();
  const expected = retrievalResult(request);
  const adapter = { retrieve: async () => expected };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, expected);
});

test("the returned result is frozen — mutating it after the fact does not silently succeed and cannot corrupt what was validated", async () => {
  const request = retrievalRequest();
  const adapter = { retrieve: async () => retrievalResult(request) };
  const store = createRetrieverStore(adapter, RUN_CONTEXT);
  const result = await store.resolve(request);
  assert.equal(result.ok, true);
  assert.throws(() => { result.result.top_k = 999; }, TypeError);
  assert.equal(result.result.top_k, request.top_k);
});
