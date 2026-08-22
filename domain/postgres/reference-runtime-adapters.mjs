// Turn N2: thin adapters exposing ONE shared domain/postgres/reference-repository.mjs
// instance through the three existing Runtime Store contracts --
// domain/runtime/fact-store.mjs's `{ getFact }`, domain/runtime/citation-validator.mjs's
// `{ getEvidence }`, and domain/runtime/structured-store.mjs's `{ query }`.
// No SQL, no validation logic, and no envelope-construction logic is
// duplicated between the three -- every one of these adapters is a plain
// translation between a Runtime Store contract's calling convention and the
// repository's own, nothing more. None of these adapters mutate the
// envelope/status/code shapes the underlying Runtime Store modules already
// define; they only ever construct the plain data envelope those modules
// expect (`{ corpus_snapshot_id, record }`, `{ corpus_snapshot_id,
// fact_coverage_snapshot_id, record }`, or a raw structured-result-shaped
// object) and let fact-store.mjs/citation-validator.mjs/structured-store.mjs
// themselves decide status/code.
//
// corpus_snapshot_id / fact_coverage_snapshot_id on every envelope this
// module returns come from the REPOSITORY (verified once, at construction,
// against the real disclosure_reference.releases row) -- never fabricated
// here, and never an echo of whatever the caller's own request happened to
// ask for.
//
// PRODUCTION WIRING: constructing one of these adapters here does NOT wire
// it into configured-seed-runtime.mjs or GET /answer -- see
// domain/postgres/README.md's "Repository/Adapter" section. This Turn only
// adds the adapter layer itself; production still runs on the portable
// bundle-backed Runtime.

function translateQueryToFilters(structuredQuery) {
  const predicates = structuredQuery.predicates ?? {};
  return Object.freeze({
    corp_codes: structuredQuery.corp_codes ?? [],
    scope_filter: structuredQuery.scope_filter ?? [],
    period_filter: structuredQuery.period_filter ?? Object.freeze({ start: null, end: null, period_types: [] }),
    verification_statuses: structuredQuery.verification_statuses ?? ["VERIFIED"],
    as_of_date: structuredQuery.as_of_date,
    limit: structuredQuery.limit,
    document_ids: predicates.document_ids ?? [],
    evidence_ids: predicates.evidence_ids ?? [],
    metric_codes: predicates.metric_codes ?? [],
    fact_ids: predicates.fact_ids ?? [],
    event_types: predicates.event_types ?? [],
    event_ids: predicates.event_ids ?? [],
    relation_types: predicates.relation_types ?? [],
    relation_ids: predicates.relation_ids ?? [],
  });
}

const TARGET_ORDER = Object.freeze({ FACT: 0, EVENT: 1, RELATION: 2, EVIDENCE: 3 });
function dateValue(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}
function sortRecords(records) {
  return [...records].sort((a, b) => {
    const time = (dateValue(b.known_at) ?? 0) - (dateValue(a.known_at) ?? 0);
    return time || TARGET_ORDER[a.record_type] - TARGET_ORDER[b.record_type] || a.record_id.localeCompare(b.record_id);
  });
}

// domain/runtime/fact-store.mjs's createFactStore expects an adapter with
// `async getFact(factId, { signal }) -> { corpus_snapshot_id,
// fact_coverage_snapshot_id, record } | null`. Never throws for "not
// found" (repository.getFact already returns null for that); a genuine
// repository/DB failure propagates as a thrown error, which createFactStore
// converts to FACT_STORE_UNAVAILABLE -- this adapter does not catch it.
export function createPostgresFactStoreAdapter(repository) {
  if (!repository) throw new TypeError("repository is required");
  return Object.freeze({
    async getFact(factId, { signal } = {}) {
      const record = await repository.getFact(factId, { signal });
      if (!record) return null;
      return Object.freeze({
        corpus_snapshot_id: repository.corpusSnapshotId,
        fact_coverage_snapshot_id: repository.factCoverageSnapshotId,
        record,
      });
    },
  });
}

// domain/runtime/citation-validator.mjs's createEvidenceStore expects
// `async getEvidence(evidenceId, { signal }) -> { corpus_snapshot_id,
// record } | null`. Same not-found/error-propagation contract as above.
export function createPostgresEvidenceStoreAdapter(repository) {
  if (!repository) throw new TypeError("repository is required");
  return Object.freeze({
    async getEvidence(evidenceId, { signal } = {}) {
      const record = await repository.getEvidence(evidenceId, { signal });
      if (!record) return null;
      return Object.freeze({ corpus_snapshot_id: repository.corpusSnapshotId, record });
    },
  });
}

// domain/runtime/structured-store.mjs's createStructuredStore expects
// `async query(structuredQuery, { signal }) -> { corpus_snapshot_id,
// fact_coverage_snapshot_id, status, error_codes, records }`.
// createStructuredStore itself re-validates the schema, the snapshot pins,
// the OFFICIAL/VERIFIED-only invariant, and the final structured-result
// shape -- this adapter's only job is to fan a query's `targets` out across
// the repository's per-target query methods, merge, sort, and trim to
// `limit`, exactly mirroring the single combined/sorted/limited array the
// portable seed-structured-query-adapter.mjs produces.
export function createPostgresStructuredStoreAdapter(repository) {
  if (!repository) throw new TypeError("repository is required");
  const queryByTarget = Object.freeze({
    FACT: (filters, opts) => repository.queryFacts(filters, opts),
    EVENT: (filters, opts) => repository.queryEvents(filters, opts),
    RELATION: (filters, opts) => repository.queryRelations(filters, opts),
    EVIDENCE: (filters, opts) => repository.queryEvidence(filters, opts),
  });
  return Object.freeze({
    async query(structuredQuery, { signal } = {}) {
      const filters = translateQueryToFilters(structuredQuery);
      const targets = Array.isArray(structuredQuery.targets) ? structuredQuery.targets : [];
      // Sequential, not Promise.all: the repository's `client` may be a
      // single pg.Client (one physical connection), which does not support
      // concurrent in-flight queries -- node-postgres queues them but warns
      // that this behavior is deprecated. A pg.Pool would tolerate
      // concurrency fine, but this adapter has no way to know which one it
      // was handed, so it stays safe for both by never overlapping calls.
      const groups = [];
      for (const target of targets) {
        groups.push(queryByTarget[target] ? await queryByTarget[target](filters, { signal }) : []);
      }
      const combined = sortRecords(groups.flat()).slice(0, structuredQuery.limit);
      return Object.freeze({
        corpus_snapshot_id: repository.corpusSnapshotId,
        fact_coverage_snapshot_id: repository.factCoverageSnapshotId,
        status: combined.length > 0 ? "OK" : "NOT_FOUND",
        error_codes: [],
        records: combined,
      });
    },
  });
}
