// Turn AC-COLAB-BENCH-V1, section J/K: confirms this Turn's own DB
// boundary was respected -- zero vector inserts, zero materialization, no
// attempt status changed to EMBEDDING_COMPLETE/READY, and every attempt
// this Turn reads from (the pre-existing 750-doc READY shard, the
// INVALID_DISCOVERY_CANONICAL_SCOPE attempt this Turn's manifest is
// scoped from, and the provenance-only successor attempt) is exactly as
// it was found -- read-only.
//
// Excluded from `npm run test:domain`/`verify:contracts` (same discipline
// as every other *-postgres16-integration.test.mjs in this repo). Fails
// CLOSED if DATABASE_URL is not set. Zero DEV_TUNE/DEV_CHECK/HOLDOUT/Gold
// access.
//
//   DATABASE_URL='postgresql://user@host:port/scratch_db' \
//     node --test tests/p11f0-colab-benchmark-db-boundary-postgres16-integration.test.mjs
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import pg from "pg";

const { Client } = pg;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`P11F0_COLAB_BENCHMARK_DB_BOUNDARY_POSTGRESQL_16_INTEGRATION_NOT_RUN: ${name} is required to run this test file`);
  }
  return value;
}
const databaseUrl = requireEnv("DATABASE_URL");

const READY_SHARD_ID = "fixed_kure_session_21f4fafafafe8f7c38e8cd94897bc583";
const DISCOVERY_SOURCE_ATTEMPT_ID = "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36";
const SUCCESSOR_ATTEMPT_ID = "fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e";

let client;
test.before(async () => { client = new Client({ connectionString: databaseUrl }); await client.connect(); });
test.after(async () => { await client.end(); });

async function getSession(id) {
  const r = await client.query(
    `SELECT status, discovered_document_count, discovered_total_chunk_count, discovered_search_eligible_count,
            discovered_unique_text_count, embedded_unique_text_count, materialized_chunk_count, last_error_code
     FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id = $1`,
    [id],
  );
  return r.rows[0];
}

test("pre-existing READY 750-doc shard: unchanged, still exactly 1144/1144 materialized", async () => {
  const s = await getSession(READY_SHARD_ID);
  assert.ok(s, "the pre-existing shard row must still exist");
  assert.equal(s.status, "READY");
  assert.equal(s.discovered_document_count, 750);
  assert.equal(s.materialized_chunk_count, 1144);
});

test("discovery source attempt (INVALID_DISCOVERY_CANONICAL_SCOPE): status and counts unchanged by this Turn", async () => {
  const s = await getSession(DISCOVERY_SOURCE_ATTEMPT_ID);
  assert.ok(s, "the discovery source attempt must still exist");
  assert.equal(s.status, "INVALID_DISCOVERY_CANONICAL_SCOPE");
  assert.equal(s.discovered_document_count, 4204);
  assert.equal(s.discovered_search_eligible_count, 442549);
  assert.equal(s.discovered_unique_text_count, 447225);
  // This Turn is read-only over this attempt's staging data -- it must
  // never have embedded or materialized anything against it.
  assert.equal(s.embedded_unique_text_count, 0);
  assert.equal(s.materialized_chunk_count, 0);
});

test("successor attempt: still CREATED, zero progress -- this Turn recorded no embedding progress against it", async () => {
  const s = await getSession(SUCCESSOR_ATTEMPT_ID);
  assert.ok(s, "the successor attempt must still exist");
  assert.equal(s.status, "CREATED", "must not have been advanced to DISCOVERING/EMBEDDING/EMBEDDING_COMPLETE/READY by this Turn");
  assert.equal(s.discovered_document_count, 0);
  assert.equal(s.discovered_total_chunk_count, 0);
  assert.equal(s.embedded_unique_text_count, 0);
  assert.equal(s.materialized_chunk_count, 0);
});

test("zero DB vector rows exist for the successor attempt's own canonical queue (no embedding writes happened against it)", async () => {
  const r = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.reference_fixed_kure_canonical_queue WHERE load_session_id = $1 AND embedding IS NOT NULL",
    [SUCCESSOR_ATTEMPT_ID],
  );
  assert.equal(r.rows[0].n, 0);
});

test("no new reference_retrieval_indexes row was created/marked READY for the successor's retrieval_index_id", async () => {
  const successor = await client.query(
    "SELECT retrieval_index_id FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id = $1",
    [SUCCESSOR_ATTEMPT_ID],
  );
  const retrievalIndexId = successor.rows[0].retrieval_index_id;
  const idx = await client.query(
    "SELECT index_status FROM disclosure_reference.reference_retrieval_indexes WHERE retrieval_index_id = $1",
    [retrievalIndexId],
  );
  if (idx.rows.length > 0) {
    assert.notEqual(idx.rows[0].index_status, "READY", "this Turn must not have materialized/readied the full-corpus retrieval index");
  }
});
