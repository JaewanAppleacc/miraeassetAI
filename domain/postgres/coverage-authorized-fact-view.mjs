// Turn N3.1 (hardened in N3.1.1): a thin, read-only Coverage-authorization
// boundary in FRONT of domain/postgres/reference-repository.mjs's raw
// getFact/queryFacts -- mirrors, for the PostgreSQL path, exactly what
// domain/adapters/seed-fact-artifact-store.mjs already enforces for the
// portable bundle path: getFact()/queryFacts() only ever serve a fact_id
// that is actually referenced by SOME slot in the release's
// FACT_COVERAGE_SNAPSHOT, AND whose corp_code/metric_code/non-null scope
// agree with that slot. A VERIFIED Fact sitting in the release but outside
// every slot's fact_ids -- or referenced by a slot whose own dimensions
// disagree with the Fact's -- is treated exactly like a Fact that does not
// exist.
//
// This module NEVER modifies domain/postgres/reference-repository.mjs --
// it does not import anything from that file beyond using an
// already-constructed `repository` instance as a plain dependency, exactly
// the way createPostgresFactStoreAdapter/createPostgresStructuredStoreAdapter
// already consume it in reference-runtime-adapters.mjs. The raw
// repository's own getFact/queryFacts keep serving every VERIFIED_FACT row
// in the release, unfiltered -- that is its audit/diagnostic purpose (see
// domain/postgres/README.md's "raw Repository vs Agent adapter" section).
// This module is the ONLY place PostgreSQL-side Coverage authorization is
// decided; nothing here fabricates or infers authorization from any source
// other than the release's own FACT_COVERAGE_SNAPSHOT rows, and every Fact
// payload used for the dimension check is fetched through the raw
// Repository's own already-integrity-checked getFact() -- never a second,
// separately-reimplemented read of disclosure_reference.records.
//
// Real DB storage shape (verified directly against a real PostgreSQL 16
// v0.20-r3 load before writing this module -- not assumed from reading the
// loader alone): domain/postgres/reference-release-contract.mjs's
// ARRAY_ROLE_CONFIG.FACT_COVERAGE_SNAPSHOT explodes the coverage document's
// `slots[]` array into ONE disclosure_reference.records ROW PER SLOT, with
// role='FACT_COVERAGE_SNAPSHOT', record_key=slot.slot_key, and
// payload=the individual slot object (NOT the whole coverage document --
// the slot payload itself carries no fact_coverage_snapshot_id or
// corpus_snapshot_id field; those live only on disclosure_reference.releases,
// already pin-verified by the time a `repository` exists). For the real
// v0.20-r3 release this is 102 slot rows whose fact_ids[] union to exactly
// the 87 real VERIFIED_FACT ids.
import { RequestAbortedError, abortReason } from "../runtime/abortable.mjs";

const RECORDS_TABLE = "disclosure_reference.records";
const COVERAGE_ROLE = "FACT_COVERAGE_SNAPSHOT";

export class CoverageAuthorizationIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoverageAuthorizationIntegrityError";
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${name} is required and must be a non-empty string`);
  }
}

async function checkedQuery(client, signal, sql, params) {
  if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
  const result = await client.query(sql, params);
  if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
  return result;
}

// Same role/record_key <-> payload integrity discipline as
// reference-repository.mjs's assertRoleRecordIntegrity, applied to
// FACT_COVERAGE_SNAPSHOT slot rows specifically: a row whose record_key
// was corrupted/rewritten independently of its own payload.slot_key, or
// whose payload does not look like a real VERIFIED coverage slot, is
// refused rather than silently trusted for authorization decisions.
function assertSlotIntegrity(row) {
  const slot = row.payload;
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
    throw new CoverageAuthorizationIntegrityError(
      `FACT_COVERAGE_SNAPSHOT "${row.record_key}": payload is not an object -- refusing to trust a malformed coverage slot`,
    );
  }
  if (slot.slot_key !== row.record_key) {
    throw new CoverageAuthorizationIntegrityError(
      `FACT_COVERAGE_SNAPSHOT: record_key "${row.record_key}" does not match payload.slot_key (${JSON.stringify(slot.slot_key)}) -- refusing to trust a coverage slot whose record_key does not match its own payload`,
    );
  }
  if (slot.verification_status !== "VERIFIED") {
    throw new CoverageAuthorizationIntegrityError(
      `FACT_COVERAGE_SNAPSHOT slot "${row.record_key}": verification_status is "${slot.verification_status}", not VERIFIED -- refusing to authorize Facts from a non-VERIFIED coverage slot`,
    );
  }
  if (!Array.isArray(slot.fact_ids) || slot.fact_ids.some((id) => typeof id !== "string" || id === "")) {
    throw new CoverageAuthorizationIntegrityError(
      `FACT_COVERAGE_SNAPSHOT slot "${row.record_key}": fact_ids must be an array of non-empty strings -- refusing a malformed coverage payload`,
    );
  }
}

// Turn N3.1.1: the SAME direct-dimension-consistency rule
// domain/adapters/seed-fact-artifact-store.mjs already enforces for the
// portable bundle path -- corp_code and metric_code must match exactly;
// scope is checked ONLY when the slot declares a non-null/non-undefined
// scope (a slot omitting scope, or setting it to null, means "no scope
// filter", matching the portable store's own `!= null` loose check). No
// new meaning is invented for period_key -- it is deliberately left
// unchecked here, exactly as the portable store leaves it unchecked (no
// official Fact-field mapping exists for it).
function assertSlotFactDimensionsMatch(slotKey, slot, factId, factPayload) {
  if (factPayload.corp_code !== slot.corp_code) {
    throw new CoverageAuthorizationIntegrityError(
      `FACT_COVERAGE_SNAPSHOT slot "${slotKey}": corp_code "${slot.corp_code}" does not match fact_id "${factId}" corp_code "${factPayload.corp_code}"`,
    );
  }
  if (factPayload.metric_code !== slot.metric_code) {
    throw new CoverageAuthorizationIntegrityError(
      `FACT_COVERAGE_SNAPSHOT slot "${slotKey}": metric_code "${slot.metric_code}" does not match fact_id "${factId}" metric_code "${factPayload.metric_code}"`,
    );
  }
  if (slot.scope != null && factPayload.scope !== slot.scope) {
    throw new CoverageAuthorizationIntegrityError(
      `FACT_COVERAGE_SNAPSHOT slot "${slotKey}": scope "${slot.scope}" does not match fact_id "${factId}" scope "${factPayload.scope}"`,
    );
  }
}

// Fails closed (rejects) on: expectedFactCoverageSnapshotId missing or not
// matching the repository's own already-pin-verified factCoverageSnapshotId
// (never trusts a caller-supplied pin that disagrees with the repository it
// is layered on top of -- this is what makes "다른 release의 Coverage를
// 섞지 않음" structural rather than a convention: every slot query below is
// scoped to repository.releaseId, the SAME release_id the repository itself
// was pin-verified against), zero FACT_COVERAGE_SNAPSHOT rows for the
// release (a Coverage-authorized view with an empty authorization boundary
// would silently authorize nothing forever -- treated as a construction
// failure, not a legitimate empty state), a malformed slot payload, a slot
// row whose role/record_key does not match its own payload (see
// assertSlotIntegrity), a slot referencing a fact_id that does not resolve
// to any real VERIFIED_FACT row in the same release (checked via the raw
// Repository's own pinned getFact() -- never a bulk, limit-bounded scan, so
// this scales correctly regardless of total Fact count), a slot whose
// corp_code/metric_code/non-null scope disagrees with a Fact it authorizes
// (mirrors seed-fact-artifact-store.mjs's own direct-dimension-consistency
// check), or a genuine DB failure during any of the above (propagates as a
// thrown error, same as the raw repository -- never silently converted into
// an empty authorization set).
//
// The SAME fact_id is allowed to appear in more than one slot (matching
// seed-fact-artifact-store.mjs's own documented policy) -- each occurrence
// is still independently required to pass the dimension check against
// THAT slot.
export async function createCoverageAuthorizedFactView({ client, repository, expectedFactCoverageSnapshotId, signal } = {}) {
  if (!client || typeof client.query !== "function") throw new TypeError("client (or pool) with an async query(sql, params) method is required");
  if (!repository || typeof repository.getFact !== "function" || typeof repository.queryFacts !== "function") {
    throw new TypeError("repository (a constructed createPostgresReferenceRepository instance) is required");
  }
  assertNonEmptyString(expectedFactCoverageSnapshotId, "expectedFactCoverageSnapshotId");
  if (repository.factCoverageSnapshotId !== expectedFactCoverageSnapshotId) {
    throw new Error(
      `coverage-authorized fact view: fact_coverage_snapshot_id mismatch (repository is pinned to "${repository.factCoverageSnapshotId}", caller expected "${expectedFactCoverageSnapshotId}")`,
    );
  }

  const slotResult = await checkedQuery(
    client, signal,
    `SELECT record_key, payload FROM ${RECORDS_TABLE} WHERE release_id = $1 AND role = $2 ORDER BY ordinal`,
    [repository.releaseId, COVERAGE_ROLE],
  );
  if (slotResult.rows.length === 0) {
    throw new Error(
      `coverage-authorized fact view: release "${repository.releaseId}" has zero FACT_COVERAGE_SNAPSHOT rows -- refusing to construct an authorization boundary that would authorize nothing`,
    );
  }

  // Sequential, not Promise.all: the repository's `client` may be a single
  // pg.Client (one physical connection), which does not support concurrent
  // in-flight queries -- same rationale already documented in
  // reference-runtime-adapters.mjs for its own per-target query loop.
  const factPayloadCache = new Map(); // fact_id -> payload (from repository.getFact)
  async function resolveFact(factId) {
    if (factPayloadCache.has(factId)) return factPayloadCache.get(factId);
    const payload = await repository.getFact(factId, { signal });
    factPayloadCache.set(factId, payload);
    return payload;
  }

  const authorizedFactIds = new Set();
  for (const row of slotResult.rows) {
    assertSlotIntegrity(row);
    const slot = row.payload;
    for (const factId of slot.fact_ids) {
      const factPayload = await resolveFact(factId);
      if (!factPayload) {
        throw new Error(
          `coverage-authorized fact view: a coverage slot references fact_id "${factId}", which is not a real VERIFIED_FACT row in release "${repository.releaseId}"`,
        );
      }
      assertSlotFactDimensionsMatch(row.record_key, slot, factId, factPayload);
      authorizedFactIds.add(factId);
    }
  }

  return Object.freeze({
    releaseId: repository.releaseId,
    corpusSnapshotId: repository.corpusSnapshotId,
    factCoverageSnapshotId: repository.factCoverageSnapshotId,
    approvedRevision: repository.approvedRevision,

    // Same null-for-not-found / throw-for-real-failure contract as
    // repository.getFact -- a fact_id that is VERIFIED but not
    // Coverage-authorized is indistinguishable from a fact_id that does
    // not exist at all, exactly matching seed-fact-artifact-store.mjs's
    // getFact().
    async getFact(factId, { signal: callSignal } = {}) {
      if (!authorizedFactIds.has(factId)) return null;
      return repository.getFact(factId, { signal: callSignal });
    },

    // Turn N3.1.1: authorization is now PUSHED DOWN into the raw
    // Repository's own `fact_ids` filter, not applied by fetching a fixed
    // limit=1000 slice and filtering afterward -- the previous approach
    // silently under-served whenever the total real Fact count exceeded
    // 1000, or whenever unauthorized Facts happened to sort ahead of
    // authorized ones within the first 1000. Pushing the filter down means
    // repository.queryFacts itself does the full filter -> sort -> limit
    // pipeline over the COMPLETE record set (it has no internal 1000-row
    // pre-truncation of its own -- only the final OUTPUT is capped at
    // 1000, per its own filters.limit contract), so authorization is
    // always applied before limit, regardless of how many real Facts
    // exist.
    async queryFacts(filters, { signal: callSignal } = {}) {
      if (!filters || typeof filters !== "object") throw new TypeError("filters is required");
      if (!Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 1000) {
        throw new TypeError("filters.limit is required and must be an integer between 1 and 1000");
      }
      const requestedFactIds = Array.isArray(filters.fact_ids) ? filters.fact_ids : [];
      // requestedFactIds.length === 0 means the caller did not restrict by
      // fact_id at all -- the full authorized set applies. A non-empty
      // requestedFactIds means the caller DID restrict, so only the
      // intersection with the authorized set may ever be returned.
      const effectiveFactIds = requestedFactIds.length > 0
        ? requestedFactIds.filter((id) => authorizedFactIds.has(id))
        : [...authorizedFactIds];
      // Turn N3.1.2: a genuinely empty intersection is answered directly --
      // no query is issued to the raw Repository at all, and no sentinel
      // fact_id is fabricated to coerce a real query into matching zero
      // rows. reference-repository.mjs's own filter semantics treat an
      // EMPTY `fact_ids` array as "no restriction" (its `includesOrEmpty`
      // helper), so pushing an empty array down would have silently meant
      // "return everything" -- returning [] here directly, before any
      // query, is simpler and cannot leak any real (or accidentally
      // sentinel-colliding) record_key. The abort check mirrors
      // checkedQuery's own "before" check so an already-aborted signal is
      // never silently ignored just because this path does no I/O.
      if (effectiveFactIds.length === 0) {
        if (callSignal?.aborted) throw new RequestAbortedError(abortReason(callSignal));
        return [];
      }
      return repository.queryFacts({ ...filters, fact_ids: effectiveFactIds }, { signal: callSignal });
    },

    // Diagnostics only -- not part of any Runtime Store contract.
    authorizedFactCount() {
      return authorizedFactIds.size;
    },
  });
}
