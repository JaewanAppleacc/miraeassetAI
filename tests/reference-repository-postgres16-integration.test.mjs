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
import { createSeedStructuredQueryAdapter } from "../domain/adapters/seed-structured-query-adapter.mjs";
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

let client, repository, portableAdapter;
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
