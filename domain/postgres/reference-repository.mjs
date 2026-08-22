// Turn N2: read-only PostgreSQL Reference Repository over one pinned, READY
// disclosure_reference release (see domain/postgres/reference-release-loader.mjs
// for how a release actually gets there, and 002_reference_release.sql for
// the schema/immutability triggers this module relies on).
//
// THIS MODULE NEVER WRITES. No INSERT/UPDATE/DELETE/ALTER/DROP/CREATE/GRANT
// appears anywhere below -- enforced both by review and by a static grep
// test (tests/reference-repository-no-write-sql.test.mjs). Migration and
// the loader remain the only places that write; this file only issues
// SELECT statements, always with parameter binding, never with a table/
// column/role name built from caller input.
//
// createPostgresReferenceRepository(...) is the ONLY way to obtain a usable
// repository. Construction validates the caller's pin (release_id, status
// READY, corpus_snapshot_id, approved_revision, fact_coverage_snapshot_id)
// against the real `disclosure_reference.releases` row for that release_id
// BEFORE returning -- every pin is REQUIRED (no optional/omittable pin, no
// "production-shaped but slightly permissive" variant, mirroring
// seed-structured-query-adapter.mjs's "no unpinned production path"
// discipline, applied here to a DB row instead of a manifest file). A
// missing release, a release still LOADING, or ANY pin mismatch throws --
// this module never falls back to a different release and never selects
// "the latest READY release" (no `ORDER BY imported_at DESC LIMIT 1`
// anywhere in this file).
//
// client/pool lifecycle is entirely CALLER-owned: this module never calls
// client.end()/pool.end()/pool.release() and accepts anything exposing an
// async query(sql, params) method (a pg Client, a pg Pool, or a test fake).
//
// get*(id) methods (getFact/getEvidence/getEvent/getRelation) and
// query*(filters) methods (queryFacts/queryEvents/queryRelations/
// queryEvidence) each issue their OWN fresh, parameter-bound SQL on every
// call -- there is no construction-time cache to go stale, and (just as
// important for the required negative-test coverage) a genuine DB failure
// during any individual call surfaces as a thrown error from THAT call, not
// as a quietly-returned NOT_FOUND. This is safe to do on every call (not
// just once) because a READY release's artifacts/records are provably
// immutable for the repository's entire lifetime -- 002_reference_release.sql's
// `reject_non_loading_child_write`/`guard_release_transition` triggers make
// it impossible for the underlying rows to change out from under a live
// repository instance.
//
// KNOWN, DELIBERATE SIMPLIFICATION vs the portable seed-structured-query-adapter.mjs:
// that adapter falls back to a cross-artifact "documentCorp" map (inferring
// a record's corp_code from ANY other Fact/Event/Relation anchored to the
// same document_id) when a Relation/Evidence record's own corp_code is
// missing. This repository builds that SAME documentCorp map (from a single
// combined SELECT over all four VERIFIED_* roles, every query* call) so
// query results stay semantically identical to the portable adapter for the
// real v0.20-r3 data (empirically verified: all 40 Relations already carry
// attributes.corp_code, and all 24 Evidence records missing metadata.corp_code
// are covered by the documentCorp fallback -- see
// tests/reference-repository-postgres16-integration.test.mjs's full
// 87/219/24/40 equivalence check against the portable adapter).
import { RequestAbortedError, abortReason } from "../runtime/abortable.mjs";

const RELEASES_TABLE = "disclosure_reference.releases";
const RECORDS_TABLE = "disclosure_reference.records";

const VERIFIED_ROLES = Object.freeze(["VERIFIED_FACT", "VERIFIED_EVENT", "VERIFIED_RELATION", "VERIFIED_EVIDENCE"]);
const ROLE_BY_TARGET = Object.freeze({ FACT: "VERIFIED_FACT", EVENT: "VERIFIED_EVENT", RELATION: "VERIFIED_RELATION", EVIDENCE: "VERIFIED_EVIDENCE" });
const ID_FIELD_BY_TARGET = Object.freeze({ FACT: "fact_id", EVENT: "event_id", RELATION: "relation_id", EVIDENCE: "evidence_id" });
const ID_FIELD_BY_ROLE = Object.freeze({ VERIFIED_FACT: "fact_id", VERIFIED_EVENT: "event_id", VERIFIED_RELATION: "relation_id", VERIFIED_EVIDENCE: "evidence_id" });
const TARGET_ORDER = Object.freeze({ FACT: 0, EVENT: 1, RELATION: 2, EVIDENCE: 3 });

export class ReferenceRepositoryIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReferenceRepositoryIntegrityError";
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${name} is required and must be a non-empty string`);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// Checked immediately before AND after every SQL round trip -- "before" so
// an already-aborted signal never issues a query at all, "after" so a
// signal that aborted WHILE the query was in flight is not silently
// ignored just because node-postgres itself returned a result. This
// project's `pg` usage does NOT wire real mid-flight query cancellation
// (node-postgres has no built-in AbortSignal integration, and implementing
// true server-side cancellation would require a second connection issuing
// pg_cancel_backend -- out of scope for this Turn and not attempted here).
// A caller that aborts mid-query gets a RequestAbortedError promptly after
// the query settles, but the query itself keeps running to completion on
// the server; this limitation is deliberate and documented, not silently
// assumed away.
async function checkedQuery(client, signal, sql, params) {
  if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
  const result = await client.query(sql, params);
  if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
  return result;
}

function dateValue(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}
function intersects(recordStart, recordEnd, filterStart, filterEnd) {
  const rs = dateValue(recordStart) ?? Number.NEGATIVE_INFINITY;
  const re = dateValue(recordEnd) ?? rs;
  const fs = dateValue(filterStart) ?? Number.NEGATIVE_INFINITY;
  const fe = dateValue(filterEnd) ?? Number.POSITIVE_INFINITY;
  return rs <= fe && re >= fs;
}
function includesOrEmpty(values, candidate) {
  return !values || values.length === 0 || values.includes(candidate);
}
function documentDate(documentId) {
  const match = /_(\d{4})(\d{2})(\d{2})\d{6}$/.exec(documentId ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}
function atStartOfDay(date) {
  return date ? `${date}T00:00:00Z` : null;
}

// Mirrors seed-structured-query-adapter.mjs's `descriptor()` field-by-field
// -- same target-type shape, same fallback order -- so a query result is
// structurally comparable to the portable adapter's own output. `documentCorp`
// is the fallback map built once per query* call from ALL four VERIFIED_*
// roles (see buildDescriptors below), not just the target type being queried.
function descriptor(type, raw, documentCorp) {
  if (type === "FACT") {
    return {
      record_type: type, record_id: raw.fact_id, verification_status: raw.verification_status, known_at: raw.known_at,
      source_document_ids: [raw.source_document_id], evidence_ids: raw.evidence_ids ?? [], payload: raw,
      corp_code: raw.corp_code, metric_code: raw.metric_code, scope: raw.scope ?? "UNKNOWN", period_type: raw.period_type,
      period_start: raw.period_start ?? raw.as_of_date, period_end: raw.period_end ?? raw.as_of_date,
      valid_from: raw.valid_from, valid_to: raw.valid_to,
    };
  }
  if (type === "EVENT") {
    return {
      record_type: type, record_id: raw.event_id, verification_status: raw.verification_status, known_at: raw.known_at,
      source_document_ids: [raw.anchor_document_id], evidence_ids: raw.evidence_ids ?? [], payload: raw,
      corp_code: raw.corp_code, event_type: raw.event_type, scope: "COMPANY", period_type: "EVENT_PERIOD",
      period_start: raw.event_date, period_end: raw.event_date, valid_from: raw.valid_from, valid_to: raw.valid_to,
    };
  }
  if (type === "RELATION") {
    const date = documentDate(raw.source_document_id);
    return {
      record_type: type, record_id: raw.relation_id, verification_status: raw.verification_status,
      known_at: atStartOfDay(date), source_document_ids: [raw.source_document_id, raw.target_document_id],
      evidence_ids: raw.evidence_id ? [raw.evidence_id] : [], payload: raw,
      corp_code: raw.attributes?.corp_code ?? documentCorp.get(raw.source_document_id) ?? null, relation_type: raw.relation_type,
      scope: "COMPANY", period_type: "EVENT_PERIOD", period_start: date, period_end: date,
    };
  }
  const date = documentDate(raw.document_id);
  return {
    record_type: "EVIDENCE", record_id: raw.evidence_id, verification_status: raw.verification_status,
    known_at: atStartOfDay(date), source_document_ids: [raw.document_id], evidence_ids: [raw.evidence_id], payload: raw,
    corp_code: raw.metadata?.corp_code ?? documentCorp.get(raw.document_id) ?? null, scope: "COMPANY", period_type: "UNKNOWN",
    period_start: date, period_end: date,
  };
}

function trimmedRecord(record) {
  return deepFreeze(structuredClone({
    record_type: record.record_type, record_id: record.record_id, verification_status: record.verification_status,
    known_at: record.known_at, source_document_ids: record.source_document_ids, evidence_ids: record.evidence_ids,
    payload: record.payload,
  }));
}

function recordMatchesFilters(record, filters) {
  if (!includesOrEmpty(filters.verification_statuses, record.verification_status)) return false;
  if (!includesOrEmpty(filters.corp_codes, record.corp_code)) return false;
  if (!includesOrEmpty(filters.scope_filter, record.scope)) return false;
  const asOfEndOfDay = dateValue(`${filters.as_of_date}T23:59:59.999Z`);
  if (dateValue(record.known_at) > asOfEndOfDay) return false;
  if (record.valid_from && dateValue(record.valid_from) > asOfEndOfDay) return false;
  if (record.valid_to && dateValue(record.valid_to) < dateValue(`${filters.as_of_date}T00:00:00Z`)) return false;
  if (!includesOrEmpty(filters.period_filter?.period_types, record.period_type)) return false;
  if (!intersects(record.period_start, record.period_end, filters.period_filter?.start, filters.period_filter?.end)) return false;

  if (record.record_type === "FACT") {
    if (!includesOrEmpty(filters.metric_codes, record.metric_code) || !includesOrEmpty(filters.fact_ids, record.record_id)) return false;
  } else if (record.record_type === "EVENT") {
    if (!includesOrEmpty(filters.event_types, record.event_type) || !includesOrEmpty(filters.event_ids, record.record_id)) return false;
  } else if (record.record_type === "RELATION") {
    if (!includesOrEmpty(filters.relation_types, record.relation_type) || !includesOrEmpty(filters.relation_ids, record.record_id)) return false;
  } else if (!includesOrEmpty(filters.evidence_ids, record.record_id)) {
    return false;
  }
  if (filters.document_ids?.length && !record.source_document_ids.some((id) => filters.document_ids.includes(id))) return false;
  if (filters.evidence_ids?.length && !record.evidence_ids.some((id) => filters.evidence_ids.includes(id))) return false;
  return true;
}

function sortRecords(records) {
  return [...records].sort((a, b) => {
    const time = (dateValue(b.known_at) ?? 0) - (dateValue(a.known_at) ?? 0);
    return time || TARGET_ORDER[a.record_type] - TARGET_ORDER[b.record_type] || a.record_id.localeCompare(b.record_id);
  });
}

function assertValidFilters(filters) {
  if (!filters || typeof filters !== "object") throw new TypeError("filters is required");
  if (typeof filters.as_of_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(filters.as_of_date)) {
    throw new TypeError("filters.as_of_date is required and must be an ISO date string (YYYY-MM-DD)");
  }
  if (!Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 1000) {
    throw new TypeError("filters.limit is required and must be an integer between 1 and 1000");
  }
}

// Every role's own record_key must equal the ID field the record's OWN
// payload declares for its type (e.g. a VERIFIED_FACT row's record_key must
// equal payload.fact_id) -- this is the single integrity check backing both
// the "role mismatch" and "record_key <-> payload ID mismatch" required
// negative tests: a row whose stored role does not match what its payload
// actually looks like, AND a row whose record_key was corrupted/rewritten
// independently of its payload, both fail this same assertion. Also
// enforces the VERIFIED-only boundary at the lowest layer, defense-in-depth
// against a hand-crafted non-VERIFIED row ever slipping into a VERIFIED_*
// role (the loader does not itself enforce this at import time -- see
// reference-release-contract.mjs).
function assertRoleRecordIntegrity(role, idField, row) {
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || payload[idField] !== row.record_key) {
    throw new ReferenceRepositoryIntegrityError(
      `${role}: record_key "${row.record_key}" does not match payload.${idField} (${JSON.stringify(payload?.[idField])}) -- refusing to serve a row whose role/record_key does not match its own payload`,
    );
  }
  if (payload.verification_status !== "VERIFIED") {
    throw new ReferenceRepositoryIntegrityError(
      `${role} "${row.record_key}": verification_status is "${payload.verification_status}", not VERIFIED -- refusing to serve non-VERIFIED data from a VERIFIED_* role`,
    );
  }
}

async function fetchVerifiedRows({ client, releaseId, roles, signal }) {
  const result = await checkedQuery(
    client, signal,
    `SELECT role, record_key, payload FROM ${RECORDS_TABLE} WHERE release_id = $1 AND role = ANY($2) ORDER BY role, ordinal`,
    [releaseId, roles],
  );
  return result.rows;
}

// Turn N2.1 fix (Codex-reported defect): mirrors seed-structured-query-adapter.mjs's
// own `register()` exactly -- the SAME document_id repeated with the SAME
// corp_code is fine (idempotent registration), but the SAME document_id
// with a DIFFERENT corp_code across ANY combination of Fact/Event/Relation
// is a genuine data-integrity conflict, not something to resolve by
// silently keeping whichever value happened to be seen first. The previous
// `if (!documentCorp.has(documentId))` form did exactly that -- accepting a
// bundle where the same document_id-> two different real companies, and
// never surfacing it. Every register() call (Fact/Event/Relation source AND
// target document ids) goes through this same check, so a conflict is
// caught no matter which role pair introduces it, and no matter which
// target's query* call triggers the read (buildDocumentCorpMap always scans
// all four VERIFIED_* roles up front -- see queryByTarget below).
function buildDocumentCorpMap(rowsByRole) {
  const documentCorp = new Map();
  const register = (documentId, corpCode) => {
    if (!documentId || !corpCode) return;
    const prior = documentCorp.get(documentId);
    if (prior !== undefined && prior !== corpCode) {
      throw new ReferenceRepositoryIntegrityError(
        `document_id "${documentId}" is associated with conflicting corp_code values ("${prior}" vs "${corpCode}") across VERIFIED_FACT/VERIFIED_EVENT/VERIFIED_RELATION -- refusing to guess which one is correct`,
      );
    }
    documentCorp.set(documentId, corpCode);
  };
  for (const row of rowsByRole.get("VERIFIED_FACT") ?? []) register(row.payload.source_document_id, row.payload.corp_code);
  for (const row of rowsByRole.get("VERIFIED_EVENT") ?? []) register(row.payload.anchor_document_id, row.payload.corp_code);
  for (const row of rowsByRole.get("VERIFIED_RELATION") ?? []) {
    register(row.payload.source_document_id, row.payload.attributes?.corp_code);
    register(row.payload.target_document_id, row.payload.attributes?.corp_code);
  }
  return documentCorp;
}

async function queryByTarget({ client, releaseId, target, filters, signal }) {
  assertValidFilters(filters);
  const rows = await fetchVerifiedRows({ client, releaseId, roles: VERIFIED_ROLES, signal });
  const rowsByRole = new Map();
  for (const row of rows) {
    assertRoleRecordIntegrity(row.role, ID_FIELD_BY_ROLE[row.role], row);
    if (!rowsByRole.has(row.role)) rowsByRole.set(row.role, []);
    rowsByRole.get(row.role).push(row);
  }
  const documentCorp = buildDocumentCorpMap(rowsByRole);
  const role = ROLE_BY_TARGET[target];
  const records = (rowsByRole.get(role) ?? []).map((row) => descriptor(target, row.payload, documentCorp));
  const matched = records.filter((record) => recordMatchesFilters(record, filters));
  return sortRecords(matched).slice(0, filters.limit).map(trimmedRecord);
}

export async function createPostgresReferenceRepository(options = {}) {
  const { client, expectedReleaseId, expectedCorpusSnapshotId, expectedApprovedRevision, expectedFactCoverageSnapshotId } = options;
  if (!client || typeof client.query !== "function") throw new TypeError("client (or pool) with an async query(sql, params) method is required");
  assertNonEmptyString(expectedReleaseId, "expectedReleaseId");
  assertNonEmptyString(expectedCorpusSnapshotId, "expectedCorpusSnapshotId");
  assertNonEmptyString(expectedApprovedRevision, "expectedApprovedRevision");
  assertNonEmptyString(expectedFactCoverageSnapshotId, "expectedFactCoverageSnapshotId");

  const result = await client.query(
    `SELECT release_id, status, approved_revision, corpus_snapshot_id, fact_coverage_snapshot_id FROM ${RELEASES_TABLE} WHERE release_id = $1`,
    [expectedReleaseId],
  );
  const row = result?.rows?.[0];
  // Fail-closed with NO fallback: a missing release, or one that is still
  // LOADING, is treated identically to "cannot construct a repository" --
  // never silently substituted with a different release_id (there is no
  // `ORDER BY imported_at DESC LIMIT 1` anywhere in this module).
  if (!row) {
    throw new Error(`disclosure_reference release "${expectedReleaseId}" was not found -- refusing to construct a repository`);
  }
  if (row.status !== "READY") {
    throw new Error(`disclosure_reference release "${expectedReleaseId}" is not READY (status=${row.status}) -- refusing to construct a repository`);
  }
  if (row.corpus_snapshot_id !== expectedCorpusSnapshotId) {
    throw new Error(`disclosure_reference release "${expectedReleaseId}": corpus_snapshot_id mismatch (expected ${expectedCorpusSnapshotId}, found ${row.corpus_snapshot_id})`);
  }
  if (row.approved_revision !== expectedApprovedRevision) {
    throw new Error(`disclosure_reference release "${expectedReleaseId}": approved_revision mismatch (expected ${expectedApprovedRevision}, found ${row.approved_revision})`);
  }
  if ((row.fact_coverage_snapshot_id ?? null) !== expectedFactCoverageSnapshotId) {
    throw new Error(`disclosure_reference release "${expectedReleaseId}": fact_coverage_snapshot_id mismatch (expected ${expectedFactCoverageSnapshotId}, found ${row.fact_coverage_snapshot_id})`);
  }

  const releaseId = row.release_id;
  const corpusSnapshotId = row.corpus_snapshot_id;
  const factCoverageSnapshotId = row.fact_coverage_snapshot_id;
  const approvedRevision = row.approved_revision;

  async function getByRole(target, id, signal) {
    if (typeof id !== "string" || id === "") return null;
    const role = ROLE_BY_TARGET[target];
    const idField = ID_FIELD_BY_TARGET[target];
    const result = await checkedQuery(
      client, signal,
      `SELECT record_key, payload FROM ${RECORDS_TABLE} WHERE release_id = $1 AND role = $2 AND record_key = $3`,
      [releaseId, role, id],
    );
    const found = result.rows[0];
    if (!found) return null;
    assertRoleRecordIntegrity(role, idField, found);
    // Independent copy: a caller mutating the returned object can never
    // affect a later call's result or any other caller's view of the DB.
    return deepFreeze(structuredClone(found.payload));
  }

  return Object.freeze({
    releaseId,
    corpusSnapshotId,
    factCoverageSnapshotId,
    approvedRevision,

    async getFact(factId, { signal } = {}) {
      return getByRole("FACT", factId, signal);
    },
    async getEvidence(evidenceId, { signal } = {}) {
      return getByRole("EVIDENCE", evidenceId, signal);
    },
    async getEvent(eventId, { signal } = {}) {
      return getByRole("EVENT", eventId, signal);
    },
    async getRelation(relationId, { signal } = {}) {
      return getByRole("RELATION", relationId, signal);
    },

    async queryFacts(filters, { signal } = {}) {
      return queryByTarget({ client, releaseId, target: "FACT", filters, signal });
    },
    async queryEvents(filters, { signal } = {}) {
      return queryByTarget({ client, releaseId, target: "EVENT", filters, signal });
    },
    async queryRelations(filters, { signal } = {}) {
      return queryByTarget({ client, releaseId, target: "RELATION", filters, signal });
    },
    // Not in the Turn N2 spec's explicit "최소 조회 기능" list, but required
    // for the StructuredStore adapter to honestly support a query whose
    // `targets` includes "EVIDENCE" (structured-query.schema.json allows
    // it) without inventing a second, divergent filter mechanism.
    async queryEvidence(filters, { signal } = {}) {
      return queryByTarget({ client, releaseId, target: "EVIDENCE", filters, signal });
    },

    // Diagnostics only -- not part of any Runtime Store contract.
    async recordCounts({ signal } = {}) {
      const rows = await fetchVerifiedRows({ client, releaseId, roles: VERIFIED_ROLES, signal });
      const counts = { FACT: 0, EVENT: 0, RELATION: 0, EVIDENCE: 0 };
      const roleToTarget = { VERIFIED_FACT: "FACT", VERIFIED_EVENT: "EVENT", VERIFIED_RELATION: "RELATION", VERIFIED_EVIDENCE: "EVIDENCE" };
      for (const row of rows) counts[roleToTarget[row.role]] += 1;
      return Object.freeze(counts);
    },
  });
}
