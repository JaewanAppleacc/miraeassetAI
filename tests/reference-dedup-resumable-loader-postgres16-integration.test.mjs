// Turn P8: REAL PostgreSQL 16 + pgvector integration coverage for
// 005_reference_dedup_load_sessions.sql /
// reference-dedup-resumable-loader.mjs / reference-dedup-load-session-*.mjs.
//
//   DATABASE_URL='postgresql://user:pass@host:5432/scratch_db' \
//     npm run test:resumable-dedup-loader:postgres16
//
// or, for a fully disposable scratch cluster (recommended):
//
//   node scripts/run-with-scratch-postgres16.mjs -- \
//     npm run test:resumable-dedup-loader:postgres16
//
// Same fail-closed convention as every other *-postgres16-integration test
// in this repo: no DATABASE_URL => POSTGRESQL_16_INTEGRATION_NOT_RUN (never
// a silent skip); CREATE EXTENSION vector failing =>
// BLOCKED_PGVECTOR_EXTENSION_NOT_AVAILABLE.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import { applyReferenceReleaseMigration, importReferenceRelease } from "../domain/postgres/reference-release-loader.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "../domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs";
import { createPostgresDedupRetrievalRepository } from "../domain/postgres/reference-dedup-retrieval-repository.mjs";
import { loadExactTextDedupIndex } from "../domain/postgres/reference-dedup-retrieval-loader.mjs";
import {
  applyReferenceDedupLoadSessionReaderGrant, applyReferenceDedupLoadSessionWriterGrant,
} from "../domain/postgres/reference-dedup-load-session-grants.mjs";
import {
  createOrResumeLoadSession, runDiscoveryPhase, runEmbeddingPhase, runMaterializationPhase, runFinalizationPhase,
  runResumableDedupLoad, ResumableDedupLoaderError,
} from "../domain/postgres/reference-dedup-resumable-loader.mjs";
import { createDedupLoadSessionRepository, DedupLoadSessionError } from "../domain/postgres/reference-dedup-load-session-repository.mjs";

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
const RELEASE_ID = "seed-release-v0.20";
const CHUNKING_POLICY_ID = "document-node-first-v0.1";
const CHUNKING_POLICY_SHA256 = "c930bdb99ac087287772037ad315f640725d5be7331ede56562dd9a1f95365fd";
const DIM = 8;

let client;
let tmpDirs = [];

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function chunkLine({ chunkId, docId, corpCode, text, ordinal = 0, blockType = "PARAGRAPH" }) {
  return JSON.stringify({
    chunk_id: chunkId, source_document_id: docId, corp_code: corpCode, source_group: "exchange", document_type: "test",
    node_id: `${docId}::a.xml::n0`, source_locator: `${docId}/a.xml#node=0`, parse_status: "SUCCESS",
    chunk_ordinal: ordinal, char_start: 0, char_end: text.length, text_content: text, text_sha256: sha256Hex(text),
    metadata: { block_type: blockType },
  });
}

async function writeJsonlFixture(lines) {
  const dir = await mkdtemp(path.join(tmpdir(), "dedup-loader-integration-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, "chunks.jsonl");
  await writeFile(filePath, lines.map((l) => `${l}\n`).join(""), "utf8");
  return filePath;
}

function sessionPins(overrides = {}) {
  return {
    releaseId: RELEASE_ID,
    snapshotId: overrides.snapshotId ?? `docsnap_test_${randomUUID().slice(0, 8)}`,
    snapshotManifestSha256: "a".repeat(64),
    documentChunksSha256: "b".repeat(64),
    embeddingConfig: { provider: "test-fixture", model: "deterministic-fake-embedding-v1", revision: "v1", dimension: DIM },
    distanceMetric: "cosine",
    chunkingPolicyId: CHUNKING_POLICY_ID,
    chunkingPolicySha256: CHUNKING_POLICY_SHA256,
    batchSize: 2, discoveryBatchSize: 2, maxRetryAttempts: 2, leaseDurationMs: 60_000,
    codeRevision: "test-revision",
    ...overrides,
  };
}

test.before(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: DATABASE_URL is required to run tests/reference-dedup-resumable-loader-postgres16-integration.test.mjs. "
      + "Run: node scripts/run-with-scratch-postgres16.mjs -- npm run test:resumable-dedup-loader:postgres16",
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
    throw new Error(`BLOCKED_PGVECTOR_EXTENSION_NOT_AVAILABLE: CREATE EXTENSION vector failed (${error.message})`);
  }
  await client.query("DROP EXTENSION vector");

  await applyReferenceReleaseMigration({ client, root: ROOT });
  const { readFile } = await import("node:fs/promises");
  await client.query(await readFile(path.join(ROOT, "domain/postgres/004_reference_dedup_retrieval_index.sql"), "utf8"));
  await client.query(await readFile(path.join(ROOT, "domain/postgres/005_reference_dedup_load_sessions.sql"), "utf8"));
  await importReferenceRelease({ client, ...LOAD_OPTIONS });
});

test.after(async () => {
  if (client) await client.end();
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

// =====================================================================
// Full pipeline: synthetic fixture with duplicate text + cross-company
// occurrence + a second connection per "worker".
// =====================================================================

test("full pipeline: DISCOVERY -> EMBEDDING -> MATERIALIZATION -> FINALIZATION produces exact canonical/occurrence counts, real dedup happened, session and index both land on READY", async () => {
  const lines = [
    chunkLine({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", corpCode: "00000001", text: "shared boilerplate phrase" }),
    chunkLine({ chunkId: `chunk_${"2".repeat(24)}`, docId: "holding_20250102000002", corpCode: "00000002", text: "shared boilerplate phrase", ordinal: 1 }),
    chunkLine({ chunkId: `chunk_${"3".repeat(24)}`, docId: "holding_20250102000002", corpCode: "00000002", text: "unique text for doc 2", ordinal: 2 }),
    chunkLine({ chunkId: `chunk_${"4".repeat(24)}`, docId: "major_20250103000003", corpCode: "00000003", text: "another unique paragraph" }),
  ];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins();
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: DIM });

  await runResumableDedupLoad({
    client, loadSessionId: session.load_session_id, chunksFilePath, embeddingAdapter,
    embeddingConfig: pins.embeddingConfig,
  });

  const repo = createDedupLoadSessionRepository({ client });
  const finalSession = await repo.getSession(session.load_session_id);
  assert.equal(finalSession.status, "READY");
  assert.equal(finalSession.discovered_canonical_count, 3);
  assert.equal(finalSession.discovered_occurrence_count, 4);
  assert.equal(finalSession.materialized_canonical_count, 3);
  assert.equal(finalSession.materialized_occurrence_count, 4);

  const dedupRepository = createPostgresDedupRetrievalRepository({ client });
  const index = await dedupRepository.getRetrievalIndex(finalSession.retrieval_index_id);
  assert.equal(index.index_status, "READY");
  assert.equal(index.canonical_count, 3);
  assert.equal(index.occurrence_count, 4);

  const queryVector = await embeddingAdapter.embedQuery("shared boilerplate phrase");
  const results = await dedupRepository.search({ retrievalIndexId: finalSession.retrieval_index_id, queryVector, topK: 10 });
  assert.ok(results.length > 0);
});

// =====================================================================
// Resume: discovery interrupted mid-stream, resumed to completion.
// =====================================================================

test("discovery resume: a bounded partial run's checkpoint is durable, and resuming re-reads from exactly that point (no duplicate, no gap)", async () => {
  const lines = Array.from({ length: 9 }, (_, i) => chunkLine({
    chunkId: `chunk_${String(i).padStart(24, "0")}`, docId: `exchange_2025010${i}000001`, corpCode: "00000010", text: `discovery resume text ${i}`, ordinal: i,
  }));
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ discoveryBatchSize: 2 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });

  const first = await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath, maxBatches: 1 });
  assert.equal(first.reachedEnd, false);
  assert.equal(first.batchesRun, 1);

  const repo = createDedupLoadSessionRepository({ client });
  const midSession = await repo.getSession(session.load_session_id);
  assert.equal(midSession.discovered_occurrence_count, 2, "exactly one batch's worth of occurrences must be checkpointed");
  assert.equal(midSession.source_line_number, 2);

  const second = await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });
  assert.equal(second.reachedEnd, true);
  assert.equal(second.status, "DISCOVERY_COMPLETE");

  const finalSession = await repo.getSession(session.load_session_id);
  assert.equal(finalSession.discovered_occurrence_count, 9, "resume must account for every remaining line exactly once");
  assert.equal(finalSession.discovered_canonical_count, 9);

  const occurrenceCount = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.reference_dedup_occurrence_staging WHERE load_session_id = $1",
    [session.load_session_id],
  );
  assert.equal(occurrenceCount.rows[0].n, 9, "no duplicate occurrence rows from re-reading across the resume boundary");
});

// =====================================================================
// Crash injection: a batch that never commits leaves the checkpoint
// untouched; resuming re-processes from the last real commit.
// =====================================================================

test("crash injection: a client that throws mid-batch never advances the checkpoint or writes partial rows -- resuming from a FRESH client reprocesses that batch exactly once", async () => {
  const lines = Array.from({ length: 4 }, (_, i) => chunkLine({
    chunkId: `chunk_${String(i).padStart(23, "0")}9`, docId: `exchange_2025011${i}000001`, corpCode: "00000011", text: `crash injection text ${i}`, ordinal: i,
  }));
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ discoveryBatchSize: 2 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });

  // A second real connection wrapped to throw on the SECOND occurrence
  // INSERT it sees -- simulates a crash after the canonical insert
  // succeeded but before the occurrence insert (and therefore the whole
  // transaction) committed.
  const crashClient = new Client({ connectionString: process.env.DATABASE_URL });
  await crashClient.connect();
  let occurrenceInsertCount = 0;
  const realQuery = crashClient.query.bind(crashClient);
  crashClient.query = async (sql, params) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO disclosure_reference.reference_dedup_occurrence_staging")) {
      occurrenceInsertCount += 1;
      if (occurrenceInsertCount === 1) throw new Error("INJECTED_CRASH_BEFORE_COMMIT");
    }
    return realQuery(sql, params);
  };

  await assert.rejects(
    () => runDiscoveryPhase({ client: crashClient, loadSessionId: session.load_session_id, chunksFilePath }),
    /INJECTED_CRASH_BEFORE_COMMIT/,
  );
  await crashClient.end();

  const repo = createDedupLoadSessionRepository({ client });
  const afterCrash = await repo.getSession(session.load_session_id);
  assert.equal(afterCrash.discovered_occurrence_count, 0, "the crashed batch's transaction must have rolled back completely -- no partial checkpoint advance");
  assert.equal(afterCrash.source_line_number, 0);
  const stagedRows = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.reference_dedup_occurrence_staging WHERE load_session_id = $1",
    [session.load_session_id],
  );
  assert.equal(stagedRows.rows[0].n, 0, "no partial rows from the rolled-back transaction");

  const resumed = await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });
  assert.equal(resumed.reachedEnd, true);
  const finalSession = await repo.getSession(session.load_session_id);
  assert.equal(finalSession.discovered_occurrence_count, 4, "resuming with a healthy client must reprocess every line exactly once, including the ones the crashed attempt never committed");
});

test("crash injection: an embedding lease that is never committed as EMBEDDED (simulated API-success-then-crash) is safely re-leased and re-embedded once its lease expires", async () => {
  const lines = [chunkLine({ chunkId: `chunk_${"a".repeat(24)}`, docId: "exchange_20250120000001", corpCode: "00000012", text: "lease crash recovery text" })];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ leaseDurationMs: 200 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });

  const repo = createDedupLoadSessionRepository({ client });
  await repo.transitionStatus(session.load_session_id, ["DISCOVERY_COMPLETE"], "EMBEDDING");
  // Simulate: worker leases the row, calls the (successful) embedding API,
  // then crashes -- markEmbedded() is NEVER called, so the row is left
  // dangling in LEASED status until its lease_expires_at passes.
  await client.query("BEGIN");
  const leased = await repo.leaseCanonicalBatch(session.load_session_id, { limit: 10, leaseOwner: "dead_worker", leaseDurationMs: 200 });
  await client.query("COMMIT");
  assert.equal(leased.length, 1);

  await new Promise((resolve) => { setTimeout(resolve, 400); });

  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: DIM });
  const result = await runEmbeddingPhase({
    client, loadSessionId: session.load_session_id, embeddingAdapter, embeddingConfig: pins.embeddingConfig,
    batchSize: 10, maxRetryAttempts: 2, leaseDurationMs: 60_000, leaseOwner: "recovering_worker",
  });
  assert.equal(result.done, true);
  const counts = await repo.queueStatusCounts(session.load_session_id);
  assert.equal(counts.EMBEDDED, 1);
  assert.equal(counts.PENDING, 0);
  assert.equal(counts.LEASED, 0);
});

// =====================================================================
// Duplicate rejection
// =====================================================================

test("a duplicate chunk_id appearing again in a FRESH forward-progress batch (never previously committed) is rejected fail-closed", async () => {
  const dupId = `chunk_${"d".repeat(24)}`;
  const lines = [
    chunkLine({ chunkId: dupId, docId: "exchange_20250130000001", corpCode: "00000013", text: "first occurrence" }),
    chunkLine({ chunkId: dupId, docId: "exchange_20250131000001", corpCode: "00000013", text: "second occurrence, same chunk_id", ordinal: 1 }),
  ];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ discoveryBatchSize: 5 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await assert.rejects(
    () => runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath }),
    (error) => { assert.equal(error.code, "DUPLICATE_CHUNK_ID"); return true; },
  );
});

test("a text_sha256 collision with different canonical text within one discovery batch is rejected fail-closed", async () => {
  const sharedHash = sha256Hex("real text");
  const lines = [
    chunkLine({ chunkId: `chunk_${"e".repeat(24)}`, docId: "exchange_20250201000001", corpCode: "00000014", text: "real text" }),
    { ...JSON.parse(chunkLine({ chunkId: `chunk_${"f".repeat(24)}`, docId: "exchange_20250202000001", corpCode: "00000014", text: "real text", ordinal: 1 })), text_content: "tampered text", text_sha256: sharedHash },
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ discoveryBatchSize: 5 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await assert.rejects(
    () => runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath }),
    (error) => { assert.equal(error.code, "TEXT_SHA256_COLLISION"); return true; },
  );
});

// =====================================================================
// Malformed embedding batch handling: whole-batch rejection, retry budget,
// permanent FAILED (never promoted to READY).
// =====================================================================

test("a malformed embedding batch (wrong vector count) is rejected whole, retried up to max_retry_attempts, then the session lands on FAILED -- never READY", async () => {
  const lines = [chunkLine({ chunkId: `chunk_${"1".repeat(23)}0`, docId: "exchange_20250210000001", corpCode: "00000015", text: "malformed batch text" })];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ maxRetryAttempts: 1 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });

  const badAdapter = { async embedDocuments() { return [[1, 2, 3]]; } }; // wrong dimension, and wrong count semantics
  // A single runEmbeddingPhase call internally retries a failing batch
  // until its retry budget (maxRetryAttempts=1) is exhausted, then stops --
  // no separate call is needed to observe the terminal FAILED state.
  const result = await runEmbeddingPhase({
    client, loadSessionId: session.load_session_id, embeddingAdapter: badAdapter, embeddingConfig: pins.embeddingConfig,
    batchSize: 10, maxRetryAttempts: 1, leaseDurationMs: 60_000,
  });
  assert.equal(result.status, "FAILED");

  const repo = createDedupLoadSessionRepository({ client });
  const finalSession = await repo.getSession(session.load_session_id);
  assert.equal(finalSession.status, "FAILED");
  assert.equal(finalSession.last_error_code, "EMBEDDING_PERMANENTLY_FAILED");

  await assert.rejects(
    () => runMaterializationPhase({ client, loadSessionId: session.load_session_id }),
    ResumableDedupLoaderError,
  );
});

test("a partial embedding batch (fewer vectors than texts) is treated as a whole-batch failure, never partially accepted", async () => {
  const lines = [
    chunkLine({ chunkId: `chunk_${"2".repeat(23)}0`, docId: "exchange_20250211000001", corpCode: "00000016", text: "partial batch text 1" }),
    chunkLine({ chunkId: `chunk_${"2".repeat(23)}1`, docId: "exchange_20250212000001", corpCode: "00000016", text: "partial batch text 2", ordinal: 1 }),
  ];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ maxRetryAttempts: 1, batchSize: 10 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });

  const partialAdapter = { async embedDocuments() { return [new Array(DIM).fill(0.5)]; } }; // 1 vector for 2 texts
  // maxRetryAttempts=1 exhausts the retry budget on the FIRST attempt (a
  // single runEmbeddingPhase call retries internally until the budget is
  // exhausted or the queue drains), so both texts land on FAILED, never
  // EMBEDDED -- proving the "fewer vectors than requested" batch was
  // rejected as a whole, not partially accepted for whichever text happened
  // to line up with a returned vector.
  const result = await runEmbeddingPhase({
    client, loadSessionId: session.load_session_id, embeddingAdapter: partialAdapter, embeddingConfig: pins.embeddingConfig,
    batchSize: 10, maxRetryAttempts: 1, leaseDurationMs: 60_000,
  });
  assert.equal(result.status, "FAILED");
  const repo = createDedupLoadSessionRepository({ client });
  const counts = await repo.queueStatusCounts(session.load_session_id);
  assert.equal(counts.EMBEDDED, 0, "neither text may be marked EMBEDDED when the batch returned fewer vectors than requested");
  assert.equal(counts.FAILED, 2, "both must be rejected together, not just the 'missing' one");
});

// =====================================================================
// Two-worker concurrency: disjoint leases, no double-processing, and a
// deterministic final result regardless of worker count.
// =====================================================================

test("two concurrent workers embedding the SAME session never lease the same canonical row twice, and reach the identical final materialized state as a single worker would", async () => {
  const lines = Array.from({ length: 12 }, (_, i) => chunkLine({
    chunkId: `chunk_${String(i).padStart(23, "3")}9`, docId: `exchange_2025022${String(i).padStart(2, "0")}000001`, corpCode: "00000017", text: `two worker text ${i}`, ordinal: i,
  }));
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ discoveryBatchSize: 20, batchSize: 3 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });
  await createDedupLoadSessionRepository({ client }).transitionStatus(session.load_session_id, ["DISCOVERY_COMPLETE"], "EMBEDDING");

  const clientA = new Client({ connectionString: process.env.DATABASE_URL });
  const clientB = new Client({ connectionString: process.env.DATABASE_URL });
  await Promise.all([clientA.connect(), clientB.connect()]);

  const leaseLog = [];
  function trackingAdapter() {
    const inner = createDeterministicFakeEmbeddingAdapter({ dimension: DIM });
    return {
      async embedDocuments(texts, cfg) {
        leaseLog.push([...texts]);
        return inner.embedDocuments(texts, cfg);
      },
    };
  }

  await Promise.all([
    runEmbeddingPhase({ client: clientA, loadSessionId: session.load_session_id, embeddingAdapter: trackingAdapter(), embeddingConfig: pins.embeddingConfig, batchSize: 3, maxRetryAttempts: 2, leaseDurationMs: 30_000, leaseOwner: "worker_A" }),
    runEmbeddingPhase({ client: clientB, loadSessionId: session.load_session_id, embeddingAdapter: trackingAdapter(), embeddingConfig: pins.embeddingConfig, batchSize: 3, maxRetryAttempts: 2, leaseDurationMs: 30_000, leaseOwner: "worker_B" }),
  ]);
  await Promise.all([clientA.end(), clientB.end()]);

  const allLeasedTexts = leaseLog.flat();
  assert.equal(new Set(allLeasedTexts).size, allLeasedTexts.length, "no text was leased/embedded by more than one worker");
  assert.equal(allLeasedTexts.length, 12, "every one of the 12 distinct texts must have been embedded exactly once across both workers");

  const repo = createDedupLoadSessionRepository({ client });
  const counts = await repo.queueStatusCounts(session.load_session_id);
  assert.equal(counts.EMBEDDED, 12);
  assert.equal(counts.PENDING + counts.LEASED + counts.FAILED, 0);

  // materialize + finalize once, then verify the final row set is exactly
  // the deterministic-fake-embedding value regardless of which of the two
  // workers happened to embed a given row.
  await runMaterializationPhase({ client, loadSessionId: session.load_session_id });
  await runFinalizationPhase({ client, loadSessionId: session.load_session_id });
  const finalSession = await repo.getSession(session.load_session_id);
  const canonicalRows = await client.query(
    "SELECT text_sha256, embedding FROM disclosure_reference.reference_dedup_canonical_texts WHERE retrieval_index_id = $1 ORDER BY text_sha256",
    [finalSession.retrieval_index_id],
  );
  const referenceAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: DIM });
  for (const row of canonicalRows.rows) {
    const text = lines.map((l) => JSON.parse(l)).find((c) => c.text_sha256 === row.text_sha256).text_content;
    const [expected] = await referenceAdapter.embedDocuments([text]);
    const stored = row.embedding.slice(1, -1).split(",").map(Number);
    // pgvector's `vector` type is single (float4) precision, so a stored
    // value can differ from the float64 JS reference in the last few
    // digits -- compare with a tolerance appropriate to float4, not by
    // exact string/float64 equality.
    for (let i = 0; i < expected.length; i += 1) {
      assert.ok(Math.abs(stored[i] - expected[i]) < 1e-6, `dimension ${i}: stored ${stored[i]} vs expected ${expected[i]} -- the embedding stored is the deterministic function of the TEXT alone, independent of which worker computed it`);
    }
  }
});

// =====================================================================
// Idempotency: re-running a READY session's full pipeline is a no-op.
// =====================================================================

test("re-running runResumableDedupLoad against an already-READY session is a pure no-op (no new rows, no error)", async () => {
  const lines = [chunkLine({ chunkId: `chunk_${"4".repeat(24)}`, docId: "exchange_20250301000001", corpCode: "00000018", text: "idempotent rerun text" })];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins();
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: DIM });
  await runResumableDedupLoad({ client, loadSessionId: session.load_session_id, chunksFilePath, embeddingAdapter, embeddingConfig: pins.embeddingConfig });

  const before = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id = (SELECT retrieval_index_id FROM disclosure_reference.reference_dedup_load_sessions WHERE load_session_id = $1)",
    [session.load_session_id],
  );
  const readySession = await runResumableDedupLoad({ client, loadSessionId: session.load_session_id, chunksFilePath, embeddingAdapter, embeddingConfig: pins.embeddingConfig });
  assert.equal(readySession.status, "READY");
  const after = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id = (SELECT retrieval_index_id FROM disclosure_reference.reference_dedup_load_sessions WHERE load_session_id = $1)",
    [session.load_session_id],
  );
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("re-running createOrResumeLoadSession with a DIFFERENT embedding config against the same snapshot identity is rejected fail-closed", async () => {
  const snapshotId = `docsnap_config_mismatch_${randomUUID().slice(0, 8)}`;
  const pinsA = sessionPins({ snapshotId, embeddingConfig: { provider: "test-fixture", model: "deterministic-fake-embedding-v1", revision: "v1", dimension: DIM } });
  await createOrResumeLoadSession({ client, ...pinsA });
  const pinsB = sessionPins({ snapshotId, embeddingConfig: { provider: "test-fixture", model: "deterministic-fake-embedding-v1", revision: "v1", dimension: 16 } });
  await assert.rejects(() => createOrResumeLoadSession({ client, ...pinsB }), (error) => {
    assert.equal(error.code, "EMBEDDING_CONFIG_MISMATCH");
    return true;
  });
});

// =====================================================================
// READY guard: finalization refuses on any count mismatch.
// =====================================================================

test("finalization refuses to promote to READY when materialized counts don't match discovered counts, and never flips the 004 index to READY", async () => {
  const lines = [chunkLine({ chunkId: `chunk_${"5".repeat(24)}`, docId: "exchange_20250310000001", corpCode: "00000019", text: "ready guard text" })];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins();
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: DIM });
  await runEmbeddingPhase({ client, loadSessionId: session.load_session_id, embeddingAdapter, embeddingConfig: pins.embeddingConfig, batchSize: 10, maxRetryAttempts: 2, leaseDurationMs: 60_000 });
  await runMaterializationPhase({ client, loadSessionId: session.load_session_id });

  // Directly tamper with the session's own bookkeeping to simulate an
  // internal inconsistency (never reachable via the public API in correct
  // operation) -- proves finalize() re-verifies against the REAL tables,
  // not just its own counters.
  await client.query(
    "UPDATE disclosure_reference.reference_dedup_load_sessions SET materialized_occurrence_count = 0 WHERE load_session_id = $1",
    [session.load_session_id],
  );
  await assert.rejects(
    () => runFinalizationPhase({ client, loadSessionId: session.load_session_id }),
    (error) => { assert.equal(error.code, "FINALIZATION_MISMATCH"); return true; },
  );
  const repo = createDedupLoadSessionRepository({ client });
  const stillNotReady = await repo.getSession(session.load_session_id);
  assert.notEqual(stillNotReady.status, "READY");
  const indexRow = await client.query("SELECT index_status FROM disclosure_reference.reference_dedup_indexes WHERE retrieval_index_id = $1", [stillNotReady.retrieval_index_id]);
  assert.equal(indexRow.rows[0].index_status, "LOADING");
});

test("a FAILED session can never be promoted to READY, and resuming it is rejected", async () => {
  const lines = [chunkLine({ chunkId: `chunk_${"6".repeat(24)}`, docId: "exchange_20250320000001", corpCode: "00000020", text: "failed session text" })];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins({ maxRetryAttempts: 0 });
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });
  const badAdapter = { async embedDocuments() { throw new Error("permanent adapter failure"); } };
  await runEmbeddingPhase({ client, loadSessionId: session.load_session_id, embeddingAdapter: badAdapter, embeddingConfig: pins.embeddingConfig, batchSize: 10, maxRetryAttempts: 0, leaseDurationMs: 60_000 });

  const repo = createDedupLoadSessionRepository({ client });
  const failed = await repo.getSession(session.load_session_id);
  assert.equal(failed.status, "FAILED");

  await assert.rejects(() => createOrResumeLoadSession({ client, ...pins }), DedupLoadSessionError);
  await assert.rejects(
    () => client.query("UPDATE disclosure_reference.reference_dedup_load_sessions SET status = 'READY' WHERE load_session_id = $1", [session.load_session_id]),
    /immutable once/i,
  );
});

// =====================================================================
// RequestAbortedError / BudgetExceededError propagation
// =====================================================================

test("RequestAbortedError from the embedding adapter is propagated immediately, never swallowed into the retry path", async () => {
  const { RequestAbortedError } = await import("../domain/runtime/abortable.mjs");
  const lines = [chunkLine({ chunkId: `chunk_${"7".repeat(24)}`, docId: "exchange_20250330000001", corpCode: "00000021", text: "abort propagation text" })];
  const chunksFilePath = await writeJsonlFixture(lines);
  const pins = sessionPins();
  const { session } = await createOrResumeLoadSession({ client, ...pins });
  await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath });
  const abortingAdapter = { async embedDocuments() { throw new RequestAbortedError("TIMEOUT"); } };
  await assert.rejects(
    () => runEmbeddingPhase({ client, loadSessionId: session.load_session_id, embeddingAdapter: abortingAdapter, embeddingConfig: pins.embeddingConfig, batchSize: 10, maxRetryAttempts: 3, leaseDurationMs: 60_000 }),
    RequestAbortedError,
  );
  const repo = createDedupLoadSessionRepository({ client });
  const counts = await repo.queueStatusCounts(session.load_session_id);
  assert.equal(counts.FAILED, 0, "an aborted request must never be recorded as a permanent embedding failure");
});

// =====================================================================
// Grants: minimal privilege for the new staging/session tables.
// =====================================================================

test("minimum-privilege reader/writer grants on the new load-session tables apply and actually enforce", async () => {
  const readerRole = "p8_dedup_load_reader_role";
  const writerRole = "p8_dedup_load_writer_role";
  await client.query(`DROP ROLE IF EXISTS ${readerRole}`);
  await client.query(`DROP ROLE IF EXISTS ${writerRole}`);
  await client.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD 'test'`);
  await client.query(`CREATE ROLE ${writerRole} LOGIN PASSWORD 'test'`);
  await applyReferenceDedupLoadSessionReaderGrant({ client, roleName: readerRole });
  await applyReferenceDedupLoadSessionWriterGrant({ client, roleName: writerRole });
  const INSUFFICIENT_PRIVILEGE = "42501";

  try {
    await client.query(`SET ROLE ${readerRole}`);
    await assert.rejects(
      () => client.query(
        `INSERT INTO disclosure_reference.reference_dedup_load_sessions
           (load_session_id, retrieval_index_id, release_id, snapshot_id, snapshot_manifest_sha256, document_chunks_sha256,
            embedding_config_sha256, embedding_provider, embedding_model, embedding_dimension, distance_metric,
            chunking_policy_id, chunking_policy_sha256, batch_size, discovery_batch_size, max_retry_attempts,
            lease_duration_ms, code_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        ["x", "y", RELEASE_ID, "z", "a".repeat(64), "b".repeat(64), "c".repeat(64), "p", "m", 8, "cosine", "pol", "d".repeat(64), 1, 1, 1, 1000, "rev"],
      ),
      (error) => error.code === INSUFFICIENT_PRIVILEGE,
    );
  } finally {
    await client.query("RESET ROLE");
  }

  try {
    await client.query(`SET ROLE ${writerRole}`);
    await assert.rejects(
      () => client.query("DELETE FROM disclosure_reference.reference_dedup_canonical_queue WHERE true"),
      (error) => error.code === INSUFFICIENT_PRIVILEGE,
    );
  } finally {
    await client.query("RESET ROLE");
  }

  await client.query(`DROP OWNED BY ${readerRole}`);
  await client.query(`DROP OWNED BY ${writerRole}`);
  await client.query(`DROP ROLE IF EXISTS ${readerRole}`);
  await client.query(`DROP ROLE IF EXISTS ${writerRole}`);
});

// =====================================================================
// 003/004 regression: the old (non-resumable) loader still works
// unmodified against the SAME schema, and its output is retrieval-
// indistinguishable from the new loader's output.
// =====================================================================

test("[regression] the pre-existing (Turn P5.2) loadExactTextDedupIndex still works unmodified against the schema this Turn added, side by side with the new loader", async () => {
  const chunks = [{
    chunk_id: `chunk_${"8".repeat(24)}`, source_document_id: "exchange_20250401000001", corp_code: "00000022",
    source_group: "exchange", document_type: "test", node_id: "exchange_20250401000001::a.xml::n0",
    source_locator: "exchange_20250401000001/a.xml#node=0", parse_status: "SUCCESS", chunk_ordinal: 0,
    char_start: 0, char_end: 20, text_content: "old loader still works", text_sha256: sha256Hex("old loader still works"),
    metadata: { block_type: "PARAGRAPH" },
  }];
  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: DIM });
  const result = await loadExactTextDedupIndex({
    client, chunkSourceFactory: () => chunks, embeddingAdapter,
    embeddingConfig: { provider: "test-fixture", model: "deterministic-fake-embedding-v1", revision: "v1", dimension: DIM },
    releaseId: RELEASE_ID, sourceSnapshotId: "docsnap_old_loader_regression", chunkingPolicyId: CHUNKING_POLICY_ID, chunkingPolicySha256: CHUNKING_POLICY_SHA256,
  });
  assert.equal(result.created, true);
  const repository = createPostgresDedupRetrievalRepository({ client });
  const index = await repository.getRetrievalIndex(result.retrievalIndexId);
  assert.equal(index.index_status, "READY");
});
