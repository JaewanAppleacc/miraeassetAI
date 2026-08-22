// Turn N2: REAL PostgreSQL 16 integration coverage for
// domain/postgres/reference-repository.mjs and
// domain/postgres/reference-runtime-adapters.mjs -- the read-only
// Repository/Adapter layer, as distinct from tests/reference-release-postgres16-integration.test.mjs
// (which covers the WRITE side: migration + loader + immutability triggers
// + grants). This suite loads the real v0.20-r3 bundle into a disposable
// scratch database, then verifies the Repository serves semantically
// IDENTICAL data to the portable seed-structured-query-adapter.mjs for the
// full VERIFIED_FACT(87)/VERIFIED_EVIDENCE(219)/VERIFIED_EVENT(24)/
// VERIFIED_RELATION(40) sets, plus representative filtered queries, plus
// the Repository's own negative paths against a real server, plus real
// reader-role least-privilege enforcement.
//
// Deliberately excluded from `npm run test:reference-db` and
// `npm run verify:contracts` -- run explicitly via:
//
//   DATABASE_URL='postgresql://user:pass@host:5432/scratch_db' \
//     npm run test:reference-repository:postgres16
//
// If DATABASE_URL is not set, this suite FAILS CLOSED with
// POSTGRESQL_16_INTEGRATION_NOT_RUN (never a silent skip).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import { applyReferenceReleaseMigration, importReferenceRelease } from "../domain/postgres/reference-release-loader.mjs";
import { applyReferenceReaderGrant } from "../domain/postgres/reference-release-grants.mjs";
import { createPostgresReferenceRepository } from "../domain/postgres/reference-repository.mjs";
import {
  createPostgresFactStoreAdapter,
  createPostgresEvidenceStoreAdapter,
  createPostgresStructuredStoreAdapter,
} from "../domain/postgres/reference-runtime-adapters.mjs";
import { compareRecordSets, compareSingleRecord, assertParity } from "../domain/postgres/shadow-parity-comparator.mjs";
import { createCoverageAuthorizedFactView } from "../domain/postgres/coverage-authorized-fact-view.mjs";
import { createSeedStructuredQueryAdapter } from "../domain/adapters/seed-structured-query-adapter.mjs";
import { createSeedFactArtifactStore } from "../domain/adapters/seed-fact-artifact-store.mjs";
import { createSeedEvidenceArtifactStore } from "../domain/adapters/seed-evidence-artifact-store.mjs";
import { createFactStore } from "../domain/runtime/fact-store.mjs";
import { createEvidenceStore } from "../domain/runtime/citation-validator.mjs";
import { createStructuredStore } from "../domain/runtime/structured-store.mjs";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dirname, "..");
const LOAD_OPTIONS = Object.freeze({
  root: ROOT,
  bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: "seed-release-v0.20",
  expectedApprovedRevision: "seed-structured-artifacts-v0.7",
});
const RELEASE_ID = "seed-release-v0.20";
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
const APPROVED_REVISION = "seed-structured-artifacts-v0.7";
const FACT_COVERAGE_SNAPSHOT_ID = "fact_coverage_snapshot_87ad2fa54e8ab7f7543c1ce3";
const STRUCTURED_MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json");
const READER_ROLE = "disclosure_reference_repo_test_reader";
const FAR_FUTURE_AS_OF_DATE = "2099-12-31";

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url === "") {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: DATABASE_URL is required to run tests/reference-repository-postgres16-integration.test.mjs. "
      + "Point it at an EMPTY scratch PostgreSQL 16 database, e.g.: "
      + "DATABASE_URL='postgresql://user:pass@localhost:5432/scratch_db' npm run test:reference-repository:postgres16",
    );
  }
  return url;
}

function baseQuery(overrides) {
  return {
    schema_version: "0.2.0", query_id: "query_n2_equivalence", execution_scope: "OFFICIAL",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
    corp_codes: [], predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: FAR_FUTURE_AS_OF_DATE, limit: 1000,
    ...overrides,
  };
}
function baseFilters(overrides) {
  return {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [], fact_ids: [], event_ids: [], relation_ids: [],
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: FAR_FUTURE_AS_OF_DATE, limit: 1000,
    ...overrides,
  };
}

function sortById(records) {
  return [...records].sort((a, b) => a.record_id.localeCompare(b.record_id));
}
function assertEquivalentRecordSets(dbRecords, portableRecords, label) {
  const db = sortById(dbRecords);
  const portable = sortById(portableRecords);
  assert.equal(db.length, portable.length, `${label}: record count differs`);
  for (let i = 0; i < db.length; i += 1) {
    assert.equal(db[i].record_id, portable[i].record_id, `${label}[${i}]: record_id differs`);
    assert.deepEqual(db[i], portable[i], `${label}[${i}] (${db[i].record_id}): full record differs between DB adapter and portable adapter`);
  }
}

// Turn N3: resolves the SAME structured-manifest role pins the portable
// query adapter already loads, so productionFactStore/productionEvidenceStore
// below are the REAL production-shaped bundle read path (createSeedFactArtifactStore/
// createSeedEvidenceArtifactStore, exactly as domain/adapters/seed-runtime-service-adapters.mjs
// wires them) -- not a stand-in built from the broader structured-query
// adapter's query() results. This is the accurate "existing bundle read
// path" comparison target for getFact/getEvidence single-ID parity.
async function loadStructuredManifestRoles() {
  const manifest = JSON.parse(await readFile(STRUCTURED_MANIFEST_PATH, "utf8"));
  return new Map((manifest.artifacts ?? []).map((artifact) => [artifact.role, artifact]));
}

let client, repository, portableAdapter, productionFactStore, productionEvidenceStore;
test.before(async () => {
  client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  const existing = await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'disclosure_reference'");
  if (existing.rows.length > 0) {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: disclosure_reference schema already exists on the target database. "
      + "This suite requires a genuinely empty scratch database.",
    );
  }
  await applyReferenceReleaseMigration({ client, root: ROOT });
  const result = await importReferenceRelease({ client, ...LOAD_OPTIONS });
  assert.equal(result.status, "LOADED");

  repository = await createPostgresReferenceRepository({
    client,
    expectedReleaseId: RELEASE_ID,
    expectedCorpusSnapshotId: CORPUS_SNAPSHOT_ID,
    expectedApprovedRevision: APPROVED_REVISION,
    expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID,
  });
  portableAdapter = await createSeedStructuredQueryAdapter({ manifestPath: STRUCTURED_MANIFEST_PATH, root: ROOT });

  const roles = await loadStructuredManifestRoles();
  const resolveRolePath = (role) => path.resolve(ROOT, roles.get(role).path);
  productionFactStore = await createSeedFactArtifactStore({
    factArtifactPath: resolveRolePath("VERIFIED_FACT"),
    factArtifactSha256: roles.get("VERIFIED_FACT").sha256,
    factRecordCount: roles.get("VERIFIED_FACT").record_count,
    factCoverageSnapshotPath: resolveRolePath("FACT_COVERAGE_SNAPSHOT"),
    factCoverageSnapshotSha256: roles.get("FACT_COVERAGE_SNAPSHOT").sha256,
  });
  productionEvidenceStore = await createSeedEvidenceArtifactStore({
    evidencePath: resolveRolePath("VERIFIED_EVIDENCE"),
    manifestPath: resolveRolePath("VERIFIED_EVIDENCE_MANIFEST"),
  });
});
test.after(async () => {
  if (client) {
    await client.query(`DROP ROLE IF EXISTS ${READER_ROLE}`).catch(() => {});
    await client.end();
  }
});

test("Postgres 16: repository constructs against the real READY v0.20 release with the real pinned snapshot ids", async () => {
  assert.equal(repository.releaseId, RELEASE_ID);
  assert.equal(repository.corpusSnapshotId, CORPUS_SNAPSHOT_ID);
  assert.equal(repository.approvedRevision, APPROVED_REVISION);
  assert.equal(repository.factCoverageSnapshotId, FACT_COVERAGE_SNAPSHOT_ID);
  const counts = await repository.recordCounts();
  assert.deepEqual(counts, { FACT: 87, EVENT: 24, RELATION: 40, EVIDENCE: 219 });
});

test("Postgres 16: wrong release/corpus/revision/coverage pins are all rejected against the real loaded release", async () => {
  await assert.rejects(
    createPostgresReferenceRepository({ client, expectedReleaseId: "seed-release-v0.19", expectedCorpusSnapshotId: CORPUS_SNAPSHOT_ID, expectedApprovedRevision: APPROVED_REVISION, expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID }),
    /was not found/,
  );
  await assert.rejects(
    createPostgresReferenceRepository({ client, expectedReleaseId: RELEASE_ID, expectedCorpusSnapshotId: "wrong-corpus-snapshot", expectedApprovedRevision: APPROVED_REVISION, expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID }),
    /corpus_snapshot_id mismatch/,
  );
  await assert.rejects(
    createPostgresReferenceRepository({ client, expectedReleaseId: RELEASE_ID, expectedCorpusSnapshotId: CORPUS_SNAPSHOT_ID, expectedApprovedRevision: "wrong-revision", expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID }),
    /approved_revision mismatch/,
  );
  await assert.rejects(
    createPostgresReferenceRepository({ client, expectedReleaseId: RELEASE_ID, expectedCorpusSnapshotId: CORPUS_SNAPSHOT_ID, expectedApprovedRevision: APPROVED_REVISION, expectedFactCoverageSnapshotId: "wrong-coverage-snapshot" }),
    /fact_coverage_snapshot_id mismatch/,
  );
});

// -- Full equivalence: DB-backed Repository vs the portable file-backed
// seed-structured-query-adapter.mjs, over the ENTIRE VERIFIED set of each
// type (not a sample) -- the exact 87/219/24/40 counts the Turn requires.

test("Postgres 16 equivalence: ALL 87 VERIFIED_FACT records are identical between the DB Repository and the portable adapter", async () => {
  const dbRecords = await repository.queryFacts(baseFilters({}));
  const portableResult = await portableAdapter.query(baseQuery({ targets: ["FACT"] }));
  assert.equal(portableResult.status, "OK");
  assert.equal(dbRecords.length, 87);
  assertEquivalentRecordSets(dbRecords, portableResult.records, "FACT");
});

test("Postgres 16 equivalence: ALL 219 VERIFIED_EVIDENCE records are identical between the DB Repository and the portable adapter", async () => {
  const dbRecords = await repository.queryEvidence(baseFilters({}));
  const portableResult = await portableAdapter.query(baseQuery({ targets: ["EVIDENCE"] }));
  assert.equal(portableResult.status, "OK");
  assert.equal(dbRecords.length, 219);
  assertEquivalentRecordSets(dbRecords, portableResult.records, "EVIDENCE");
});

test("Postgres 16 equivalence: ALL 24 VERIFIED_EVENT records are identical between the DB Repository and the portable adapter", async () => {
  const dbRecords = await repository.queryEvents(baseFilters({}));
  const portableResult = await portableAdapter.query(baseQuery({ targets: ["EVENT"] }));
  assert.equal(portableResult.status, "OK");
  assert.equal(dbRecords.length, 24);
  assertEquivalentRecordSets(dbRecords, portableResult.records, "EVENT");
});

test("Postgres 16 equivalence: ALL 40 VERIFIED_RELATION records are identical between the DB Repository and the portable adapter, including the documentCorp corp_code fallback", async () => {
  const dbRecords = await repository.queryRelations(baseFilters({}));
  const portableResult = await portableAdapter.query(baseQuery({ targets: ["RELATION"] }));
  assert.equal(portableResult.status, "OK");
  assert.equal(dbRecords.length, 40);
  assertEquivalentRecordSets(dbRecords, portableResult.records, "RELATION");
  assert.ok(dbRecords.every((r) => typeof r.payload.attributes?.corp_code === "string"), "sanity: every real Relation carries attributes.corp_code directly");
});

test("Postgres 16 equivalence: getFact/getEvidence/getEvent/getRelation return byte-identical payloads to the portable records, for every ID (87/219/24/40, not a sample)", async () => {
  const portableFacts = (await portableAdapter.query(baseQuery({ targets: ["FACT"] }))).records;
  assert.equal(portableFacts.length, 87);
  for (const record of portableFacts) {
    const payload = await repository.getFact(record.record_id);
    assert.deepEqual(payload, record.payload, `getFact(${record.record_id}) diverges from the portable adapter's payload`);
  }

  const portableEvidence = (await portableAdapter.query(baseQuery({ targets: ["EVIDENCE"] }))).records;
  assert.equal(portableEvidence.length, 219);
  for (const record of portableEvidence) {
    const payload = await repository.getEvidence(record.record_id);
    assert.deepEqual(payload, record.payload, `getEvidence(${record.record_id}) diverges from the portable adapter's payload`);
  }

  // Turn N2.1 fix: the ORIGINAL version of this test never actually called
  // getEvent()/getRelation() despite the test name claiming all four APIs
  // were checked -- these two blocks are new, and are what makes the name
  // true. Every single one of the 24 real Events and 40 real Relations is
  // fetched through repository.getEvent()/getRelation() and compared,
  // exactly mirroring the Fact/Evidence blocks above -- not a sample.
  const portableEvents = (await portableAdapter.query(baseQuery({ targets: ["EVENT"] }))).records;
  assert.equal(portableEvents.length, 24);
  for (const record of portableEvents) {
    const payload = await repository.getEvent(record.record_id);
    assert.deepEqual(payload, record.payload, `getEvent(${record.record_id}) diverges from the portable adapter's payload`);
  }

  const portableRelations = (await portableAdapter.query(baseQuery({ targets: ["RELATION"] }))).records;
  assert.equal(portableRelations.length, 40);
  for (const record of portableRelations) {
    const payload = await repository.getRelation(record.record_id);
    assert.deepEqual(payload, record.payload, `getRelation(${record.record_id}) diverges from the portable adapter's payload`);
  }
});

// -- Representative StructuredQuery filter combinations (corp_codes,
// metric_codes, document_ids, period_filter, scope_filter,
// verification_statuses, as_of_date cutoff) -- each compared against the
// SAME filter applied through the portable adapter. --------------------

test("Postgres 16 equivalence: corp_codes + metric_codes filter combination matches the portable adapter", async () => {
  const filters = baseFilters({ corp_codes: ["00164645"], metric_codes: ["CONTRACT_AMOUNT"] });
  const dbRecords = await repository.queryFacts(filters);
  const portableResult = await portableAdapter.query(baseQuery({
    targets: ["FACT"], corp_codes: ["00164645"],
    predicates: { ...baseQuery({}).predicates, metric_codes: ["CONTRACT_AMOUNT"] },
  }));
  assert.ok(dbRecords.length > 0, "sanity: this corp_code/metric_code combination must exist in the real data");
  assertEquivalentRecordSets(dbRecords, portableResult.records, "FACT corp_codes+metric_codes filter");
});

test("Postgres 16 equivalence: as_of_date cutoff (excluding future-known facts) matches the portable adapter", async () => {
  const filters = baseFilters({ as_of_date: "2023-01-01" });
  const dbRecords = await repository.queryFacts(filters);
  const portableResult = await portableAdapter.query(baseQuery({ targets: ["FACT"], as_of_date: "2023-01-01" }));
  assertEquivalentRecordSets(dbRecords, portableResult.records, "FACT as_of_date cutoff");
  assert.ok(dbRecords.length < 87, "sanity: an early as_of_date cutoff must exclude at least one real Fact");
});

test("Postgres 16 equivalence: document_ids filter matches the portable adapter across all four targets", async () => {
  const documentId = "exchange_20230428800439";
  for (const [target, dbQuery] of [
    ["FACT", () => repository.queryFacts(baseFilters({ document_ids: [documentId] }))],
    ["EVENT", () => repository.queryEvents(baseFilters({ document_ids: [documentId] }))],
    ["RELATION", () => repository.queryRelations(baseFilters({ document_ids: [documentId] }))],
    ["EVIDENCE", () => repository.queryEvidence(baseFilters({ document_ids: [documentId] }))],
  ]) {
    const dbRecords = await dbQuery();
    const portableResult = await portableAdapter.query(baseQuery({
      targets: [target], predicates: { ...baseQuery({}).predicates, document_ids: [documentId] },
    }));
    assertEquivalentRecordSets(dbRecords, portableResult.records, `${target} document_ids filter`);
  }
});

test("Postgres 16 equivalence: limit truncation matches the portable adapter's own sort+limit for the same query", async () => {
  const dbRecords = await repository.queryFacts(baseFilters({ limit: 5 }));
  const portableResult = await portableAdapter.query(baseQuery({ targets: ["FACT"], limit: 5 }));
  assert.equal(dbRecords.length, 5);
  assertEquivalentRecordSets(dbRecords, portableResult.records, "FACT limit=5");
});

// -- Runtime Store adapters, wired through the REAL createFactStore /
// createEvidenceStore / createStructuredStore, against the real server. --

test("Postgres 16: createPostgresFactStoreAdapter/createPostgresEvidenceStoreAdapter/createPostgresStructuredStoreAdapter serve real data through the actual Runtime Store contracts", async () => {
  const context = { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID };
  const factStore = createFactStore(createPostgresFactStoreAdapter(repository), context);
  const evidenceStore = createEvidenceStore(createPostgresEvidenceStoreAdapter(repository), context);
  const structuredStore = createStructuredStore(createPostgresStructuredStoreAdapter(repository), context);

  const anyFact = (await repository.queryFacts(baseFilters({ limit: 1 })))[0];
  const factResolution = await factStore.resolve(anyFact.record_id);
  assert.equal(factResolution.ok, true);
  assert.equal(factResolution.record.fact_id, anyFact.record_id);

  const anyEvidence = (await repository.queryEvidence(baseFilters({ limit: 1 })))[0];
  const evidenceResolution = await evidenceStore.resolve(anyEvidence.record_id);
  assert.equal(evidenceResolution.ok, true);
  assert.equal(evidenceResolution.record.evidence_id, anyEvidence.record_id);

  const result = await structuredStore.query(baseQuery({ targets: ["FACT", "EVENT", "RELATION", "EVIDENCE"] }));
  assert.equal(result.status, "OK");
  assert.equal(result.records.length, 370, "87 Fact + 24 Event + 40 Relation + 219 Evidence, all under the 1000 limit");
});

// -- Reader role least-privilege: the repository must work end-to-end
// through a real reader-only DB role, and that role must be rejected for
// any write. --------------------------------------------------------------

test("Postgres 16: repository works end-to-end through a real least-privilege reader role, which cannot write", async () => {
  await client.query(`DROP ROLE IF EXISTS ${READER_ROLE}`);
  await client.query(`CREATE ROLE ${READER_ROLE} LOGIN PASSWORD 'test_only_scratch_password'`);
  await applyReferenceReaderGrant({ client, roleName: READER_ROLE });

  const baseUrl = new URL(requireDatabaseUrl());
  const readerUrl = new URL(baseUrl);
  readerUrl.username = READER_ROLE;
  readerUrl.password = "test_only_scratch_password";
  const readerClient = new Client({ connectionString: readerUrl.toString() });
  await readerClient.connect();
  try {
    const readerRepository = await createPostgresReferenceRepository({
      client: readerClient,
      expectedReleaseId: RELEASE_ID,
      expectedCorpusSnapshotId: CORPUS_SNAPSHOT_ID,
      expectedApprovedRevision: APPROVED_REVISION,
      expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID,
    });
    const facts = await readerRepository.queryFacts(baseFilters({}));
    assert.equal(facts.length, 87, "a real reader-role connection must be able to fully serve the Repository's query surface");

    await assert.rejects(
      readerClient.query("INSERT INTO disclosure_reference.records (release_id, role, ordinal, record_key, payload) VALUES ('x','x',0,'x','{}'::jsonb)"),
      /permission denied/i,
    );
    await assert.rejects(
      readerClient.query("DELETE FROM disclosure_reference.records WHERE release_id = $1", [RELEASE_ID]),
      /permission denied/i,
    );
    await assert.rejects(
      readerClient.query("UPDATE disclosure_reference.releases SET approved_revision = 'x' WHERE release_id = $1", [RELEASE_ID]),
      /permission denied/i,
    );
  } finally {
    await readerClient.end();
  }
});

// -- Turn N3: shadow/read-parity hardening on top of Turn N2's equivalence
// suite above. Uses domain/postgres/shadow-parity-comparator.mjs (the
// bundle result is always the baseline, the DB result is always the
// shadow) so every failure here reports role/query/id/field path instead
// of an opaque assert.deepEqual diff. --------------------------------------

test("Postgres 16 shadow parity: explicit ID-set completeness (0 missing, 0 extra, 0 duplicate) for all four roles", async () => {
  const queryByTarget = {
    FACT: (filters) => repository.queryFacts(filters), EVIDENCE: (filters) => repository.queryEvidence(filters),
    EVENT: (filters) => repository.queryEvents(filters), RELATION: (filters) => repository.queryRelations(filters),
  };
  for (const target of ["FACT", "EVIDENCE", "EVENT", "RELATION"]) {
    const role = target;
    const dbRecords = await queryByTarget[target](baseFilters({}));
    const portableResult = await portableAdapter.query(baseQuery({ targets: [target] }));
    const result = compareRecordSets({ role, query: "full-set", baseline: portableResult.records, shadow: dbRecords });
    assert.equal(result.idSetResult.missing.length, 0, `${role}: DB is missing IDs the bundle has`);
    assert.equal(result.idSetResult.extra.length, 0, `${role}: DB has extra IDs the bundle does not`);
    assert.equal(result.idSetResult.baselineDuplicateCount, 0, `${role}: bundle result contains a duplicate ID`);
    assert.equal(result.idSetResult.shadowDuplicateCount, 0, `${role}: DB result contains a duplicate ID`);
    assertParity(result);
  }
});

test("Postgres 16 shadow parity: native (non-re-sorted) return order matches exactly for a combined multi-target query -- order IS part of the contract here (both implementations mirror the same known_at/type/id sort)", async () => {
  const structuredStoreAdapter = createPostgresStructuredStoreAdapter(repository);
  const dbResult = await structuredStoreAdapter.query(baseQuery({ targets: ["FACT", "EVENT", "RELATION", "EVIDENCE"], limit: 50 }));
  const portableResult = await portableAdapter.query(baseQuery({ targets: ["FACT", "EVENT", "RELATION", "EVIDENCE"], limit: 50 }));
  assert.equal(dbResult.records.length, 50);
  assertParity(compareRecordSets({
    role: "MIXED", query: "combined-order", baseline: portableResult.records, shadow: dbResult.records, orderMatters: true,
  }));
});

test("Postgres 16 shadow parity: event_type filter (dynamically drawn from real data, never hardcoded) matches the portable adapter", async () => {
  const anyEvent = (await repository.queryEvents(baseFilters({ limit: 1 })))[0];
  assert.ok(anyEvent, "sanity: at least one real Event must exist");
  const eventType = anyEvent.payload.event_type;
  const dbRecords = await repository.queryEvents(baseFilters({ event_types: [eventType] }));
  const portableResult = await portableAdapter.query(baseQuery({
    targets: ["EVENT"], predicates: { ...baseQuery({}).predicates, event_types: [eventType] },
  }));
  assert.ok(dbRecords.length > 0);
  assertParity(compareRecordSets({ role: "EVENT", query: `event_types=[${eventType}]`, baseline: portableResult.records, shadow: dbRecords }));
});

test("Postgres 16 shadow parity: relation_type filter (dynamically drawn from real data) matches the portable adapter", async () => {
  const anyRelation = (await repository.queryRelations(baseFilters({ limit: 1 })))[0];
  assert.ok(anyRelation, "sanity: at least one real Relation must exist");
  const relationType = anyRelation.payload.relation_type;
  const dbRecords = await repository.queryRelations(baseFilters({ relation_types: [relationType] }));
  const portableResult = await portableAdapter.query(baseQuery({
    targets: ["RELATION"], predicates: { ...baseQuery({}).predicates, relation_types: [relationType] },
  }));
  assert.ok(dbRecords.length > 0);
  assertParity(compareRecordSets({ role: "RELATION", query: `relation_types=[${relationType}]`, baseline: portableResult.records, shadow: dbRecords }));
});

test("Postgres 16 shadow parity: compound filter (corp_code + document_ids + period_filter together, drawn from one real Fact) matches the portable adapter", async () => {
  // Turn N3 note: queryFacts()/query() both return the TRIMMED descriptor
  // shape (record_type/record_id/verification_status/known_at/
  // source_document_ids/evidence_ids/payload only -- see trimmedRecord()
  // in reference-repository.mjs and the equivalent inline .map() in
  // seed-structured-query-adapter.mjs). corp_code/period_start/period_end/
  // period_type are filter-internal fields, NOT part of the returned
  // shape -- they must be re-derived from the raw payload, exactly the way
  // descriptor() computes them, not read off the trimmed result.
  const anyFact = (await repository.queryFacts(baseFilters({ limit: 1 })))[0];
  const payload = anyFact.payload;
  const periodStart = payload.period_start ?? payload.as_of_date;
  const periodEnd = payload.period_end ?? payload.as_of_date;
  const periodFilter = { start: periodStart, end: periodEnd, period_types: payload.period_type ? [payload.period_type] : [] };
  const compoundFilters = baseFilters({
    corp_codes: [payload.corp_code], document_ids: [payload.source_document_id], period_filter: periodFilter,
  });
  const dbRecords = await repository.queryFacts(compoundFilters);
  const portableResult = await portableAdapter.query(baseQuery({
    targets: ["FACT"], corp_codes: [payload.corp_code],
    predicates: { ...baseQuery({}).predicates, document_ids: [payload.source_document_id] },
    period_filter: periodFilter,
  }));
  assert.ok(dbRecords.length > 0, "sanity: the compound filter drawn from a real Fact must match at least itself");
  assertParity(compareRecordSets({ role: "FACT", query: "compound", baseline: portableResult.records, shadow: dbRecords }));
});

test("Postgres 16 shadow parity: limit edge cases (limit=1 and limit=exact-total-count) both match the portable adapter's own sort+slice", async () => {
  for (const limit of [1, 87]) {
    const dbRecords = await repository.queryFacts(baseFilters({ limit }));
    const portableResult = await portableAdapter.query(baseQuery({ targets: ["FACT"], limit }));
    assert.equal(dbRecords.length, limit);
    assertParity(compareRecordSets({ role: "FACT", query: `limit=${limit}`, baseline: portableResult.records, shadow: dbRecords, orderMatters: true }));
  }
});

test("Postgres 16 shadow parity: an empty result (a corp_code that matches nothing) is empty on both sides, not silently substituted with unrelated data", async () => {
  const filters = baseFilters({ corp_codes: ["__n3_shadow_parity_nonexistent_corp_code__"] });
  const dbRecords = await repository.queryFacts(filters);
  const portableResult = await portableAdapter.query(baseQuery({ targets: ["FACT"], corp_codes: ["__n3_shadow_parity_nonexistent_corp_code__"] }));
  assert.equal(dbRecords.length, 0);
  assert.equal(portableResult.records.length, 0);
  assert.equal(portableResult.status, "NOT_FOUND");
});

test("Postgres 16 shadow parity: repeated identical queries are deterministic (same content AND same order) on both sides", async () => {
  const filters = baseFilters({ limit: 20 });
  const first = await repository.queryFacts(filters);
  const second = await repository.queryFacts(filters);
  assertParity(compareRecordSets({ role: "FACT", query: "determinism-db", baseline: first, shadow: second, orderMatters: true }));

  const portableFirst = (await portableAdapter.query(baseQuery({ targets: ["FACT"], limit: 20 }))).records;
  const portableSecond = (await portableAdapter.query(baseQuery({ targets: ["FACT"], limit: 20 }))).records;
  assertParity(compareRecordSets({ role: "FACT", query: "determinism-portable", baseline: portableFirst, shadow: portableSecond, orderMatters: true }));
});

test("Postgres 16 shadow parity: returned records are frozen, independent copies on both sides -- mutating one can never affect a later call", async () => {
  const dbFact = (await repository.queryFacts(baseFilters({ limit: 1 })))[0];
  assert.throws(() => { dbFact.payload.corp_code = "MUTATED"; }, TypeError);
  const dbFactAgain = (await repository.queryFacts(baseFilters({ limit: 1 })))[0];
  assert.notEqual(dbFactAgain.payload.corp_code, "MUTATED");

  const portableFact = (await portableAdapter.query(baseQuery({ targets: ["FACT"], limit: 1 }))).records[0];
  assert.throws(() => { portableFact.payload.corp_code = "MUTATED"; }, TypeError);
  const portableFactAgain = (await portableAdapter.query(baseQuery({ targets: ["FACT"], limit: 1 }))).records[0];
  assert.notEqual(portableFactAgain.payload.corp_code, "MUTATED");
});

// -- Turn N3: NOT_FOUND / value parity against the REAL production bundle
// read path (createSeedFactArtifactStore/createSeedEvidenceArtifactStore,
// exactly as domain/adapters/seed-runtime-service-adapters.mjs wires them
// for GET /answer) -- not just the broader structured-query adapter used
// above. -------------------------------------------------------------------

test("Postgres 16 shadow parity: getFact/getEvidence match the REAL production artifact stores for every real ID (not just the structured-query adapter)", async () => {
  const portableFacts = (await portableAdapter.query(baseQuery({ targets: ["FACT"] }))).records;
  for (const record of portableFacts) {
    const dbPayload = await repository.getFact(record.record_id);
    const productionEnvelope = await productionFactStore.getFact(record.record_id);
    assertParity(compareSingleRecord({
      role: "FACT", query: `getFact(${record.record_id})`, baseline: productionEnvelope?.record ?? null, shadow: dbPayload,
    }));
  }

  const portableEvidence = (await portableAdapter.query(baseQuery({ targets: ["EVIDENCE"] }))).records;
  for (const record of portableEvidence) {
    const dbPayload = await repository.getEvidence(record.record_id);
    const productionEnvelope = await productionEvidenceStore.getEvidence(record.record_id);
    assertParity(compareSingleRecord({
      role: "EVIDENCE", query: `getEvidence(${record.record_id})`, baseline: productionEnvelope?.record ?? null, shadow: dbPayload,
    }));
  }
});

test("Postgres 16 shadow parity: NOT_FOUND is identical (null) on both sides for a non-existent ID, across getFact/getEvidence/getEvent/getRelation", async () => {
  const missingId = "__n3_shadow_parity_nonexistent_id__";
  assertParity(compareSingleRecord({
    role: "FACT", query: `getFact(${missingId})`,
    baseline: (await productionFactStore.getFact(missingId))?.record ?? null, shadow: await repository.getFact(missingId),
  }));
  assertParity(compareSingleRecord({
    role: "EVIDENCE", query: `getEvidence(${missingId})`,
    baseline: (await productionEvidenceStore.getEvidence(missingId))?.record ?? null, shadow: await repository.getEvidence(missingId),
  }));
  // Turn N3 finding: the portable bundle path has NO dedicated getEvent/
  // getRelation single-ID store (see domain/adapters/seed-runtime-service-adapters.mjs --
  // Event/Relation records are only consumed as plain arrays, never through
  // a Runtime Store `{ getEvent }`/`{ getRelation }` contract). The only
  // bundle-side mechanism able to answer "does this Event/Relation ID
  // exist" at all is the structured query() path, so that is what NOT_FOUND
  // parity is checked against for these two roles -- documented in
  // domain/postgres/README.md's Turn N3 comparison table, not silently
  // glossed over as if a symmetric bundle-side store existed.
  const eventQueryResult = await portableAdapter.query(baseQuery({
    targets: ["EVENT"], predicates: { ...baseQuery({}).predicates, event_ids: [missingId] },
  }));
  assert.equal(eventQueryResult.records.length, 0);
  assert.equal(await repository.getEvent(missingId), null);

  const relationQueryResult = await portableAdapter.query(baseQuery({
    targets: ["RELATION"], predicates: { ...baseQuery({}).predicates, relation_ids: [missingId] },
  }));
  assert.equal(relationQueryResult.records.length, 0);
  assert.equal(await repository.getRelation(missingId), null);
});

// -- Turn N3: release/snapshot pin fail-closed against a REAL second
// release row (not a fake client) -- a LOADING release genuinely present
// in the same database as the READY one under test must never be servable,
// and must never cause any kind of fallback onto the READY release. -------

test("Postgres 16: a genuinely LOADING (non-READY) release row in the same database is rejected, not served and not confused with the READY release under test", async () => {
  const probeReleaseId = "seed-release-v0.20-n3-loading-probe";
  const probeCorpusSnapshotId = "n3_probe_corpus_snapshot";
  const probeApprovedRevision = "n3_probe_revision";
  const probeCoverageSnapshotId = "n3_probe_coverage_snapshot";
  const dummySha256 = "0".repeat(64);
  await client.query(
    `INSERT INTO disclosure_reference.releases
       (release_id, status, approved_revision, corpus_snapshot_id, fact_coverage_snapshot_id,
        bundle_manifest_sha256, final_manifest_sha256, final_decision_sha256, bundle_entry_count,
        record_counts, bundle_manifest, final_manifest, final_decision, imported_at)
     VALUES ($1, 'LOADING', $2, $3, $4, $5, $5, $5, 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL)`,
    [probeReleaseId, probeApprovedRevision, probeCorpusSnapshotId, probeCoverageSnapshotId, dummySha256],
  );
  try {
    await assert.rejects(
      createPostgresReferenceRepository({
        client, expectedReleaseId: probeReleaseId, expectedCorpusSnapshotId: probeCorpusSnapshotId,
        expectedApprovedRevision: probeApprovedRevision, expectedFactCoverageSnapshotId: probeCoverageSnapshotId,
      }),
      /is not READY/,
    );
    // The READY release under test must still resolve to itself alone --
    // the LOADING probe row existing alongside it must never leak into or
    // replace the pinned RELEASE_ID's own results.
    const facts = await repository.queryFacts(baseFilters({}));
    assert.equal(facts.length, 87);
  } finally {
    await client.query("DELETE FROM disclosure_reference.releases WHERE release_id = $1", [probeReleaseId]);
  }
});

// -- Turn N3.1: three-way v0.20-r3 parity -- raw Repository (audit,
// unfiltered), Coverage-authorized Agent view (new this Turn), and the
// REAL production bundle FactStore (createSeedFactArtifactStore) -- must
// all agree on the same 87 IDs/payloads, because the real v0.20-r3 Coverage
// Snapshot happens to authorize all 87 real Facts today. This is the
// specific "current results must not change" guarantee this Turn requires. -

test("Postgres 16 Turn N3.1: raw Repository, Coverage-authorized Agent view, and the REAL production FactStore all agree on the same 87 Facts for v0.20-r3", async () => {
  const authorizedView = await createCoverageAuthorizedFactView({
    client, repository, expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID,
  });
  assert.equal(authorizedView.authorizedFactCount(), 87, "v0.20-r3's real Coverage Snapshot authorizes all 87 real Facts");

  const rawFacts = await repository.queryFacts(baseFilters({}));
  const authorizedFacts = await authorizedView.queryFacts(baseFilters({}));
  assert.equal(rawFacts.length, 87);
  assertParity(compareRecordSets({ role: "FACT", query: "N3.1-raw-vs-authorized", baseline: rawFacts, shadow: authorizedFacts }));

  for (const record of rawFacts) {
    const rawPayload = await repository.getFact(record.record_id);
    const authorizedPayload = await authorizedView.getFact(record.record_id);
    const productionEnvelope = await productionFactStore.getFact(record.record_id);
    assertParity(compareSingleRecord({ role: "FACT", query: `N3.1 raw-vs-authorized getFact(${record.record_id})`, baseline: rawPayload, shadow: authorizedPayload }));
    assertParity(compareSingleRecord({ role: "FACT", query: `N3.1 authorized-vs-production getFact(${record.record_id})`, baseline: productionEnvelope?.record ?? null, shadow: authorizedPayload }));
  }
});
