// Turn P5.2: REAL PostgreSQL 16 + pgvector integration coverage for
// 004_reference_dedup_retrieval_index.sql /
// reference-dedup-retrieval-{repository,loader,grants}.mjs. Deliberately
// excluded from `npm run test:reference-db` / `verify:contracts` -- run via:
//
//   DATABASE_URL='postgresql://user:pass@host:5432/scratch_db' \
//     npm run test:reference-dedup-retrieval:postgres16
//
// If DATABASE_URL is not set, this suite FAILS CLOSED with
// POSTGRESQL_16_INTEGRATION_NOT_RUN (never a silent skip). If
// `CREATE EXTENSION vector` fails, it fails closed with
// BLOCKED_PGVECTOR_EXTENSION_NOT_AVAILABLE -- same convention as every
// other *-postgres16-integration.test.mjs in this repo.
//
// SCALE NOTE: this suite loads a small synthetic fixture and a bounded,
// deterministic 192-row SHARD of the real Turn P5 snapshot (two real
// documents from two different real companies that both genuinely contain
// the exact text "(단위: 백만원)" -- see reference-dedup-retrieval-loader.mjs's
// own header comment on why full 1,874,688-row loading is out of this
// Turn's required scope).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import { applyReferenceReleaseMigration, importReferenceRelease } from "../domain/postgres/reference-release-loader.mjs";
import {
  createPostgresDedupRetrievalRepository, DedupRetrievalRepositoryError,
} from "../domain/postgres/reference-dedup-retrieval-repository.mjs";
import { loadExactTextDedupIndex, DedupRetrievalLoaderError } from "../domain/postgres/reference-dedup-retrieval-loader.mjs";
import { applyReferenceDedupWriterGrant, applyReferenceDedupReaderGrant } from "../domain/postgres/reference-dedup-retrieval-grants.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "../domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs";
import { createDedupRetrieverAdapter } from "../domain/agent-comparison/retrieval/dedup-retriever-adapter.mjs";
import { createRetrieverStore } from "../domain/runtime/retriever-store.mjs";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dirname, "..");
const SNAPSHOT_CHUNKS_PATH = path.join(ROOT, "work/domain-seed/document-retrieval-snapshot-v0.1/document-chunks.v0.1.jsonl");
const LOAD_OPTIONS = Object.freeze({
  root: ROOT,
  bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: "seed-release-v0.20",
});
const EMBEDDING_CONFIG = Object.freeze({ provider: "test-fixture", model: "deterministic-fake-embedding-v1", revision: "v1", dimension: 8 });
const RELEASE_ID = "seed-release-v0.20";
const SOURCE_SNAPSHOT_ID = "docsnap_8e480ec27b33b15bada7b3e764df5385"; // Turn P5's real snapshot_id, pinned
const CHUNKING_POLICY_ID = "document-node-first-v0.1";
const CHUNKING_POLICY_SHA256 = "c930bdb99ac087287772037ad315f640725d5be7331ede56562dd9a1f95365fd";

let client;
let shardResult; // set by the shard-load test, read by the two search-semantics tests that follow it in this same file (Node's test runner runs tests within one file sequentially by default)

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fixtureChunk({ chunkId, docId, corpCode, text, blockType = "PARAGRAPH", ordinal = 0 }) {
  return {
    chunk_id: chunkId, source_document_id: docId, corp_code: corpCode, source_group: "exchange", document_type: "test",
    node_id: `${docId}::a.xml::n0`, source_locator: `${docId}/a.xml#node=0`, parse_status: "SUCCESS",
    chunk_ordinal: ordinal, char_start: 0, char_end: text.length, text_content: text, text_sha256: sha256Hex(text),
    metadata: { block_type: blockType },
  };
}

test.before(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: DATABASE_URL is required to run tests/reference-dedup-retrieval-postgres16-integration.test.mjs. "
      + "This is a real-server integration suite, never silently skipped. Run: "
      + "DATABASE_URL='postgresql://user:pass@localhost:5432/scratch_db' npm run test:reference-dedup-retrieval:postgres16",
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

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch (error) {
    throw new Error(
      `BLOCKED_PGVECTOR_EXTENSION_NOT_AVAILABLE: CREATE EXTENSION vector failed against this PostgreSQL 16 server (${error.message}). `
      + "The pgvector extension's control/SQL files are not installed on this server's filesystem. This suite is intentionally "
      + "reported as a hard failure, not a skip and not a pass, until pgvector is actually installed on the target server.",
    );
  }
  await client.query("DROP EXTENSION vector");

  await applyReferenceReleaseMigration({ client, root: ROOT });
  await client.query(await (await import("node:fs/promises")).readFile(path.join(ROOT, "domain/postgres/004_reference_dedup_retrieval_index.sql"), "utf8"));
  await importReferenceRelease({ client, ...LOAD_OPTIONS }); // gives us a real releases row to FK against
});

test.after(async () => {
  if (client) await client.end();
});

test("real PostgreSQL 16 + pgvector: a small synthetic fixture loads with EXACT canonical/occurrence counts, and dedup actually happened", async () => {
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "shared boilerplate phrase" }),
    fixtureChunk({ chunkId: `chunk_${"2".repeat(24)}`, docId: "exchange_20250102000002", corpCode: "00000002", text: "shared boilerplate phrase", ordinal: 1 }),
    fixtureChunk({ chunkId: `chunk_${"3".repeat(24)}`, docId: "exchange_20250102000002", corpCode: "00000002", text: "unique text for doc 2", ordinal: 2 }),
    fixtureChunk({ chunkId: `chunk_${"4".repeat(24)}`, docId: "major_20250103000003", corpCode: "00000003", text: "another unique paragraph" }),
  ];
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const result = await loadExactTextDedupIndex({
    client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG,
    releaseId: RELEASE_ID, sourceSnapshotId: "docsnap_fixture_small", chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256,
  });
  assert.equal(result.created, true);
  assert.equal(result.canonicalCount, 3); // 4 occurrences, 1 exact duplicate -> 3 unique texts
  assert.equal(result.occurrenceCount, 4);

  const canonicalRowCount = await client.query("SELECT count(*) FROM disclosure_reference.reference_dedup_canonical_texts WHERE retrieval_index_id = $1", [result.retrievalIndexId]);
  const occurrenceRowCount = await client.query("SELECT count(*) FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id = $1", [result.retrievalIndexId]);
  assert.equal(Number(canonicalRowCount.rows[0].count), 3);
  assert.equal(Number(occurrenceRowCount.rows[0].count), 4);

  const repository = createPostgresDedupRetrievalRepository({ client });
  const index = await repository.getRetrievalIndex(result.retrievalIndexId);
  assert.equal(index.index_status, "READY");
  assert.equal(index.canonical_count, 3);
  assert.equal(index.occurrence_count, 4);
});

test("real PostgreSQL 16 + pgvector: loader is idempotent against the real database (same inputs, second call is a no-op)", async () => {
  const chunks = [fixtureChunk({ chunkId: `chunk_${"5".repeat(24)}`, docId: "exchange_20250104000004", corpCode: "00000004", text: "idempotency check text" })];
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const args = { client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG, releaseId: RELEASE_ID, sourceSnapshotId: "docsnap_fixture_idempotent", chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256 };
  const first = await loadExactTextDedupIndex(args);
  assert.equal(first.created, true);
  const second = await loadExactTextDedupIndex(args);
  assert.equal(second.created, false);
  assert.equal(second.retrievalIndexId, first.retrievalIndexId);

  const occurrenceRowCount = await client.query("SELECT count(*) FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id = $1", [first.retrievalIndexId]);
  assert.equal(Number(occurrenceRowCount.rows[0].count), 1, "re-running must never duplicate rows");
});

test("real PostgreSQL 16 + pgvector: a mid-load failure (CHECK constraint violation) rolls back completely -- the retrieval_index_id does not exist afterward", async () => {
  const badChunks = [
    fixtureChunk({ chunkId: `chunk_${"6".repeat(24)}`, docId: "exchange_20250105000005", corpCode: "00000005", text: "ok text" }),
    { ...fixtureChunk({ chunkId: `chunk_${"7".repeat(24)}`, docId: "exchange_20250106000006", corpCode: "00000005", text: "bad text", ordinal: 1 }), parse_status: "SUCCESS", char_start: 5, char_end: 2 }, // char_end < char_start violates the CHECK constraint
  ];
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  let thrownRetrievalIndexId = null;
  await assert.rejects(async () => {
    try {
      await loadExactTextDedupIndex({ client, chunkSourceFactory: () => badChunks, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG, releaseId: RELEASE_ID, sourceSnapshotId: "docsnap_fixture_rollback", chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256 });
    } catch (error) {
      thrownRetrievalIndexId = error.message; // capture something to help debug if this ever fails
      throw error;
    }
  });
  const indexRows = await client.query("SELECT count(*) FROM disclosure_reference.reference_dedup_indexes WHERE source_snapshot_id = $1", ["docsnap_fixture_rollback"]);
  assert.equal(Number(indexRows.rows[0].count), 0, "the LOADING index row itself must be rolled back, not just left in LOADING");
});

test("real PostgreSQL 16 + pgvector: READY immutability -- direct DELETE and UPDATE on both indexes and child rows are rejected by real triggers", async () => {
  const chunks = [fixtureChunk({ chunkId: `chunk_${"8".repeat(24)}`, docId: "exchange_20250107000007", corpCode: "00000006", text: "immutability check text" })];
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const result = await loadExactTextDedupIndex({ client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG, releaseId: RELEASE_ID, sourceSnapshotId: "docsnap_fixture_immutable", chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256 });

  await assert.rejects(
    () => client.query("DELETE FROM disclosure_reference.reference_dedup_indexes WHERE retrieval_index_id = $1", [result.retrievalIndexId]),
    /cannot be deleted/i,
  );
  await assert.rejects(
    () => client.query("UPDATE disclosure_reference.reference_dedup_indexes SET canonical_count = 999 WHERE retrieval_index_id = $1", [result.retrievalIndexId]),
    /immutable once/i,
  );
  const [canonicalRow] = (await client.query("SELECT text_sha256 FROM disclosure_reference.reference_dedup_canonical_texts WHERE retrieval_index_id = $1 LIMIT 1", [result.retrievalIndexId])).rows;
  await assert.rejects(
    () => client.query("DELETE FROM disclosure_reference.reference_dedup_canonical_texts WHERE retrieval_index_id = $1 AND text_sha256 = $2", [result.retrievalIndexId, canonicalRow.text_sha256]),
    /immutable once/i,
  );
  const [occurrenceRow] = (await client.query("SELECT chunk_id FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id = $1 LIMIT 1", [result.retrievalIndexId])).rows;
  await assert.rejects(
    () => client.query("DELETE FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id = $1 AND chunk_id = $2", [result.retrievalIndexId, occurrenceRow.chunk_id]),
    /immutable once/i,
  );
});

test("real PostgreSQL 16 + pgvector: minimum-privilege reader/writer grants apply and actually enforce (reader cannot INSERT, writer cannot DELETE)", async () => {
  const readerRole = "p52_dedup_reader_role";
  const writerRole = "p52_dedup_writer_role";
  await client.query(`DROP ROLE IF EXISTS ${readerRole}`);
  await client.query(`DROP ROLE IF EXISTS ${writerRole}`);
  await client.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD 'test'`);
  await client.query(`CREATE ROLE ${writerRole} LOGIN PASSWORD 'test'`);
  await applyReferenceDedupReaderGrant({ client, roleName: readerRole });
  await applyReferenceDedupWriterGrant({ client, roleName: writerRole });

  // "permission denied" error TEXT is locale-dependent (this server's own
  // locale renders it in Korean, as seen when this test was first run
  // against it) -- SQLSTATE 42501 (insufficient_privilege) is the portable,
  // locale-independent signal every PostgreSQL server uses for this.
  const INSUFFICIENT_PRIVILEGE = "42501";

  try {
    await client.query(`SET ROLE ${readerRole}`);
    await assert.rejects(
      () => client.query(
        `INSERT INTO disclosure_reference.reference_dedup_indexes
           (retrieval_index_id, release_id, source_snapshot_id, embedding_provider, embedding_model, embedding_revision,
            embedding_dimension, distance_metric, chunking_policy_id, chunking_policy_sha256, manifest_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        ["x", "y", "z", "p", "m", "r", 8, "cosine", "pol", "a".repeat(64), "b".repeat(64)],
      ),
      (error) => error.code === INSUFFICIENT_PRIVILEGE,
    );
  } finally {
    await client.query("RESET ROLE");
  }

  try {
    await client.query(`SET ROLE ${writerRole}`);
    await assert.rejects(
      () => client.query("DELETE FROM disclosure_reference.reference_dedup_occurrences WHERE true"),
      (error) => error.code === INSUFFICIENT_PRIVILEGE,
    );
  } finally {
    await client.query("RESET ROLE");
  }

  // A role that was GRANTed privileges cannot be DROPped until those
  // grants are revoked (or the role's dependent privileges dropped) --
  // real PostgreSQL behavior this test only discovered by actually running
  // against a real server.
  await client.query(`DROP OWNED BY ${readerRole}`);
  await client.query(`DROP OWNED BY ${writerRole}`);
  await client.query(`DROP ROLE IF EXISTS ${readerRole}`);
  await client.query(`DROP ROLE IF EXISTS ${writerRole}`);
});

// --- the core semantic invariant, against a bounded real-corpus shard ------

async function readShardChunks(documentIds) {
  const idSet = new Set(documentIds);
  const chunks = [];
  const rl = createInterface({ input: createReadStream(SNAPSHOT_CHUNKS_PATH, { highWaterMark: 1024 * 1024 }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let quickMatch = false;
    for (const id of idSet) { if (line.includes(id)) { quickMatch = true; break; } }
    if (!quickMatch) continue;
    const chunk = JSON.parse(line);
    if (idSet.has(chunk.source_document_id)) chunks.push(chunk);
  }
  return chunks;
}

test("real PostgreSQL 16 + pgvector: bounded real-corpus shard (2 real documents, 2 real companies, a genuine shared boilerplate text) loads correctly", async () => {
  const documentIds = ["holding_20230713000028", "holding_20240924000330"];
  const chunks = await readShardChunks(documentIds);
  assert.equal(chunks.length, 192, "expected exactly the known real shard size for these two documents");
  const corpCodes = new Set(chunks.map((c) => c.corp_code));
  assert.equal(corpCodes.size, 2, "the shard must span 2 distinct real companies");

  const sharedHash = "01bd41d517e0bb8a0dbfbc63204e0ed60523a79dd87ddf8d3a81c5f8b17fc7b9"; // "(단위: 백만원)"
  const sharedOccurrences = chunks.filter((c) => c.text_sha256 === sharedHash);
  assert.ok(sharedOccurrences.length >= 2, "the shard must contain at least 2 real occurrences of the known shared boilerplate text");
  assert.equal(new Set(sharedOccurrences.map((c) => c.corp_code)).size, 2, "the shared text must genuinely appear under BOTH companies in this shard");

  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const result = await loadExactTextDedupIndex({
    client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: EMBEDDING_CONFIG,
    releaseId: RELEASE_ID, sourceSnapshotId: SOURCE_SNAPSHOT_ID, chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256,
  });
  assert.equal(result.occurrenceCount, 192);
  const uniqueHashes = new Set(chunks.map((c) => c.text_sha256));
  assert.equal(result.canonicalCount, uniqueHashes.size);
  assert.ok(result.canonicalCount < result.occurrenceCount, "real duplicate text must have actually reduced the embedding payload count");

  shardResult = { retrievalIndexId: result.retrievalIndexId, chunks, corpCodes: [...corpCodes] };
});

test("real PostgreSQL 16 + pgvector: metadata filter is applied at the OCCURRENCE stage before top-k -- filtering by one real company never returns another company's occurrence, even for the identical shared text", async () => {
  const { retrievalIndexId, chunks, corpCodes } = shardResult;
  const [corpA, corpB] = corpCodes;
  const repository = createPostgresDedupRetrievalRepository({ client });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const queryVector = await embeddingAdapter.embedQuery("단위 확인");
  const sharedHash = "01bd41d517e0bb8a0dbfbc63204e0ed60523a79dd87ddf8d3a81c5f8b17fc7b9";

  // topK is capped at 100 by the repository itself, and one of these two
  // real companies has 101 distinct texts -- so "does hash X rank in the
  // top K" is not a reliable way to prove existence with a
  // non-semantic FAKE embedding. topK for corpA is set to cover its ENTIRE
  // real candidate set (fewer than 100), which makes "found" deterministic
  // regardless of ranking; corpB's is capped at 100 (near-total coverage)
  // for the "no cross-contamination" invariant, which does not depend on
  // ranking luck at all.
  const uniqueTextCountByCorp = (corp) => new Set(chunks.filter((c) => c.corp_code === corp).map((c) => c.text_sha256)).size;
  const topKForA = Math.min(100, uniqueTextCountByCorp(corpA));

  const resultsForA = await repository.search({ retrievalIndexId, queryVector, topK: topKForA, corpCodes: [corpA] });
  assert.ok(resultsForA.length > 0);
  assert.ok(resultsForA.every((hit) => hit.corp_code === corpA), "every returned occurrence must belong to the requested company, even though the canonical text is shared with corpB");
  assert.ok(resultsForA.some((hit) => hit.text_sha256 === sharedHash), "corpA's own occurrence of the shared text must be findable when topK covers its full candidate set");

  const chunkIdsForA = new Set(chunks.filter((c) => c.corp_code === corpA).map((c) => c.chunk_id));
  for (const hit of resultsForA) {
    assert.ok(chunkIdsForA.has(hit.chunk_id), `returned chunk_id ${hit.chunk_id} must be one of corpA's own real chunk ids`);
  }

  // The shared boilerplate hash's canonical row is retrievable for BOTH
  // companies independently -- proving one canonical embedding safely
  // serves two different companies' citations without cross-contamination.
  // (topK=100 here does not necessarily cover corpB's full ~101-text
  // candidate set -- the invariant under test is "never the wrong
  // company's occurrence," not "every hash always ranks in view.")
  const resultsForB = await repository.search({ retrievalIndexId, queryVector, topK: 100, corpCodes: [corpB] });
  assert.ok(resultsForB.length > 0);
  assert.ok(resultsForB.every((hit) => hit.corp_code === corpB));
  // No chunk_id may appear in both result sets (they are disjoint real occurrence sets).
  const idsA = new Set(resultsForA.map((h) => h.chunk_id));
  const idsB = new Set(resultsForB.map((h) => h.chunk_id));
  for (const id of idsA) assert.ok(!idsB.has(id));

  // Data-integrity proof (independent of any ranking/topK limit): the
  // shared canonical row genuinely has occurrence rows under BOTH real
  // companies in the database itself.
  const occurrenceCorps = await client.query(
    "SELECT DISTINCT corp_code FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id = $1 AND text_sha256 = $2 ORDER BY corp_code",
    [retrievalIndexId, sharedHash],
  );
  assert.deepEqual(occurrenceCorps.rows.map((r) => r.corp_code).sort(), [corpA, corpB].sort());
});

test("real PostgreSQL 16 + pgvector: document_id filter further narrows within a company, and results are stably ordered (similarity DESC, document_id ASC, chunk_id ASC)", async () => {
  const { retrievalIndexId } = shardResult;
  const repository = createPostgresDedupRetrievalRepository({ client });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const queryVector = await embeddingAdapter.embedQuery("보고자 지분 현황");

  const results = await repository.search({ retrievalIndexId, queryVector, topK: 20, documentIds: ["holding_20230713000028"] });
  assert.ok(results.every((hit) => hit.source_document_id === "holding_20230713000028"));

  for (let i = 1; i < results.length; i += 1) {
    const prev = results[i - 1];
    const cur = results[i];
    assert.ok(
      prev.similarity_score > cur.similarity_score
      || (prev.similarity_score === cur.similarity_score && (prev.source_document_id < cur.source_document_id
        || (prev.source_document_id === cur.source_document_id && prev.chunk_id <= cur.chunk_id))),
      "results must be ordered by similarity DESC then a stable tie-break",
    );
  }

  // Re-running the identical query twice yields byte-identical ordering (determinism).
  const again = await repository.search({ retrievalIndexId, queryVector, topK: 20, documentIds: ["holding_20230713000028"] });
  assert.deepEqual(results.map((h) => h.chunk_id), again.map((h) => h.chunk_id));
});

// =====================================================================
// Turn P5.2.1: top_k overflow + distance-metric-mismatch regression tests.
//
// Both of these were REAL bugs, independently confirmed by running this
// exact test file against the pre-fix code before the fix in this Turn was
// applied (see the Turn P5.2.1 final report for the captured RED output):
//   1. repository.search()'s SQL bounded only the CANONICAL ranking stage
//      to topK -- expanding the top-K canonical hits out to every matching
//      occurrence could return MORE than topK rows whenever a canonical
//      text had multiple matching occurrences (e.g. the same boilerplate
//      phrase repeated within one company's own filings).
//   2. dedup-retriever-adapter.mjs hard-coded score_type="COSINE" on every
//      result regardless of the REAL index's own distance_metric, so an
//      l2/inner_product index's results were silently mislabeled.
// =====================================================================

const OVERFLOW_EMBEDDING_CONFIG = Object.freeze({ provider: "test-fixture", model: "deterministic-fake-embedding-v1", revision: "v1", dimension: 8 });

async function loadOverflowFixture({ sourceSnapshotId, distanceMetric = "cosine" }) {
  // A tiny, fully-controlled synthetic fixture (not the real corpus) --
  // exactly what Section A of the Turn P5.2.1 task brief asks for: one
  // canonical text shared by (at least) 3 occurrences across 3 different
  // real-shaped companies, so it is trivially "similarity rank #1" (it is
  // the ONLY canonical text in this tiny index -- no embedding luck
  // involved), isolating the overflow bug from any ranking non-determinism.
  const sharedText = "동일 canonical 텍스트 -- overflow 회귀 테스트 전용";
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"a".repeat(24)}`, docId: "exchange_20250201000001", corpCode: "00000011", text: sharedText, ordinal: 0 }),
    fixtureChunk({ chunkId: `chunk_${"b".repeat(24)}`, docId: "exchange_20250202000002", corpCode: "00000012", text: sharedText, ordinal: 1 }),
    fixtureChunk({ chunkId: `chunk_${"c".repeat(24)}`, docId: "exchange_20250203000003", corpCode: "00000013", text: sharedText, ordinal: 2 }),
  ];
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const result = await loadExactTextDedupIndex({
    client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: OVERFLOW_EMBEDDING_CONFIG,
    releaseId: RELEASE_ID, sourceSnapshotId, chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256, distanceMetric,
  });
  return { retrievalIndexId: result.retrievalIndexId, chunks, embeddingAdapter };
}

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] 3 occurrences share 1 canonical text; topK=1 returns EXACTLY 1 row (previously returned 3)", async () => {
  const { retrievalIndexId, embeddingAdapter } = await loadOverflowFixture({ sourceSnapshotId: "docsnap_overflow_1" });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const queryVector = await embeddingAdapter.embedQuery("아무 질문");

  const results = await repository.search({ retrievalIndexId, queryVector, topK: 1 });
  assert.equal(results.length, 1, "exactly one occurrence must be returned when topK=1, even though 3 occurrences share the single ranked canonical text");
});

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] the SAME fixture with topK=2 returns EXACTLY 2 rows, stably ordered", async () => {
  const { retrievalIndexId, embeddingAdapter } = await loadOverflowFixture({ sourceSnapshotId: "docsnap_overflow_2" });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const queryVector = await embeddingAdapter.embedQuery("아무 질문");

  const results = await repository.search({ retrievalIndexId, queryVector, topK: 2 });
  assert.equal(results.length, 2);
  // All 3 occurrences share the identical canonical similarity_score, so
  // the stable tie-break (source_document_id ASC, chunk_id ASC) alone
  // determines which 2 of the 3 survive the final LIMIT.
  assert.deepEqual(results.map((r) => r.source_document_id), [...results.map((r) => r.source_document_id)].sort());
  assert.ok(results[0].source_document_id < results[1].source_document_id || (results[0].source_document_id === results[1].source_document_id && results[0].chunk_id < results[1].chunk_id));

  // Re-running yields byte-identical rows/order (determinism preserved by the fix).
  const again = await repository.search({ retrievalIndexId, queryVector, topK: 2 });
  assert.deepEqual(results.map((r) => r.chunk_id), again.map((r) => r.chunk_id));
});

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] a mixed fixture (2 canonicals, uneven occurrence counts) never returns more than topK rows total", async () => {
  const textA = "mixed fixture canonical A -- shared by two occurrences";
  const textB = "mixed fixture canonical B -- shared by two occurrences also";
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"d".repeat(24)}`, docId: "exchange_20250204000004", corpCode: "00000014", text: textA, ordinal: 0 }),
    fixtureChunk({ chunkId: `chunk_${"e".repeat(24)}`, docId: "exchange_20250205000005", corpCode: "00000015", text: textA, ordinal: 1 }),
    fixtureChunk({ chunkId: `chunk_${"f".repeat(24)}`, docId: "exchange_20250206000006", corpCode: "00000016", text: textB, ordinal: 2 }),
    fixtureChunk({ chunkId: `chunk_0${"1".repeat(23)}`, docId: "exchange_20250207000007", corpCode: "00000017", text: textB, ordinal: 3 }),
  ];
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const result = await loadExactTextDedupIndex({
    client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: OVERFLOW_EMBEDDING_CONFIG,
    releaseId: RELEASE_ID, sourceSnapshotId: "docsnap_overflow_mixed", chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256,
  });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const queryVector = await embeddingAdapter.embedQuery("아무 질문");

  for (const topK of [1, 2, 3, 4]) {
    // eslint-disable-next-line no-await-in-loop
    const results = await repository.search({ retrievalIndexId: result.retrievalIndexId, queryVector, topK });
    assert.ok(results.length <= topK, `topK=${topK}: got ${results.length} results, which must never exceed topK`);
    assert.equal(new Set(results.map((r) => r.chunk_id)).size, results.length, "no duplicate chunk_id within one response");
  }
});

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] corp_code filter narrows the candidate set, and the GLOBAL topK is still enforced afterward", async () => {
  const sharedText = "corp-filtered overflow fixture -- same company, 3 documents";
  const corp = "00000021";
  const chunks = [
    fixtureChunk({ chunkId: `chunk_${"2".repeat(23)}1`, docId: "exchange_20250211000001", corpCode: corp, text: sharedText, ordinal: 0 }),
    fixtureChunk({ chunkId: `chunk_${"2".repeat(23)}2`, docId: "exchange_20250212000002", corpCode: corp, text: sharedText, ordinal: 1 }),
    fixtureChunk({ chunkId: `chunk_${"2".repeat(23)}3`, docId: "exchange_20250213000003", corpCode: corp, text: sharedText, ordinal: 2 }),
    fixtureChunk({ chunkId: `chunk_${"2".repeat(23)}4`, docId: "exchange_20250214000004", corpCode: "00000099", text: sharedText, ordinal: 3 }),
  ];
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const result = await loadExactTextDedupIndex({
    client, chunkSourceFactory: () => chunks, embeddingAdapter, embeddingConfig: OVERFLOW_EMBEDDING_CONFIG,
    releaseId: RELEASE_ID, sourceSnapshotId: "docsnap_overflow_corpfilter", chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256,
  });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const queryVector = await embeddingAdapter.embedQuery("아무 질문");

  const results = await repository.search({ retrievalIndexId: result.retrievalIndexId, queryVector, topK: 2, corpCodes: [corp] });
  assert.equal(results.length, 2, "global topK=2 must apply even though 3 of corp's own occurrences pass the metadata filter");
  assert.ok(results.every((r) => r.corp_code === corp));
});

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] the fixed adapter's results pass the REAL, unmodified createRetrieverStore boundary (ok:true) -- the pre-fix overflow would have produced RETRIEVER_INVALID_RESULT here", async () => {
  const { retrievalIndexId } = await loadOverflowFixture({ sourceSnapshotId: "docsnap_overflow_retriever_boundary" });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const adapter = createDedupRetrieverAdapter({ dedupRepository: repository, embeddingAdapter, embeddingConfig: OVERFLOW_EMBEDDING_CONFIG, retrievalIndexId });

  const context = { corpus_snapshot_id: "corpus_test", chunking_config_id: "chunking_test", index_snapshot_id: "index_test" };
  const store = createRetrieverStore(adapter, context);
  const request = {
    schema_version: "0.1.0", query_id: "query_p521_overflow_check", question: "아무 질문",
    corpus_snapshot_id: context.corpus_snapshot_id, chunking_config_id: context.chunking_config_id, index_snapshot_id: context.index_snapshot_id,
    metadata_filters: { corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true },
    top_k: 1, retrieval_method: "DENSE",
  };
  const outcome = await store.resolve(request);
  assert.equal(outcome.ok, true, `expected ok:true, got: ${JSON.stringify(outcome)}`);
  assert.ok(outcome.result.results.length <= 1);
  assert.equal(outcome.result.results.length, 1);
  assert.equal(outcome.result.results[0].rank, 1);
});

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] a cosine index's adapter wiring succeeds and reports score_type=COSINE with the real similarity_score", async () => {
  const { retrievalIndexId } = await loadOverflowFixture({ sourceSnapshotId: "docsnap_p521_cosine_ok", distanceMetric: "cosine" });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const adapter = createDedupRetrieverAdapter({ dedupRepository: repository, embeddingAdapter, embeddingConfig: OVERFLOW_EMBEDDING_CONFIG, retrievalIndexId });
  const context = { corpus_snapshot_id: "corpus_test", chunking_config_id: "chunking_test", index_snapshot_id: "index_test" };
  const store = createRetrieverStore(adapter, context);
  const request = {
    schema_version: "0.1.0", query_id: "query_p521_cosine_ok", question: "아무 질문",
    corpus_snapshot_id: context.corpus_snapshot_id, chunking_config_id: context.chunking_config_id, index_snapshot_id: context.index_snapshot_id,
    metadata_filters: { corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true },
    top_k: 1, retrieval_method: "DENSE",
  };
  const outcome = await store.resolve(request);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.results[0].score_type, "COSINE");
  assert.equal(outcome.result.results[0].component_scores.dense, outcome.result.results[0].score);
  assert.equal(outcome.result.results[0].component_scores.bm25, null);
});

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] an l2 index is REJECTED fail-closed by the adapter's wiring -- never mislabeled as COSINE", async () => {
  const { retrievalIndexId } = await loadOverflowFixture({ sourceSnapshotId: "docsnap_p521_l2_reject", distanceMetric: "l2" });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const adapter = createDedupRetrieverAdapter({ dedupRepository: repository, embeddingAdapter, embeddingConfig: OVERFLOW_EMBEDDING_CONFIG, retrievalIndexId });

  await assert.rejects(
    () => adapter.retrieve({
      schema_version: "0.1.0", query_id: "q", question: "아무 질문",
      corpus_snapshot_id: "x", chunking_config_id: "y", index_snapshot_id: "z",
      metadata_filters: {}, top_k: 1, retrieval_method: "DENSE",
    }),
    (error) => {
      assert.match(error.message, /distance_metric mismatch/i);
      assert.match(error.message, /expected "cosine"/i);
      assert.match(error.message, /found "l2"/i);
      // The error must never leak the query vector or any embedding output.
      assert.doesNotMatch(error.message, /\[-?\d+\.\d+,/);
      return true;
    },
  );
});

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] an inner_product index is REJECTED fail-closed by the adapter's wiring", async () => {
  const { retrievalIndexId } = await loadOverflowFixture({ sourceSnapshotId: "docsnap_p521_ip_reject", distanceMetric: "inner_product" });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  const adapter = createDedupRetrieverAdapter({ dedupRepository: repository, embeddingAdapter, embeddingConfig: OVERFLOW_EMBEDDING_CONFIG, retrievalIndexId });

  await assert.rejects(
    () => adapter.retrieve({
      schema_version: "0.1.0", query_id: "q", question: "아무 질문",
      corpus_snapshot_id: "x", chunking_config_id: "y", index_snapshot_id: "z",
      metadata_filters: {}, top_k: 1, retrieval_method: "DENSE",
    }),
    /distance_metric mismatch.*expected "cosine".*found "inner_product"/is,
  );
});

test("real PostgreSQL 16 + pgvector: [P5.2.1 regression] a caller cannot bypass the cosine requirement by supplying its own expectedPins.distance_metric", async () => {
  const { retrievalIndexId } = await loadOverflowFixture({ sourceSnapshotId: "docsnap_p521_l2_bypass_attempt", distanceMetric: "l2" });
  const repository = createPostgresDedupRetrievalRepository({ client });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: 8 });
  // The caller explicitly (and incorrectly) asserts distance_metric: "l2" is
  // acceptable via expectedPins -- the adapter must still force "cosine"
  // and reject, never trusting this caller-supplied claim.
  const adapter = createDedupRetrieverAdapter({ dedupRepository: repository, embeddingAdapter, embeddingConfig: OVERFLOW_EMBEDDING_CONFIG, retrievalIndexId, expectedPins: { distance_metric: "l2" } });

  await assert.rejects(
    () => adapter.retrieve({
      schema_version: "0.1.0", query_id: "q", question: "아무 질문",
      corpus_snapshot_id: "x", chunking_config_id: "y", index_snapshot_id: "z",
      metadata_filters: {}, top_k: 1, retrieval_method: "DENSE",
    }),
    /distance_metric mismatch/i,
  );
});
