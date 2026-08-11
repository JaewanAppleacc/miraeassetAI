// StructuredQuery -> StructuredResult (CLAUDE.md section 4/5), matching
// domain/interfaces/structured-query.schema.json and
// domain/interfaces/structured-result.schema.json.
//
// Fail-closed by design: with no adapter wired, every query returns
// STORE_UNAVAILABLE, never NOT_FOUND — "no store" and "no data" are
// different facts and must not be conflated. When an adapter IS wired,
// this module still re-checks the OFFICIAL/VERIFIED-only invariant and the
// exact corpus/fact-coverage snapshot pinning on the adapter's own
// response, preserves the adapter's reported status verbatim, and — as a
// last line of defense — validates the exact response it is about to
// return against the real structured-result.schema.json before handing it
// back. An adapter is never trusted just because it was injected: every
// response this module produces, on every path, is schema-valid by
// construction, not by convention.
//
// KNOWN LIMITATION: no adapter is implemented yet. VERIFIED Fact/Evidence
// data does not exist in this repo (domain/HANDOFF.md: BLOCKED_BY_HUMAN_
// REVIEW), so there is nothing to wire a real adapter to today. This
// module only defines the fail-closed boundary and the OFFICIAL-scope
// enforcement that a future adapter must pass through.

import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { RequestAbortedError } from "./abortable.mjs";
import querySchema from "../interfaces/structured-query.schema.json" with { type: "json" };
import resultSchema from "../interfaces/structured-result.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateQuerySchema = ajv.compile(querySchema);
const validateResultSchema = ajv.compile(resultSchema);

const RESULT_STATUSES = Object.freeze(["OK", "NOT_FOUND", "PARTIAL", "PARSE_BLOCKED", "ERROR"]);

// The query itself is the single source of truth (domain/interfaces/
// structured-query.schema.json), not a hand-maintained duplicate of it —
// duplicating the field list here would drift from the schema over time.
export function validateStructuredQuery(query) {
  if (validateQuerySchema(query)) return [];
  return (validateQuerySchema.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

// What this module can honestly claim was "applied" when nothing was
// actually returned (every error path, and STORE_UNAVAILABLE in
// particular): the enforcement policy in effect, not an empirical
// observation over zero records. OFFICIAL only ever enforces VERIFIED;
// SANDBOX falls back to whatever the query itself validly requested.
function policyAppliedStatuses(query) {
  if (query?.execution_scope === "OFFICIAL") return ["VERIFIED"];
  if (Array.isArray(query?.verification_statuses)) {
    const known = query.verification_statuses.filter((status) =>
      ["CANDIDATE", "VERIFIED", "REJECTED", "PARSE_BLOCKED"].includes(status),
    );
    if (known.length > 0) return [...new Set(known)];
  }
  return ["VERIFIED"];
}

function errorResult(query, errorCode, startedAt) {
  const queryIdValid = typeof query?.query_id === "string" && /^query_[a-z0-9_.-]+$/.test(query.query_id);
  const result = {
    schema_version: "0.2.0",
    query_id: queryIdValid ? query.query_id : "query_unknown",
    execution_scope: ["OFFICIAL", "SANDBOX"].includes(query?.execution_scope) ? query.execution_scope : "SANDBOX",
    corpus_snapshot_id: typeof query?.corpus_snapshot_id === "string" && query.corpus_snapshot_id.length > 0
      ? query.corpus_snapshot_id
      : "unknown",
    fact_coverage_snapshot_id: typeof query?.fact_coverage_snapshot_id === "string" ? query.fact_coverage_snapshot_id : null,
    query_snapshot_id: randomUUID(),
    status: "ERROR",
    error_codes: [errorCode],
    applied_verification_statuses: policyAppliedStatuses(query),
    latency_ms: Date.now() - startedAt,
    records: [],
  };
  // Defensive: if this construction is ever wrong, fail to a value the
  // schema itself guarantees is valid rather than leaking a malformed
  // response.
  if (!validateResultSchema(result)) {
    return {
      ...result,
      query_id: "query_unknown",
      execution_scope: "SANDBOX",
      corpus_snapshot_id: "unknown",
      fact_coverage_snapshot_id: null,
      applied_verification_statuses: ["VERIFIED"],
    };
  }
  return result;
}

// `context` pins the snapshot this request is actually running against
// (the same SharedContext ValidationAuthority is built from). A query is
// rejected against THIS pinning before the adapter is ever called — a Flow
// choosing its own corpus_snapshot_id and an adapter obligingly echoing it
// back would otherwise agree with each other while both disagreeing with
// the request's real snapshot.
// `signal`, if provided, is the request-scoped AbortSignal (see
// domain/runtime/abortable.mjs and agent-runtime.mjs's createSharedServices)
// — bound here via closure (not part of `structuredQuery`, which stays
// exactly what structured-query.schema.json validates) and passed to the
// adapter as a SEPARATE second argument, so a real adapter can opt into
// honoring it without that ever becoming part of the schema-validated
// query shape. No real adapter exists yet — this module only defines the
// boundary a future one can pass through.
export function createStructuredStore(adapter = null, context = {}, signal) {
  return {
    async query(structuredQuery) {
      const startedAt = Date.now();

      // structured-query.schema.json's own OFFICIAL->["VERIFIED"]-only
      // conditional makes an OFFICIAL query requesting non-VERIFIED data
      // fail here as INVALID_QUERY — the schema is the single source of
      // truth for that invariant, not a second hand-written copy of it.
      if (validateStructuredQuery(structuredQuery).length > 0) {
        return errorResult(structuredQuery, "INVALID_QUERY", startedAt);
      }
      if (structuredQuery.corpus_snapshot_id !== context?.corpus_snapshot_id) {
        return errorResult(structuredQuery, "SNAPSHOT_MISMATCH", startedAt);
      }
      if ((structuredQuery.fact_coverage_snapshot_id ?? null) !== (context?.fact_coverage_snapshot_id ?? null)) {
        return errorResult(structuredQuery, "SNAPSHOT_MISMATCH", startedAt);
      }
      if (!adapter) return errorResult(structuredQuery, "STORE_UNAVAILABLE", startedAt);

      // Checked immediately before the adapter call — this module can be
      // used directly, not only through agent-runtime.mjs's wrapAsync
      // pre-check, so it needs its own guard (same pattern as retriever-
      // store.mjs/citation-validator.mjs/fact-store.mjs). Unlike those
      // modules, this one's whole design is "never throws, always returns
      // a schema-valid StructuredResult" (see the header comment), so this
      // stays inside that convention rather than throwing —
      // structured-result.schema.json's error_codes already declares
      // "TIMEOUT" for exactly this kind of "did not complete" outcome, so
      // no schema/contract change is needed to report it this way.
      if (signal?.aborted) return errorResult(structuredQuery, "TIMEOUT", startedAt);

      let raw;
      try {
        raw = await adapter.query(structuredQuery, { signal });
      } catch (error) {
        // A real adapter that itself observes `signal` mid-flight and
        // aborts is reporting the same condition as the pre-check above.
        if (error instanceof RequestAbortedError) return errorResult(structuredQuery, "TIMEOUT", startedAt);
        return errorResult(structuredQuery, "INTERNAL_ERROR", startedAt);
      }

      if (raw?.corpus_snapshot_id !== structuredQuery.corpus_snapshot_id) {
        return errorResult(structuredQuery, "SNAPSHOT_MISMATCH", startedAt);
      }
      if ((raw?.fact_coverage_snapshot_id ?? null) !== (structuredQuery.fact_coverage_snapshot_id ?? null)) {
        return errorResult(structuredQuery, "SNAPSHOT_MISMATCH", startedAt);
      }
      if (!RESULT_STATUSES.includes(raw?.status)) {
        return errorResult(structuredQuery, "INTERNAL_ERROR", startedAt);
      }

      const records = Array.isArray(raw.records) ? raw.records : [];

      // Precise, reachable check for the specific case the error code
      // names: a store handing back non-VERIFIED data on an OFFICIAL
      // request. The schema-validation fallback below still catches any
      // *other* malformed adapter response as a generic INTERNAL_ERROR.
      if (structuredQuery.execution_scope === "OFFICIAL" && records.some((record) => record?.verification_status !== "VERIFIED")) {
        return errorResult(structuredQuery, "UNVERIFIED_DATA_FORBIDDEN", startedAt);
      }

      const appliedStatuses = records.length > 0
        ? [...new Set(records.map((record) => record?.verification_status))]
        : policyAppliedStatuses(structuredQuery);

      const candidate = {
        schema_version: "0.2.0",
        query_id: structuredQuery.query_id,
        execution_scope: structuredQuery.execution_scope,
        corpus_snapshot_id: structuredQuery.corpus_snapshot_id,
        fact_coverage_snapshot_id: structuredQuery.fact_coverage_snapshot_id ?? null,
        query_snapshot_id: randomUUID(),
        status: raw.status,
        error_codes: Array.isArray(raw.error_codes) ? raw.error_codes : [],
        applied_verification_statuses: appliedStatuses,
        latency_ms: Date.now() - startedAt,
        records,
      };

      // Last line of defense: an adapter that leaks a non-VERIFIED record
      // into an OFFICIAL response, or returns a malformed record shape,
      // fails schema validation here — the response never leaves this
      // module trusting the adapter's word for it.
      if (!validateResultSchema(candidate)) {
        return errorResult(structuredQuery, "INTERNAL_ERROR", startedAt);
      }
      return candidate;
    },
  };
}

export function createBudgetedStructuredStore(structuredStore, budget) {
  return {
    async query(structuredQuery) {
      budget.recordToolCall();
      budget.checkTimeout();
      return structuredStore.query(structuredQuery);
    },
  };
}
