// Retriever Runtime boundary (CLAUDE.md sections 4-5, 10; domain/retrieval/
// README.md). This module implements the COMMON safety boundary every
// retrieval strategy (BM25, Dense, HYBRID_RRF, HYBRID_RRF_RERANKER) must
// pass through identically — it does NOT implement any retrieval strategy
// itself. Mirrors CLAUDE.md's RetrieverRequest -> RetrieverResult Component
// I/O contract, the same way citation-validator.mjs/fact-store.mjs/
// structured-store.mjs mirror their own request/result boundaries:
//
//   1. RetrieverRequest is validated against retrieval-request.schema.json
//      BEFORE the adapter is ever called — a malformed request never
//      reaches a real search backend.
//   2. No adapter wired -> fail-closed RETRIEVER_UNAVAILABLE. This is
//      distinct from "search ran and legitimately found nothing", which is
//      a valid, non-error RetrieverResult with results: [].
//   3. The request's corpus_snapshot_id/chunking_config_id/index_snapshot_id
//      are checked against this request's own SharedContext BEFORE calling
//      the adapter — a Flow (or an adapter obligingly echoing back
//      whatever it was asked) cannot silently retrieve against a different
//      corpus/chunking/index snapshot than the one this request is bound
//      to. See createSharedServices in agent-runtime.mjs for how context
//      carries this triple.
//   4. The adapter's raw response is validated against
//      retrieval-result.schema.json — an adapter is never trusted just
//      because it was injected.
//   5. Request/result consistency (query_id, retrieval_method, the three
//      snapshot ids, top_k, applied_filters vs metadata_filters) is
//      re-checked via domain/contracts.mjs's validateRetrievalRequestResultPair.
//   6. Rank contiguity, score ordering, top_k overflow, and score_type/
//      component_scores-per-method rules are re-checked via
//      domain/contracts.mjs's validateRetrievalResult — cross-field
//      invariants a JSON Schema alone cannot express.
//   7. citation_authority is schema-pinned to SOURCE_SPANS and source_spans
//      is schema-required non-empty (both re-checked here too); this
//      module never strips, summarizes, or substitutes raw_text for
//      source_spans — raw_text passes through unmodified as retrieval/HCX
//      context only, never as the citation itself.
//   8. An adapter that THROWS is RETRIEVER_ADAPTER_ERROR (a genuine
//      failure) — distinct from an adapter that legitimately found no
//      matching chunks, which is a valid, schema-conformant RetrieverResult
//      with results: [] and is NOT an error at all.
//
// Like Validator/Calculator/HcxClient (and unlike StructuredStore, whose
// OWN result schema has a status/error_codes field), a rejection here is
// reported as { ok: false, code, message } — retrieval-result.schema.json
// has no status field, so there is no schema-valid way to represent
// "rejected" as a RetrieverResult value. agent-runtime.mjs's
// createRetrieverService turns this into the same RejectedInputError every
// other SharedServices boundary throws, exactly the way createValidator
// turns citation-validator.mjs/fact-store.mjs's own {ok,code} results into
// thrown errors — this module does not import RejectedInputError itself,
// to avoid a circular import with agent-runtime.mjs.
//
// KNOWN LIMITATION: no real BM25/Dense/RRF adapter exists yet — this
// module only defines the boundary a future adapter must pass through.
//
// TOCTOU (time-of-check to time-of-use) hardening: everything this module
// validates is checked against IMMUTABLE, deep-cloned snapshots, never a
// live object someone else still holds a reference to.
//   - The context snapshot triple is copied out of `context` at
//     createRetrieverStore() call time — mutating the caller's original
//     context object afterward can never change what this store considers
//     a valid snapshot.
//   - The request is deep-cloned and deep-frozen into `requestSnapshot`
//     immediately after schema validation, before the adapter is ever
//     called. Every check from that point on (snapshot-triple, request/
//     result consistency) reads `requestSnapshot`, never the caller's
//     live `request` object.
//   - The adapter receives its OWN independent deep clone, not
//     `requestSnapshot` and not the caller's `request` — an adapter that
//     mutates what it was handed (whether by design or by bug) can never
//     retroactively change what this module already validated, and can
//     never corrupt the caller's own request object either.
//   - The returned result is likewise deep-cloned and deep-frozen before
//     being handed back, so a consumer mutating it afterward can't
//     retroactively "un-validate" what this module already checked.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { abortReason, RequestAbortedError } from "./abortable.mjs";
import { validateRetrievalRequestResultPair, validateRetrievalResult } from "../contracts.mjs";
import requestSchema from "../retrieval/retrieval-request.schema.json" with { type: "json" };
import resultSchema from "../retrieval/retrieval-result.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateRequestSchema = ajv.compile(requestSchema);
const validateResultSchema = ajv.compile(resultSchema);

export const RETRIEVER_CODES = Object.freeze([
  "RETRIEVER_UNAVAILABLE",
  "RETRIEVER_INVALID_REQUEST",
  "RETRIEVER_SNAPSHOT_MISMATCH",
  "RETRIEVER_ADAPTER_ERROR",
  "RETRIEVER_INVALID_RESULT",
  "RETRIEVER_REQUEST_RESULT_MISMATCH",
]);

// The request itself is validated against the real schema (single source
// of truth), not a hand-maintained duplicate field list.
export function validateRetrievalRequest(request) {
  if (validateRequestSchema(request)) return [];
  return (validateRequestSchema.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

function rejected(code, message) {
  return { ok: false, code, message };
}

// Recursively freezes a value in place (Object.freeze is shallow on its
// own — a frozen object can still have its NESTED objects/arrays mutated
// unless each of those is frozen too).
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// A deep, independent copy — mutating the return value can never affect
// `value` or anything `value` itself references.
function deepClone(value) {
  return structuredClone(value);
}

// `context` pins the corpus/chunking/index snapshot triple this request is
// actually running against — same pinning pattern as DocumentStore/
// EvidenceStore/FactStore/StructuredStore, extended to the three-part
// snapshot triple retrieval needs (a fixed index is itself pinned to one
// corpus snapshot AND one chunking config — see domain/retrieval/README.md).
export function createRetrieverStore(adapter = null, context = {}) {
  // Copied by value at construction time (all three fields are strings) —
  // see the TOCTOU note above.
  const pinnedSnapshot = Object.freeze({
    corpus_snapshot_id: context?.corpus_snapshot_id,
    chunking_config_id: context?.chunking_config_id,
    index_snapshot_id: context?.index_snapshot_id,
  });

  return {
    // Returns { ok: true, result } or { ok: false, code, message }.
    // `options.signal`, if provided, is the request-scoped AbortSignal
    // (see domain/runtime/abortable.mjs and agent-runtime.mjs's
    // createRetrieverService) — it is passed to the adapter as a SEPARATE
    // second argument, never merged into `request`, so a real adapter can
    // opt into honoring it (e.g. to cancel a real search backend call)
    // without `request` ever growing a field retrieval-request.schema.json
    // does not declare. No real adapter exists yet — this module only
    // defines the boundary a future one can pass through.
    async resolve(request, options = {}) {
      const requestErrors = validateRetrievalRequest(request);
      if (requestErrors.length > 0) {
        return rejected("RETRIEVER_INVALID_REQUEST", requestErrors.join("; "));
      }

      // The one and only object every subsequent check reads. Cloned +
      // frozen now, before the adapter (or anything else) gets a chance
      // to touch the request — see the TOCTOU note above.
      const requestSnapshot = deepFreeze(deepClone(request));

      if (
        requestSnapshot.corpus_snapshot_id !== pinnedSnapshot.corpus_snapshot_id ||
        requestSnapshot.chunking_config_id !== pinnedSnapshot.chunking_config_id ||
        requestSnapshot.index_snapshot_id !== pinnedSnapshot.index_snapshot_id
      ) {
        return rejected(
          "RETRIEVER_SNAPSHOT_MISMATCH",
          "request corpus_snapshot_id/chunking_config_id/index_snapshot_id does not match this request's context",
        );
      }

      if (!adapter) {
        return rejected("RETRIEVER_UNAVAILABLE", "no Retriever adapter is wired");
      }

      // Checked immediately before the adapter call, independent of
      // whoever constructed this store (agent-runtime.mjs's wrapMaybeAsync
      // pre-check covers the normal runAgentFlow path, but this module can
      // be used directly too — see structured-store.mjs/citation-
      // validator.mjs/fact-store.mjs for the same pattern applied to their
      // own adapters). A RequestAbortedError is thrown here rather than
      // returned as this module's usual { ok: false, code, message } shape
      // — a deliberate, narrow exception to that convention so the
      // TIMEOUT/CLIENT_DISCONNECT distinction survives all the way up to
      // ExecutionTrace.fallback_reason instead of collapsing into a generic
      // RETRIEVER_* code (agent-runtime.mjs's createRetrieverService does
      // not catch this — it propagates straight through).
      if (options.signal?.aborted) {
        throw new RequestAbortedError(abortReason(options.signal));
      }

      let raw;
      try {
        // The adapter gets its own independent, mutable clone — never
        // requestSnapshot itself, and never the caller's original
        // `request` object. Whatever the adapter does to what it's
        // handed has zero effect on what this module validates next, and
        // zero effect on the caller's own object.
        raw = await adapter.retrieve(deepClone(requestSnapshot), { signal: options.signal });
      } catch (error) {
        // A real adapter that itself observes `signal` mid-flight and
        // aborts is reporting the SAME condition as the pre-check above,
        // just discovered later — preserve it rather than collapsing it
        // into a generic adapter-failure code.
        if (error instanceof RequestAbortedError) throw error;
        return rejected("RETRIEVER_ADAPTER_ERROR", "the Retriever adapter threw while executing the search");
      }

      if (!validateResultSchema(raw)) {
        return rejected(
          "RETRIEVER_INVALID_RESULT",
          (validateResultSchema.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`).join("; "),
        );
      }

      const invariantErrors = validateRetrievalResult(raw);
      if (invariantErrors.length > 0) {
        return rejected("RETRIEVER_INVALID_RESULT", invariantErrors.join("; "));
      }

      const pairErrors = validateRetrievalRequestResultPair(requestSnapshot, raw);
      if (pairErrors.length > 0) {
        return rejected("RETRIEVER_REQUEST_RESULT_MISMATCH", pairErrors.join("; "));
      }

      // Frozen before returning — a consumer mutating the returned result
      // afterward can't retroactively change what was actually validated.
      return { ok: true, result: deepFreeze(deepClone(raw)) };
    },
  };
}
