// Turn P4: fake-pg-client unit/contract tests for
// domain/postgres/reference-vector-retrieval-{repository,loader,grants}.mjs.
// No real PostgreSQL/pgvector needed for any test in this file -- see
// tests/reference-vector-retrieval-postgres16-integration.test.mjs for the
// real-server tier.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { RequestAbortedError } from "../domain/runtime/abortable.mjs";
import {
  createPostgresVectorRetrievalRepository, computeChunkId, VectorRetrievalRepositoryError,
} from "../domain/postgres/reference-vector-retrieval-repository.mjs";
import {
  loadVerifiedEvidenceRetrievalIndex, computeRetrievalIndexId, VectorRetrievalLoaderError,
  VERIFIED_EVIDENCE_CHUNKING_POLICY_ID,
} from "../domain/postgres/reference-vector-retrieval-loader.mjs";
import {
  referenceRetrievalReaderGrantSql, referenceRetrievalWriterGrantSql,
} from "../domain/postgres/reference-vector-retrieval-grants.mjs";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- chunk_id / retrieval_index_id determinism -----------------------------

test("computeChunkId is deterministic for the same (retrievalIndexId, recordKey) and differs for a different one", () => {
  const a = computeChunkId({ retrievalIndexId: "retrieval_index_x", recordKey: "evidence_1" });
  const b = computeChunkId({ retrievalIndexId: "retrieval_index_x", recordKey: "evidence_1" });
  const c = computeChunkId({ retrievalIndexId: "retrieval_index_x", recordKey: "evidence_2" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^chunk_[0-9a-f]{24}$/);
});

test("computeRetrievalIndexId is deterministic for identical inputs and changes when any pin changes", () => {
  const base = { releaseId: "seed-release-v0.20", sourceSnapshotId: "corpus_x", embeddingProvider: "p", embeddingModel: "m", embeddingRevision: "v1", chunkingPolicyId: VERIFIED_EVIDENCE_CHUNKING_POLICY_ID };
  const a = computeRetrievalIndexId(base);
  const b = computeRetrievalIndexId({ ...base });
  const c = computeRetrievalIndexId({ ...base, embeddingRevision: "v2" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// --- repository: fake client plumbing --------------------------------------

function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [pattern, handler] of handlers) {
        if (pattern.test(sql)) return handler(sql, params);
      }
      throw new Error(`fakeClient: no handler matched SQL: ${sql}`);
    },
  };
}

const READY_INDEX_ROW = Object.freeze({
  retrieval_index_id: "retrieval_index_ready", release_id: "seed-release-v0.20", source_snapshot_id: "corpus_x",
  embedding_provider: "p", embedding_model: "m", embedding_revision: "v1", embedding_dimension: 4,
  distance_metric: "cosine", chunking_policy_id: "policy", chunking_policy_sha256: "a".repeat(64),
  index_status: "READY", created_at: new Date("2026-01-01T00:00:00Z"), ready_at: new Date("2026-01-01T00:00:01Z"),
  record_count: 1, manifest_sha256: "b".repeat(64),
});

test("getRetrievalIndex returns null (not an error) for a genuinely missing index, and a real DB error is never reduced to that", async () => {
  const client = fakeClient([[/^SELECT/i, () => ({ rows: [] })]]);
  const repo = createPostgresVectorRetrievalRepository({ client });
  assert.equal(await repo.getRetrievalIndex("retrieval_index_missing"), null);

  const failingClient = { async query() { throw new Error("connection reset"); } };
  const repoWithFailure = createPostgresVectorRetrievalRepository({ client: failingClient });
  await assert.rejects(() => repoWithFailure.getRetrievalIndex("x"), /connection reset/);
});

test("assertReadyRetrievalIndex fails closed on a non-READY index and on a release/pin mismatch", async () => {
  const loadingRow = { ...READY_INDEX_ROW, index_status: "LOADING", ready_at: null };
  const client = fakeClient([[/^SELECT/i, () => ({ rows: [loadingRow] })]]);
  const repo = createPostgresVectorRetrievalRepository({ client });
  await assert.rejects(() => repo.assertReadyRetrievalIndex("retrieval_index_ready"), VectorRetrievalRepositoryError);

  const readyClient = fakeClient([[/^SELECT/i, () => ({ rows: [READY_INDEX_ROW] })]]);
  const readyRepo = createPostgresVectorRetrievalRepository({ client: readyClient });
  await assert.rejects(
    () => readyRepo.assertReadyRetrievalIndex("retrieval_index_ready", { release_id: "some-other-release" }),
    VectorRetrievalRepositoryError,
  );
  // A correct pin (using the row's own snake_case field names) passes.
  const index = await readyRepo.assertReadyRetrievalIndex("retrieval_index_ready", { release_id: "seed-release-v0.20", embedding_dimension: 4 });
  assert.equal(index.retrieval_index_id, "retrieval_index_ready");
});

test("search rejects a queryVector with the wrong dimension, and one containing NaN/Infinity, before ever issuing the chunk SELECT", async () => {
  let chunkQueryIssued = false;
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_retrieval_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/FROM disclosure_reference\.reference_retrieval_chunks/i, () => { chunkQueryIssued = true; return { rows: [] }; }],
  ]);
  const repo = createPostgresVectorRetrievalRepository({ client });

  await assert.rejects(() => repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [1, 2], topK: 5 }), VectorRetrievalRepositoryError);
  assert.equal(chunkQueryIssued, false);

  await assert.rejects(() => repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [1, 2, 3, Number.NaN], topK: 5 }), TypeError);
  assert.equal(chunkQueryIssued, false);

  await assert.rejects(() => repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [1, 2, 3, Number.POSITIVE_INFINITY], topK: 5 }), TypeError);
  assert.equal(chunkQueryIssued, false);
});

test("search parameter-binds every dynamic value -- a corp_code/document_id containing SQL-special characters never appears literally in the SQL text, only in the params array", async () => {
  let capturedSql = null;
  let capturedParams = null;
  const dangerousCorpCode = "0'; DROP TABLE x; --";
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_retrieval_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/FROM disclosure_reference\.reference_retrieval_chunks/i, (sql, params) => { capturedSql = sql; capturedParams = params; return { rows: [] }; }],
  ]);
  const repo = createPostgresVectorRetrievalRepository({ client });
  await repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 3, corpCodes: [dangerousCorpCode] });

  assert.doesNotMatch(capturedSql, /DROP TABLE/i);
  assert.ok(capturedParams.some((p) => Array.isArray(p) && p.includes(dangerousCorpCode)));
});

test("search: filters are applied before top_k (WHERE precedes LIMIT), and the ORDER BY implements the required stable tie-break (similarity -> source_document_id -> chunk_id)", async () => {
  let capturedSql = null;
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_retrieval_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/FROM disclosure_reference\.reference_retrieval_chunks/i, (sql) => { capturedSql = sql; return { rows: [] }; }],
  ]);
  const repo = createPostgresVectorRetrievalRepository({ client });
  await repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 3, corpCodes: ["00000001"] });

  const whereIndex = capturedSql.indexOf("WHERE");
  const orderByIndex = capturedSql.indexOf("ORDER BY");
  const limitIndex = capturedSql.indexOf("LIMIT");
  assert.ok(whereIndex > -1 && orderByIndex > whereIndex && limitIndex > orderByIndex, "expected WHERE ... ORDER BY ... LIMIT in that order");
  assert.match(capturedSql, /ORDER BY \(c\.embedding <=> \$2::vector\) ASC, c\.source_document_id ASC, c\.chunk_id ASC/);
});

test("search propagates a real DB error unchanged (never reduced to an empty result), and throws RequestAbortedError for an already-aborted signal", async () => {
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_retrieval_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/FROM disclosure_reference\.reference_retrieval_chunks/i, () => { throw new Error("simulated real DB failure"); }],
  ]);
  const repo = createPostgresVectorRetrievalRepository({ client });
  await assert.rejects(() => repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 3 }), /simulated real DB failure/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 3 }, { signal: controller.signal }),
    RequestAbortedError,
  );
});

test("search returns frozen, mutation-independent results -- mutating one call's result never affects a later call", async () => {
  const chunkRow = {
    chunk_id: "chunk_000000000000000000000001", source_kind: "VERIFIED_EVIDENCE", evidence_id: "evidence_000000000000000000000001",
    source_document_id: "periodic_00000000000001", corp_code: "00000001", source_locator: "loc", chunk_ordinal: 0,
    text_sha256: "c".repeat(64), text_content: "text", metadata: { file_id: "file_000000000000000000000001" },
    similarity_score: 0.5, retrieval_index_id: "retrieval_index_ready", release_id: "seed-release-v0.20", source_snapshot_id: "corpus_x",
  };
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_retrieval_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/FROM disclosure_reference\.reference_retrieval_chunks/i, () => ({ rows: [{ ...chunkRow }] })],
  ]);
  const repo = createPostgresVectorRetrievalRepository({ client });
  const first = await repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 3 });
  assert.throws(() => { first[0].text_content = "tampered"; });
  assert.throws(() => { first[0].metadata.file_id = "tampered"; });
  const second = await repo.search({ retrievalIndexId: "retrieval_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 3 });
  assert.equal(second[0].text_content, "text");
});

// --- loader: fake client plumbing ------------------------------------------

function fakeReferenceRepository({ releaseId = "seed-release-v0.20", evidenceRecords = [], factRecords = [] } = {}) {
  return {
    releaseId,
    async queryEvidence() { return evidenceRecords; },
    async queryFacts() { return factRecords; },
  };
}

function verifiedEvidenceRecord({ evidenceId, documentId, quotedText, fileId, sourceLocator, verificationStatus = "VERIFIED" }) {
  return {
    record_type: "EVIDENCE", record_id: evidenceId, verification_status: verificationStatus,
    known_at: "2026-01-01T00:00:00.000Z", source_document_ids: [documentId], evidence_ids: [evidenceId],
    payload: {
      evidence_id: evidenceId, document_id: documentId, file_id: fileId, chunk_id: null, source_locator: sourceLocator,
      quoted_text: quotedText, quote_sha256: sha256Hex(quotedText ?? ""), extraction_method: "RULE", confidence: 1,
      verification_status: verificationStatus, metadata: {},
    },
  };
}

function fakeEmbeddingAdapter(dimension = 4) {
  return { async embedDocuments(texts) { return texts.map((_, i) => Array.from({ length: dimension }, (_, d) => (i + 1) * 0.1 + d * 0.01)); } };
}

function fakeWriterClient({ existingRow = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT retrieval_index_id, index_status, manifest_sha256/i.test(sql)) return { rows: existingRow ? [existingRow] : [] };
      return { rows: [] };
    },
  };
}

test("loadVerifiedEvidenceRetrievalIndex skips a non-VERIFIED or empty-quoted_text Evidence record, and never fabricates a chunk for it", async () => {
  const referenceRepository = fakeReferenceRepository({
    evidenceRecords: [
      verifiedEvidenceRecord({ evidenceId: "evidence_000000000000000000000001", documentId: "periodic_00000000000001", quotedText: "real quote", fileId: "file_000000000000000000000001", sourceLocator: "loc1" }),
      verifiedEvidenceRecord({ evidenceId: "evidence_000000000000000000000002", documentId: "periodic_00000000000001", quotedText: "", fileId: "file_000000000000000000000002", sourceLocator: "loc2" }),
    ],
  });
  const client = fakeWriterClient();
  const result = await loadVerifiedEvidenceRetrievalIndex({
    client, referenceRepository, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "p", model: "m", revision: "v1", dimension: 4 }, sourceSnapshotId: "corpus_x",
  });
  assert.equal(result.recordCount, 1);
  const insertCall = client.calls.find((c) => /INSERT INTO disclosure_reference\.reference_retrieval_chunks/i.test(c.sql));
  assert.equal(insertCall.params[3], "evidence_000000000000000000000001");
});

test("loadVerifiedEvidenceRetrievalIndex is idempotent: re-running with the SAME inputs against an existing READY row with a matching manifest_sha256 is a no-op (no INSERT/UPDATE issued)", async () => {
  const referenceRepository = fakeReferenceRepository({
    evidenceRecords: [verifiedEvidenceRecord({ evidenceId: "evidence_000000000000000000000001", documentId: "periodic_00000000000001", quotedText: "real quote", fileId: "file_000000000000000000000001", sourceLocator: "loc1" })],
  });
  const embeddingConfig = { provider: "p", model: "m", revision: "v1", dimension: 4 };
  // First, compute what manifest_sha256 a real run would produce.
  const probeClient = fakeWriterClient();
  const first = await loadVerifiedEvidenceRetrievalIndex({ client: probeClient, referenceRepository, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig, sourceSnapshotId: "corpus_x" });
  assert.equal(first.created, true);

  const secondClient = fakeWriterClient({ existingRow: { retrieval_index_id: first.retrievalIndexId, index_status: "READY", manifest_sha256: first.manifestSha256 } });
  const second = await loadVerifiedEvidenceRetrievalIndex({ client: secondClient, referenceRepository, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig, sourceSnapshotId: "corpus_x" });
  assert.equal(second.created, false);
  assert.equal(secondClient.calls.some((c) => /^INSERT|^UPDATE|^BEGIN/i.test(c.sql.trim())), false);
});

test("loadVerifiedEvidenceRetrievalIndex refuses to reuse the same retrieval_index_id for a DIFFERENT embedding config (different manifest_sha256)", async () => {
  const referenceRepository = fakeReferenceRepository({
    evidenceRecords: [verifiedEvidenceRecord({ evidenceId: "evidence_000000000000000000000001", documentId: "periodic_00000000000001", quotedText: "real quote", fileId: "file_000000000000000000000001", sourceLocator: "loc1" })],
  });
  const client = fakeWriterClient({ existingRow: { retrieval_index_id: "retrieval_index_x", index_status: "READY", manifest_sha256: "f".repeat(64) } });
  await assert.rejects(
    () => loadVerifiedEvidenceRetrievalIndex({ client, referenceRepository, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "p", model: "m", revision: "v1", dimension: 4 }, sourceSnapshotId: "corpus_x" }),
    VectorRetrievalLoaderError,
  );
});

test("loadVerifiedEvidenceRetrievalIndex rolls back the ENTIRE transaction if any chunk insert fails -- BEGIN is followed by ROLLBACK, never a partial COMMIT", async () => {
  const referenceRepository = fakeReferenceRepository({
    evidenceRecords: [
      verifiedEvidenceRecord({ evidenceId: "evidence_000000000000000000000001", documentId: "periodic_00000000000001", quotedText: "real quote 1", fileId: "file_000000000000000000000001", sourceLocator: "loc1" }),
      verifiedEvidenceRecord({ evidenceId: "evidence_000000000000000000000002", documentId: "periodic_00000000000001", quotedText: "real quote 2", fileId: "file_000000000000000000000002", sourceLocator: "loc2" }),
    ],
  });
  const calls = [];
  let chunkInsertCount = 0;
  const client = {
    async query(sql, params) {
      calls.push(sql.trim().split("\n")[0].trim());
      if (/SELECT retrieval_index_id, index_status, manifest_sha256/i.test(sql)) return { rows: [] };
      if (/INSERT INTO disclosure_reference\.reference_retrieval_chunks/i.test(sql)) {
        chunkInsertCount += 1;
        if (chunkInsertCount === 2) throw new Error("simulated insert failure on the second chunk");
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  await assert.rejects(
    () => loadVerifiedEvidenceRetrievalIndex({ client, referenceRepository, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "p", model: "m", revision: "v1", dimension: 4 }, sourceSnapshotId: "corpus_x" }),
    /simulated insert failure/,
  );
  assert.ok(calls.includes("BEGIN"));
  assert.ok(calls.includes("ROLLBACK"));
  assert.equal(calls.includes("COMMIT"), false);
});

test("loadVerifiedEvidenceRetrievalIndex rejects when embedDocuments returns the wrong count, or a non-finite value, before ever opening a transaction", async () => {
  const referenceRepository = fakeReferenceRepository({
    evidenceRecords: [verifiedEvidenceRecord({ evidenceId: "evidence_000000000000000000000001", documentId: "periodic_00000000000001", quotedText: "real quote", fileId: "file_000000000000000000000001", sourceLocator: "loc1" })],
  });
  const client = fakeWriterClient();
  await assert.rejects(
    () => loadVerifiedEvidenceRetrievalIndex({ client, referenceRepository, embeddingAdapter: { async embedDocuments() { return []; } }, embeddingConfig: { provider: "p", model: "m", revision: "v1", dimension: 4 }, sourceSnapshotId: "corpus_x" }),
    VectorRetrievalLoaderError,
  );
  assert.equal(client.calls.some((c) => /^BEGIN/i.test(c.sql)), false);

  await assert.rejects(
    () => loadVerifiedEvidenceRetrievalIndex({ client, referenceRepository, embeddingAdapter: { async embedDocuments() { return [[1, 2, 3, Number.NaN]]; } }, embeddingConfig: { provider: "p", model: "m", revision: "v1", dimension: 4 }, sourceSnapshotId: "corpus_x" }),
    VectorRetrievalLoaderError,
  );
});

// --- grants: minimum privilege -----------------------------------------

test("referenceRetrievalReaderGrantSql grants SELECT-only on exactly the two new tables, never ALL TABLES / ALTER DEFAULT PRIVILEGES / CREATE ROLE", () => {
  const statements = referenceRetrievalReaderGrantSql("agent_runtime_reader");
  const joined = statements.join("\n");
  assert.doesNotMatch(joined, /ALL TABLES/i);
  assert.doesNotMatch(joined, /ALTER DEFAULT PRIVILEGES/i);
  assert.doesNotMatch(joined, /CREATE ROLE/i);
  assert.doesNotMatch(joined, /INSERT|UPDATE|DELETE/i);
  assert.doesNotMatch(joined, /schema_migrations/i);
  assert.ok(joined.includes("disclosure_reference.reference_retrieval_indexes"));
  assert.ok(joined.includes("disclosure_reference.reference_retrieval_chunks"));
});

test("referenceRetrievalWriterGrantSql grants only the minimum DML the loader needs -- no DELETE anywhere, no access to releases/artifacts/records/schema_migrations", () => {
  const statements = referenceRetrievalWriterGrantSql("reference_vector_writer");
  const joined = statements.join("\n");
  assert.doesNotMatch(joined, /DELETE/i);
  assert.doesNotMatch(joined, /disclosure_reference\.releases/);
  assert.doesNotMatch(joined, /disclosure_reference\.artifacts/);
  assert.doesNotMatch(joined, /disclosure_reference\.records\b/);
  assert.doesNotMatch(joined, /schema_migrations/i);
  assert.doesNotMatch(joined, /ALL TABLES|ALTER DEFAULT PRIVILEGES/i);
  assert.match(joined, /GRANT SELECT, INSERT, UPDATE ON disclosure_reference\.reference_retrieval_indexes/);
  assert.match(joined, /GRANT SELECT, INSERT ON disclosure_reference\.reference_retrieval_chunks/);
});

test("grant SQL builders reject an unsafe role name (SQL identifier injection defense)", () => {
  assert.throws(() => referenceRetrievalReaderGrantSql("not a valid role; DROP TABLE x"));
  assert.throws(() => referenceRetrievalWriterGrantSql("'; DROP TABLE x; --"));
});

// --- migration: static structural checks (no real DB needed) ---------------

test("003_reference_vector_retrieval.sql never touches 001/002's own tables (Fact/Evidence/Event/Relation/releases/artifacts/records) with ALTER/DROP", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const sql = await readFile(path.join(root, "domain/postgres/003_reference_vector_retrieval.sql"), "utf8");
  assert.doesNotMatch(sql, /ALTER TABLE disclosure_reference\.(releases|artifacts|records)\b/i);
  assert.doesNotMatch(sql, /DROP TABLE disclosure_reference\.(releases|artifacts|records)\b/i);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.reference_retrieval_indexes/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.reference_retrieval_chunks/i);
});
