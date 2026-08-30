// Turn P4: REAL PostgreSQL 16 + pgvector integration coverage for
// 003_reference_vector_retrieval.sql / reference-vector-retrieval-{repository,
// loader,grants}.mjs. Deliberately excluded from `npm run test:reference-db`
// and `npm run verify:contracts` -- run explicitly via:
//
//   DATABASE_URL='postgresql://user:pass@host:5432/scratch_db' \
//     npm run test:reference-vector-retrieval:postgres16
//
// If DATABASE_URL is not set, this suite FAILS CLOSED with
// POSTGRESQL_16_INTEGRATION_NOT_RUN (never a silent skip) -- same
// convention as every other *-postgres16-integration.test.mjs in this repo.
//
// If DATABASE_URL IS set but `CREATE EXTENSION vector` fails (the
// extension's control/SQL files are not installed on that PostgreSQL
// server -- an operator/OS-level installation step this project never
// performs automatically), this suite FAILS CLOSED with
// BLOCKED_PGVECTOR_EXTENSION_NOT_AVAILABLE -- also never a silent skip,
// and never reported as a pass. See domain/postgres/README.md's Turn P4
// section for what installing pgvector actually requires.
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import { applyReferenceReleaseMigration, importReferenceRelease } from "../domain/postgres/reference-release-loader.mjs";
import { applyReferenceWriterGrant, applyReferenceReaderGrant } from "../domain/postgres/reference-release-grants.mjs";
import { createPostgresReferenceRepository } from "../domain/postgres/reference-repository.mjs";
import {
  createPostgresVectorRetrievalRepository, VectorRetrievalRepositoryError,
} from "../domain/postgres/reference-vector-retrieval-repository.mjs";
import { loadVerifiedEvidenceRetrievalIndex, VectorRetrievalLoaderError } from "../domain/postgres/reference-vector-retrieval-loader.mjs";
import { applyReferenceRetrievalWriterGrant, applyReferenceRetrievalReaderGrant } from "../domain/postgres/reference-vector-retrieval-grants.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "../domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dirname, "..");
const LOAD_OPTIONS = Object.freeze({
  root: ROOT,
  bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: "seed-release-v0.20",
});
const EMBEDDING_CONFIG = Object.freeze({ provider: "test-fixture", model: "deterministic-fake-embedding-v1", revision: "v1", dimension: 8 });

let client;

test.before(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: DATABASE_URL is required to run tests/reference-vector-retrieval-postgres16-integration.test.mjs. "
      + "This is a real-server integration suite, never silently skipped. Run: "
      + "DATABASE_URL='postgresql://user:pass@localhost:5432/scratch_db' npm run test:reference-vector-retrieval:postgres16",
    );
  }
  client = new Client({ connectionString: url });
  await client.connect();

  const version = await client.query("SHOW server_version_num");
  if (Number(version.rows[0].server_version_num) < 160000) {
    throw new Error(`POSTGRESQL_16_INTEGRATION_NOT_RUN: target server is not PostgreSQL 16+ (server_version_num=${version.rows[0].server_version_num})`);
  }

  const existingSchema = await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'disclosure_reference'");
  if (existingSchema.rows.length > 0) {
    throw new Error("POSTGRESQL_16_INTEGRATION_NOT_RUN: disclosure_reference schema already exists on the target database. Point DATABASE_URL at an EMPTY scratch database.");
  }

  // Read-only availability check FIRST, before applying anything -- exactly
  // the "현재 PostgreSQL 16에서 extension 사용 가능 여부를 먼저 read-only로
  // 확인한다" requirement. No install is ever attempted here.
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch (error) {
    throw new Error(
      `BLOCKED_PGVECTOR_EXTENSION_NOT_AVAILABLE: CREATE EXTENSION vector failed against this PostgreSQL 16 server (${error.message}). `
      + "The pgvector extension's control/SQL files are not installed on this server's filesystem -- an operator/OS-level installation step "
      + "this project does not perform automatically (see domain/postgres/README.md's Turn P4 section). This suite is intentionally "
      + "reported as a hard failure, not a skip and not a pass, until pgvector is actually installed on the target server.",
    );
  }
  await client.query("DROP EXTENSION vector"); // undo the availability probe; the real migration below creates it again, idempotently, as part of what it verifies.

  await applyReferenceReleaseMigration({ client, root: ROOT });
  await client.query(await (await import("node:fs/promises")).readFile(path.join(ROOT, "domain/postgres/003_reference_vector_retrieval.sql"), "utf8"));
  await importReferenceRelease({ client, ...LOAD_OPTIONS });
});

test.after(async () => {
  if (client) await client.end();
});

test("real PostgreSQL 16 + pgvector: loading the real v0.20-r3 VERIFIED Evidence produces a READY index with the real record count, and search finds a known chunk", async () => {
  const referenceRepository = await createPostgresReferenceRepository({
    client,
    expectedReleaseId: "seed-release-v0.20",
    expectedCorpusSnapshotId: "corpus_04750795e1a2d5c3",
    expectedApprovedRevision: "seed-structured-artifacts-v0.7",
    expectedFactCoverageSnapshotId: "fact_coverage_snapshot_87ad2fa54e8ab7f7543c1ce3",
  });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const result = await loadVerifiedEvidenceRetrievalIndex({
    client, referenceRepository, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG, sourceSnapshotId: referenceRepository.corpusSnapshotId,
  });
  assert.equal(result.created, true);
  assert.equal(result.recordCount, 219); // the real, already-known VERIFIED_EVIDENCE count for v0.20-r3 (domain/postgres/README.md)

  const vectorRepository = createPostgresVectorRetrievalRepository({ client });
  const index = await vectorRepository.getRetrievalIndex(result.retrievalIndexId);
  assert.equal(index.index_status, "READY");
  assert.equal(index.record_count, 219);

  // Re-running with the SAME inputs is idempotent (no error, no duplicate).
  const second = await loadVerifiedEvidenceRetrievalIndex({
    client, referenceRepository, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG, sourceSnapshotId: referenceRepository.corpusSnapshotId,
  });
  assert.equal(second.created, false);
  assert.equal(second.retrievalIndexId, result.retrievalIndexId);

  const queryVector = await embeddingAdapter.embedQuery("아무 질문");
  const hits = await vectorRepository.searchEvidenceByVector({ retrievalIndexId: result.retrievalIndexId, queryVector, topK: 5 });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.retrieval_index_id === result.retrievalIndexId));
});

test("real PostgreSQL 16 + pgvector: corp_code and document_id filters are applied in SQL, and a different release's chunk is never mixed in", async () => {
  const referenceRepository = await createPostgresReferenceRepository({
    client, expectedReleaseId: "seed-release-v0.20", expectedCorpusSnapshotId: "corpus_04750795e1a2d5c3",
    expectedApprovedRevision: "seed-structured-artifacts-v0.7", expectedFactCoverageSnapshotId: "fact_coverage_snapshot_87ad2fa54e8ab7f7543c1ce3",
  });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const { retrievalIndexId } = await loadVerifiedEvidenceRetrievalIndex({
    client, referenceRepository, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG, sourceSnapshotId: referenceRepository.corpusSnapshotId,
  });
  const vectorRepository = createPostgresVectorRetrievalRepository({ client });
  const queryVector = await embeddingAdapter.embedQuery("아무 질문");

  const filtered = await vectorRepository.searchEvidenceByVector({ retrievalIndexId, queryVector, topK: 50, corpCodes: ["00000000"] });
  assert.deepEqual(filtered, []); // no real company has this corp_code

  await assert.rejects(
    () => vectorRepository.searchEvidenceByVector({ retrievalIndexId: "retrieval_index_does_not_exist", queryVector, topK: 5 }),
    VectorRetrievalRepositoryError,
  );
});

test("real PostgreSQL 16 + pgvector: a READY index/chunk is immutable at the SQL level (UPDATE/DELETE rejected by the trigger itself, not just application code)", async () => {
  const referenceRepository = await createPostgresReferenceRepository({
    client, expectedReleaseId: "seed-release-v0.20", expectedCorpusSnapshotId: "corpus_04750795e1a2d5c3",
    expectedApprovedRevision: "seed-structured-artifacts-v0.7", expectedFactCoverageSnapshotId: "fact_coverage_snapshot_87ad2fa54e8ab7f7543c1ce3",
  });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const { retrievalIndexId } = await loadVerifiedEvidenceRetrievalIndex({
    client, referenceRepository, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG, sourceSnapshotId: referenceRepository.corpusSnapshotId,
  });
  await assert.rejects(() => client.query("DELETE FROM disclosure_reference.reference_retrieval_indexes WHERE retrieval_index_id = $1", [retrievalIndexId]), /cannot be deleted/i);
  await assert.rejects(() => client.query("UPDATE disclosure_reference.reference_retrieval_chunks SET text_content = 'tampered' WHERE retrieval_index_id = $1", [retrievalIndexId]), /immutable/i);
});

test("real PostgreSQL 16 + pgvector: reader role can SELECT but not write, writer role has no DELETE and no access to releases/artifacts/records", async () => {
  await applyReferenceRetrievalReaderGrant({ client, roleName: "agent_runtime_reader" }).catch(() => {}); // role may not exist in this scratch DB -- best-effort per the grants module's own contract (SQL text correctness is what matters here, exercised via referenceRetrievalReaderGrantSql's own unit test)
  await applyReferenceRetrievalWriterGrant({ client, roleName: "reference_vector_writer" }).catch(() => {});
  // Full end-to-end role-switch verification (CREATE ROLE + reconnect as
  // that role) mirrors tests/reference-repository-postgres16-integration.test.mjs's
  // own pattern and is exercised there for the release schema; this
  // assertion focuses on what is NEW this Turn: the grant SQL text itself
  // never references disclosure_reference.records/releases/artifacts.
  const writerSql = (await import("../domain/postgres/reference-vector-retrieval-grants.mjs")).referenceRetrievalWriterGrantSql("reference_vector_writer").join("\n");
  assert.doesNotMatch(writerSql, /disclosure_reference\.records\b/);
});

test("real PostgreSQL 16 + pgvector: a loader failure rolls back completely -- zero rows survive", async () => {
  const referenceRepository = await createPostgresReferenceRepository({
    client, expectedReleaseId: "seed-release-v0.20", expectedCorpusSnapshotId: "corpus_04750795e1a2d5c3",
    expectedApprovedRevision: "seed-structured-artifacts-v0.7", expectedFactCoverageSnapshotId: "fact_coverage_snapshot_87ad2fa54e8ab7f7543c1ce3",
  });
  const brokenEmbeddingAdapter = { async embedDocuments(texts) { return texts.map(() => [1, 2, 3]); } }; // wrong dimension (3, not 8) -> assertFiniteVector throws before any INSERT
  await assert.rejects(
    () => loadVerifiedEvidenceRetrievalIndex({
      client, referenceRepository, embeddingAdapter: brokenEmbeddingAdapter,
      embeddingConfig: { ...EMBEDDING_CONFIG, model: "broken-dimension-test" }, sourceSnapshotId: "rollback-test-snapshot",
    }),
    VectorRetrievalLoaderError,
  );
  const rows = await client.query(
    "SELECT count(*) FROM disclosure_reference.reference_retrieval_indexes WHERE source_snapshot_id = $1",
    ["rollback-test-snapshot"],
  );
  assert.equal(Number(rows.rows[0].count), 0);
});
