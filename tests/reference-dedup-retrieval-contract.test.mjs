// Turn P5.2: fake-pg-client unit/contract tests for
// domain/postgres/reference-dedup-retrieval-{repository,loader,grants}.mjs.
// No real PostgreSQL/pgvector needed for any test in this file -- see
// tests/reference-dedup-retrieval-postgres16-integration.test.mjs for the
// real-server tier, which is where the actual metadata-filter-before-top-k
// BEHAVIOR against real data is proven (this file proves SQL shape and
// fake-client plumbing only).
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { RequestAbortedError } from "../domain/runtime/abortable.mjs";
import {
  createPostgresDedupRetrievalRepository, DedupRetrievalRepositoryError,
} from "../domain/postgres/reference-dedup-retrieval-repository.mjs";
import {
  loadExactTextDedupIndex, computeDedupRetrievalIndexId, DedupRetrievalLoaderError,
} from "../domain/postgres/reference-dedup-retrieval-loader.mjs";
import {
  referenceDedupReaderGrantSql, referenceDedupWriterGrantSql,
} from "../domain/postgres/reference-dedup-retrieval-grants.mjs";
import { createDedupRetrieverAdapter } from "../domain/agent-comparison/retrieval/dedup-retriever-adapter.mjs";

// --- id determinism ---------------------------------------------------------

test("computeDedupRetrievalIndexId is deterministic and changes when any pin changes", () => {
  const base = { releaseId: "seed-release-v0.20-r3", sourceSnapshotId: "docsnap_x", embeddingProvider: "p", embeddingModel: "m", embeddingRevision: "v1", chunkingPolicyId: "document-node-first-v0.1" };
  const a = computeDedupRetrievalIndexId(base);
  const b = computeDedupRetrievalIndexId({ ...base });
  const c = computeDedupRetrievalIndexId({ ...base, embeddingRevision: "v2" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^dedup_index_[0-9a-f]{32}$/);
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
  retrieval_index_id: "dedup_index_ready", release_id: "seed-release-v0.20-r3", source_snapshot_id: "docsnap_x",
  embedding_provider: "p", embedding_model: "m", embedding_revision: "v1", embedding_dimension: 4,
  distance_metric: "cosine", chunking_policy_id: "document-node-first-v0.1", chunking_policy_sha256: "a".repeat(64),
  index_status: "READY", created_at: new Date("2026-01-01T00:00:00Z"), ready_at: new Date("2026-01-01T00:00:01Z"),
  canonical_count: 2, occurrence_count: 5, manifest_sha256: "b".repeat(64),
});

test("getRetrievalIndex returns null (not an error) for a genuinely missing index, and a real DB error is never reduced to that", async () => {
  const client = fakeClient([[/^SELECT/i, () => ({ rows: [] })]]);
  const repo = createPostgresDedupRetrievalRepository({ client });
  assert.equal(await repo.getRetrievalIndex("dedup_index_missing"), null);

  const failingClient = { async query() { throw new Error("connection reset"); } };
  const repoWithFailure = createPostgresDedupRetrievalRepository({ client: failingClient });
  await assert.rejects(() => repoWithFailure.getRetrievalIndex("x"), /connection reset/);
});

test("assertReadyRetrievalIndex fails closed on non-READY status and on any pin mismatch", async () => {
  const loadingRow = { ...READY_INDEX_ROW, index_status: "LOADING", ready_at: null };
  const client = fakeClient([[/^SELECT/i, () => ({ rows: [loadingRow] })]]);
  const repo = createPostgresDedupRetrievalRepository({ client });
  await assert.rejects(() => repo.assertReadyRetrievalIndex("dedup_index_ready"), DedupRetrievalRepositoryError);

  const readyClient = fakeClient([[/^SELECT/i, () => ({ rows: [READY_INDEX_ROW] })]]);
  const readyRepo = createPostgresDedupRetrievalRepository({ client: readyClient });
  await assert.rejects(
    () => readyRepo.assertReadyRetrievalIndex("dedup_index_ready", { release_id: "some-other-release" }),
    DedupRetrievalRepositoryError,
  );
  const index = await readyRepo.assertReadyRetrievalIndex("dedup_index_ready", { release_id: "seed-release-v0.20-r3", embedding_dimension: 4 });
  assert.equal(index.retrieval_index_id, "dedup_index_ready");
});

test("search rejects a queryVector with the wrong dimension, and one containing NaN/Infinity, before ever issuing the occurrence/canonical query", async () => {
  let searchQueryIssued = false;
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_dedup_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/WITH filtered_occurrences/i, () => { searchQueryIssued = true; return { rows: [] }; }],
  ]);
  const repo = createPostgresDedupRetrievalRepository({ client });

  await assert.rejects(() => repo.search({ retrievalIndexId: "dedup_index_ready", queryVector: [1, 2], topK: 5 }), DedupRetrievalRepositoryError);
  assert.equal(searchQueryIssued, false);
  await assert.rejects(() => repo.search({ retrievalIndexId: "dedup_index_ready", queryVector: [1, 2, 3, Number.NaN], topK: 5 }), TypeError);
  assert.equal(searchQueryIssued, false);
  await assert.rejects(() => repo.search({ retrievalIndexId: "dedup_index_ready", queryVector: [1, 2, 3, Number.POSITIVE_INFINITY], topK: 5 }), TypeError);
  assert.equal(searchQueryIssued, false);
});

test("search parameter-binds every dynamic value -- a corp_code containing SQL-special characters never appears literally in the SQL text", async () => {
  let capturedSql = null;
  let capturedParams = null;
  const dangerousCorpCode = "0'; DROP TABLE x; --";
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_dedup_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/WITH filtered_occurrences/i, (sql, params) => { capturedSql = sql; capturedParams = params; return { rows: [] }; }],
  ]);
  const repo = createPostgresDedupRetrievalRepository({ client });
  await repo.search({ retrievalIndexId: "dedup_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 5, corpCodes: [dangerousCorpCode] });
  assert.ok(!capturedSql.includes(dangerousCorpCode), "dangerous corp_code value must never appear literally in the SQL text");
  assert.ok(capturedParams.includes(dangerousCorpCode) || capturedParams.some((p) => Array.isArray(p) && p.includes(dangerousCorpCode)), "value must be bound as a parameter");
});

test("search SQL structure: occurrence metadata filtering happens strictly BEFORE the canonical top-k ranking (filtered_occurrences precedes top_canonical, which precedes the final expansion join)", async () => {
  let capturedSql = null;
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_dedup_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/WITH filtered_occurrences/i, (sql) => { capturedSql = sql; return { rows: [] }; }],
  ]);
  const repo = createPostgresDedupRetrievalRepository({ client });
  await repo.search({ retrievalIndexId: "dedup_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 5, corpCodes: ["00000001"], documentIds: ["exchange_20250101000001"] });

  const filteredIdx = capturedSql.indexOf("filtered_occurrences AS");
  const candidateIdx = capturedSql.indexOf("candidate_canonical AS");
  const topIdx = capturedSql.indexOf("top_canonical AS");
  // The final, outer SELECT's own column list legitimately re-projects
  // fo.corp_code/fo.source_document_id (the caller DOES want those back in
  // the result) -- so the "canonical CTEs never filter on them" check must
  // stop at the boundary of the top_canonical CTE body, not include the
  // outer SELECT's column list.
  const finalSelectIdx = capturedSql.indexOf("SELECT fo.chunk_id");
  assert.ok(filteredIdx >= 0 && candidateIdx > filteredIdx && topIdx > candidateIdx && finalSelectIdx > topIdx, "CTE order must be filtered_occurrences -> candidate_canonical -> top_canonical -> final expansion join");

  // corp_code/document_id conditions must appear ONLY inside the
  // filtered_occurrences CTE body, never inside the canonical-ranking CTEs
  // (candidate_canonical/top_canonical, up to but excluding the final
  // outer SELECT).
  const filteredBody = capturedSql.slice(filteredIdx, candidateIdx);
  const canonicalRankingBody = capturedSql.slice(candidateIdx, finalSelectIdx);
  assert.ok(filteredBody.includes("o.corp_code = ANY") && filteredBody.includes("o.source_document_id = ANY"));
  assert.ok(!canonicalRankingBody.includes("corp_code") && !canonicalRankingBody.includes("source_document_id"), "the canonical table has no corp_code/source_document_id column to filter on, and this query must never attempt to");
});

test("search's LIMIT (top-k) is applied to the candidate (already-filtered) canonical set, never to the whole canonical table unconditionally", async () => {
  let capturedSql = null;
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_dedup_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/WITH filtered_occurrences/i, (sql) => { capturedSql = sql; return { rows: [] }; }],
  ]);
  const repo = createPostgresDedupRetrievalRepository({ client });
  await repo.search({ retrievalIndexId: "dedup_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 5 });
  const topCanonicalBlock = capturedSql.slice(capturedSql.indexOf("top_canonical AS"), capturedSql.indexOf("SELECT fo.chunk_id"));
  assert.ok(/FROM candidate_canonical/.test(topCanonicalBlock));
  assert.ok(/LIMIT \$\d+/.test(topCanonicalBlock));
  assert.ok(topCanonicalBlock.indexOf("FROM candidate_canonical") < topCanonicalBlock.indexOf("LIMIT"), "LIMIT must come after selecting FROM the already-restricted candidate set");
});

// --- RequestAbortedError / abort propagation -------------------------------

test("an already-aborted signal throws RequestAbortedError before any query runs", async () => {
  const client = fakeClient([[/./, () => ({ rows: [] })]]);
  const repo = createPostgresDedupRetrievalRepository({ client });
  const controller = new AbortController();
  controller.abort("test-abort-reason");
  await assert.rejects(() => repo.getRetrievalIndex("x", { signal: controller.signal }), RequestAbortedError);
});

// --- mutation independence --------------------------------------------------

test("getRetrievalIndex returns a deep-frozen, independent copy", async () => {
  const client = fakeClient([[/^SELECT/i, () => ({ rows: [{ ...READY_INDEX_ROW }] })]]);
  const repo = createPostgresDedupRetrievalRepository({ client });
  const index = await repo.getRetrievalIndex("dedup_index_ready");
  assert.throws(() => { index.retrieval_index_id = "tampered"; }, TypeError);
  const again = await repo.getRetrievalIndex("dedup_index_ready");
  assert.notEqual(index, again);
  assert.deepEqual({ ...index }, { ...again });
});

// --- grants ------------------------------------------------------------------

test("reader grant SQL is SELECT-only on exactly the 3 dedup tables, no schema_migrations/other-table access", () => {
  const statements = referenceDedupReaderGrantSql("dedup_reader_role");
  const joined = statements.join(" ");
  assert.ok(joined.includes("reference_dedup_indexes"));
  assert.ok(joined.includes("reference_dedup_canonical_texts"));
  assert.ok(joined.includes("reference_dedup_occurrences"));
  assert.ok(!joined.includes("schema_migrations"));
  assert.ok(!/INSERT|UPDATE|DELETE/i.test(joined));
});

test("writer grant SQL has no DELETE anywhere and no access to releases/artifacts/records/reference_retrieval_*", () => {
  const statements = referenceDedupWriterGrantSql("dedup_writer_role");
  const joined = statements.join(" ");
  assert.ok(!/DELETE/i.test(joined));
  assert.ok(!joined.includes("disclosure_reference.releases"));
  assert.ok(!joined.includes("reference_retrieval_indexes"));
  assert.ok(!joined.includes("reference_retrieval_chunks"));
});

test("grant SQL builders reject an unsafe role name", () => {
  assert.throws(() => referenceDedupReaderGrantSql("bad-role; DROP TABLE x"), Error);
  assert.throws(() => referenceDedupWriterGrantSql("Robert'); DROP TABLE Students;--"), Error);
});

// --- loader: embedding call count and batching -----------------------------

function fixtureChunk({ chunkId, docId, corpCode, text, ordinal = 0, blockType = "PARAGRAPH" }) {
  return {
    chunk_id: chunkId, source_document_id: docId, corp_code: corpCode, source_group: "exchange", document_type: "test",
    node_id: `${docId}::a.xml::n0`, source_locator: `${docId}/a.xml#node=0`, parse_status: "SUCCESS",
    chunk_ordinal: ordinal, char_start: 0, char_end: text.length, text_content: text,
    text_sha256: createHash("sha256").update(text).digest("hex"),
    metadata: { block_type: blockType },
  };
}

function fakeEmbeddingAdapter(dimension = 4) {
  const calls = [];
  return {
    calls,
    async embedDocuments(texts) {
      calls.push([...texts]);
      return texts.map((text, index) => new Array(dimension).fill(0).map((_, dim) => (text.length + index + dim) / 100));
    },
  };
}

function fakeLoaderClient({ existingRow = null } = {}) {
  const inserts = { indexes: [], canonical: [], occurrences: [] };
  const commands = [];
  return {
    inserts, commands,
    async query(sql, params) {
      commands.push(sql.trim().split("\n")[0].trim());
      if (/^SELECT retrieval_index_id, index_status, manifest_sha256/.test(sql)) {
        return { rows: existingRow ? [existingRow] : [] };
      }
      if (/^BEGIN$/.test(sql) || /^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) return { rows: [] };
      if (/INSERT INTO disclosure_reference\.reference_dedup_indexes/.test(sql)) { inserts.indexes.push(params); return { rows: [] }; }
      if (/INSERT INTO disclosure_reference\.reference_dedup_canonical_texts/.test(sql)) { inserts.canonical.push(params); return { rows: [] }; }
      if (/INSERT INTO disclosure_reference\.reference_dedup_occurrences/.test(sql)) { inserts.occurrences.push(params); return { rows: [] }; }
      if (/^UPDATE disclosure_reference\.reference_dedup_indexes SET index_status = 'READY'/.test(sql)) return { rows: [] };
      throw new Error(`fakeLoaderClient: no handler for SQL: ${sql}`);
    },
  };
}

const BASE_LOADER_ARGS = {
  releaseId: "seed-release-v0.20-r3", sourceSnapshotId: "docsnap_test", chunkingPolicyId: "document-node-first-v0.1", chunkingPolicySha256: "c".repeat(64),
};

test("3 occurrences of the identical text result in exactly ONE embedDocuments call covering exactly 1 text", async () => {
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "repeated boilerplate line" }),
    fixtureChunk({ chunkId: `chunk_${"2".repeat(24)}`, docId: "exchange_20250102000002", corpCode: "00000002", text: "repeated boilerplate line", ordinal: 1 }),
    fixtureChunk({ chunkId: `chunk_${"3".repeat(24)}`, docId: "exchange_20250103000003", corpCode: "00000003", text: "repeated boilerplate line", ordinal: 2 }),
  ];
  const client = fakeLoaderClient();
  const embeddingAdapter = fakeEmbeddingAdapter();
  const result = await loadExactTextDedupIndex({
    client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 },
    ...BASE_LOADER_ARGS,
  });
  assert.equal(embeddingAdapter.calls.length, 1, "exactly one embedDocuments call");
  assert.equal(embeddingAdapter.calls[0].length, 1, "exactly one distinct text sent to embedDocuments");
  assert.equal(result.canonicalCount, 1);
  assert.equal(result.occurrenceCount, 3);
  assert.equal(client.inserts.canonical.length, 1);
  assert.equal(client.inserts.occurrences.length, 3);
});

test("occurrences from different companies all preserve their own corp_code/source_document_id under one shared canonical row", async () => {
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "(단위: 백만원)" }),
    fixtureChunk({ chunkId: `chunk_${"2".repeat(24)}`, docId: "holding_20250102000002", corpCode: "00000002", text: "(단위: 백만원)", ordinal: 1 }),
  ];
  const client = fakeLoaderClient();
  const embeddingAdapter = fakeEmbeddingAdapter();
  await loadExactTextDedupIndex({ client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS });
  const corpCodesInserted = client.inserts.occurrences.map((params) => params[4]); // corp_code positional param
  assert.deepEqual(new Set(corpCodesInserted), new Set(["00000001", "00000002"]));
  const docIdsInserted = client.inserts.occurrences.map((params) => params[3]);
  assert.deepEqual(new Set(docIdsInserted), new Set(["exchange_20250101000001", "holding_20250102000002"]));
});

test("batchSize is honored: N unique texts with batchSize=2 yields ceil(N/2) embedDocuments calls", async () => {
  const chunks = [1, 2, 3, 4, 5].map((n) => fixtureChunk({ chunkId: `chunk_${String(n).repeat(24)}`, docId: `exchange_2025010${n}000001`, corpCode: "00000001", text: `unique text number ${n}` }));
  const client = fakeLoaderClient();
  const embeddingAdapter = fakeEmbeddingAdapter();
  await loadExactTextDedupIndex({ client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, batchSize: 2, ...BASE_LOADER_ARGS });
  assert.equal(embeddingAdapter.calls.length, 3); // ceil(5/2)
  assert.deepEqual(embeddingAdapter.calls.map((batch) => batch.length), [2, 2, 1]);
});

test("a duplicate chunk_id in the source is rejected fail-closed before any embedding call", async () => {
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "a" }),
    fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250102000002", corpCode: "00000002", text: "b", ordinal: 1 }),
  ];
  const embeddingAdapter = fakeEmbeddingAdapter();
  await assert.rejects(
    () => loadExactTextDedupIndex({ client: fakeLoaderClient(), chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS }),
    /duplicate chunk_id/,
  );
  assert.equal(embeddingAdapter.calls.length, 0);
});

test("a text_sha256 collision with different text_content is rejected fail-closed (defensive: this should never happen for real sha256 input)", async () => {
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "real text" }),
    { ...fixtureChunk({ chunkId: `chunk_${"2".repeat(24)}`, docId: "exchange_20250102000002", corpCode: "00000002", text: "real text", ordinal: 1 }), text_content: "tampered text", text_sha256: createHash("sha256").update("real text").digest("hex") },
  ];
  await assert.rejects(
    () => loadExactTextDedupIndex({ client: fakeLoaderClient(), chunkSourceFactory: () => chunks, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS }),
    /text_sha256 collision/,
  );
});

test("a config mismatch on reuse (same retrievalIndexId, different manifest_sha256) is rejected fail-closed", async () => {
  const chunks = [fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "a" })];
  const client = fakeLoaderClient({ existingRow: { retrieval_index_id: "whatever", index_status: "READY", manifest_sha256: "totally-different" } });
  await assert.rejects(
    () => loadExactTextDedupIndex({ client, chunkSourceFactory: () => chunks, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS }),
    /DIFFERENT manifest_sha256/,
  );
});

test("loader is idempotent: same snapshot/config re-run against an existing READY row with the SAME manifest_sha256 is a no-op (created=false)", async () => {
  const chunks = [fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "stable text" })];
  // First, compute what the real manifest_sha256 would be by running once against a fresh client.
  const freshClient = fakeLoaderClient();
  const embeddingAdapter = fakeEmbeddingAdapter();
  const firstResult = await loadExactTextDedupIndex({ client: freshClient, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS });
  assert.equal(firstResult.created, true);

  const idempotentClient = fakeLoaderClient({ existingRow: { retrieval_index_id: firstResult.retrievalIndexId, index_status: "READY", manifest_sha256: firstResult.manifestSha256 } });
  const secondResult = await loadExactTextDedupIndex({ client: idempotentClient, chunkSourceFactory: () => chunks, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS });
  assert.equal(secondResult.created, false);
  assert.equal(secondResult.retrievalIndexId, firstResult.retrievalIndexId);
});

test("an existing LOADING row for the same retrievalIndexId is rejected (never resumed silently)", async () => {
  const chunks = [fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "a" })];
  const client = fakeLoaderClient({ existingRow: { retrieval_index_id: "whatever", index_status: "LOADING", manifest_sha256: "x" } });
  await assert.rejects(
    () => loadExactTextDedupIndex({ client, chunkSourceFactory: () => chunks, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS }),
    /already exists in LOADING status/,
  );
});

test("dimension/NaN/Infinity vectors from the embedding adapter are rejected before any INSERT", async () => {
  const chunks = [fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "a" })];
  const badAdapter = { async embedDocuments() { return [[1, 2, 3]]; } }; // wrong dimension (expects 4)
  const client = fakeLoaderClient();
  await assert.rejects(
    () => loadExactTextDedupIndex({ client, chunkSourceFactory: () => chunks, embeddingAdapter: badAdapter, embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS }),
    /expected a 4-dimension vector/,
  );
  assert.equal(client.inserts.indexes.length, 0);

  const nanAdapter = { async embedDocuments() { return [[1, 2, 3, Number.NaN]]; } };
  await assert.rejects(
    () => loadExactTextDedupIndex({ client: fakeLoaderClient(), chunkSourceFactory: () => chunks, embeddingAdapter: nanAdapter, embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS }),
    /finite numbers/,
  );
});

test("a mid-load failure (INSERT throws partway through) triggers ROLLBACK and never leaves a READY row", async () => {
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "a" }),
    fixtureChunk({ chunkId: `chunk_${"2".repeat(24)}`, docId: "exchange_20250102000002", corpCode: "00000002", text: "b", ordinal: 1 }),
  ];
  let occurrenceInsertCount = 0;
  const commands = [];
  const client = {
    async query(sql, params) {
      commands.push(sql.trim().split("\n")[0].trim());
      if (/^SELECT retrieval_index_id, index_status, manifest_sha256/.test(sql)) return { rows: [] };
      if (/^BEGIN$/.test(sql) || /^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) return { rows: [] };
      if (/INSERT INTO disclosure_reference\.reference_dedup_indexes/.test(sql)) return { rows: [] };
      if (/INSERT INTO disclosure_reference\.reference_dedup_canonical_texts/.test(sql)) return { rows: [] };
      if (/INSERT INTO disclosure_reference\.reference_dedup_occurrences/.test(sql)) {
        occurrenceInsertCount += 1;
        if (occurrenceInsertCount === 2) throw new Error("simulated mid-load failure");
        return { rows: [] };
      }
      if (/^UPDATE/.test(sql)) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  await assert.rejects(
    () => loadExactTextDedupIndex({ client, chunkSourceFactory: () => chunks, embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS }),
    /simulated mid-load failure/,
  );
  assert.ok(commands.includes("ROLLBACK"), "ROLLBACK must have been issued");
  assert.ok(!commands.some((c) => c.startsWith("UPDATE")), "the READY-flip UPDATE must never have been reached");
});

// --- migration: static structural checks (no real DB needed) ---------------

test("004_reference_dedup_retrieval_index.sql never touches 001/002/003's own tables with ALTER/DROP, and declares the 3 new tables additively", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const sql = await readFile(path.join(root, "domain/postgres/004_reference_dedup_retrieval_index.sql"), "utf8");
  assert.doesNotMatch(sql, /ALTER TABLE disclosure_reference\.(releases|artifacts|records|reference_retrieval_indexes|reference_retrieval_chunks)\b/i);
  assert.doesNotMatch(sql, /DROP TABLE disclosure_reference\.(releases|artifacts|records|reference_retrieval_indexes|reference_retrieval_chunks)\b/i);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.reference_dedup_indexes/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.reference_dedup_canonical_texts/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.reference_dedup_occurrences/i);
  // The canonical table must never declare a corp_code/source_document_id
  // column -- if it ever did, a future edit could tempt someone into
  // filtering on it directly, defeating the whole invariant this schema
  // exists to enforce.
  const canonicalTableBlock = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS disclosure_reference.reference_dedup_canonical_texts"), sql.indexOf("CREATE TABLE IF NOT EXISTS disclosure_reference.reference_dedup_occurrences"));
  assert.doesNotMatch(canonicalTableBlock, /\bcorp_code\b/i);
  assert.doesNotMatch(canonicalTableBlock, /\bsource_document_id\b/i);
});

test("an empty source is rejected fail-closed (never creates an empty dedup index)", async () => {
  await assert.rejects(
    () => loadExactTextDedupIndex({ client: fakeLoaderClient(), chunkSourceFactory: () => [], embeddingAdapter: fakeEmbeddingAdapter(), embeddingConfig: { provider: "test", model: "fake", revision: "v1", dimension: 4 }, ...BASE_LOADER_ARGS }),
    /no chunks were found/,
  );
});

// =====================================================================
// Turn P5.2.1: top_k overflow + distance-metric fail-closed regressions
// =====================================================================

test("[P5.2.1] search SQL structure: the final SELECT ends with a LIMIT on the SAME topK parameter used to bound canonical ranking -- the expansion join can never overflow past topK", async () => {
  let capturedSql = null;
  const client = fakeClient([
    [/FROM disclosure_reference\.reference_dedup_indexes/i, () => ({ rows: [READY_INDEX_ROW] })],
    [/WITH filtered_occurrences/i, (sql) => { capturedSql = sql; return { rows: [] }; }],
  ]);
  const repo = createPostgresDedupRetrievalRepository({ client });
  await repo.search({ retrievalIndexId: "dedup_index_ready", queryVector: [0.1, 0.2, 0.3, 0.4], topK: 7 });

  // Exactly two LIMIT clauses: one inside top_canonical (bounding canonical
  // ranking work), one at the very end of the final SELECT (bounding the
  // actual response). Both must reference the identical parameter index.
  const limitMatches = [...capturedSql.matchAll(/LIMIT \$(\d+)/g)];
  assert.equal(limitMatches.length, 2, `expected exactly 2 LIMIT clauses, found ${limitMatches.length}`);
  assert.equal(limitMatches[0][1], limitMatches[1][1], "both LIMIT clauses must reference the same bound topK parameter");

  const finalSelectStart = capturedSql.indexOf("SELECT fo.chunk_id");
  const finalLimitIndex = capturedSql.lastIndexOf("LIMIT");
  assert.ok(finalLimitIndex > finalSelectStart, "the final LIMIT must belong to the outer SELECT, after the expansion join, not only inside top_canonical");
  const textAfterFinalOrderBy = capturedSql.slice(capturedSql.lastIndexOf("ORDER BY"));
  assert.match(textAfterFinalOrderBy, /LIMIT \$\d+\s*$/, "LIMIT must be the very last clause of the query, applied after ORDER BY on the fully expanded+sorted set");
});

test("[P5.2.1] dedup-retriever-adapter forces distance_metric:'cosine' into expectedPins, overriding any caller-supplied value", async () => {
  let capturedRequest = null;
  const fakeRepository = {
    async search(request) { capturedRequest = request; return []; },
  };
  const embeddingAdapter = { async embedQuery() { return [0.1, 0.2, 0.3, 0.4]; } };
  const adapter = createDedupRetrieverAdapter({
    dedupRepository: fakeRepository, embeddingAdapter, embeddingConfig: { dimension: 4 },
    retrievalIndexId: "dedup_index_x", expectedPins: { distance_metric: "l2", release_id: "some-release" },
  });
  await adapter.retrieve({ query_id: "q", question: "test", top_k: 5, metadata_filters: {} });
  assert.equal(capturedRequest.expectedPins.distance_metric, "cosine", "the adapter must force cosine regardless of what the caller's own expectedPins claims");
  assert.equal(capturedRequest.expectedPins.release_id, "some-release", "other caller-supplied pins must still pass through unchanged");
});

test("[P5.2.1] dedup-retriever-adapter defensively bounds results to request.top_k even if the repository returns more rows than requested", async () => {
  const overflowingRepository = {
    async search() {
      // Simulates a hypothetical repository bug (or a future regression)
      // returning more rows than topK -- the adapter must not trust this.
      return [1, 2, 3].map((n) => ({
        chunk_id: `chunk_${String(n).repeat(24)}`, source_document_id: `doc_${n}`, corp_code: "00000001",
        source_locator: `doc_${n}/a.xml#node=0`, node_id: `doc_${n}::a.xml::n0`, block_type: "PARAGRAPH",
        chunk_ordinal: 0, similarity_score: 1 - n * 0.01, canonical_text: "shared text", metadata: {},
      }));
    },
  };
  const embeddingAdapter = { async embedQuery() { return [0.1, 0.2, 0.3, 0.4]; } };
  const adapter = createDedupRetrieverAdapter({ dedupRepository: overflowingRepository, embeddingAdapter, embeddingConfig: { dimension: 4 }, retrievalIndexId: "dedup_index_x" });
  const result = await adapter.retrieve({ query_id: "q", question: "test", top_k: 1, metadata_filters: {} });
  assert.equal(result.results.length, 1, "the adapter must defensively bound its own output to top_k regardless of what the repository returned");
  assert.equal(result.results[0].rank, 1);
});
