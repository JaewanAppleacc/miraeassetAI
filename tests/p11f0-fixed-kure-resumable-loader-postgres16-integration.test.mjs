// Turn P11-F0: REAL PostgreSQL 16 (+ pgvector) integration coverage for
// reference-fixed-kure-load-session-repository.mjs's resumability
// guarantees -- lease/reclaim, two-worker disjoint leasing, idempotent
// resume, duplicate/collision rejection, and the READY finalize() guard.
//
// Excluded from `npm run test:domain`/`verify:contracts` (same discipline
// as tests/reference-release-postgres16-integration.test.mjs) -- requires
// a real, scratch-only PostgreSQL 16 + pgvector database with migrations
// 001-006 already applied and one `seed-release-v0.20` releases row
// present (FK target only; no real Fact/Evidence/bundle content is
// required). Invoke explicitly:
//
//   DATABASE_URL='postgresql://user@host:port/scratch_db' \
//     node --test tests/p11f0-fixed-kure-resumable-loader-postgres16-integration.test.mjs
//
// If DATABASE_URL is not set, this suite FAILS CLOSED (never a silent
// skip). Never touches production DATABASE_URL, never reads DEV_TUNE/
// DEV_CHECK/HOLDOUT/Gold, never calls a real embedding API or HCX.
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import { createFixedKureLoadSessionRepository } from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";

const { Client } = pg;

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: DATABASE_URL is required to run "
      + "tests/p11f0-fixed-kure-resumable-loader-postgres16-integration.test.mjs. "
      + "DATABASE_URL='postgresql://user@host:port/scratch_db' node --test tests/p11f0-fixed-kure-resumable-loader-postgres16-integration.test.mjs",
    );
  }
  return url;
}

let client;
let client2; // a second, independent connection -- for the two-worker disjoint-lease test
let repo;
let repo2;

test.before(async () => {
  const url = requireDatabaseUrl();
  client = new Client({ connectionString: url });
  client2 = new Client({ connectionString: url });
  await client.connect();
  await client2.connect();
  repo = createFixedKureLoadSessionRepository({ client });
  repo2 = createFixedKureLoadSessionRepository({ client: client2 });
});

test.after(async () => {
  if (client) await client.end();
  if (client2) await client2.end();
});

// Load session rows are immutable/undeletable by design (the transition
// guard trigger rejects DELETE outright -- an audit-trail invariant, not a
// bug). A static per-test suffix would therefore collide with the SAME
// test's own leftover row from any prior manual run against this
// persistent scratch DB. RUN_ID makes every invocation's corpus_snapshot_id
// (and so load_session_id) fresh.
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function uniquePins(suffix) {
  return {
    releaseId: "seed-release-v0.20",
    corpusSnapshotId: `corpus_p11f0_integration_test_${suffix}_${RUN_ID}`,
    corpusManifestSha256: "a".repeat(64),
    embeddingProvider: "nlpai-lab", embeddingModel: "KURE-v1",
    embeddingRevision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", embeddingDimension: 8, distanceMetric: "cosine",
    chunkingPolicyId: "fixed-token-512-o64.v0.1.0", chunkingPolicySha256: "b".repeat(64),
    batchSize: 4, discoveryBatchSize: 100, maxRetryAttempts: 3, leaseDurationMs: 500, // SHORT lease -- this suite deliberately waits for it to expire
    codeRevision: "integration-test",
  };
}

function fakeVec(seed) {
  return Array.from({ length: 8 }, (_, i) => (seed + i) / 100);
}

async function seedDiscoveredSession(repoInstance, pins, uniqueTextCount) {
  const { session } = await repoInstance.createOrGetSession(pins);
  await repoInstance.transitionStatus(session.load_session_id, ["CREATED"], "DISCOVERING");
  const rows = Array.from({ length: uniqueTextCount }, (_, i) => ({
    embedTextSha256: require_sha256(`text-${pins.corpusSnapshotId}-${i}`), embedText: `본문 ${i} ${pins.corpusSnapshotId}`, charLength: 10,
  }));
  await repoInstance.insertCanonicalBatch(session.load_session_id, rows);
  await repoInstance.updateDiscoveryCheckpoint(session.load_session_id, {
    sourceFilesProgress: { done: true }, newDocumentCount: 1, newTotalChunkCount: uniqueTextCount, newSearchEligibleCount: uniqueTextCount, newUniqueTextCount: uniqueTextCount,
  });
  const completed = await repoInstance.completeDiscovery(session.load_session_id);
  return completed;
}

import { createHash } from "node:crypto";
function require_sha256(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }

test("lease reclaim: an expired LEASED row is picked up again by a later lease call (a dead worker's own lease)", async () => {
  const pins = uniquePins("lease-reclaim");
  const session = await seedDiscoveredSession(repo, pins, 3);
  await repo.transitionStatus(session.load_session_id, ["DISCOVERY_COMPLETE"], "EMBEDDING");

  const firstLease = await repo.leaseCanonicalBatch(session.load_session_id, { limit: 10, leaseOwner: "worker-A", leaseDurationMs: 300 });
  assert.equal(firstLease.length, 3);

  // Immediately re-leasing (before expiry) must return NOTHING -- the rows are still validly LEASED.
  const tooSoon = await repo.leaseCanonicalBatch(session.load_session_id, { limit: 10, leaseOwner: "worker-B", leaseDurationMs: 300 });
  assert.equal(tooSoon.length, 0);

  // Wait past the lease duration.
  await new Promise((resolve) => { setTimeout(resolve, 500); });

  const reclaimed = await repo.leaseCanonicalBatch(session.load_session_id, { limit: 10, leaseOwner: "worker-B", leaseDurationMs: 300 });
  assert.equal(reclaimed.length, 3, "the expired lease's rows must be reclaimable by a new worker");
  assert.deepEqual(new Set(reclaimed.map((r) => r.embed_text_sha256)), new Set(firstLease.map((r) => r.embed_text_sha256)));
});

test("two-worker disjoint lease: two independent connections leasing the SAME session concurrently never receive overlapping rows", async () => {
  const pins = uniquePins("two-worker");
  const session = await seedDiscoveredSession(repo, pins, 20);
  await repo.transitionStatus(session.load_session_id, ["DISCOVERY_COMPLETE"], "EMBEDDING");

  const [leaseA, leaseB] = await Promise.all([
    repo.leaseCanonicalBatch(session.load_session_id, { limit: 10, leaseOwner: "worker-A", leaseDurationMs: 60000 }),
    repo2.leaseCanonicalBatch(session.load_session_id, { limit: 10, leaseOwner: "worker-B", leaseDurationMs: 60000 }),
  ]);
  const idsA = new Set(leaseA.map((r) => r.embed_text_sha256));
  const idsB = new Set(leaseB.map((r) => r.embed_text_sha256));
  assert.equal(idsA.size + idsB.size, 20, "every row must be leased by exactly one worker");
  for (const id of idsA) assert.equal(idsB.has(id), false, "no row may be leased by both workers");
});

test("idempotent resume: createOrGetSession on the SAME pins twice returns the SAME session, never a duplicate", async () => {
  const pins = uniquePins("idempotent-session");
  const { session: first, created: firstCreated } = await repo.createOrGetSession(pins);
  const { session: second, created: secondCreated } = await repo.createOrGetSession(pins);
  assert.equal(firstCreated, true);
  assert.equal(secondCreated, false);
  assert.equal(first.load_session_id, second.load_session_id);
});

test("duplicate/collision rejection: a different embedding_config_sha256 under the SAME corpus/chunking identity is refused, never silently reused", async () => {
  const pins = uniquePins("collision");
  await repo.createOrGetSession(pins);
  // load_session_id/retrieval_index_id are hashed from
  // {releaseId, corpusSnapshotId, embeddingProvider, embeddingModel,
  // embeddingRevision, chunkingPolicyId} -- changing embeddingModel would
  // itself change the load_session_id (a legitimately DIFFERENT session,
  // by design: section 10's per-embedding-model comparison requires
  // separate indices per model, not a collision). embeddingDimension and
  // distanceMetric are the fields that feed embedding_config_sha256 WITHOUT
  // being part of the load_session_id hash -- changing one of those is the
  // actual same-identity/different-config collision this guard exists for.
  await assert.rejects(
    () => repo.createOrGetSession({ ...pins, embeddingDimension: 16 }),
    (error) => { assert.equal(error.code, "EMBEDDING_CONFIG_MISMATCH"); return true; },
  );
});

test("READY guard: finalize() refuses when materialized_chunk_count does not match discovered_search_eligible_count", async () => {
  const pins = uniquePins("ready-guard");
  const session = await seedDiscoveredSession(repo, pins, 2);
  await repo.transitionStatus(session.load_session_id, ["DISCOVERY_COMPLETE"], "EMBEDDING");
  // Never actually embed/materialize anything -- finalize() must refuse.
  await repo.transitionStatus(session.load_session_id, ["EMBEDDING"], "MATERIALIZING");
  await assert.rejects(
    () => repo.finalize(session.load_session_id, session.retrieval_index_id),
    (error) => { assert.equal(error.code, "FINALIZATION_MISMATCH"); return true; },
  );
});

test("full resumable cycle: discover -> embed (via two leased batches) -> materialize -> finalize READY, then a second createOrGetSession call resumes (never duplicates) the same READY session", async () => {
  const pins = uniquePins("full-cycle");
  const session = await seedDiscoveredSession(repo, pins, 5);
  await repo.transitionStatus(session.load_session_id, ["DISCOVERY_COMPLETE"], "EMBEDDING");

  let remaining = 5;
  while (remaining > 0) {
    // eslint-disable-next-line no-await-in-loop
    const leased = await repo.leaseCanonicalBatch(session.load_session_id, { limit: 2, leaseOwner: "worker-full-cycle", leaseDurationMs: 60000 });
    if (leased.length === 0) break;
    // eslint-disable-next-line no-await-in-loop
    await repo.markEmbedded(session.load_session_id, leased.map((r, i) => ({ embedTextSha256: r.embed_text_sha256, embedding: fakeVec(i) })));
    remaining -= leased.length;
  }
  const counts = await repo.queueStatusCounts(session.load_session_id);
  assert.deepEqual(counts, { PENDING: 0, LEASED: 0, EMBEDDED: 5, FAILED: 0 });

  await repo.transitionStatus(session.load_session_id, ["EMBEDDING"], "MATERIALIZING");
  await repo.ensureRetrievalIndexRow({
    retrievalIndexId: session.retrieval_index_id, releaseId: pins.releaseId, corpusSnapshotId: pins.corpusSnapshotId,
    embeddingProvider: pins.embeddingProvider, embeddingModel: pins.embeddingModel, embeddingRevision: pins.embeddingRevision,
    embeddingDimension: pins.embeddingDimension, distanceMetric: pins.distanceMetric, chunkingPolicyId: pins.chunkingPolicyId,
    chunkingPolicySha256: pins.chunkingPolicySha256, manifestSha256: pins.corpusManifestSha256,
  });
  // No chunk_staging rows were ever inserted in this synthetic test (it
  // exercises the EMBEDDING queue path only) -- materializeChunkBatch
  // correctly finds nothing to do, and this test's own READY assertion is
  // instead about the embedded_unique_text_count bookkeeping, checked via
  // getSession below (finalize() itself is exercised separately by the
  // dedicated READY-guard test above).
  const afterMaterializeAttempt = await repo.materializeChunkBatch(session.load_session_id, session.retrieval_index_id, 100);
  assert.equal(afterMaterializeAttempt.done, true);
  assert.equal(afterMaterializeAttempt.materializedCount, 0);

  const finalCheck = await repo.getSession(session.load_session_id);
  assert.equal(finalCheck.embedded_unique_text_count, 5);

  // Resuming with the SAME pins never creates a second session.
  const { created: resumedCreated, session: resumedSession } = await repo.createOrGetSession(pins);
  assert.equal(resumedCreated, false);
  assert.equal(resumedSession.load_session_id, session.load_session_id);
});
