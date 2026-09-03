// Turn AC-IMPL, section J: REAL PostgreSQL 16 (+pgvector) + REAL local
// KURE-v1 embedding server re-validation of the existing 1,144-chunk
// validation shard (load_session_id computed from
// P11F0_CORPUS_SNAPSHOT_ID, default corpus_04750795e1a2d5c3_shard_val_750
// -- the same shard scripts/p11f0-shard-integration-smoke.mjs already
// validated). Builds/loads the SAME persisted BM25 index both arms share,
// then exercises arm A (FIXED+FULL_DENSE) and arm C (FIXED+DENSE_OFF)
// end-to-end against real data.
//
// Excluded from `npm run test:domain`/`verify:contracts` (same discipline
// as tests/p11f0-fixed-kure-resumable-loader-postgres16-integration.test.mjs).
// Fails CLOSED (never a silent skip) if DATABASE_URL or
// P11F0_KURE_SERVER_URL is not set. Zero DEV_TUNE/DEV_CHECK/HOLDOUT/Gold
// access -- the probe question is the shard's own already-materialized
// chunk text, never Gold. Invoke explicitly:
//
//   DATABASE_URL='postgresql://user@host:port/scratch_db' \
//   P11F0_KURE_SERVER_URL='http://127.0.0.1:PORT/v1/embeddings' \
//     node --test tests/four-arm-fixed-ac-postgres16-integration.test.mjs
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { createPostgresVectorRetrievalRepository } from "../domain/postgres/reference-vector-retrieval-repository.mjs";
import { buildFixedKureBm25Index, persistFixedKureBm25Index, loadFixedKureBm25Index } from "../domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs";
import { computeFixedKureLoadSessionId, computeFixedKureRetrievalIndexId } from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";
import { createArmRetrieverAdapter, KURE_PIN } from "../domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs";

const { Client } = pg;
const BM25_CACHE_DIR = path.join(os.homedir(), "Library", "Caches", "ai-festival-p11f0-bm25-index");
const CORPUS_SNAPSHOT_ID = process.env.P11F0_CORPUS_SNAPSHOT_ID ?? "corpus_04750795e1a2d5c3_shard_val_750";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`FOUR_ARM_AC_POSTGRESQL_16_INTEGRATION_NOT_RUN: ${name} is required to run tests/four-arm-fixed-ac-postgres16-integration.test.mjs`);
  }
  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
const embeddingServerUrl = requireEnv("P11F0_KURE_SERVER_URL");

let client;
let bm25Index;
let loadSessionId;
let retrievalIndexId;

test.before(async () => {
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  loadSessionId = computeFixedKureLoadSessionId({
    releaseId: "seed-release-v0.20", corpusSnapshotId: CORPUS_SNAPSHOT_ID,
    embeddingProvider: "nlpai-lab", embeddingModel: "KURE-v1", embeddingRevision: KURE_PIN.revision,
    chunkingPolicyId: "fixed-token-512-o64.v0.1.0",
  });
  retrievalIndexId = computeFixedKureRetrievalIndexId({
    releaseId: "seed-release-v0.20", corpusSnapshotId: CORPUS_SNAPSHOT_ID,
    embeddingProvider: "nlpai-lab", embeddingModel: "KURE-v1", embeddingRevision: KURE_PIN.revision,
    chunkingPolicyId: "fixed-token-512-o64.v0.1.0",
  });
  try {
    bm25Index = await loadFixedKureBm25Index(BM25_CACHE_DIR, loadSessionId);
  } catch {
    const { index } = await buildFixedKureBm25Index(client, loadSessionId);
    await persistFixedKureBm25Index(BM25_CACHE_DIR, loadSessionId, index);
    bm25Index = index;
  }
});

test.after(async () => {
  await client.end();
});

function embeddingConfig() {
  return {
    schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
    revision: KURE_PIN.revision, dimension: KURE_PIN.dimension,
    endpoint_url: embeddingServerUrl, timeout_ms: 60000, auth_mode: "NONE",
  };
}

async function samplePrimeChunk() {
  const probe = await client.query(
    `SELECT chunk_id, source_document_id, text_content
     FROM disclosure_reference.reference_retrieval_chunks
     WHERE retrieval_index_id = $1 ORDER BY chunk_id LIMIT 1`,
    [retrievalIndexId],
  );
  if (probe.rows.length === 0) throw new Error(`no materialized chunks found for retrieval_index_id=${retrievalIndexId} -- run materialization first`);
  return probe.rows[0];
}

test("shard smoke: BM25 index build/persist/reload round-trips over the real 1,144-chunk shard", async () => {
  assert.ok(bm25Index.documentCount > 0);
});

test("arm A (FIXED+FULL_DENSE): BM25+dense self-match probe -- the probe chunk's own full text finds itself near rank 1", async () => {
  const sampleChunk = await samplePrimeChunk();
  const vectorRepository = createPostgresVectorRetrievalRepository({ client });
  const embeddingAdapter = createEmbeddingAdapter(embeddingConfig());
  const armA = createArmRetrieverAdapter({
    arm: "A", client, bm25Index, retrievalIndexId, loadSessionId,
    vectorRepository, embeddingAdapter,
    expectedPins: { embedding_provider: "nlpai-lab", embedding_model: "KURE-v1", embedding_dimension: KURE_PIN.dimension, chunking_policy_id: "fixed-token-512-o64.v0.1.0" },
  });
  const results = await armA.search(sampleChunk.text_content, {}, 10);
  const selfHit = results.find((r) => r.chunk_id === sampleChunk.chunk_id);
  assert.ok(selfHit, "arm A must find the probe chunk in its own top-10 HYBRID_RRF result");
  assert.equal(selfHit.arm_code, "A");
  assert.equal(selfHit.arm_id, "FIXED+FULL_DENSE");
  assert.notEqual(selfHit.component_scores.bm25, null);
  assert.notEqual(selfHit.component_scores.dense, null);
});

test("arm C (FIXED+DENSE_OFF): BM25-only self-match probe -- zero dense/embedding calls", async () => {
  const sampleChunk = await samplePrimeChunk();
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId, loadSessionId });
  const results = await armC.search(sampleChunk.text_content, {}, 10);
  const selfHit = results.find((r) => r.chunk_id === sampleChunk.chunk_id);
  assert.ok(selfHit, "arm C must find the probe chunk in its own top-10 BM25 result");
  assert.equal(selfHit.score_type, "BM25");
  assert.equal(selfHit.component_scores.dense, null);
  assert.equal(selfHit.component_scores.rrf, null);
});

test("readiness(): measured against the real shard -- code_ready/full_index_ready true, ambiguous-but-interpretable locator provenance no longer blocks official readiness", async () => {
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId, loadSessionId });
  const readiness = await armC.readiness();
  assert.equal(readiness.code_ready, true);
  assert.equal(readiness.full_index_ready, true);
  assert.equal(readiness.checks.load_session_status, "READY");
  assert.ok(readiness.checks.locator_provenance.total_chunks > 0);
  console.log(`[four-arm-ac smoke] locator coverage: ${JSON.stringify(readiness.checks.locator_provenance)}`);
  // Turn AC-LOCATOR-READY: `all_fully_resolved` is now an OBSERVABILITY-ONLY
  // measurement (as of the AC-IMPL Turn this shard is 12/1,144 == 1.05%
  // single-node+row, the rest legitimately multi-row/multi-node Fixed-512
  // chunks -- see locator-provenance.mjs's header). The actual readiness
  // gate is `provenance_ready`: every chunk has SOME interpretable,
  // non-empty candidate set. As long as this shard has zero
  // EMPTY_SPANS_INVALID chunks (unresolved_count === 0, true as measured by
  // the AC-IMPL Turn's own 12+821+311=1144 breakdown), official readiness
  // must NOT be blocked by mere multi-row/multi-node ambiguity.
  assert.equal(readiness.checks.locator_provenance.provenance_ready, readiness.checks.locator_provenance.unresolved_count === 0);
  if (readiness.checks.locator_provenance.unresolved_count === 0) {
    assert.equal(readiness.official_experiment_ready, true, "zero unresolved chunks -- ambiguity alone must not block official readiness");
    assert.ok(!readiness.reasons.includes("A_C_LOCATOR_UNRESOLVED_SPANS_PRESENT"));
  } else {
    assert.equal(readiness.official_experiment_ready, false);
    assert.ok(readiness.reasons.includes("A_C_LOCATOR_UNRESOLVED_SPANS_PRESENT"));
  }
});

test("fetch_node: identity-verified against the real staging table for a node known to exist in the shard", async () => {
  const sampleChunk = await samplePrimeChunk();
  const stagingRow = await client.query(
    `SELECT source_spans FROM disclosure_reference.reference_fixed_kure_chunk_staging WHERE load_session_id = $1 AND chunk_id = $2`,
    [loadSessionId, sampleChunk.chunk_id],
  );
  assert.ok(stagingRow.rows.length > 0, "expected a staging row for the sampled chunk");
  const firstSpan = stagingRow.rows[0].source_spans[0];
  const armC = createArmRetrieverAdapter({ arm: "C", client, bm25Index, retrievalIndexId, loadSessionId });
  const result = await armC.fetch_node(sampleChunk.source_document_id, firstSpan.order_index);
  assert.equal(result.found, true);
  assert.equal(result.node_text_available, false);
});
